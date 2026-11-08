"""
================================================================================
FILE: backend/tests/test_release_workflow.py
================================================================================

SUMMARY
    Holds .github/workflows/release.yml to its two promises
    (release-packaging 5.4, AC-7, AC-8, D-119): it never publishes a release,
    only drafts one, and it builds from python.org's embeddable Python only
    when the file's SHA-256 is the one written in it. Also that the bundled
    Python is the minor version CI's backend-windows job tests, and that the
    release's `._pth` lists exactly the four places 5.1 names, and that the
    smoke test's step 1 fails a server not at the folder's VERSION.txt
    (launcher-version-check 5.4, AC-6).

BASIC IDEA
    Configuration assertions, read from the workflow, the same model as
    test_deployment_binding.py: no runner is needed to notice a
    `gh release create` losing its `--draft`, a step that edits a release,
    or the hash check turning into a print. The scan of publishing commands
    is first run over planted lines, each of which it must catch.

INPUTS / INPUT SOURCES
    - .github/workflows/release.yml and ci.yml; release/build.py and smoke.py.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

# Every way a workflow can make a release visible to the world.
PUBLISHING = [
    re.compile(r"gh\s+release\s+(?:edit|upload|publish)\b"),
    re.compile(r"--draft[= ]false|draft:\s*false", re.I),
    re.compile(r"(?:softprops/action-gh-release|ncipollo/release-action|actions/create-release)"),
    re.compile(r"/releases/\d+|repos/[^ ]*/releases", re.I),
]


def publishing(text: str) -> list[str]:
    return [m.group(0) for pattern in PUBLISHING for m in pattern.finditer(text)]


def _workflow() -> dict:
    return yaml.safe_load(RELEASE_WORKFLOW.read_text(encoding="utf-8"))


def _runs(workflow: dict) -> list[str]:
    return [step.get("run", "") for job in workflow["jobs"].values() for step in job["steps"]]


def test_the_scan_sees_every_way_to_publish():
    planted = [
        "gh release edit v1.0.0 --draft=false",
        "gh release upload v1 x.zip",
        "uses: softprops/action-gh-release@v2",
        "draft: false",
        "curl -X PATCH https://api.github.com/repos/o/r/releases/12",
    ]
    for line in planted:
        assert publishing(line), line
    assert not publishing("gh release create v1 --draft --verify-tag x.zip")


def test_the_workflow_never_publishes_it_drafts():
    text = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    assert publishing(text) == []
    creates = [line for run in _runs(_workflow()) for line in run.splitlines() if "gh release create" in line]
    assert len(creates) == 1 and "--draft" in creates[0]


def test_only_the_draft_job_may_write_and_only_for_a_tag():
    workflow = _workflow()
    assert workflow["permissions"] == {"contents": "read"}
    writers = {name: job for name, job in workflow["jobs"].items() if "permissions" in job}
    assert list(writers) == ["draft"]
    draft = writers["draft"]
    assert draft["permissions"] == {"contents": "write"}
    assert "github.ref_type == 'tag'" in draft["if"]
    assert any("merge-base --is-ancestor" in run for run in (s.get("run", "") for s in draft["steps"]))


def test_the_embeddable_python_is_refused_unless_its_hash_matches():
    workflow = _workflow()
    digest = workflow["env"]["PYTHON_EMBED_SHA256"]
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert set(digest) != {"0"}, "the pinned hash is still the placeholder"
    check = next(run for run in _runs(workflow) if "Get-FileHash" in run)
    assert "-Algorithm SHA256" in check
    assert re.search(r"if \(\$actual -ne \$env:PYTHON_EMBED_SHA256(?:\.ToLowerInvariant\(\))?\)\s*\{\s*throw", check)
    assert "https://www.python.org/ftp/python/" in check
    # The build step uses the checked file, set only after the check passed.
    assert check.index("throw") < check.index("EMBED_ZIP=")


def test_the_bundled_python_is_the_minor_ci_tests_on_windows():
    release = _workflow()["env"]["PYTHON_VERSION"]
    ci = yaml.safe_load(CI_WORKFLOW.read_text(encoding="utf-8"))
    windows = next(
        step["with"]["python-version"] for step in ci["jobs"]["backend-windows"]["steps"]
        if "setup-python" in step.get("uses", "")
    )
    assert re.fullmatch(r"\d+\.\d+\.\d+", release), "the workflow pins the exact patch"
    assert release.rsplit(".", 1)[0] == windows


def test_the_pth_lists_exactly_the_four_places():
    spec = importlib.util.spec_from_file_location("release_build", ROOT / "release" / "build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    lines = build.pth_lines("python314.zip")
    assert lines == ["python314.zip", ".", "lib", ".."]
    assert not any("import site" in line for line in lines)


def test_the_artifact_is_kept_seven_days_and_the_smoke_test_runs():
    workflow = _workflow()
    steps = workflow["jobs"]["windows-zip"]["steps"]
    upload = next(s for s in steps if "upload-artifact" in s.get("uses", ""))
    assert upload["with"]["retention-days"] == 7
    assert workflow["jobs"]["windows-zip"]["runs-on"] == "windows-latest"
    smoke = next(s for s in steps if s.get("name") == "Smoke test")
    assert '"smoke test"' in smoke["run"] and "release/smoke.py" in smoke["run"]
    assert steps.index(smoke) < steps.index(upload)


def _smoke():
    spec = importlib.util.spec_from_file_location("release_smoke", ROOT / "release" / "smoke.py")
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    return smoke


def test_smoke_step_1_holds_health_to_the_folders_version(tmp_path):
    """launcher-version-check 5.4, AC-6: a server that says another version
    than the unzipped folder's VERSION.txt fails step 1."""
    import pytest

    smoke = _smoke()
    (tmp_path / "VERSION.txt").write_text("Semantic Studio 1.1.0\nBuilt from commit abc\n", encoding="utf-8")
    ours = {"status": "ok", "app": "semantic-studio"}
    assert smoke.check_health({**ours, "version": "1.1.0"}, tmp_path) == "1.1.0"
    for wrong in ({**ours, "version": "1.0.0"}, {**ours, "version": "development"}, ours,
                  {"status": "ok", "version": "1.1.0"}):
        with pytest.raises(smoke.Failed):
            smoke.check_health(wrong, tmp_path)
    (tmp_path / "VERSION.txt").unlink()
    with pytest.raises(smoke.Failed, match="no VERSION.txt"):
        smoke.check_health({**ours, "version": "development"}, tmp_path)
    # Step 1 is the one that asks it.
    source = (ROOT / "release" / "smoke.py").read_text(encoding="utf-8")
    step_1 = source[source.index("def health():"):source.index("step(1,")]
    assert "check_health(answer, top)" in step_1


def test_no_script_has_an_expression_pasted_in():
    """A tag's name may hold quotes and $( ): values reach a script through
    `env:`, never `${{ }}` inside `run:`."""
    runs = _runs(_workflow())
    assert runs and all("${{" not in run for run in runs), [r for r in runs if "${{" in r]
