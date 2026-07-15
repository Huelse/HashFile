#!/usr/bin/env python3
"""HashFile web server — serves static UI and /api/hash endpoint."""

import os
import json
import time
import uuid
import socket
import sqlite3
import subprocess
import threading
import socketserver
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, SimpleHTTPRequestHandler

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
                uid        TEXT    NOT NULL,
                path       TEXT    NOT NULL,
                algo       TEXT    NOT NULL,
                hash       TEXT,
                created_at TEXT    NOT NULL
            )
        """)
        # 兼容旧库：补充 uid 列
        # cols = [r[1] for r in conn.execute("PRAGMA table_info(hash_history)")]
        # if "uid" not in cols:
        #     conn.execute("ALTER TABLE hash_history ADD COLUMN uid TEXT NOT NULL DEFAULT ''")
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


# ── 异步哈希任务 ──────────────────────────────────────────────
# 统一网关对代理请求有约 5 分钟的固定超时（应用端不可配置），大文件的
# 同步计算会被网关以 504 掐断。因此 /api/hash 只提交任务并立即返回
# task id，由后台线程计算，前端轮询 /api/hash/status 获取进度与结果。
_tasks = {}
_tasks_lock = threading.Lock()
TASK_TTL = 3600  # 已结束任务保留 1 小时，供前端（含刷新后）取结果


def _purge_tasks():
    now = time.time()
    with _tasks_lock:
        stale = [tid for tid, t in _tasks.items()
                 if t["finished_at"] and now - t["finished_at"] > TASK_TTL]
        for tid in stale:
            del _tasks[tid]


def _run_hash_task(task, path, algos, recursive, expected, sub_timeout):
    try:
        results = compute_hashes(path, algos, recursive, expected, sub_timeout, task)
        try:
            if results:
                _save_history(results, task["uid"])
        except Exception:
            pass
        task["results"] = results
        task["status"] = "cancelled" if task["cancelled"] else "done"
    except Exception as exc:
        task["error"] = str(exc)
        task["status"] = "error"
    finally:
        task["proc"] = None
        task["finished_at"] = time.time()


def compute_hashes(path, algos, recursive, expected, sub_timeout=None, task=None):

    files = []
    if os.path.isfile(path):
        files = [path]
    elif os.path.isdir(path):
        if recursive:
            for root, dirs, names in os.walk(path):
                if task is not None and task["cancelled"]:
                    return []
                dirs.sort()
                for name in sorted(names):
                    files.append(os.path.join(root, name))
        else:
            files = sorted(
                os.path.join(path, f)
                for f in os.listdir(path)
                if os.path.isfile(os.path.join(path, f))
            )

    if task is not None:
        task["total"] = len(files) * len(algos)

    results = []
    for f in files:
        for a in algos:
            if task is not None and task["cancelled"]:
                return results
            cmd = ALGO_CMDS.get(a)
            if not cmd:
                continue
            hash_val = None
            err = None
            # 先用 os.access 预检读权限：不可读时直接给出可操作提示，
            # 不再依赖子进程 stderr 文本（受 locale 影响）
            if not os.access(f, os.R_OK):
                err = "无读取权限，请先至应用设置内添加文件夹读取权限"
            else:
                try:
                    # 用 Popen 而非 subprocess.run：把进程句柄挂到任务上，
                    # 取消时可直接 kill 正在计算的子进程
                    proc = subprocess.Popen(
                        [cmd, "--", f],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
                    )
                    if task is not None:
                        task["proc"] = proc
                        # 发布句柄后重查取消标志，堵住取消落在 Popen 与句柄
                        # 发布之间的窗口：取消方看到句柄则由它 kill，否则这里自行 kill
                        if task["cancelled"]:
                            proc.kill()
                    try:
                        out, errout = proc.communicate(timeout=sub_timeout)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.communicate()
                        raise
                    finally:
                        if task is not None:
                            task["proc"] = None
                    if task is not None and task["cancelled"]:
                        return results
                    if proc.returncode == 0:
                        parts = out.split()
                        if parts:
                            hash_val = parts[0]
                        else:
                            err = f"{cmd} produced no output"
                    else:
                        err = errout.strip() or "hash command failed"
                except subprocess.TimeoutExpired:
                    err = f"{cmd} timed out after {sub_timeout}s"
                except FileNotFoundError:
                    err = f"command not found: {cmd}"

            entry = {"file": f, "algo": a, "hash": hash_val}
            if err:
                entry["error"] = err
            if expected:
                entry["verified"] = (hash_val == expected)
                entry["expected"] = expected
            results.append(entry)
            if task is not None:
                task["done"] = len(results)

    return results


class HashHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW_DIR, **kwargs)

    def _uid(self):
        # 身份只信任统一网关注入的 X-Trim-Userid，绝不使用客户端自带的 ID。
        return (self.headers.get("X-Trim-Userid") or "").strip()

    def end_headers(self):
        # 静态文件默认无 Cache-Control，浏览器启发式缓存会导致更新包后仍用旧前端
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

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
        elif parsed.path == "/api/hash/status":
            self._handle_hash_status(parsed)
        elif parsed.path == "/api/history":
            self._handle_history_list(parsed)
        else:
            super().do_GET()

    def do_DELETE(self):
        if self._normalize_path():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/hash":
            self._handle_hash_cancel(parsed)
        elif parsed.path == "/api/history":
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

        task = {
            "id": uuid.uuid4().hex,
            "uid": self._uid(),
            "path": path,
            "status": "running",
            "cancelled": False,
            "proc": None,
            "results": None,
            "error": None,
            "done": 0,
            "total": None,
            "finished_at": None,
        }
        _purge_tasks()
        with _tasks_lock:
            _tasks[task["id"]] = task
        threading.Thread(
            target=_run_hash_task,
            args=(task, path, algos, recursive, expected, sub_timeout),
            daemon=True,
        ).start()
        self._json({"success": True, "task": task["id"]}, 202)

    def _get_task(self, parsed):
        """按 id 取任务；不存在或不属于当前 uid 时返回 None（不泄露他人任务）。"""
        tid = parse_qs(parsed.query).get("id", [""])[0]
        with _tasks_lock:
            task = _tasks.get(tid)
        if not task or task["uid"] != self._uid():
            return None
        return task

    def _handle_hash_status(self, parsed):
        _purge_tasks()  # 长期无新提交时也能回收过期任务占用的内存
        task = self._get_task(parsed)
        if not task:
            return self._json({"success": False, "error": "任务不存在或已过期"}, 404)
        resp = {"success": True, "status": task["status"],
                "done": task["done"], "total": task["total"]}
        if task["status"] in ("done", "cancelled"):
            resp["path"] = task["path"]
            resp["results"] = task["results"]
        elif task["status"] == "error":
            resp["error"] = task["error"]
        self._json(resp)

    def _handle_hash_cancel(self, parsed):
        task = self._get_task(parsed)
        if not task:
            return self._json({"success": False, "error": "任务不存在或已过期"}, 404)
        task["cancelled"] = True
        proc = task["proc"]
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        self._json({"success": True})

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
    if not SOCKET_PATH:
        print(
            "HashFile: SOCKET_PATH not configured. "
            "Set GATEWAY_SOCKET or TRIM_APPDEST environment variable.",
            flush=True,
        )
        raise SystemExit(1)

    _init_db()

    socket_dir = os.path.dirname(SOCKET_PATH)
    if socket_dir:
        os.makedirs(socket_dir, exist_ok=True)

    server = ThreadingUnixHTTPServer(SOCKET_PATH, HashHandler)
    print(f"HashFile gateway socket at {SOCKET_PATH}", flush=True)
    server.serve_forever()
