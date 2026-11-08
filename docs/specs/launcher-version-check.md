# The launcher checks the running version (X-15)

| Version | Date | Status | Change |
| --- | --- | --- | --- |
| v1.0 | 2026-11-08 | Ready for build | Approved for implementation by Imran. No change to the content of v0.1. |
| v0.1 | 2026-11-08 | Draft | Initial spec-lite, from backlog order 15 (Imran, 2026-11-01). Grounded in `main` at `082fbc6`. No open question. |

Spec-lite (CLAUDE.md Section 8): no new network path (the launcher already asks `/api/health` on 127.0.0.1), no new kind of input file (`VERSION.txt` is written by our own build). Order 15 in `backlog.md`; `releasing.md` step 2 checks it is merged.

## 1. Problem

*Start Semantic Studio* runs `app.launcher`. Before starting a server, `launcher.choose()` binds ports 8000 to 8019 on 127.0.0.1, asks each taken port `/api/health`, and if one answers `{"app": "semantic-studio"}` it opens the browser there and exits (*Semantic Studio is already running at … Opening it in your browser.*). It never asks which version is running, and `/api/health` does not say.

So a person who unzips a new release while the old one's window is still open gets the old one, with no warning, and believes they are on the new one. Both versions use the same data folder, so it matters most when a release changes how work is kept (`releasing.md` Section 8). The same happens to Imran when a development server is running: `releasing.md` step 5 asks him to stop it first for this reason.

The version is known in a release. `release/build.py` writes `VERSION.txt` at the top of the unzipped folder: *Semantic Studio 1.0.0* on its first line, then the commit. The launcher and the server both run from `app\` beside it. A copy run from source has no `VERSION.txt`.

**Primary stakeholder:** the person updating Semantic Studio. What changes: the launcher opens a running Semantic Studio only when it is the same version, and otherwise says which one is running and what to do.

## 5. Behavior

### 5.1 Where the version comes from

One function, `version()`, in a new small module `app/version.py`, so `main.py` and `launcher.py` read it the same way without one importing the other. It reads `VERSION.txt` in the folder above `app\` once, and returns what follows *Semantic Studio* on the first line (`1.1.0`). With no file, or a first line that is not that shape, it returns `development`. It never raises.

`/api/health` answers `{"status": "ok", "app": "semantic-studio", "version": version()}`. Nothing else changes in it.

### 5.2 What the launcher does

`choose()` keeps its order: bind the ports, then ask only the taken ones. A taken port that answers as Semantic Studio is compared with the launcher's own `version()`:

| Running answers | Launcher does |
| --- | --- |
| The same version | Today's behavior: opens it in the browser and exits 0 |
| No `version` (any release before this change) | Treated as an older version |
| A different version | Opens nothing, prints one sentence (5.3), waits for Enter, exits 1, as it does when every port is taken |

*Older* and *newer* compare the numbers part by part (`1.10.0` is newer than `1.9.2`). When either side is `development`, or either does not read as numbers, the sentence says *another version*. The first Semantic Studio found decides, as today; the launcher never starts a second server beside one that is running.

### 5.3 The sentences

Each names both versions and the address, so the person can find the other window:

- Older: *An older version of Semantic Studio (1.0.0) is running at http://127.0.0.1:8000. Close its window, titled Semantic Studio, then start this one (1.1.0) again.*
- Older, no version given: *An older version of Semantic Studio is running at http://127.0.0.1:8000. Close its window, titled Semantic Studio, then start this one (1.1.0) again.*
- Newer: *A newer version of Semantic Studio (1.2.0) is running at http://127.0.0.1:8000. Close its window, titled Semantic Studio, then start this one (1.1.0) again, or keep using the newer one.*
- Another: *Another version of Semantic Studio (development) is running at http://127.0.0.1:8000. Close it, then start this one (1.1.0) again.*

Then the existing *Press Enter to close this window.* wait (`_wait_for_a_key`).

### 5.4 The smoke test

`release/smoke.py` step 1 also checks that `/api/health`'s `version` equals the version in the unzipped folder's `VERSION.txt`. Step 6, *a second start finds the first and exits*, keeps passing unchanged, since both starts are the same version.

## 11. Test plan

| Test | Type | Layer | File | Covers |
| --- | --- | --- | --- | --- |
| `version()` reads `1.1.0` from *Semantic Studio 1.1.0*; `development` with no file, an empty file, or another first line; never raises | unit | pytest | `tests/test_launcher.py` | AC-1 |
| `/api/health` carries `version` | integration | pytest | `tests/test_launcher.py` | AC-1 |
| With a stub server answering the same version, `main(["--no-browser"])` exits 0 with today's sentence | integration | pytest | `tests/test_launcher.py` | AC-2 |
| Stub answers `1.0.0`, no version, `1.2.0`, `development`: exit 1, the matching sentence from 5.3 with both versions and the port, no server started, the browser not opened | integration | pytest | `tests/test_launcher.py` | AC-3, AC-4 |
| Comparison table: `1.10.0` > `1.9.2`, `1.1.0` = `1.1.0`, `1.1` against `1.1.0` reads as the same, `development` and `1.x-rc` give *another* | unit | pytest | `tests/test_launcher.py` | AC-3 |
| The probe still goes through `http.client` to 127.0.0.1 (the existing AC-9 proxy test passes unchanged) | regression | pytest | `tests/test_launcher.py` | AC-5 |
| The smoke test's step 1 compares `version` with `VERSION.txt` | regression | pytest | `tests/test_release_workflow.py` | AC-6 |
| Removal checks: remove the comparison in `choose()`, then the `version` field in `/api/health`; the matching tests go red each time | removal | pytest | as above | all |

## 12. Acceptance criteria

- **AC-1.** `/api/health` says the version, read from `VERSION.txt`, or `development` without one.
- **AC-2.** Given the same version is running, *Start Semantic Studio* opens it, as today.
- **AC-3.** Given an older, newer or other version is running, *Start Semantic Studio* opens nothing, starts no server and says which version is running, where, and what to do.
- **AC-4.** A release from before this change counts as older.
- **AC-5.** No new network path: the only request is the existing `/api/health` on 127.0.0.1, through `http.client`.
- **AC-6.** The release smoke test fails if the running version does not match the folder's `VERSION.txt`.

## 13. Skills to use

`build-spec`.

## 14. Architecture impact

- New module `backend/app/version.py` (`version()`), read by `main.py` (`/api/health`) and `launcher.py`. No new dependency, endpoint or network path.
- `/api/health` gains `version`. State it in the PR description.
- `release/smoke.py` step 1 checks it.
- `releasing.md` step 5's note (*stop the dev server first: the launcher opens any Semantic Studio already on port 8000*) changes once this is merged: the launcher now refuses a development server instead of opening it. The analyst updates it at merge.
- **D-130**, to append to `decisions.md`: *The launcher opens a running Semantic Studio only when it is the same version; otherwise it opens nothing and says which version is running (X-15).* Considered: opening it with a warning (the person would still work in the wrong version); stopping the old one for the person (the launcher cannot know whether unsaved work is open in it). Chosen because the person decides when to close a window that may hold unsaved work.

## 15. Open questions

None.
