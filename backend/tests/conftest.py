"""
================================================================================
FILE: backend/tests/conftest.py
================================================================================

SUMMARY
    pytest's automatic configuration file. It runs before any test module is
    collected and points the app's data directory at a throwaway temp folder.

BASIC IDEA
    The store persists ontologies and saved queries to a per-user directory.
    If tests used the real one they would pollute (or read) the developer's
    actual library. Setting the env var here — at import time, before any app
    module loads and reads it — guarantees every test run gets a clean,
    isolated, disposable data directory.

INPUTS / INPUT SOURCES
    - None; it only sets an environment variable.

EXPECTED OUTPUT
    - SEMANTIC_STUDIO_DATA_DIR set to a fresh temp directory for the test run.
================================================================================
"""

import os
import tempfile

# Isolate the persistent store: tests must never touch the developer's real
# per-user data directory. This runs before any app module is imported, so
# default_data_dir() in store.py picks up this override.
os.environ["SEMANTIC_STUDIO_DATA_DIR"] = tempfile.mkdtemp(prefix="semantic-studio-tests-")
