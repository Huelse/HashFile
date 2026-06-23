#!/usr/bin/env python3
"""HashFile web server — serves static UI and /api/hash endpoint."""

import os
import json
import sqlite3
import subprocess
import threading
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("service_port", 17743))
WWW_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www")
DATA_DIR = os.environ.get("DATA_DIR") or "/var/apps/HashFile/shares/HashFile"
DB_PATH  = os.path.join(DATA_DIR, "data.db")

ALGO_CMDS = {
    "sha256": "sha256sum",
    "md5":    "md5sum",
    "sha1":   "sha1sum",
    "sha512": "sha512sum",
}

_db_lock = threading.Lock()


def _init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA encoding = 'UTF-8'")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS hash_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                path       TEXT    NOT NULL,
                algo       TEXT    NOT NULL,
                hash       TEXT,
                created_at TEXT    NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_path ON hash_history(path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_hash ON hash_history(hash)")


def _save_history(results):
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _db_lock:
        with sqlite3.connect(DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO hash_history (path, algo, hash, created_at) VALUES (?,?,?,?)",
                [(r["file"], r["algo"], r.get("hash"), created_at) for r in results]
            )


PER_PAGE = 20

def _list_history(q=None, page=1):
    offset = (page - 1) * PER_PAGE
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        if q:
            pattern = f"%{q}%"
            rows = conn.execute(
                "SELECT id, path, algo, hash, created_at FROM hash_history"
                " WHERE path LIKE ? OR hash LIKE ?"
                " ORDER BY id DESC LIMIT ? OFFSET ?",
                (pattern, pattern, PER_PAGE, offset)
            ).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) FROM hash_history WHERE path LIKE ? OR hash LIKE ?",
                (pattern, pattern)
            ).fetchone()[0]
        else:
            rows = conn.execute(
                "SELECT id, path, algo, hash, created_at FROM hash_history"
                " ORDER BY id DESC LIMIT ? OFFSET ?",
                (PER_PAGE, offset)
            ).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) FROM hash_history"
            ).fetchone()[0]
    return [dict(r) for r in rows], total


def _delete_history(entry_id):
    with _db_lock:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM hash_history WHERE id = ?", (entry_id,))


def compute_hashes(path, algos, recursive, expected, sub_timeout=None):

    files = []
    if os.path.isfile(path):
        files = [path]
    elif os.path.isdir(path):
        if recursive:
            for root, dirs, names in os.walk(path):
                dirs.sort()
                for name in sorted(names):
                    files.append(os.path.join(root, name))
        else:
            files = sorted(
                os.path.join(path, f)
                for f in os.listdir(path)
                if os.path.isfile(os.path.join(path, f))
            )

    results = []
    for f in files:
        for a in algos:
            cmd = ALGO_CMDS.get(a)
            if not cmd:
                continue
            try:
                proc = subprocess.run(
                    [cmd, "--", f],
                    capture_output=True, text=True, timeout=sub_timeout
                )
                if proc.returncode == 0:
                    hash_val = proc.stdout.split()[0]
                    err = None
                else:
                    hash_val = None
                    err = proc.stderr.strip() or "hash command failed"
            except subprocess.TimeoutExpired:
                hash_val = None
                err = f"{cmd} timed out after {sub_timeout}s"
            except FileNotFoundError:
                hash_val = None
                err = f"command not found: {cmd}"

            entry = {"file": f, "algo": a, "hash": hash_val}
            if err:
                entry["error"] = err
            if expected:
                entry["verified"] = (hash_val == expected)
                entry["expected"] = expected
            results.append(entry)

    return results


class HashHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/hash":
            self._handle_api(parsed)
        elif parsed.path == "/api/history":
            self._handle_history_list(parsed)
        else:
            super().do_GET()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/history":
            qs = parse_qs(parsed.query)
            raw_id = qs.get("id", [None])[0]
            if not raw_id:
                return self._json({"success": False, "error": "id required"}, 400)
            try:
                _delete_history(int(raw_id))
                self._json({"success": True})
            except Exception as exc:
                self._json({"success": False, "error": str(exc)}, 500)
        else:
            self.send_response(405)
            self.end_headers()

    def _handle_api(self, parsed):
        qs = parse_qs(parsed.query)
        path = qs.get("path", [""])[0].strip()
        algo_param = qs.get("algo", ["sha256"])[0].strip()
        recursive = qs.get("recursive", ["false"])[0].lower() == "true"
        expected = qs.get("expected", [""])[0].strip()

        if not path:
            return self._json({"success": False, "error": "path parameter is required"}, 400)
        if not os.path.exists(path):
            return self._json({"success": False, "error": f"Path not found: {path}"}, 404)

        if algo_param == "all":
            algos = list(ALGO_CMDS)
        else:
            algos = [a.strip() for a in algo_param.split(",") if a.strip() in ALGO_CMDS]
            if not algos:
                return self._json({"success": False, "error": f"No valid algorithm: {algo_param}"}, 400)

        raw_timeout = int(qs.get("timeout", ["60"])[0])
        sub_timeout = raw_timeout if raw_timeout > 0 else None

        try:
            results = compute_hashes(path, algos, recursive, expected, sub_timeout)
            try:
                _save_history(results)
            except Exception:
                pass
            self._json({"success": True, "path": path, "results": results})
        except Exception as exc:
            self._json({"success": False, "error": str(exc)}, 500)

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _handle_history_list(self, parsed):
        qs = parse_qs(parsed.query)
        q    = qs.get("q",    [""])[0].strip() or None
        page = max(1, int(qs.get("page", ["1"])[0]))
        try:
            entries, total = _list_history(q, page)
            pages = max(1, (total + PER_PAGE - 1) // PER_PAGE)
            self._json({"success": True, "entries": entries,
                        "total": total, "page": page, "pages": pages})
        except Exception as exc:
            self._json({"success": False, "error": str(exc)}, 500)

    def log_message(self, fmt, *args):
        pass  # quiet — errors only


if __name__ == "__main__":
    _init_db()
    server = ThreadingHTTPServer(("", PORT), HashHandler)
    print(f"HashFile listening on :{PORT}", flush=True)
    server.serve_forever()
