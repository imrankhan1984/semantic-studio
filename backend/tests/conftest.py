import os
import tempfile

# Isolate the persistent store: tests must never touch the developer's real
# per-user data directory. This runs before any app module is imported.
os.environ["SEMANTIC_STUDIO_DATA_DIR"] = tempfile.mkdtemp(prefix="semantic-studio-tests-")
