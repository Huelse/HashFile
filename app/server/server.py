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
import traceback
import http.client
import concurrent.futures
from contextlib import closing
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, SimpleHTTPRequestHandler

_SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
WWW_DIR  = os.path.join(_SERVER_DIR, "..", "www")
DATA_DIR = os.environ.get("DATA_DIR") or "/var/apps/HashFile/shares/HashFile"
DB_PATH  = os.path.join(DATA_DIR, "data.db")

# fnOS 统一网关：网关会把匹配 GATEWAY_PREFIX 的请求转发到 SOCKET_PATH，
# 转发前完成登录态校验，并注入 X-Trim-* 身份头（X-Trim-Userid 等）。
GATEWAY_PREFIX = "/app/HashFile"
SOCKET_PATH = os.environ.get("GATEWAY_SOCKET") or (
    os.path.join(os.environ["TRIM_APPDEST"], "app.sock")
    if os.environ.get("TRIM_APPDEST") else None
)

# fnOS 开放平台后端 API（api-scope）：只能由应用服务端经这个 Unix Socket 调用，
# 凭 TRIM_API_TOKEN 鉴权。目前用到 trim.file.convertPath（把 /vol1/... 内部路径
# 转成给用户看的语义化路径）与用户授权目录的查询/删除。任何一步失败都降级：
# 路径原样显示、授权目录入口不出现，哈希主功能不受影响。
APISCOPE_SOCKET = os.environ.get("APISCOPE_SOCKET") or "/var/run/trim_open_gateway_apiscope.socket"
APISCOPE_PATH   = "/api/v1/trimapp"
APP_NAME        = "HashFile"
CONVERT_MAX     = 200   # 单次 convertPath 的路径条数上限

# 面向用户的固定文案：三处（顶层目录、子目录、单文件）必须一致，故提取为常量
NO_PERMISSION = "无读取权限，请先至应用设置内添加文件夹读取权限"

# 前四项委托给系统 coreutils 的 *sum 命令（PATH 查找）；
# blake3 无对应系统命令，故打包静态 b3sum 二进制并以绝对路径引用，
# 这样 compute_hashes 无需区分命令式/绝对路径，二者对 Popen 等价。
ALGO_CMDS = {
    "sha256": "sha256sum",
    "md5":    "md5sum",
    "sha1":   "sha1sum",
    "sha512": "sha512sum",
    "blake3": os.path.join(_SERVER_DIR, "bin", "b3sum"),
}

# 单任务内的并行度：留 1 核给系统/Web 服务。*sum 为外部子进程，
# 线程池只是阻塞等待其 I/O，GIL 不影响子进程本身的 CPU 并行。
_MAX_WORKERS = max(1, (os.cpu_count() or 2) - 1)

_db_lock = threading.Lock()


_write_conn = None   # 写连接：全局唯一，所有写入都在 _db_lock 下串行走它


def _execute_write(sql, params):
    """在共享写连接上执行一条写语句。调用方必须已持有 _db_lock。

    连接是复用的（每次新建的开销在逐条落库的热路径上压过哈希本身），
    但复用意味着连接一旦坏掉就会一直坏下去——早先每次新建反而自带自愈。
    因此出错时丢弃连接并重试一次，把这个性质补回来。
    """
    global _write_conn
    for attempt in (1, 2):
        try:
            if _write_conn is None:
                # 写入发生在任务线程里，故 check_same_thread=False；
                # 并发安全由 _db_lock 保证（所有写入点都在锁内）
                _write_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            with _write_conn:
                _write_conn.execute(sql, params)
            return
        except sqlite3.Error:
            try:
                if _write_conn is not None:
                    _write_conn.close()
            except sqlite3.Error:
                pass
            _write_conn = None
            if attempt == 2:
                raise


def _init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    # sqlite3 连接自身的上下文管理器只提交/回滚事务，不会关闭连接，
    # 因此一律用 closing() 包一层，避免每次请求泄漏一个连接。
    with closing(sqlite3.connect(DB_PATH)) as conn, conn:
        conn.execute("PRAGMA encoding = 'UTF-8'")
        # WAL：历史是逐条落库的（compute_hashes 每算完一项写一行），默认的
        # 回滚日志下每行都要 fsync，递归大目录时这会成为整条流水线的瓶颈，
        # 且读连接会被写事务阻塞。WAL 是持久属性，设一次即可。
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS hash_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                uid        TEXT    NOT NULL,
                path       TEXT    NOT NULL,
                algo       TEXT    NOT NULL,
                hash       TEXT,
                elapsed_ms INTEGER,
                created_at TEXT    NOT NULL
            )
        """)
        # 兼容旧库：补充 elapsed_ms 列（旧数据为 NULL，前端显示为 —）
        cols = [r[1] for r in conn.execute("PRAGMA table_info(hash_history)")]
        if "elapsed_ms" not in cols:
            conn.execute("ALTER TABLE hash_history ADD COLUMN elapsed_ms INTEGER")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_uid ON hash_history(uid)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_path ON hash_history(path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_hh_hash ON hash_history(hash)")


def _save_history_one(entry, uid):
    """逐条写入历史：流式计算中每完成一项即落库，避免任务被取消或网关中断时
    已算出的结果丢失。hash_history 表 algo 为自由 TEXT，成功与错误（hash=None）均写入。"""
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # 复用同一条写连接：这里是热路径（每个 (文件, 算法) 一次），
    # 每次新建连接意味着一轮 open+commit+close，大目录下开销压过哈希本身
    with _db_lock:
        _execute_write(
            "INSERT INTO hash_history (uid, path, algo, hash, elapsed_ms, created_at) VALUES (?,?,?,?,?,?)",
            (uid, entry["file"], entry["algo"], entry.get("hash"), entry.get("elapsed_ms"), created_at)
        )


PER_PAGE = 20

def _list_history(uid, q=None, page=1, dup=False):
    offset = (page - 1) * PER_PAGE
    where = "uid = ?"
    args = [uid]
    if dup:
        # 仅保留出现次数 > 1 的 hash（相同文件），hash 为 NULL 的错误行排除
        where += " AND hash IS NOT NULL AND hash IN (SELECT hash FROM hash_history WHERE uid = ? AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*) > 1)"
        args.append(uid)
    if q:
        pattern = f"%{q}%"
        where += " AND (path LIKE ? OR hash LIKE ?)"
        args += [pattern, pattern]
    order = "hash, id DESC" if dup else "id DESC"
    with closing(sqlite3.connect(DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, path, algo, hash, elapsed_ms, created_at FROM hash_history"
            f" WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            (*args, PER_PAGE, offset)
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM hash_history WHERE {where}", args
        ).fetchone()[0]
    return [dict(r) for r in rows], total


def _delete_history(entry_id, uid):
    with _db_lock:
        _execute_write("DELETE FROM hash_history WHERE id = ? AND uid = ?", (entry_id, uid))


def _int_param(qs, name, default):
    """取整型查询参数：缺失或非数字时回退到 default。
    直接 int() 会让非法输入在处理线程里抛 ValueError，客户端只能看到连接被重置。"""
    try:
        return int(qs.get(name, [""])[0])
    except (TypeError, ValueError):
        return default


# ── 异步哈希任务 ──────────────────────────────────────────────
# 统一网关对代理请求有约 5 分钟的固定超时（应用端不可配置），大文件的
# 同步计算会被网关以 504 掐断。因此 /api/hash 只提交任务并立即返回
# task id，由后台线程计算，前端轮询 /api/hash/status 获取进度与结果。
_tasks = {}
_tasks_lock = threading.Lock()
TASK_TTL = 3600  # 已结束任务保留 1 小时，供前端（含刷新后）取结果
# 未结束任务的硬上限：timeout=0（前端「无限制」）时子进程可以永久阻塞，
# 这类任务 finished_at 永远是 None，只按 TASK_TTL 回收的话会永远留在内存里
TASK_MAX_AGE = 24 * 3600
# 每个用户同时进行的任务数上限。每个任务 = 1 个线程 + 1 个 _MAX_WORKERS 线程池，
# 不设限的话连点几次就能把机器上的 *sum 子进程数乘上去
MAX_TASKS_PER_UID = 3
# 单次 status 响应最多返回的结果条数，配合 since 把响应体钉死为常量大小
STATUS_CHUNK = 500


def _kill_task_procs(task):
    """杀掉任务当前在跑的所有哈希子进程。取消与超龄回收共用。"""
    procs = task["procs"]
    if not procs:
        return
    with task["procs_lock"]:
        for proc in list(procs):
            try:
                proc.kill()
            except Exception:
                pass


def _purge_tasks():
    now = time.time()
    with _tasks_lock:
        stale = []
        for tid, t in _tasks.items():
            if t["finished_at"]:
                if now - t["finished_at"] > TASK_TTL:
                    stale.append(tid)
            elif now - t["created_at"] > TASK_MAX_AGE:
                # 卡死的任务：先标记取消并杀子进程，工作线程才能退出，
                # 否则删掉字典项也只是让它变成无人认领的常驻线程
                t["cancelled"] = True
                _kill_task_procs(t)
                stale.append(tid)
        for tid in stale:
            del _tasks[tid]


def _run_hash_task(task, path, algos, recursive, expected, sub_timeout):
    try:
        results = compute_hashes(path, algos, recursive, expected, sub_timeout, task)
        # 历史记录已在 compute_hashes 中逐条即时落库，此处无需再批量写入
        task["results"] = results
        task["status"] = "cancelled" if task["cancelled"] else "done"
    except Exception as exc:
        task["error"] = str(exc)
        task["status"] = "error"
    finally:
        task["procs"] = None
        task["finished_at"] = time.time()


def compute_hashes(path, algos, recursive, expected, sub_timeout=None, task=None):

    files = []
    walk_errors = []  # 收集 os.walk 遇到的子目录 PermissionError.filename
    if os.path.isfile(path):
        files = [path]
    elif os.path.isdir(path):
        # 顶层目录预检读权限：不可读时直接给出可操作提示，避免 os.walk/listdir
        # 静默吞错（walk 默认 onerror=None）或抛 raw PermissionError
        if not os.access(path, os.R_OK):
            raise PermissionError(NO_PERMISSION)
        if recursive:
            def _on_walk_error(err):
                # os.walk 默认会静默吞掉 scandir 抛出的 OSError，必须显式收集
                if isinstance(err, PermissionError):
                    walk_errors.append(err.filename)
            for root, dirs, names in os.walk(path, onerror=_on_walk_error):
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
        # walk_errors 会在循环前作为 error 行预填入 results，每条计为 1
        task["total"] = len(files) * len(algos) + len(walk_errors)

    results = []
    # 子目录无读取权限：每个失败目录追加一条 error 行，让用户看到哪些目录被跳过。
    # algo 字段填 algos[0] 只为对齐数据形状，前端 flattenState() 按 ALGO_ORDER 过滤。
    if walk_errors:
        first_algo = algos[0]
        for d in walk_errors:
            results.append({"file": d, "algo": first_algo, "hash": None,
                            "error": NO_PERMISSION})
        if task is not None:
            task["done"] = len(results)
            task["results"] = results  # 预填的 error 行也即时可见
            for r in results:
                _save_history_one(r, task["uid"])

    # 并行计算：把 (file, algo) 展平为工作单元，用线程池并发执行 *sum 子进程。
    # append/done/发布/落库全在主线程的 as_completed 循环里，worker 只返回 entry，
    # 天然无竞态。*sum 为外部子进程，线程只是阻塞等待其 I/O，GIL 不影响并行。
    jobs = [(f, a) for f in files for a in algos if ALGO_CMDS.get(a)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        future_map = {pool.submit(_hash_one, f, a, expected, sub_timeout, task): (f, a)
                      for f, a in jobs}
        for fut in concurrent.futures.as_completed(future_map):
            if task is not None and task["cancelled"]:
                for x in future_map:  # 取消尚未开始的 future，已完成的仍收集
                    x.cancel()
                break
            entry = fut.result()
            if entry is None:  # worker 检测到 cancelled，跳过
                continue
            results.append(entry)
            if task is not None:
                task["done"] = len(results)
                # 每完成一项即发布，运行中的轮询可拿到已完成部分供前端实时渲染
                task["results"] = results
                # 即时落库：即便后续任务被取消或网关中断，已算出的结果也已持久化
                _save_history_one(entry, task["uid"])

    return results


def _hash_one(f, a, expected, sub_timeout, task):
    """计算单个 (file, algo) 的哈希，供线程池并行调用。
    返回 entry dict；若任务已取消则返回 None。"""
    if task is not None and task["cancelled"]:
        return None
    cmd = ALGO_CMDS.get(a)
    hash_val = None
    err = None
    elapsed_ms = None  # 仅实际执行子进程时计时；权限不足等行无耗时
    ran = False        # 子进程是否真的跑起来过，决定要不要记耗时
    # 先用 os.access 预检读权限：不可读时直接给出可操作提示，
    # 不再依赖子进程 stderr 文本（受 locale 影响）
    if not os.access(f, os.R_OK):
        err = NO_PERMISSION
    else:
        _t0 = time.perf_counter()
        try:
            # 用 Popen 而非 subprocess.run：把进程句柄注册到任务的进程集合，
            # 取消时可 kill 全部正在计算的子进程
            # errors="replace"：文件名或 stderr 含当前 locale 解不出的字节时，
            # 默认的严格解码会在 communicate() 里抛 UnicodeDecodeError——它不在
            # 下面的捕获范围内，会一路穿过 fut.result() 把整个任务打成 error。
            proc = subprocess.Popen(
                [cmd, "--", f],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, errors="replace"
            )
            ran = True
            if task is not None:
                with task["procs_lock"]:
                    # 发布句柄后重查取消标志，堵住取消落在 Popen 与注册之间
                    # 的窗口：取消方看到句柄则由它 kill，否则这里自行 kill
                    if task["cancelled"]:
                        proc.kill()
                    task["procs"].add(proc)
            try:
                out, errout = proc.communicate(timeout=sub_timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise
            finally:
                if task is not None:
                    with task["procs_lock"]:
                        task["procs"].discard(proc)
            if task is not None and task["cancelled"]:
                return None
            if proc.returncode == 0:
                # 文件名含 \ 或换行时，GNU *sum（含打包的 b3sum）会转义文件名
                # 并在整行开头加一个 \ 作标记。不剥掉的话哈希值会多一个前导
                # 反斜杠，既入库也参与 expected 比对，这类文件永远校验失败。
                if out.startswith("\\"):
                    out = out[1:]
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
        except OSError as exc:
            # Popen 本身也可能失败（权限、fd 耗尽、exec 格式错误…）
            err = f"{cmd}: {exc}"
        # 实际执行过子进程即记录耗时（成功/超时/非零退出）；拉起失败则没有耗时可言
        if ran:
            elapsed_ms = int((time.perf_counter() - _t0) * 1000)

    entry = {"file": f, "algo": a, "hash": hash_val}
    if elapsed_ms is not None:
        entry["elapsed_ms"] = elapsed_ms
    if err:
        entry["error"] = err
    if expected:
        # *sum 输出小写，但用户粘贴的校验值常为大写，比对需忽略大小写；
        # expected 回显保持用户原始输入
        entry["verified"] = hash_val is not None and hash_val.lower() == expected.lower()
        entry["expected"] = expected
    return entry


class _UnixHTTPConnection(http.client.HTTPConnection):
    """http.client 不支持 Unix Socket，只需把建连换成 AF_UNIX，其余 HTTP 逻辑照旧。"""

    def __init__(self, socket_path, timeout=None):
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if self.timeout is not None:
            self.sock.settimeout(self.timeout)
        self.sock.connect(self._socket_path)


_apiscope_warned = set()
_apiscope_last = None   # 最近一次失败原因，随 convert-path 响应回前端，方便真机排障


def _apiscope_warn(msg, key=None):
    # 开放平台不可用属于可降级的场景：同一种失败只记一次，避免刷屏；
    # 但不同的失败原因要各记一条，否则真机排障时只能看到最早那条。
    # 去重用 key 而不是完整 msg：msg 里嵌了网关返回的原始片段，拿它做 key
    # 的话网关每抖一次就多一条常驻条目，集合会无界增长。
    global _apiscope_last
    _apiscope_last = msg
    key = key or msg
    if key not in _apiscope_warned:
        _apiscope_warned.add(key)
        print(f"HashFile: open-platform API unavailable ({msg}); "
              f"falling back to raw paths", flush=True)


def _trimapp_call(req, data, timeout=3):
    """调用 fnOS 开放平台后端 API，失败一律返回 None（调用方负责降级）。"""
    # token 由系统在拉起 cmd/main 时注入，且可能随重装/重新注册更新，
    # 因此每次都从当前环境读取，绝不缓存或落盘。
    token = os.environ.get("TRIM_API_TOKEN")
    if not token:
        _apiscope_warn("TRIM_API_TOKEN not set")
        return None

    body = json.dumps({
        "reqId": uuid.uuid4().hex,
        "req": req,
        "appName": APP_NAME,
        "data": data,
    }, ensure_ascii=False).encode("utf-8")

    conn = _UnixHTTPConnection(APISCOPE_SOCKET, timeout=timeout)
    try:
        conn.request("POST", APISCOPE_PATH, body=body, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Length": str(len(body)),
        })
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace")
        if resp.status != 200:
            _apiscope_warn(f"{req}: HTTP {resp.status} {raw[:200]}", f"{req}:http{resp.status}")
            return None
        payload = json.loads(raw)
        # 网关返回的结构不做任何假设：非对象一律当失败处理，
        # 免得后面 .get() 抛异常把整个请求打成 502。
        if not isinstance(payload, dict):
            _apiscope_warn(f"{req}: unexpected payload {raw[:200]}", f"{req}:payload")
            return None
        if payload.get("code") != 0:
            _apiscope_warn(f"{req}: code={payload.get('code')} msg={payload.get('msg')}", f"{req}:code{payload.get('code')}")
            return None
        # data 缺席时回 {} 而不是 None，这样 None 严格只表示「调用失败」
        data = payload.get("data")
        return {} if data is None else data
    except Exception as exc:
        _apiscope_warn(f"{req}: {type(exc).__name__}: {exc}", f"{req}:{type(exc).__name__}")
        return None
    finally:
        conn.close()


def _convert_paths(paths, language):
    """/vol1/... → 语义化路径。返回 {原路径: 语义路径}；无法转换的键直接缺席。"""
    data = _trimapp_call("trim.file.convertPath", {"path": paths, "language": language})
    if isinstance(data, str):
        # 有的网关实现会把 data 再包一层 JSON 字符串，容错解一次
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    # 实测网关直接回结果数组，文档写的是 {status, result}，两种都认
    if isinstance(data, dict):
        if data.get("status") not in (0, None):
            _apiscope_warn(f"convertPath: status={data.get('status')}", "convertPath:status")
            return None
        items = data.get("result")
    else:
        items = data
    if not isinstance(items, list):
        if data is not None:
            _apiscope_warn(f"convertPath: unexpected data {str(data)[:200]}", "convertPath:data")
        return None
    out = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        src, sem = item.get("path"), item.get("semanticPath")
        if src and sem:
            out[src] = sem
    return out


def _pluck_paths(data):
    """从网关返回里挖出路径列表；形状对不上返回 None。
    文档写的是 {"paths": ["/vol1/..."]}，但 convertPath 已经证明实际形状可能与
    文档不符，故对「裸数组」「换了字段名」「元素是对象」都做容错。"""
    items = data
    if isinstance(data, dict):
        items = data.get("paths")
        if items is None:   # 字段名对不上时退而求其次：取第一个列表值
            items = next((v for v in data.values() if isinstance(v, list)), None)
        if items is None:
            return []       # 一条授权都没有
    if not isinstance(items, list):
        return None
    out = []
    for it in items:
        if isinstance(it, str):
            out.append(it)
        elif isinstance(it, dict):
            v = it.get("path") or it.get("folder") or it.get("dir") or it.get("name")
            if isinstance(v, str):
                out.append(v)
    return out


def _user_folders(uid):
    """查询该用户授权给本应用的目录。返回 (paths|None, 原始 data)。
    注意只包含目录授权，pickUserFile 选中的单个文件不会出现在这里。"""
    data = _trimapp_call("trim.file.getUserAccessibleFolders", {"uid": uid})
    if data is None:
        return None, None
    paths = _pluck_paths(data)
    if paths is None:
        _apiscope_warn(f"getUserAccessibleFolders: unexpected data {str(data)[:300]}", "folders:data")
        return None, data
    if not paths and data not in ({}, [], None):
        # 有内容却一条都没挖出来，说明字段名又变了：把原始形状记进日志便于对齐
        _apiscope_warn(f"getUserAccessibleFolders: no path found in {str(data)[:300]}", "folders:nopath")
    return paths, data


def _del_user_folder(uid, path):
    """删除该用户的一条目录授权。"""
    # _trimapp_call 已经把 code≠0 当失败挡掉，这里只在网关明确说了 suc:false 时才判失败
    # ——data 的具体形状不敢假设（convertPath 就与文档不符）。
    data = _trimapp_call("trim.file.delUserAccessibleFolder", {"uid": uid, "path": path})
    if data is None:
        return False
    if isinstance(data, dict) and data.get("suc") is False:
        _apiscope_warn(f"delUserAccessibleFolder: not deleted {str(data)[:200]}", "delFolder:notdeleted")
        return False
    return True


class HashHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WWW_DIR, **kwargs)

    def _uid(self):
        # 身份只信任统一网关注入的 X-Trim-Userid，绝不使用客户端自带的 ID。
        return (self.headers.get("X-Trim-Userid") or "").strip()

    def _uid_int(self):
        # 开放平台的 uid 是数字；拿不到身份（如本地直连调试）时返回 None
        try:
            return int(self._uid())
        except ValueError:
            return None

    def end_headers(self):
        # 静态文件默认无 Cache-Control，浏览器启发式缓存会导致更新包后仍用旧前端
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_response(self, *args, **kwargs):
        # 记一个「已应答」标记，_guard 据此决定还能不能再补一个 500
        self._responded = True
        super().send_response(*args, **kwargs)

    def _guard(self, fn):
        """未捕获异常会让 socketserver 直接断开连接，统一网关只能报 502，
        既没有响应体也没有堆栈可查。这里兜住：堆栈进 info.log，客户端拿 500。"""
        try:
            fn()
        except Exception:
            traceback.print_exc()
            if not getattr(self, "_responded", False):
                try:
                    self._json({"success": False, "error": "internal error"}, 500)
                except Exception:
                    pass

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
        self._guard(self._route_get)

    def do_DELETE(self):
        self._guard(self._route_delete)

    def do_HEAD(self):
        # 继承来的 do_HEAD 既不剥网关前缀（经网关的 HEAD 一律 404），
        # 也不过 _guard（异常直接断连，网关只能报 502），故显式接管
        self._guard(self._route_head)

    def _route_head(self):
        if self._normalize_path():
            return
        super().do_HEAD()

    def _route_get(self):
        if self._normalize_path():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/hash":
            self._handle_api(parsed)
        elif parsed.path == "/api/hash/status":
            self._handle_hash_status(parsed)
        elif parsed.path == "/api/history":
            self._handle_history_list(parsed)
        elif parsed.path == "/api/convert-path":
            self._handle_convert_path(parsed)
        elif parsed.path == "/api/user-access":
            self._handle_user_access_list(parsed)
        else:
            super().do_GET()

    def _route_delete(self):
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
        elif parsed.path == "/api/user-access":
            self._handle_user_access_del(parsed)
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

        raw_timeout = _int_param(qs, "timeout", 60)
        sub_timeout = raw_timeout if raw_timeout > 0 else None

        uid = self._uid()
        task = {
            "id": uuid.uuid4().hex,
            "uid": uid,
            "path": path,
            "status": "running",
            "cancelled": False,
            "procs": set(),          # 正在运行的 *sum 子进程集合，取消时 kill 全部
            "procs_lock": threading.Lock(),
            "results": None,
            "error": None,
            "done": 0,
            "total": None,
            "created_at": time.time(),
            "finished_at": None,
        }
        _purge_tasks()   # 先回收，免得早已结束的任务占着配额
        with _tasks_lock:
            running = sum(1 for t in _tasks.values()
                          if t["uid"] == uid and not t["finished_at"])
            if running >= MAX_TASKS_PER_UID:
                return self._json({
                    "success": False,
                    "error": f"同时进行的计算任务不能超过 {MAX_TASKS_PER_UID} 个，请等待或中止后再试",
                }, 429)
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
        # 运行中也返回已完成的 results，供前端实时渲染。results 只追加、既不重排
        # 也不删除，下标因此是稳定的：客户端用 since 报告已收到的条数，这里只回传
        # 增量。否则每轮都要重传全量，响应体和前端的合并开销都随结果数线性增长。
        # 切片同时也充当快照，避免序列化到一半时后台线程正在 append。
        results = task["results"]
        if results is not None:
            since = max(0, _int_param(parse_qs(parsed.query), "since", 0))
            chunk = results[since:since + STATUS_CHUNK]
            resp["results"] = chunk
            resp["since"] = since
            # 积压超过一个 chunk 时置 more，客户端应立即续拉而不是等下一轮退避
            resp["more"] = since + len(chunk) < len(results)
        if task["status"] in ("done", "cancelled"):
            resp["path"] = task["path"]
        elif task["status"] == "error":
            resp["error"] = task["error"]
        self._json(resp)

    def _handle_hash_cancel(self, parsed):
        task = self._get_task(parsed)
        if not task:
            return self._json({"success": False, "error": "任务不存在或已过期"}, 404)
        task["cancelled"] = True
        _kill_task_procs(task)
        self._json({"success": True})

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_convert_path(self, parsed):
        """把内部路径转成语义化展示路径。前端仅用于显示，失败即降级为原路径，
        因此任何失败都回 success:false + HTTP 200，不产生前端错误噪音。"""
        qs = parse_qs(parsed.query)
        # 去重但保序：同一批结果里重复路径很常见，没必要重复问网关
        paths = list(dict.fromkeys(p for p in qs.get("path", []) if p.strip()))[:CONVERT_MAX]
        language = qs.get("language", ["zh-CN"])[0].strip() or "zh-CN"
        if not paths:
            return self._json({"success": True, "paths": {}})
        mapping = _convert_paths(paths, language)
        if mapping is None:
            # reason 只是失败原因文本（不含 token），给真机排障用
            return self._json({"success": False, "paths": {}, "reason": _apiscope_last})
        self._json({"success": True, "paths": mapping})

    def _handle_user_access_list(self, parsed):
        """当前用户授权给本应用的目录。uid 只取自网关注入的身份头，
        前端传什么都不作数，避免越权查看别人的授权列表。"""
        uid = self._uid_int()
        if uid is None:
            return self._json({"success": False, "paths": [], "reason": "no gateway identity"})
        paths, raw = _user_folders(uid)
        # ?debug=1 回传所用 uid、网关注入的身份头和平台原样返回的结构，
        # 用来对齐真机上的实际形状（形状不符与 uid 取错，症状都是列表为空）
        extra = {}
        if parse_qs(parsed.query).get("debug"):
            extra = {"uid": uid, "raw": raw, "headers": {
                k: v for k, v in self.headers.items() if k.lower().startswith("x-trim")}}
        if paths is None:
            return self._json({"success": False, "paths": [], "reason": _apiscope_last, **extra})
        self._json({"success": True, "paths": paths, **extra})

    def _handle_user_access_del(self, parsed):
        """删除当前用户的一条目录授权。同样以网关身份为准。"""
        uid = self._uid_int()
        path = parse_qs(parsed.query).get("path", [""])[0]
        if uid is None or not path:
            return self._json({"success": False, "error": "uid/path required"}, 400)
        if not _del_user_folder(uid, path):
            return self._json({"success": False, "reason": _apiscope_last})
        self._json({"success": True})

    def _handle_history_list(self, parsed):
        qs = parse_qs(parsed.query)
        q    = qs.get("q",    [""])[0].strip() or None
        page = max(1, _int_param(qs, "page", 1))
        dup  = qs.get("dup",  [""])[0].lower() in ("1", "true")
        try:
            entries, total = _list_history(self._uid(), q, page, dup)
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
