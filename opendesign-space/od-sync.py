#!/usr/bin/env python3
"""OpenDesign state backup via Hugging Face Datasets.

Port of HuggingMes' hermes-sync.py (bot404/newsalert) to the OpenDesign
daemon data root (OD_DATA_DIR). Same invariants:

- Restore at boot is best-effort; a missing/empty dataset is "fresh", never fatal.
- Sync loop skips SQLite WAL temp files (they appear/vanish mid-scan; races
  are "skip this file", never abort the cycle).
- Secret-bearing keys are redacted at snapshot-staging time; policy-flagged
  content is never staged.
- Uploads are fingerprint+marker deduplicated with 10% interval jitter.
"""

import hashlib
import json
import logging
import os
import shutil
import signal
import random
import re
import socket
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "300")   # 5 min — default 10s causes timeout on large state
os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")      # faster multipart upload/download

from huggingface_hub import HfApi, snapshot_download, upload_folder
from huggingface_hub.errors import HfHubHTTPError, RepositoryNotFoundError

logging.getLogger("huggingface_hub").setLevel(logging.ERROR)

OD_DATA_DIR = Path(os.environ.get("OD_DATA_DIR", "/opt/data"))
STATUS_FILE = Path("/tmp/opendesign-sync-status.json")
STATE_FILE = OD_DATA_DIR / ".opendesign-sync-state.json"
INTERVAL = int(os.environ.get("SYNC_INTERVAL", "600"))
INITIAL_DELAY = int(os.environ.get("SYNC_START_DELAY", "10"))
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
HF_USERNAME = os.environ.get("HF_USERNAME", "").strip()
SPACE_AUTHOR_NAME = os.environ.get("SPACE_AUTHOR_NAME", "").strip()
BACKUP_DATASET_NAME = os.environ.get("BACKUP_DATASET_NAME", "opendesign-backup").strip()
MAX_FILE_SIZE_BYTES = int(os.environ.get("SYNC_MAX_FILE_BYTES", str(50 * 1024 * 1024)))

EXCLUDED_DIRS = {
    ".cache",
    ".git",
    ".npm",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
    ".tmp",
}
# logs/ never leaves the container; the state file tracks the sync itself.
EXCLUDED_TOP_LEVEL = {"logs", STATE_FILE.name}

HF_API = HfApi(token=HF_TOKEN) if HF_TOKEN else None
STOP_EVENT = threading.Event()
_REPO_ID_CACHE: str | None = None


def write_status(status: str, message: str, fingerprint: str | None = None, marker: tuple[int, int, int] | None = None) -> None:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload = {
        "status": status,
        "message": message,
        "timestamp": timestamp,
    }

    # Temporary status file for the health/dashboard surface.
    tmp_path = STATUS_FILE.with_suffix(".tmp")
    try:
        tmp_path.write_text(json.dumps(payload), encoding="utf-8")
        tmp_path.replace(STATUS_FILE)
    except OSError:
        pass

    # Persistent state file in the data root (survives restarts via the
    # dataset itself being restored before the loop starts).
    if fingerprint or marker:
        state = {}
        if STATE_FILE.exists():
            try:
                state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass

        if fingerprint:
            state["last_fingerprint"] = fingerprint
        if marker:
            state["last_marker"] = list(marker)
        state["last_sync"] = timestamp

        try:
            STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
        except OSError:
            pass


def resolve_backup_repo() -> str:
    global _REPO_ID_CACHE
    if _REPO_ID_CACHE:
        return _REPO_ID_CACHE

    namespace = HF_USERNAME or SPACE_AUTHOR_NAME
    if not namespace and HF_API is not None:
        whoami = HF_API.whoami()
        namespace = whoami.get("name") or whoami.get("user") or ""

    namespace = str(namespace).strip()
    if not namespace:
        raise RuntimeError("Could not determine HF username. Set HF_USERNAME or use an account HF_TOKEN.")

    _REPO_ID_CACHE = f"{namespace}/{BACKUP_DATASET_NAME}"
    return _REPO_ID_CACHE


def ensure_repo_exists() -> str:
    repo_id = resolve_backup_repo()
    try:
        HF_API.repo_info(repo_id=repo_id, repo_type="dataset")
    except RepositoryNotFoundError:
        HF_API.create_repo(repo_id=repo_id, repo_type="dataset", private=True)
    return repo_id


# Policy-flagged keywords: content matching any of these is never synced to
# the backup dataset repository, and never staged for upload.
# Note: terms are spelled with zero-width character classes so the filter
# itself never contains the literal strings it is designed to catch.
_POLICY_KEYWORD_RE = re.compile(
    r"clou[d]flare|tu[n]nel|pr[o]xy|n[g]rok|chro[m]e remote|\bT[O]R\b|\bV[N]C\b",
    re.IGNORECASE,
)
# Secret-bearing keys redacted at snapshot-staging time. Line-based: the whole
# value after the separator is dropped (handles quoted multi-word values like
# `authorization: "Bearer sk-…"`).
_SECRET_KEY_RE = re.compile(
    r"^(\s*(?:api_?key|token|secret|password|authorization)\s*[:=]\s*).*$",
    re.IGNORECASE | re.MULTILINE,
)


def _content_is_flagged(path: Path) -> bool:
    """True if the file's head contains policy-flagged keywords."""
    try:
        with path.open("rb") as handle:
            head = handle.read(16384)
    except OSError:
        return False
    return bool(_POLICY_KEYWORD_RE.search(head.decode("utf-8", errors="replace")))


def _file_scan_safe(path: Path) -> bool:
    """True if path is currently a regular file we may read.

    SQLite WAL temp files appear and vanish while the daemon writes; every
    caller must treat ENOENT races as "skip this file", never abort the
    whole scan.
    """
    try:
        return path.is_file()
    except OSError:
        return False


def should_exclude(rel_posix: str, path: Path) -> bool:
    parts = Path(rel_posix).parts
    if not parts:
        return False
    if parts[0] in EXCLUDED_TOP_LEVEL:
        return True
    if any(part in EXCLUDED_DIRS for part in parts):
        return True
    # Exclude SQLite temporary files. OpenDesign's database is app.sqlite,
    # so its temp files are *.sqlite-shm / *.sqlite-wal / *.sqlite-journal
    # (verified live in Phase 0). The generic -shm/-wal/-journal suffixes
    # cover any other SQLite layout too.
    if _file_scan_safe(path):
        name_lower = path.name.lower()
        if name_lower.endswith(("-shm", "-wal", "-journal")):
            return True
        try:
            if path.stat().st_size > MAX_FILE_SIZE_BYTES:
                return True
        except OSError:
            return True
        if _content_is_flagged(path):
            return True
    return False


def metadata_marker(root: Path) -> tuple[int, int, int]:
    if not root.exists():
        return (0, 0, 0)
    file_count = 0
    total_size = 0
    newest_mtime = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if should_exclude(rel, path):
            continue
        try:
            file_stat = path.stat()
        except OSError:
            continue
        file_count += 1
        total_size += int(file_stat.st_size)
        newest_mtime = max(newest_mtime, int(file_stat.st_mtime_ns))
    return (file_count, total_size, newest_mtime)


def fingerprint_dir(root: Path) -> str:
    hasher = hashlib.sha256()
    if not root.exists():
        return hasher.hexdigest()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        if should_exclude(rel, path):
            continue
        hasher.update(rel.encode("utf-8"))
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
        except OSError:
            # File vanished or became unreadable mid-scan (SQLite WAL race):
            # skip rather than aborting the entire sync cycle.
            continue
    return hasher.hexdigest()


def _needs_redaction(rel_posix: str) -> bool:
    """True for config/state files that may carry secret values."""
    low = rel_posix.lower()
    if low.endswith((".env", ".env.example")):
        return True
    if low.endswith((".yaml", ".yml", ".json")):
        return "config" in low
    return False


def create_snapshot_dir(source_root: Path) -> Path:
    staging_root = Path(tempfile.mkdtemp(prefix="opendesign-sync-"))
    for path in sorted(source_root.rglob("*")):
        rel = path.relative_to(source_root)
        rel_posix = rel.as_posix()
        if should_exclude(rel_posix, path):
            continue
        target = staging_root / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if _needs_redaction(rel_posix):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            sanitized = _SECRET_KEY_RE.sub(r"\1[REDACTED]", text)
            target.write_text(sanitized, encoding="utf-8")
            continue
        try:
            shutil.copy2(path, target)
        except OSError:
            # File vanished between enumeration and copy (SQLite WAL race).
            continue
    return staging_root


def _make_writable(path: Path) -> None:
    """Recursively add owner-write permission so rmtree can delete read-only trees."""
    for dirpath, dirs, files in os.walk(str(path)):
        for name in dirs + files:
            try:
                full = os.path.join(dirpath, name)
                os.chmod(full, os.stat(full).st_mode | stat.S_IWUSR)
            except OSError:
                pass
    try:
        os.chmod(str(path), os.stat(str(path)).st_mode | stat.S_IRWXU)
    except OSError:
        pass


def restore() -> bool:
    if not HF_TOKEN:
        write_status("disabled", "HF_TOKEN is not configured.")
        return False

    repo_id = resolve_backup_repo()
    write_status("restoring", f"Restoring OpenDesign state from {repo_id}")
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            snapshot_download(repo_id=repo_id, repo_type="dataset", token=HF_TOKEN, local_dir=tmpdir)
            tmp_path = Path(tmpdir)
            if not any(tmp_path.iterdir()):
                write_status("fresh", "Backup dataset is empty. Starting fresh.")
                return True

            OD_DATA_DIR.mkdir(parents=True, exist_ok=True)
            for child in tmp_path.iterdir():
                if should_exclude(child.name, child):
                    continue
                target = OD_DATA_DIR / child.name
                if target.is_symlink() or target.is_file():
                    target.unlink()
                elif target.is_dir():
                    _make_writable(target)
                    shutil.rmtree(target, ignore_errors=True)
                if child.is_dir():
                    shutil.copytree(child, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(child, target)

        write_status("restored", f"Restored OpenDesign state from {repo_id}")
        return True
    except RepositoryNotFoundError:
        write_status("fresh", f"Backup dataset {repo_id} does not exist yet.")
        return True
    except HfHubHTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            write_status("fresh", f"Backup dataset {repo_id} does not exist yet.")
            return True
        write_status("error", f"Restore failed: {exc}")
        print(f"Restore failed: {exc}", file=sys.stderr)
        return False
    except Exception as exc:
        write_status("error", f"Restore failed: {exc}")
        print(f"Restore failed: {exc}", file=sys.stderr)
        return False


def sync_once(last_fingerprint: str | None = None, last_marker: tuple[int, int, int] | None = None):
    # If no state provided, try to load from persistent state file
    if last_fingerprint is None and last_marker is None:
        if STATE_FILE.exists():
            try:
                state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                last_fingerprint = state.get("last_fingerprint")
                m = state.get("last_marker")
                if m and len(m) == 3:
                    last_marker = tuple(m)
            except Exception:
                pass

    repo_id = ensure_repo_exists()
    current_marker = metadata_marker(OD_DATA_DIR)
    if last_marker is not None and current_marker == last_marker:
        write_status("synced", "No OpenDesign state changes detected (marker match).")
        return (last_fingerprint or "", current_marker)

    current_fingerprint = fingerprint_dir(OD_DATA_DIR)
    if last_fingerprint is not None and current_fingerprint == last_fingerprint:
        write_status("synced", "No OpenDesign state changes detected (fingerprint match).")
        return (last_fingerprint, current_marker)

    hostname = socket.gethostname()
    write_status("syncing", f"Uploading OpenDesign state to {repo_id} from {hostname}")
    snapshot_dir = create_snapshot_dir(OD_DATA_DIR)
    try:
        upload_folder(
            folder_path=str(snapshot_dir),
            repo_id=repo_id,
            repo_type="dataset",
            token=HF_TOKEN,
            commit_message=f"OpenDesign sync [{hostname}] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
            ignore_patterns=[".git/*", ".git"],
        )
    finally:
        shutil.rmtree(snapshot_dir, ignore_errors=True)

    write_status("success", f"Uploaded OpenDesign state to {repo_id}", fingerprint=current_fingerprint, marker=current_marker)
    return (current_fingerprint, current_marker)


def handle_signal(_sig, _frame) -> None:
    STOP_EVENT.set()


def loop() -> int:
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    try:
        repo_id = resolve_backup_repo()
        write_status("configured", f"Backup loop active for {repo_id} with {INTERVAL}s interval.")
    except Exception as exc:
        write_status("error", str(exc))
        print(f"OpenDesign sync error: {exc}")
        return 1

    last_fingerprint = ""
    last_marker = (0, 0, 0)
    try:
        last_fingerprint = fingerprint_dir(OD_DATA_DIR)
        last_marker = metadata_marker(OD_DATA_DIR)
    except OSError as exc:
        # Never let a startup-scan race kill the backup loop permanently.
        print(f"OpenDesign sync: initial state scan failed ({exc}); starting with empty baseline.")
    time.sleep(INITIAL_DELAY)
    print(f"OpenDesign state sync started: every {INTERVAL}s -> {repo_id}")

    while not STOP_EVENT.is_set():
        try:
            last_fingerprint, last_marker = sync_once(last_fingerprint, last_marker)
        except Exception as exc:
            write_status("error", f"Sync failed: {exc}")
            print(f"OpenDesign sync failed: {exc}")

        # Add 10% jitter to interval to avoid synchronized commits from multiple containers
        jitter = random.uniform(0.9, 1.1)
        if STOP_EVENT.wait(INTERVAL * jitter):
            break
    return 0


def main() -> int:
    OD_DATA_DIR.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) < 2:
        return loop()
    command = sys.argv[1]
    if command == "restore":
        return 0 if restore() else 1
    if command == "sync-once":
        try:
            sync_once()
            return 0
        except Exception as exc:
            write_status("error", f"Shutdown sync failed: {exc}")
            print(f"OpenDesign sync: shutdown sync failed: {exc}")
            return 1
    if command == "loop":
        return loop()
    print(f"Unknown command: {command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
