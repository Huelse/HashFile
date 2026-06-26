#!/usr/bin/env python3
"""HashFile web server — serves static UI and /api/hash endpoint."""

import os
import json
import socket
import sqlite3
import subprocess
import threading
import socketserver
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get("service_port", 17743))
WWW_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www")
DATA_DIR = os.environ.get("DATA_DIR") or "/var/apps/HashFile/shares/HashFile"
DB_PATH  = os.path.join(DATA_DIR, "data.db")

# fnOS 统一网关：网关会把匹配 GATEWAY_PREFIX 的请求转发到 SOCKET_PATH，
# 转发前完成登录态校验，并注入 X-Trim-* 身份头（X-Trim-Userid 等）。
GATEWAY_PREFIX = "/app/HashFile"
SOCKET_PATH = os.environ.get("GATEWAY_SOCKET") or (
    os.path.join(os.environ["TRIM_APPDEST"], "app.sock")
    if os.environ.get("TRIM_APPDEST") else None
)

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
                uid        TEXT    NOT NULL DEFAULT '',
                path       TEXT    NOT NULL,
                algo       TEXT    NOT NULL,
                hash       TEXT,
                created_at TEXT    NOT NULL
            )
        """)
        # 兼容旧库：补充 uid 列
        cols = [r[1] for r in conn.execute("PRAGMA table_info(hash_history)")]
        if "uid" not in cols:
            conn.execute("ALTER TABLE hash_history ADD COLUMN uid TEXT NOT NULL DEFAULT ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_uid ON hash_history(uid)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_path ON hash_history(path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_hash ON hash_history(hash)")


def _save_history(results, uid):
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _db_lock:
        with sqlite3.connect(DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO hash_history (uid, path, algo, hash, created_at) VALUES (?,?,?,?,?)",
                [(uid, r["file"], r["algo"], r.get("hash"), created_at) for r in results]
            )


PER_PAGE = 20

def _list_history(uid, q=None, page=1):
    offset = (page - 1) * PER_PAGE
    where = "uid = ?"
    args = [uid]
    if q:
        pattern = f"%{q}%"
        where += " AND (path LIKE ? OR hash LIKE ?)"
        args += [pattern, pattern]
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, path, algo, hash, created_at FROM hash_history"
            f" WHERE {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            (*args, PER_PAGE, offset)
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM hash_history WHERE {where}", args
        ).fetchone()[0]
    return [dict(r) for r in rows], total


def _delete_history(entry_id, uid):
    with _db_lock:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM hash_history WHERE id = ? AND uid = ?", (entry_id, uid))


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

    def _uid(self):
        # 身份只信任统一网关注入的 X-Trim-Userid，绝不使用客户端自带的 ID。
        return (self.headers.get("X-Trim-Userid") or "").strip()

    def _normalize_path(self):
        """剥离网关前缀，使经网关（/app/HashFile/...）与直连端口（/...）路由一致。
        返回 True 表示已发送重定向，调用方应直接返回。"""
        parsed = urlparse(self.path)
        p = parsed.path
        if p == GATEWAY_PREFIX:
            # 补尾部斜杠，确保页面内相对路径（app.js / api/*）在前缀下正确解析
            location = GATEWAY_PREFIX + "/" + (("?" + parsed.query) if parsed.query else "")
            self.send_response(301)
            self.send_header("Location", location)
            self.end_headers()
            return True
        if p == GATEWAY_PREFIX + "/" or p.startswith(GATEWAY_PREFIX + "/"):
            rest = p[len(GATEWAY_PREFIX):] or "/"
            self.path = rest + (("?" + parsed.query) if parsed.query else "")
        return False

    def do_GET(self):
        if self._normalize_path():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/hash":
            self._handle_api(parsed)
        elif parsed.path == "/api/history":
            self._handle_history_list(parsed)
        else:
            super().do_GET()

    def do_DELETE(self):
        if self._normalize_path():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/history":
            qs = parse_qs(parsed.query)
            raw_id = qs.get("id", [None])[0]
            if not raw_id:
                return self._json({"success": False, "error": "id required"}, 400)
            try:
                _delete_history(int(raw_id), self._uid())
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
                _save_history(results, self._uid())
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
            entries, total = _list_history(self._uid(), q, page)
            pages = max(1, (total + PER_PAGE - 1) // PER_PAGE)
            self._json({"success": True, "entries": entries,
                        "total": total, "page": page, "pages": pages})
        except Exception as exc:
            self._json({"success": False, "error": str(exc)}, 500)

    def log_message(self, fmt, *args):
        pass  # quiet — errors only


class ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """监听 Unix Socket 的 HTTP 服务，供 fnOS 统一网关转发请求。"""
    address_family = socket.AF_UNIX
    daemon_threads = True

    def server_bind(self):
        try:
            os.unlink(self.server_address)
        except OSError:
            pass
        # 跳过 HTTPServer.server_bind 里基于 host/port 的 getfqdn（对 AF_UNIX 无意义）
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = 0
        try:
            os.chmod(self.server_address, 0o660)
        except OSError:
            pass


if __name__ == "__main__":
    _init_db()

    if SOCKET_PATH:
        try:
            os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
            usock = ThreadingUnixHTTPServer(SOCKET_PATH, HashHandler)
            threading.Thread(target=usock.serve_forever, daemon=True).start()
            print(f"HashFile gateway socket at {SOCKET_PATH}", flush=True)
        except Exception as exc:
            print(f"HashFile: failed to bind gateway socket {SOCKET_PATH}: {exc}", flush=True)

    server = ThreadingHTTPServer(("", PORT), HashHandler)
    print(f"HashFile listening on :{PORT}", flush=True)
    server.serve_forever()
