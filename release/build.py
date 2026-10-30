"""
================================================================================
FILE: release/build.py
================================================================================

SUMMARY
    Assembles the Windows release (release-packaging 5.1, D-119):
    `SemanticStudio-<version>-windows-x64.zip`, one top folder of the same
    name, holding python.org's embeddable Python, the backend's packages,
    `backend/app`, the built frontend, the start file, README.txt, LICENSE,
    THIRD-PARTY.txt, VERSION.txt and requirements-lock.txt, and the zip's
    SHA-256 beside it. Run by .github/workflows/release.yml on windows-latest.

BASIC IDEA
    The embeddable zip arrives already checked against the SHA-256 written in
    the workflow; this script unpacks it into `python\\` and rewrites its
    `python3XX._pth` to list exactly four places: the standard library zip,
    `python\\` itself, `python\\lib` and the folder that holds `app`. With a
    `._pth` and no `import site` line the bundled Python reads no
    PYTHONPATH, no user site folder and nothing else on the machine.

    The packages are installed by the Python running this script, which the
    workflow pins to the embeddable's exact version, with `pip install
    --target`, and `pip freeze --path` writes what actually went in to
    requirements-lock.txt: the repository's file pins five packages of ten.
    THIRD-PARTY.txt is the repository's list followed by Python's own
    license and every installed distribution's license files, read from its
    metadata, so a package that came in with another is not left out.

    Everything is compiled to bytecode here, with unchecked hashes, so a
    start reads .pyc files that never need rewriting; with `-B` in the start
    file nothing is written inside the folder at all (5.3).

    Without `--embed` the tree is made with no `python\\` and the packages
    left out: what the analyst runs on Linux with their own Python
    (Section 11, the rows run by people).

INPUTS / INPUT SOURCES
    - `--embed`: the checked embeddable zip; `--version`, `--commit`; `--out`.
    - backend/requirements.txt, backend/app, frontend/dist, LICENSE and
      release/ (the start file, README.txt, THIRD-PARTY.txt).

EXPECTED OUTPUT
    - <out>/SemanticStudio-<version>-windows-x64.zip and its .sha256 file,
      and the unzipped tree beside them; the zip's path on stdout.
================================================================================
"""

from __future__ import annotations

import argparse
import compileall
import hashlib
import importlib.metadata
import py_compile
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "release"
START_FILE = "Start Semantic Studio.cmd"


def name_for(version: str) -> str:
    return f"SemanticStudio-{version}-windows-x64"


def pth_lines(stdlib_zip: str) -> list[str]:
    """The `._pth`: relative to python\\, so `..` is the folder holding app.
    No `import site`: the user site folder and .pth files stay unread."""
    return [stdlib_zip, ".", "lib", ".."]


def unpack_python(embed: Path, target: Path) -> None:
    with zipfile.ZipFile(embed) as archive:
        archive.extractall(target)
    pths = sorted(target.glob("python3*._pth"))
    zips = sorted(p.name for p in target.glob("python3*.zip"))
    if len(pths) != 1 or len(zips) != 1:
        raise SystemExit(f"not an embeddable distribution: {pths} {zips}")
    pths[0].write_text("\n".join(pth_lines(zips[0])) + "\n", encoding="ascii")


def install_packages(lib: Path) -> str:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-compile",
         "--target", str(lib), "-r", str(ROOT / "backend" / "requirements.txt")],
        check=True,
    )
    frozen = subprocess.run(
        [sys.executable, "-m", "pip", "freeze", "--disable-pip-version-check", "--path", str(lib)],
        check=True, capture_output=True, text=True,
    ).stdout
    return frozen


def third_party(lib: Path | None, python_dir: Path | None) -> str:
    parts = [(RELEASE / "THIRD-PARTY.txt").read_text(encoding="utf-8").rstrip()]
    rule = "=" * 78
    if python_dir is not None and (python_dir / "LICENSE.txt").exists():
        parts += [rule, "Python (python.org embeddable distribution)", rule,
                  (python_dir / "LICENSE.txt").read_text(encoding="utf-8", errors="replace").rstrip()]
    if lib is not None:
        dists = sorted(importlib.metadata.distributions(path=[str(lib)]),
                       key=lambda d: d.metadata["Name"].lower())
        for dist in dists:
            meta = dist.metadata
            licence = meta.get("License-Expression") or meta.get("License") or ""
            header = f"{meta['Name']} {dist.version}" + (f" ({licence.splitlines()[0]})" if licence else "")
            texts = [
                f for f in (dist.files or [])
                if any(word in Path(str(f)).name.upper() for word in ("LICENSE", "LICENCE", "COPYING", "NOTICE"))
            ]
            body = "\n\n".join(
                Path(dist.locate_file(f)).read_text(encoding="utf-8", errors="replace").rstrip() for f in texts
            ) or f"License: {licence or 'see the package metadata'}"
            parts += [rule, header, rule, body]
    return "\n\n".join(parts) + "\n"


def lock_file(frozen: str, python_version: str, commit: str) -> str:
    return (
        "# Every package in this release and its version, as installed (release-packaging 5.1).\n"
        f"# Python {python_version} embeddable distribution, built from commit {commit}.\n"
        + frozen
    )


def build(out: Path, version: str, commit: str, embed: Path | None) -> Path:
    top_name = name_for(version)
    top = out / top_name
    if top.exists():
        shutil.rmtree(top)
    top.mkdir(parents=True)

    python_dir = lib = None
    frozen = "# No packages: built without the embeddable Python.\n"
    python_version = "(none)"
    if embed is not None:
        python_dir = top / "python"
        lib = python_dir / "lib"
        unpack_python(embed, python_dir)
        frozen = install_packages(lib)
        python_version = ".".join(map(str, sys.version_info[:3]))

    ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
    shutil.copytree(ROOT / "backend" / "app", top / "app", ignore=ignore)
    dist = ROOT / "frontend" / "dist"
    if not (dist / "index.html").exists():
        raise SystemExit("frontend/dist is missing: run the frontend build first")
    shutil.copytree(dist, top / "static")
    shutil.copy2(RELEASE / START_FILE, top / START_FILE)
    shutil.copy2(RELEASE / "README.txt", top / "README.txt")
    shutil.copy2(ROOT / "LICENSE", top / "LICENSE")
    (top / "THIRD-PARTY.txt").write_text(third_party(lib, python_dir), encoding="utf-8")
    (top / "requirements-lock.txt").write_text(lock_file(frozen, python_version, commit), encoding="utf-8")
    (top / "VERSION.txt").write_text(f"Semantic Studio {version}\nBuilt from commit {commit}\n", encoding="utf-8")

    if embed is not None:
        # Compiled by the same Python version as the embeddable; unchecked
        # hashes, so no start ever finds a .pyc stale and wants to write one.
        for folder in (lib, top / "app"):
            if not compileall.compile_dir(str(folder), quiet=1, workers=0,
                                          invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH):
                raise SystemExit(f"compiling {folder} failed")

    archive = out / f"{top_name}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(top.rglob("*")):
            zf.write(path, path.relative_to(out).as_posix())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (out / f"{top_name}.zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("SUMMARY")[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--embed", type=Path, help="the checked python-3.x.y-embed-amd64.zip")
    args = parser.parse_args()
    print(build(args.out.resolve(), args.version, args.commit, args.embed))


if __name__ == "__main__":
    main()
