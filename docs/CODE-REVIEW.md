# HashFile 代码审查报告

审查对象：`feature/open-platform` @ `d9e5d6d`（v2.0.0，相对 `main` 领先 12 个提交）
审查范围：全仓库源码 —— `server.py`(778) / `app.js`(944) / `hashcli`(191) /
`index.html`(177) / `style.css`(650) / `manifest` / `config/*` / `cmd/*` /
`wizard/*`。`app/www/vendor/trim-web-app.js` 为第三方原文，不在审查范围。
日期：2026-08-15

---

## 0. 总评

**架构判断是对的。** 几个关键决策都经得起推敲，而且——少见地——注释把 *why* 写清楚了：

- 异步任务 + 轮询，绕开统一网关约 5 分钟的固定代理超时；
- 结果增量下发（`since` 游标）+ 前端二分插入的增量渲染，把单轮开销从
  O(总行数) 压到 O(新增数)；
- `_guard()` 兜住所有未捕获异常，避免 socketserver 断连导致网关只报 502、
  连堆栈都拿不到；
- 对网关返回结构"不作任何假设"的多形状容错（`convertPath` 实测形状与文档不符），
  以及开放平台不可用时**整条链路静默降级**、主功能不受影响。

问题不在架构，集中在三类：

| 类别 | 性质 |
|---|---|
| **文件名边缘情况** | 已复现：合法文件名会让哈希值被静默写坏、JSON 非法、字段整体错位 |
| **资源无上限** | 任务数、任务寿命、日志、历史表都没有任何封顶 |
| **文档与代码脱节** | `CLAUDE.md` 有 5 处可当场证伪，含一条"照着抄跑不起来"的本地运行命令 |

本次动手修掉了 P0/P1（第 1、2 节，共 15 项），P2/P3 只记录（第 3 节）。

---

## 1. P0 — 哈希值正确性 ✅ 已修

这一组的共同点：**输入是完全合法的文件名，输出是错的，而且没有任何报错。**

### 1.1 文件名含 `\` 或换行 → 哈希值多一个前导反斜杠

`server.py:291-293`、`hashcli:91`

GNU `*sum`（以及打包的 `b3sum`）在文件名含 `\` 或换行时，会转义文件名并给**整行**加 `\` 前缀：

```console
$ sha256sum -- 'back\slash.txt'
\2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  back\\slash.txt
```

两处都用 `out.split()[0]` / `${out%% *}` 取首字段，于是拿到 65 字符的 `\2d7116…`。
这个值会**入库**、上结果表、并参与 `expected` 比对 —— 这类文件的校验必然 FAIL，
且界面上看不出任何异常（哈希列就是长这样）。

**改法**：解析前判断行首是否为 `\`，是则剥掉。两处对齐。

### 1.2 `hashcli -j` 在路径含 `"` 时输出非法 JSON

`hashcli:43,105`（原 `printf` 手拼 JSON）

```console
$ hashcli -j -a sha256 'no"such"file'
{"success":false,"error":"Path not found: no"such"file"}   ← JSONDecodeError
```

`printf '{"...%s..."}' "$TARGET"` 不做任何转义，路径里的 `"` / `\` / 换行都能破坏输出。

**改法**：新增 `json_error()`，错误分支也交给 `python3 -c` 的 `json.dumps`。
`hashcli` 原本就有两套 JSON 输出路径（手拼 + python 序列化），现在统一到后者。

### 1.3 文件名含 TAB → `hashcli -j` 整条记录字段错位

`hashcli:139-167`（原 TSV 管道）

原实现用 TAB 分隔字段、换行分隔记录，只对 `HASH_ERR` 做了换行/制表符压缩（`:88`），
**`$file` 没有**。文件名里的 TAB 完全合法，于是：

```json
{ "file": "./tab", "algo": "here.txt", "hash": "sha256",
  "verified": false, "expected": "a1fce4363854ff…" }
```

`tab\there.txt` 把每一列推移一位，`algo` 变成文件名残片、`hash` 变成算法名，
还凭空造出一个 `expected` 和一个 `verified: false`。
文件名含**换行**时更糟：字段数不足 5，python 侧 `continue` 静默丢弃该文件，
而整体仍报 `"success": true`。

**改法**：字段分隔符改为 NUL（路径里唯一不可能出现的字节），python 侧按 5 个一组切。

### 1.4 `hashcli` 把 stderr 并进 stdout

`hashcli:83` —— `out=$("$cmd" -- "$file" 2>&1)`

命令**成功**但向 stderr 打了 warning 时，warning 会排在摘要行前面，被"取首字段"当成哈希值。
`server.py:267-270` 用的是分离的 PIPE，两边行为不一致。

**改法**：stderr 重定向到一个复用的临时文件（每文件新建临时文件在大目录下开销可观）。

### 1.5 软链目录：CLI 与服务端结论完全相反

`hashcli:120-125` vs `server.py:187-203`

`find "$TARGET"` 不加 `-H`/`-L` **不会**进入软链目录；`os.walk` 会。同一输入：

```console
$ hashcli -r -a sha256 link     →  No files found.        (exit 0)
$ os.walk('link')               →  ['link/f.txt']         (会被计算)
```

CLI 报告成功、退出码 0，却一个文件都没算。
`CLAUDE.md` 原文"逻辑与 server.py 一致"在这里不成立。

**改法**：`find -H "$TARGET"` —— 只对命令行上的顶层目标解引用。
**不能**用 `-L`：那会跟随树内所有软链，反而与 `os.walk` 默认的
`followlinks=False` 相悖（并有软链环的风险）。

---

## 2. P1 — 资源、健壮性、生命周期 ✅ 已修

### 2.1 `timeout=0` 的任务永远不会被回收

`server.py:598-599` × `153-159`

前端「无限制」选项传 `timeout=0` → `sub_timeout=None` → `communicate(timeout=None)`
可以永久阻塞。这类任务的 `finished_at` 永远是 `None`，而 `_purge_tasks` 的条件是
`if t["finished_at"] and now - t["finished_at"] > TASK_TTL` —— 永远不成立。
任务字典项、工作线程、线程池、整个 `results` 列表全部常驻，直到进程重启。

**改法**：任务加 `created_at`；`_purge_tasks` 对未结束且超过 `TASK_MAX_AGE`(24h) 的任务
先置 `cancelled` 并 kill 其子进程（否则删掉字典项只是让线程变成无人认领的常驻线程），
再移除。取消与超龄回收共用新的 `_kill_task_procs()`。

### 2.2 并发任务数没有上限

`server.py:601-622`

每次 `POST /api/hash` 起 1 个线程 + 1 个 `ThreadPoolExecutor(_MAX_WORKERS)`（`:227`）。
同一个已登录用户连点 N 次，就是 N×(核数−1) 个 `*sum` 子进程，没有任何闸门。

**改法**：提交前统计该 uid 未结束的任务数，达到 `MAX_TASKS_PER_UID`(3) 返回 **429**。
前端已有 `data.error` 的展示路径（`app.js:118`），无需改前端。

实测：

```
#1..#3  {"success": true,  "task": "..."}
#4,#5   {"success": false, "error": "同时进行的计算任务不能超过 3 个，请等待或中止后再试"}
其它 uid {"success": true, "task": "..."}      ← 配额按 uid 独立
```

### 2.3 历史落库每行新建一条 SQLite 连接

`server.py:87-96`，热路径 `:244` 调用

`_save_history_one` 原本每行 `sqlite3.connect` + 事务 + 关闭，且整段在全局 `_db_lock` 内，
串行化了所有用户的所有任务。递归一个万级目录 × 5 种算法 = 5 万轮 open/commit/close，
直接抵消掉 `_MAX_WORKERS` 的并行收益。库也没开 WAL，默认回滚日志下每行一次 fsync。

**改法**：写入统一走新的 `_execute_write()` —— 全局复用一条连接
（`check_same_thread=False`，并发安全仍由 `_db_lock` 保证），
`_init_db` 里设 `journal_mode=WAL` + `synchronous=NORMAL`。
读连接维持每请求新建 + `closing()`。

复用连接有个代价：**坏了就会一直坏**，而"每次新建"反而自带自愈。
因此 `_execute_write` 在 `sqlite3.Error` 时丢弃连接并重试一次，把这个性质补回来
（已用"写入 → 强制关闭连接 → 再写入"验证过能恢复）。

实测（5000 行）：

| | 耗时 | 吞吐 |
|---|---|---|
| 改前：每行一条连接 + 回滚日志 | 9.82 s | 509 行/s |
| 改后：复用连接 + WAL | 2.05 s | 2438 行/s |

**约 4.8×**。

### 2.4 `_apiscope_warned` 集合无界增长

`server.py:333,342-343`

去重键就是完整的告警文本，而文本里嵌了网关返回的原始片段
（`raw[:200]` / `str(data)[:300]` / 异常实例文本）。网关每抖一次、返回体每变一次，
就多一条永久驻留的条目。

**改法**：`_apiscope_warn(msg, key=None)` —— 日志仍打完整 `msg`，去重改用有限基数的
`key`（如 `f"{req}:{type(exc).__name__}"`、`"convertPath:data"`）。9 个调用点全部补上。

### 2.5 `do_HEAD` 同时绕过 `_guard` 和网关前缀剥离

`server.py:534-538`

只覆写了 `do_GET`/`do_DELETE`。继承自 `SimpleHTTPRequestHandler` 的 `do_HEAD` 既不剥
`gatewayPrefix`（经网关的 `HEAD /app/HashFile/app.js` **一律 404**），
异常也不被兜底 —— 正是 `CLAUDE.md` 里点名要避免的 502-无堆栈情形。

**改法**：显式 `do_HEAD` → `_guard(self._route_head)` → 先 `_normalize_path()` 再 `super()`。

实测：`HEAD /app/HashFile/app.js` 由 404 → **200**。

### 2.6 子进程输出解码失败会打挂整个任务

`server.py:269`

`text=True` 未指定 `errors=`。文件名或 stderr 含当前 locale 解不出的字节时，
`communicate()` 抛 `UnicodeDecodeError` —— 它不在 `:298-301` 的捕获范围内，
会穿过 `fut.result()`（`:235`）一路把**整个任务**打成 `status: "error"`，
连已经算好的其它文件也一起没了。

**改法**：`errors="replace"`；并补 `except OSError`（`Popen` 本身也可能因权限、
fd 耗尽、exec 格式错误而失败）。

顺带修掉一个连带的坏味道：原先用
`if "command not found" not in (err or "")` —— 靠**子串匹配自己刚拼出来的错误文本**
来决定记不记 `elapsed_ms`。加 `except OSError` 后这个判断会误伤，故改为显式的 `ran` 标志。

### 2.7 `cmd/main start` 从不验证进程真的起来了

`cmd/main:13-31`

后台拉起 → 写 `$!` → 无条件 `return 0`。`server.py` 若立刻退出（socket 未配置、
bind 失败、`DATA_DIR` 不可写…），fnOS 依然显示"已启动"，用户只看到一个打不开的应用。

**改法**：拉起后 `sleep 1` 复查 `check_process`，失败则记日志、删 pidfile、`return 1`；
`case` 分支改为 `start_process || exit 1`（原先返回值被吞掉）。

同一处另修两点：

- `bash -c "${CMD}"` → `bash -c "exec ${CMD}"`。原写法下 `$!` 是包装 shell 的 pid；
  bash 通常会把自己 exec 成 python，但**那是优化不是契约**，不 exec 时 `stop` 只杀到包装进程，
  真正占着 socket 的 python 被孤儿化，下次 `start` 绑不上。
- `stop_process` 原本无论 KILL 成没成都 `return 0`，与其自身注释
  "exit 1 if failed" 矛盾；且干净停止的分支只记日志、不删 pidfile。两处都已改。

实测：

```
失败路径：start exit=1、status exit=3、info.log 有 ERROR 行   （原先是 exit=0）
正常路径：start=0 → status=0 → stop=0 → status=3，pidfile 清理干净
          pidfile 指向的是 python3 本身，不是 bash 包装
```

补充：`TRIM_PKGVAR` 未设时 `LOG_FILE` 会退化成 `/info.log`，每次 `log_msg` 静默失败
而脚本照样返回 0。已加 `mkdir -p "${TRIM_PKGVAR:?...}"` 提前失败。

### 2.8 `pollTask` 失败重试可能退化为零间隔空转

`app.js:157-160` × `170`

`d.more` 时把 `delay` 置 0 以便立刻续拉分片。若紧接着那次 fetch 抛异常，
`catch` 分支直接 `continue` 而**不恢复 delay** —— 于是零间隔连打 3 次才放弃。

**改法**：`catch` 里 `delay = Math.max(delay, 1000)`。

### 2.9 `cmd/main` 与 `hashcli` 在 git 里是 0644

仓库里 `bin/b3sum` 是 0755，唯独这两个可执行脚本不是。`cmd/main` 是 fnOS 调用的
生命周期脚本，只有当宿主以 `bash cmd/main` 形式调用才能跑，直接 exec 会失败。
已 `git update-index --chmod=+x`。

### 2.10 `CLAUDE.md` 有 5 处可当场证伪

| 原文 | 实际 |
|---|---|
| 包结构列 `wizard/install`、`wizard/config` | 两个都不存在；实际只有 `wizard/uninstall`，另有 8 个未记录的 `cmd/*` 空壳钩子 |
| "默认以 `root` 运行" | `config/privilege` 实际是 `package` |
| "在 `app/ui/config` 的 `fileTypes` 中添加扩展名" | 仓库里没有配置这个键，该链路是休眠的 |
| "使用 fnOS 开发者工具构建（工具不在本仓库中）" | 属实，但未说明 LFS 二进制需先还原（见 3.7） |
| 本地运行命令 | **照抄跑不起来** |

最后一条值得单独说 —— 文档给的是：

```bash
GATEWAY_SOCKET=/tmp/hashfile.sock python3 app/server/server.py
```

实际结果：

```
PermissionError: [Errno 13] Permission denied: '/var/apps'
```

`_init_db()` 会去建 `DATA_DIR` 的默认值 `/var/apps/HashFile/shares/HashFile`，
非 root 直接失败。必须先设 `DATA_DIR`，而文档从未提过这个环境变量。

以上全部已修，并补充了本次改动引入的新契约（`TASK_MAX_AGE`、`MAX_TASKS_PER_UID`、
WAL 写连接、`do_HEAD`、`*sum` 反斜杠前缀）。`README.md` 也补了「选择文件/目录」
与「已授权目录」两个新入口 —— 它此前只写了"复制原始路径粘贴"这一种老用法。

---

## 3. P2 / P3 — 只记录，本次未改

按"改动风险 / 需要产品决策"排除在本次之外。

### 3.1 安全与隔离

**`/api/hash` 的 `path` 没有任何越权约束**（`server.py:581-589`）— **建议单独立项**

只查 `os.path.exists`：不做 `realpath`、不限制在 `DATA_DIR` 或用户授权目录内、
不做软链策略（`os.path.isfile/isdir` 跟随软链，所以授权目录里一个指向 `/etc` 的
软链文件会被照常哈希）。`_user_folders()`（`:450`）查得到授权目录，但**从未**用于鉴权。

净效果：任何能到达本应用的已登录用户，可以哈希**该进程 uid 可读的任意路径**。
在当前的 `run-as: package` 下由文件系统权限兜底，尚可接受；但这层保障完全来自
运行身份而非代码——一旦改成 `root` 运行，这就是一个"任意可读文件的哈希预言机"。

这需要产品决策（要不要把可算范围限制在授权目录内？软链怎么办？），
不适合夹带在一次代码审查里改。

其余：

- **`?debug=1` 回显全部 `X-Trim-*` 请求头**（`:707-709`）。今天这些头里没有 token，
  但这是个默认开启、无需任何开关的调试面。
- **`_apiscope_last` 是全局单值**（`:334`）却被当作 `reason` 回给前端（`:694,711,721`）。
  并发下 A 用户可能看到 B 请求的失败文本（内含网关返回片段）。
- **异常文本直接回客户端**：`:572`、`:656`、`:735` 把 `str(exc)`（含 SQLite 错误原文）
  塞进响应体。

### 3.2 服务端其它

- **错误约定不统一**：4xx + `success:false`（`:567,587,596,638,662,719`）与
  HTTP 200 + `success:false`（`:694,702,711,721`）并存。降级类接口用 200 是有意为之
  且有文档，但混合约定导致前端**根本无法统一用 `res.ok`** 判断（见 3.3）。
  `_route_delete` 的 405（`:576-577`）无响应体、无 `Allow` 头。
- **`hash_history` 无保留策略**，永久增长；无行数上限、无清理入口。
- **`dup=1` 的 `GROUP BY … HAVING` 子查询一次请求跑两遍**（`:107` 同时出现在
  行查询 `:116-120` 和 `COUNT(*)` `:121-123`）。
- **`log_message` 空实现**（`:737-738`）连带吞掉了 `log_error`（后者经前者输出），
  与 `# quiet — errors only` 的注释不符 —— 实际是 errors 也没了，
  只剩 `_guard` 里的 `traceback.print_exc()`。
- **`_responded` 置位后从不复位**（`:501`）。目前被默认的 HTTP/1.0（连接不复用）掩盖，
  一旦启用 keep-alive，同一连接上的第二个失败请求会静默断连而不是回 500。
- **未走锁的跨线程读**：`task` 的各字段（`:639-656`）在读写两侧都无锁，
  正确性依赖 CPython 的 GIL 原子性。`done`、结果分片、`more` 三者可能互不一致
  （无害，但 `:641-644` 的注释把保证说得比实际强）。
- **既非文件也非目录的路径静默返回空结果**（`:180-181`）：悬空软链、FIFO、设备文件
  会得到 `total: 0` + `status: done` + 零结果，不报错。
- **`PER_PAGE` 定义在文件中部**（`:99`），与顶部常量区脱节。
- **`created_at` 是无时区的本地时间**（`:90`）。

### 3.3 前端 `app.js`

- **非 JSON 响应完全未建模**：除 `convertPaths`（`:222`）外，所有调用点都直接
  `res.json()`。网关 502 会返回 HTML，用户看到的是
  `网络请求失败：Unexpected token '<'`。
- **`loadHistory`(`:555`) / `loadAccess`(`:405`) 缺少序列守卫**。
  `showSemantic` 有 `_semSeq`（`:250,254`）做得很对，这两个没有 ——
  快速翻页或连按回车会出现旧响应覆盖新页面，`_hPage` 与实际显示不一致。
- **`fallbackCopy` 失败时零反馈**（`:923-931`）：失败把按钮文字设成"复制失败"
  却**不再复原**；而从 `bindCopyCell` 调用时传的是个临时对象字面量
  `{textContent:'',disabled:false}`（`:865,867`），文字设了也没人看得到，
  `done()` 也不会被调用。
- **历史删除不看服务端响应就摘行**（`:605-612`），与授权删除的处理（`:490-501`）
  不一致 —— 后者检查 `.success` 并在失败时复原。
- **`expected` 在两端各算一遍**：前端传 `expected`（`:104`），服务端算出
  `verified`/`expected` 返回（`server.py:311-315`）—— **前端根本不读**，
  `bucketOf`（`:713-717`）自己又算一次；服务端也不把它写进历史。
  纯重复实现，两边一旦漂移没有任何东西能发现。
- **`d.total` 在目录遍历完成前是 `null`**（`server.py:613`，`:207` 才赋值），
  前端 `if (d.total > 1)`（`:167`）于是在最慢的扫描阶段完全不显示进度。
- **`esc()` 不转义 `'`**（`:905-909`）。今天所有插值点都是双引号属性，**安全**；
  但这是靠约定维持的，加一处单引号属性就被击穿。建议补 `'` → `&#39;`。
  另外 `esc(s)` 用 `String(s || '')`，`esc(0)` 会返回空串。
- **`renderPager`（`:668-672`）是全文件唯一把服务端值不经 `esc()` 直接插进
  `innerHTML` 的地方**。今天是整数，安全，但破了一致约定。
- **首轮轮询固定等 1s**（`:150`），小文件也要 1 秒才出结果。
- **三处独立的 `document` keydown 监听**（`:337,389,515`）与两套几乎相同的
  modal 控制器（`:386-403` vs `:512-553`）。
- **`state` / `renderedRows` / `semCache` 均无上限**，无虚拟滚动 ——
  十万级文件的递归会把每个 entry 和每个 `<tr>` 都留在内存里。
- **`CONVERT_BATCH = 50`（`:206`）vs 服务端 `CONVERT_MAX = 200`**
  （`server.py:41`）：客户端一直只用到服务端上限的 1/4，多发 4 倍请求。
- `index.html:163` 的 `setTimeout(rej, 3000)` 以 `undefined` reject，
  逼出了 `:164-166` 那段"先挂空 catch 再参赛"的绕法 —— reject 一个 `Error` 就不需要了。
  另外 3s 硬超时会把响应稍慢的宿主永久降级为 `usable:false`，无重试、无补救路径。

### 3.4 可访问性

- 两个 modal 都没有焦点陷阱、初始焦点、焦点归还。
- `role="menu"`（`index.html:29-31`）只接了点击与 Escape，没有方向键导航。
- `#error-box`（`:86`）和 `#loading-text`（`:83`）没有 `aria-live`，
  读屏用户听不到进度与错误。
- `#th-status` 用内联 `style.display` 切换（`app.js:804,823`），
  其余地方都用 `hidden`/class。

### 3.5 `style.css`

- **只有亮色主题**。`:root`(`:1-16`) 已经是变量了，但全文件唯一的 `@media` 是
  600px 断点（`:647`）—— 没有 `prefers-color-scheme`。fnOS 深色桌面里这个 iframe
  会是一整块白板。**改起来很便宜**（token 已就位），但属于外观决策，故未擅自动手。
- **调色板只 token 化了一半**：`#f8fafc` 硬编码 5 次（`:343,350,522,532,591`）；
  `#fef2f2`(`:309`) 与 `--fail-bg`(`:12`) 重复；focus ring 的
  `rgba(37,99,235,.12)` 写死两次（`:104,113`），其实就是 `--primary` 加透明度；
  `--radius` 有了却仍散落 6px/4px/8px/20px。
- **重复块**：`table`/`thead th`/`tbody tr`（`:336-354`）与 `.hist-table` 版本
  （`:520-533`）几乎逐行相同；省略号三件套重复 6 次；按钮骨架重复 6 次。
- **死规则**：`.form-row`（`:188-193` 及媒体查询分支 `:648`）在 HTML 里没有对应元素；
  `.err-icon { font-style: normal }`（`:394`）作用在从不斜体的 span 上。
- `#timeout-sel`（`:216`）misfiled 在 "Algo chips" 区块里。
- `body` 用 px 字号（`:26`）而其余用 rem，两套尺度不联动。

### 3.6 `hashcli` 其它

- 多余的位置参数被静默忽略（`:38` 只取 `$1`，`hashcli a.iso b.iso` 只算前者）。
- 没有 `-h`/`--help`（`-h` 会报 "unknown option -h"）。
- 没有 `set -euo pipefail`（此处**不建议**盲目加 `-e`：`compute_hash` 是靠返回 1
  表达"这个文件失败了"的，加了会中断整轮）。
- 非递归模式用 `find -maxdepth 1 -type f`（不含指向文件的软链），
  而 `server.py` 用 `os.listdir` + `os.path.isfile`（跟随软链，含）—— 仍不一致。
- 排序口径不同：`sort -z` 全局排 vs `os.walk` 逐目录排。
- CLI 无超时、无并行、无历史、无取消。
- **算法表三处重复**：`hash_cmd`(`:59-68`)、`ALGOS` 数组(`:100`)、
  `server.py:46-52` 的 `ALGO_CMDS`，靠人工同步。
- `hashcli` 不安装到 PATH 上的任何位置，只能按绝对路径调用；README 未提及它。

### 3.7 打包与仓库

- **`manifest` 未声明最低系统版本**，而开放平台功能要求系统 ≥ 1.2.0401、App ≥ 1.34.0。
  低版本装上会得到一个"选择按钮和已授权目录都不出现"的应用 ——
  降级是优雅的，但用户无从得知原因。（需先确认 fnOS 对应的 manifest 字段名。）
- **`arch = x86_64` 单一架构**，ARM 机型装不上；根因是打包的 `b3sum` 是 x86_64 二进制。
  README 与 CLAUDE.md 都未提及这个限制。
- **`bin/b3sum` 未 strip**（1.5 MB，`file` 报 `not stripped`）。
- **LFS 指针没有兜底了**（本次新增的风险）。`b3sum` 经 Git LFS 管理，若导出源码树时
  smudge 没生效，进包的会是约 130 字节的指针文本，装机后 BLAKE3 直接不可用，
  而其余四种算法照常工作 —— 症状隐蔽。原先 `build.sh` 会检测并显式 `git lfs smudge`
  还原，该脚本已按要求删除，这层保护随之消失。打包前建议手工确认：
  `file app/server/bin/b3sum` 应报 `ELF 64-bit ... executable`，而非 ASCII text。
- **`info.log` 无轮转**，接收全部生命周期日志 + 服务端 stderr，长期运行只增不减。
- **`check_process` 只做 `kill -0`**（`cmd/main:70-77`），PID 复用后会误判"运行中"，
  甚至 `stop` 时误杀无关进程。稳妥做法是比对 `/proc/$pid/cmdline`。
- **`cmd/uninstall_init` 的注释写反了** —— 写的是 "called **after** the user uninstalls"，
  应为 before；它与 `cmd/uninstall_callback` 是同一个 git blob(`52f5bf0`)。
  8 个钩子全是 `exit 0`，没有任何一个清理 `info.log` / `app.pid`。
- **行尾不统一**：`config/privilege` 与 `app/ui/config` 是 CRLF，其余是 LF；
  `.gitattributes` 只管了 LFS 二进制，没有文本 `eol` 规则。
- **`DATA_DIR` 默认值硬编码**（`server.py:23`）为 `/var/apps/HashFile/shares/HashFile`，
  而非从环境变量推导。fnOS 若调整共享根路径，数据库会静默搬到一个新的空文件。

---

## 4. 验证记录

本次改动的验证方式，均为实际执行：

| 项 | 方式 | 结果 |
|---|---|---|
| 1.1–1.5 | 构造 `back\slash.txt`、`tab\there.txt`、`no"such"file`、软链目录，跑 `hashcli -j` | 全部通过；哈希 64 字符无前导 `\`、JSON 合法、字段不错位、软链目录能算出文件 |
| 1.1（服务端） | 同一组文件走 `/api/hash` + `/api/hash/status` | 哈希值与 CLI 逐字一致 |
| 2.2 | 单 uid 连发 5 次提交 | 前 3 次 202，后 2 次 429；其它 uid 不受影响 |
| 2.3 | 5000 行落库基准（改前/改后两种策略） | 9.82s → 2.05s，约 4.8× |
| 2.3 | `PRAGMA journal_mode` | `wal` |
| 2.5 | `HEAD /app/HashFile/app.js` | 404 → 200 |
| 2.7 | `cmd/main` 失败路径与正常路径全流程 | 失败 exit=1/status=3（原 exit=0）；正常 start→status→stop→status 全对，pidfile 指向 python3 本身并在停止后清理 |
| 全部 | `py_compile` / `bash -n`（`hashcli`、`cmd/main`）/ `node --check` | 全部通过 |

---

## 5. 建议的后续顺序

1. **`/api/hash` 的路径鉴权策略**（3.1）—— 唯一需要产品决策的一项。
   目前安全性完全依赖 `run-as: package` 这个运行身份，代码本身不设防。
2. **深色主题**（3.5）—— 用户可见度最高、成本最低（token 已就位）。
3. **前端错误处理三件套**（3.3）：`res.ok` 检查、`loadHistory`/`loadAccess` 序列守卫、
   `fallbackCopy` 反馈。
4. **`hash_history` 保留策略**（3.2）—— 长期运行的 NAS 上迟早会成为问题。
5. **CLI 与服务端的剩余分叉**（3.6）—— 或者更彻底：让 `hashcli` 直接调用 `server.py`
   的实现，消除三处算法表重复。
