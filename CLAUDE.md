# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 项目简介

HashFile 是一个 fnOS（基于 Debian 12 的 NAS 操作系统）软件包，用于计算文件或目录的哈希值（SHA-256、SHA-512、SHA-1、MD5、BLAKE3）。它将一个 Python Web 服务器、一个纯 JS 前端界面和一个 Bash 命令行工具打包成可在 fnOS 上安装的 `.fpk` 包。

## 本地运行

服务器只监听 Unix Socket，需先设置 `GATEWAY_SOCKET`：

```bash
# 启动服务器
GATEWAY_SOCKET=/tmp/hashfile.sock python3 app/server/server.py
```

用 socat 将 TCP 端口桥接到 socket，方便浏览器访问：

```bash
socat TCP-LISTEN:17743,fork,reuseaddr UNIX-CONNECT:/tmp/hashfile.sock &
```

测试 API 接口（哈希计算为异步任务，提交后轮询状态）：

```bash
curl "http://localhost:17743/api/hash?path=/tmp&algo=sha256"          # → {"success":true,"task":"<id>"}
curl "http://localhost:17743/api/hash/status?id=<id>"                 # → running / done+results
curl -X DELETE "http://localhost:17743/api/hash?id=<id>"              # 取消任务
```

开放平台相关接口本地默认不可用（无 `TRIM_API_TOKEN`、无网关身份头），一律返回 `success:false` 供前端降级；
联调时可自起 mock socket 并用 `APISCOPE_SOCKET` 指过去，身份头需手动补：

```bash
curl "http://localhost:17743/api/convert-path?path=/vol1/1000/x&language=zh-CN"       # → {"success":false,"reason":…}
curl -H "X-Trim-Userid: 1000" "http://localhost:17743/api/user-access"                # 已授权目录列表
curl -H "X-Trim-Userid: 1000" -X DELETE "http://localhost:17743/api/user-access?path=/vol1/1000/x"
```

测试命令行工具：

```bash
bash app/server/hashcli -a sha256 /path/to/file
bash app/server/hashcli -a all -r -j /path/to/dir
```

## 包结构

```
manifest              # fnOS 包元数据（名称、版本、架构）
config/privilege      # 默认以 root 权限运行
config/resource       # 声明 fnOS 数据共享目录及开放平台 api-scope
wizard/install        # 安装时显示的配置界面
wizard/config         # 应用设置中显示的配置界面
cmd/main              # start/stop/status 生命周期脚本（由 fnOS 调用）
app/
  ui/config           # fnOS iframe 嵌入配置及文件类型关联
  www/                # 静态前端（index.html、app.js、style.css）
    vendor/           # @trimjs/web-app 的 dist/index.js 原文（fnOS 微应用 JS SDK）
  server/
    server.py         # ThreadingUnixHTTPServer — 提供 www/ 静态文件、/api/hash 异步任务、/api/history、/api/convert-path 及 /api/user-access
    hashcli           # 独立 Bash CLI 工具（逻辑与 server.py 一致）
```

## 关键设计要点

- **无构建步骤** — 前端为纯 HTML/JS/CSS，不使用任何打包工具。
- **哈希计算** 委托给系统命令（`sha256sum`、`md5sum` 等）执行：服务器用 `subprocess.Popen`（句柄挂在任务上，取消时可 kill），Bash CLI 直接调用。`timeout` 参数是单个文件的哈希超时，不是总时长。
- **API 为异步任务模式** — fnOS 统一网关对代理请求有约 5 分钟固定超时（应用端不可配置），大文件同步计算会被 504 掐断。`GET /api/hash`（参数：`path`、`algo` 逗号分隔或 `all`、`recursive`、`expected`、`timeout`）提交任务并立即返回 `task` id；`GET /api/hash/status?id=` 轮询进度（`done`/`total`）与结果；`DELETE /api/hash?id=` 取消并杀掉哈希子进程。任务按 uid 隔离，结束后保留 1 小时。
- **前端状态** 在 `app.js` 中使用 `Map<filePath, Map<algo, result>>` 存储；多次计算的结果会合并而非替换。
- **打包** — 使用 fnOS 开发者工具构建 `.fpk`（工具不在本仓库中）。`.gitignore` 已排除 `*.fpk`。
- **无 TCP 端口** — 服务器只监听 Unix Socket（`${TRIM_APPDEST}/app.sock`），不对外暴露 TCP 端口。
- **文件类型右键集成** — 在 `app/ui/config` 的 `fileTypes` 中添加扩展名，即可在 fnOS 文件管理器中启用"用 HashFile 打开"功能。
- **权限** — 默认以 `root` 运行以便无限制读取文件；可改为 `package`，并在 fnOS 应用设置中为指定文件夹授予只读权限。
- **fnOS 开放平台接入** — `manifest` 声明 `micro_app=true`（否则页面不按微应用环境加载，JS SDK 无法初始化），`config/resource` 声明 `api-scope`（当前为 `trim.file.userAccess`、`trim.file.path`）。要求系统 ≥ 1.2.0401、App ≥ 1.34.0。两条链路：
  - **前端 JS SDK** — `app/www/vendor/trim-web-app.js` 是 `@trimjs/web-app` 的 `dist/index.js` 原文（零依赖自包含 ESM，故可直接 `<script type="module">` 引入，不引入构建步骤；升级即整体替换该文件）。`index.html` 底部的 module 负责初始化并 resolve `window.__sdkReady`（`{ sdk, language, usable }`），**任何失败都必定 resolve 成 `usable:false`**，`app.js` 据此决定是否显示路径选择入口。用户点「选择文件/目录」调 `sdk.pickUserFile()`，选中后系统自动把该路径授权给本应用。**用户关闭授权弹窗时宿主的返回没有专属错误码**（可能是 `undefined`、`code≠0` + 通用文案 `Operation failed`，也可能直接 reject），与真失败无从区分，因此一律静默：只认 `res.data[0]`，其余情况只写 console，不弹错误框。独立浏览器窗口（`isStandaloneWeb`）的 `openAppAuth` + 回调页链路**未实现**，直接降级。
  - **后端 API** — `convertPath` 与授权目录的增删查只有后端接口。`server.py` 的 `_trimapp_call()` 经 Unix Socket `/var/run/trim_open_gateway_apiscope.socket` 调 `POST /api/v1/trimapp`，用环境变量 `TRIM_API_TOKEN` 做 Bearer 鉴权（token 由 fnOS 拉起 `cmd/main` 时注入，**每次调用现读、绝不落盘**）。目前用到 `trim.file.convertPath`、`trim.file.getUserAccessibleFolders`、`trim.file.delUserAccessibleFolder`，分别经 `GET /api/convert-path?path=…&language=…`、`GET /api/user-access`、`DELETE /api/user-access?path=…` 暴露给前端。**对网关返回的结构不作任何假设**——真机上 `convertPath` 的 `data` 直接就是结果数组，而文档写的是 `{status, result}`，两种形状都得认；同理 `getUserAccessibleFolders` 兼容裸数组与 `{paths}`，`delUserAccessibleFolder` 只在明确回 `suc:false` 时才判失败（`code≠0` 已在 `_trimapp_call` 挡掉）。非对象、非 JSON、HTTP 非 200 一律当失败，失败统一回 HTTP 200 + `success:false` + `reason`（失败原因文本，不含 token），前端据此降级并在 console 留痕。`APISCOPE_SOCKET` 可用同名环境变量覆盖，便于本地起 mock 联调。
- **已授权目录管理** — `pickUserFile` 写入的**目录**授权可按 uid 查询与删除（文件授权不在此列表内）。前端「已授权目录」按钮默认 `hidden`，页面加载时探一次 `GET /api/user-access`，只有 `success` 才显示入口——低版本系统、未授予 scope、拿不到网关身份时整个入口不出现。删除做行内二次确认（3 秒复位），成功后只移除该行。`_pluck_paths()` 负责从网关返回里挖路径（裸数组 / 换字段名 / 元素是对象都容错），挖不出来会把原始结构记进日志；`GET /api/user-access?debug=1` 额外回传所用 uid、网关注入的 `X-Trim-*` 头和平台原样返回的 `raw`，真机形状对不上时用它排查。
- **未捕获异常兜底** — handler 里任何未捕获异常都会让 socketserver 直接断开连接，统一网关只能报 **502**，既没有响应体也没有堆栈。`do_GET`/`do_DELETE` 因此都经 `_guard()` 转发：堆栈打到 stderr（`cmd/main` 已重定向进 `${TRIM_PKGVAR}/info.log`），客户端收到 500 JSON。排障时先看这个日志。
- **路径的真实值与展示值** — fnOS 要求不要直接展示 `/vol1/...` 内部路径。`app.js` 中 `realPath` 是唯一真值来源（提交计算、写历史都用它），路径输入框的 `value` 只是展示：失焦时换成 `convertPath` 得到的语义化路径并加 `.is-semantic`，聚焦时还原 `realPath`。结果表格文件列的 `title` 同样走语义化路径（异步拿到后只改 `title` 属性，不重绘表格）。开放平台不可用时 `semDisabled` 置位，整页停止尝试并原样显示内部路径。
- **统一网关与用户隔离** — `app/ui/config` 通过 `gatewaySocket`（`app.sock`）和 `gatewayPrefix`（`/app/HashFile`）注册到 fnOS 统一网关。网关在转发前完成登录校验并注入 `X-Trim-Userid` 等身份头。`server.py` 只监听位于 `${TRIM_APPDEST}/app.sock` 的 Unix Socket，并在路由前剥离 `gatewayPrefix`。历史记录按 `X-Trim-Userid`（即 uid，绝不信任客户端传入的 ID）存储与过滤，删除也限定本人 uid。前端 API 一律使用相对路径。
