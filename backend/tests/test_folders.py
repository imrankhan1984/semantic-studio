"""
================================================================================
FILE: backend/tests/test_folders.py
================================================================================

SUMMARY
    The folder browser and the path rules (projects-anywhere 5.3, AC-11 to
    AC-14, D-135): network and device paths refused with no filesystem call
    made, the refused-folder table entry by entry, links and junctions,
    drive roots and folders near a project, the client header on the
    listing, and the 1,000-folder cap with the true total.

BASIC IDEA
    The zero-calls proof patches every way Python reaches the disk -- os.stat,
    os.lstat, os.scandir, os.listdir, the os.path checks (which on Windows
    3.12+ are nt._path_* and never call os.stat), open, the Path methods and
    the long-name lookup -- with recorders, then sends each hostile path to
    the listing, New project, Open and Locate. Called directly, folders.py
    must make no call at all; through a route, no call may name the path
    (the route itself may read the data folder's registry or settings).
    Delete the check in path_error and these go red: the removal check the
    spec asks the reviewer for.

INPUTS / INPUT SOURCES
    - folders.py directly, and the app through TestClient.

EXPECTED OUTPUT
    - Pass/fail; one budget (Section 10) under the `perf` mark.
================================================================================
"""

import builtins
import gc
import io
import os
import pathlib
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import folders
from app.editing import editing_service, project_store
from app.main import app
from app.store import store

from budget import limit_ms

client = TestClient(app, base_url="http://localhost", headers={"X-Semantic-Studio": "1"})
bare = TestClient(app, base_url="http://localhost")


@pytest.fixture(autouse=True)
def _clean():
    yield
    editing_service.close_all()
    project_store.registry_path.unlink(missing_ok=True)


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    here = tmp_path / "home"
    (here / "Work").mkdir(parents=True)
    monkeypatch.setattr(folders, "home", lambda: here)
    return here


def _detail(response) -> str:
    detail = response.json()["detail"]
    return detail["message"] if isinstance(detail, dict) else detail


# --- AC-11: network and device paths, zero filesystem calls -------------------------

HOSTILE = [
    "\\\\server\\share",
    "\\\\server\\share\\Motors",
    "//server/share",
    "\\\\?\\UNC\\server\\share",
    "\\\\.\\pipe\\x",
    "\\\\?\\C:\\Windows",
    "\\/server/share",
    "relative\\x" if os.name == "nt" else "relative/x",
    "C:\\Work\\CON\\x" if os.name == "nt" else "/tmp/../etc",
]
if os.name == "nt":
    HOSTILE += ["C:\\Work\\nul.txt", "C:\\Work\\COM1", "C:\\Windows.", "C:\\Work\\x:stream", "C:relative", "/rooted-without-drive"]


class Recorder:
    """Every filesystem call made while it is installed, with its path."""

    def __init__(self, monkeypatch):
        self.calls: list[tuple[str, str]] = []
        names = {
            os: ["stat", "lstat", "scandir", "listdir", "open", "mkdir", "makedirs"],
            os.path: ["exists", "lexists", "isdir", "isfile", "islink", "isjunction", "realpath", "getsize"],
        }
        for module, attrs in names.items():
            for attr in attrs:
                if hasattr(module, attr):
                    monkeypatch.setattr(module, attr, self._wrap(f"{module.__name__}.{attr}", getattr(module, attr)))
        monkeypatch.setattr(builtins, "open", self._wrap("open", builtins.open))
        monkeypatch.setattr(io, "open", self._wrap("io.open", io.open))
        for attr in ("exists", "is_dir", "is_file", "is_symlink", "stat", "lstat", "iterdir", "mkdir",
                     "read_text", "read_bytes", "write_text", "resolve"):
            original = getattr(pathlib.Path, attr)
            monkeypatch.setattr(pathlib.Path, attr, self._wrap(f"Path.{attr}", original))
        monkeypatch.setattr(folders, "_long_name", self._wrap("GetLongPathNameW", folders._long_name))

    def _wrap(self, name, original):
        recorder = self

        def recorded(*args, **kwargs):
            target = str(args[0]) if args else ""
            recorder.calls.append((name, target))
            return original(*args, **kwargs)

        return recorded

    def naming(self, raw: str) -> list:
        token = [t for t in ("server", "pipe", "CON", "nul", "COM1", "relative", "stream", "rooted",
                             "Windows.", "etc") if t in raw]
        return [c for c in self.calls if any(t in c[1] for t in token)]


@pytest.mark.parametrize("raw", HOSTILE)
def test_ac11_network_and_device_paths_zero_fs_calls(raw, monkeypatch):
    assert folders.path_error(raw) is not None, raw
    recorder = Recorder(monkeypatch)
    for call in (lambda: folders.path_error(raw), lambda: folders.check(raw, "create"),
                 lambda: folders.check(raw, "open"), lambda: folders.listing(raw)):
        try:
            call()
        except (folders.FolderRefused, folders.FolderNotFound):
            pass
    assert recorder.calls == [], f"{raw!r} reached the disk: {recorder.calls[:5]}"


@pytest.mark.parametrize("raw", HOSTILE)
def test_ac11_every_door_refuses_before_the_disk(raw, monkeypatch, home):
    # A registered project for Locate's door, made before the recorder.
    made = client.post("/api/projects", json={"name": "Locate me", "location": {"parent": str(home / "Work")}})
    pid = made.json()["id"]
    recorder = Recorder(monkeypatch)
    doors = [
        client.get("/api/folders", params={"path": raw}),
        client.get("/api/folders", params={"path": raw, "mode": "open"}),
        client.post("/api/projects", json={"name": "Never made", "location": {"parent": raw}}),
        client.post("/api/projects/locations", json={"folder": raw}),
        client.patch(f"/api/projects/{pid}/location", json={"folder": raw}),
    ]
    monkeypatch.undo()
    for response in doors:
        assert response.status_code == 422, (raw, response.request.url, response.text)
    assert recorder.naming(raw) == [], f"{raw!r} reached the disk: {recorder.naming(raw)[:5]}"


def test_ac11_the_sentences():
    assert folders.path_error("\\\\server\\share") == folders.NETWORK
    assert folders.path_error("\\\\.\\pipe\\x") == folders.DEVICE
    assert folders.path_error("relative") == folders.NOT_ABSOLUTE
    good = "C:\\Work\\Motors" if os.name == "nt" else "/home/someone/Work"
    assert folders.path_error(good) is None
    assert folders.path_error(good + "\\..\\x" if os.name == "nt" else good + "/../x") == folders.BAD_NAME


# --- AC-12: refused folders, links, roots, near a project ---------------------------------


def _existing_refused() -> list[Path]:
    out = []
    for root, _sentence in folders.refused_roots():
        try:
            if root.is_dir():
                out.append(root)
        except OSError:
            continue
    return out


def test_ac12_the_table_holds_what_the_spec_names():
    roots = {folders.key(r) for r, _ in folders.refused_roots()}
    # As canonical() would see it: the environment may name it short (8.3).
    assert folders.key(folders._long_name(Path(store.data_dir))) in roots
    assert folders.key(folders.app_dir()) in roots
    if os.name == "nt":
        assert folders.key(Path(os.environ["SystemRoot"])) in roots
        assert folders.key(Path(os.environ["ProgramFiles"])) in roots
        assert folders.key(folders.home() / "AppData") in roots
        assert folders.refusal(Path("D:\\$Recycle.Bin\\x")) == folders.SYSTEM
        assert folders.refusal(Path("C:\\System Volume Information")) == folders.SYSTEM
    else:
        for name in ("/bin", "/boot", "/dev", "/etc", "/proc", "/sbin", "/sys", "/usr", "/var", "/System", "/Library"):
            assert folders.key(Path(name)) in roots


@pytest.mark.parametrize("root", _existing_refused(), ids=str)
def test_ac12_refused_folders_are_never_listed_or_chosen(root):
    for mode in ("create", "open"):
        with pytest.raises(folders.FolderRefused):
            folders.check(str(root), mode)
    response = client.get("/api/folders", params={"path": str(root)})
    assert response.status_code == 422
    parent = root.parent
    if parent != root and folders.refusal(parent) is None:
        try:
            listed = folders.listing(str(parent))
        except (folders.FolderRefused, folders.FolderNotFound):
            return
        assert all(folders.key(Path(f["path"])) != folders.key(root) for f in listed["folders"]), root


def test_ac12_under_a_refused_folder_is_refused_too(home):
    inside = Path(store.data_dir) / "projects"
    with pytest.raises(folders.FolderRefused) as caught:
        folders.check(str(inside), "create")
    assert str(caught.value) == folders.APP_DATA


def _short_name(path: Path) -> str:
    import ctypes

    size = ctypes.windll.kernel32.GetShortPathNameW(str(path), None, 0)
    buffer = ctypes.create_unicode_buffer(size)
    ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, size)
    return buffer.value


@pytest.mark.skipif(os.name != "nt", reason="8.3 short names are Windows'")
def test_ac12_a_root_named_by_its_short_name_is_refused_too(home, tmp_path, monkeypatch):
    # GitHub's Windows runner has TEMP under C:\Users\RUNNER~1: the data
    # folder's root came from the environment short while canonical()
    # expanded the chosen path, so nothing under it was refused.
    data = tmp_path / "semantic studio data folder"
    system = tmp_path / "operating system folder"
    for root in (data, system):
        (root / "projects").mkdir(parents=True)
    short_data, short_system = _short_name(data), _short_name(system)
    if short_data == str(data) or short_system == str(system):
        pytest.skip("8.3 names are off on this volume")
    assert "~" in short_data and "~" in short_system
    monkeypatch.setattr(folders, "_data_dir", None)
    monkeypatch.setenv("SEMANTIC_STUDIO_DATA_DIR", short_data)
    monkeypatch.setenv("ProgramData", short_system)
    for root, sentence in ((data, folders.APP_DATA), (system, folders.SYSTEM)):
        for chosen in (root / "projects", root):
            with pytest.raises(folders.FolderRefused) as caught:
                folders.check(str(chosen), "create")
            assert str(caught.value) == sentence
    # The listing's test reads the same expanded roots.
    listed = [f["name"] for f in folders.listing(str(tmp_path))["folders"]]
    assert data.name not in listed and system.name not in listed
    assert "home" in listed, "the listing loaded"


@pytest.mark.skipif(os.name != "nt", reason="C:\\Users is Windows'")
def test_ac12_other_peoples_folders_are_refused(home):
    other = home.parent / "someone-else"
    other.mkdir()
    assert folders.refusal(other) == folders.OTHER_USER
    users = folders.listing(str(home.parent))
    assert [f["name"] for f in users["folders"]] == ["home"]
    assert users["choosable"] is False


def test_ac12_links_not_listed(home):
    work = home / "Work"
    real = work / "Real"
    real.mkdir()
    made = False
    try:
        os.symlink(real, work / "Linked", target_is_directory=True)
        made = True
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(real), str(work / "Junction"))
        made = True
    if not made:
        pytest.skip("this machine can make neither a link nor a junction")
    listed = [f["name"] for f in folders.listing(str(work))["folders"]]
    assert listed == ["Real"]
    for name in ("Linked", "Junction"):
        if (work / name).exists():
            with pytest.raises(folders.FolderRefused) as caught:
                folders.check(str(work / name), "create")
            assert str(caught.value) == folders.LINK
            assert client.get("/api/folders", params={"path": str(work / name)}).status_code == 422
            assert client.post("/api/projects", json={"name": "Through", "location": {"parent": str(work / name)}}).status_code == 422
    assert list(real.iterdir()) == []


def test_ac12_hidden_and_dot_folders_and_files_not_listed(home):
    work = home / "Work"
    (work / ".git").mkdir()
    (work / "notes.txt").write_text("x", encoding="utf-8")
    (work / "Visible").mkdir()
    if os.name == "nt":
        import ctypes

        (work / "Hidden").mkdir()
        ctypes.windll.kernel32.SetFileAttributesW(str(work / "Hidden"), folders.FILE_ATTRIBUTE_HIDDEN)
    assert [f["name"] for f in folders.listing(str(work))["folders"]] == ["Visible"]


def test_ac12_drive_root_not_choosable():
    root = Path(Path.cwd().anchor)
    listed = folders.listing(str(root))
    assert listed["choosable"] is False and listed["reason"] == folders.DRIVE_ROOT
    assert listed["parent"] is None
    with pytest.raises(folders.FolderRefused):
        folders.check(str(root), "create")


def test_ac12_inside_a_project_not_choosable(home):
    made = client.post("/api/projects", json={"name": "Motors", "location": {"parent": str(home / "Work")}}).json()
    inside = Path(made["folder"]) / "sub"
    inside.mkdir()
    for path in (Path(made["folder"]), inside):
        listed = folders.listing(str(path))
        assert listed["choosable"] is False
        assert listed["reason"] == "That folder is inside the project Motors."
    # The folder holding it can be chosen for New project: the new project
    # is a sibling, never nested.
    assert folders.listing(str(home / "Work"))["choosable"] is True


def test_ac12_open_mode_needs_a_project_json(home):
    made = client.post("/api/projects", json={"name": "Motors", "location": {"parent": str(home / "Work")}}).json()
    work = folders.listing(str(home / "Work"), mode="open")
    assert work["choosable"] is False and work["reason"] == folders.NO_PROJECT
    assert work["folders"] == [{"name": "Motors", "path": made["folder"], "project": True}]
    there = folders.listing(made["folder"], mode="open")
    assert there["choosable"] is True and there["project"] is True


def test_ac12_places_and_path_bar(home):
    (home / "Documents").mkdir()
    listed = folders.listing(str(home / "Work"))
    names = [p["name"] for p in listed["places"]]
    assert names[0] == "Home folder" and "Documents" in names and "Desktop" not in names
    assert listed["parts"][-1] == {"name": "Work", "path": str(home / "Work")}
    assert listed["parts"][-2]["name"] == "home"
    assert listed["parent"] == str(home)
    # Omitted, the path is the home folder.
    assert client.get("/api/folders").json()["path"] == str(home)


def test_a_folder_not_there_is_404(home):
    response = client.get("/api/folders", params={"path": str(home / "Nowhere")})
    assert response.status_code == 404 and _detail(response) == folders.NOT_FOUND


# --- AC-13: the listing needs the header -----------------------------------------------


def test_ac13_listing_needs_the_header(home):
    assert bare.get("/api/folders", params={"path": str(home)}).status_code == 403
    foreign = client.get("/api/folders", params={"path": str(home)}, headers={"Origin": "http://evil.example"})
    assert foreign.status_code == 403
    assert "Work" not in foreign.text
    assert client.get("/api/folders", params={"path": str(home)}).status_code == 200
    assert bare.get("/api/folders/", params={"path": str(home)}).status_code == 403


# --- AC-14: the cap and the true total -----------------------------------------------------


def test_ac14_cap_and_true_total(home):
    many = home / "Work" / "Many"
    many.mkdir()
    for i in range(1005):
        (many / f"folder {i:04d}").mkdir()
    listed = client.get("/api/folders", params={"path": str(many)}).json()
    assert len(listed["folders"]) == 1000 and listed["total"] == 1005 and listed["truncated"] is True
    assert listed["folders"][0]["name"] == "folder 0000"
    narrowed = client.get("/api/folders", params={"path": str(many), "filter": "FOLDER 100"}).json()
    assert [f["name"] for f in narrowed["folders"]] == [f"folder {i:04d}" for i in range(1000, 1005)]
    assert narrowed["total"] == 5 and narrowed["truncated"] is False


@pytest.mark.perf
def test_budget_large_folder(home):
    """5,000 subfolders listed in at most 300 ms, median of five."""
    many = home / "Work" / "Five thousand"
    many.mkdir()
    for i in range(5000):
        (many / f"f{i:05d}").mkdir()
    client.get("/api/folders", params={"path": str(many)})
    samples = []
    gc.disable()
    try:
        for _ in range(5):
            start = time.perf_counter()
            listed = client.get("/api/folders", params={"path": str(many)}).json()
            samples.append((time.perf_counter() - start) * 1000)
    finally:
        gc.enable()
    assert len(listed["folders"]) == 1000 and listed["total"] == 5000
    median = sorted(samples)[2]
    assert median <= limit_ms(300), f"5,000 folders listed in {median:.0f} ms (median of 5)"
    shutil.rmtree(many)
