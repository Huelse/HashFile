# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 项目简介

HashFile 是一个 fnOS（基于 Debian 12 的 NAS 操作系统）软件包，用于计算文件或目录的哈希值（SHA-256、SHA-512、SHA-1、MD5）。它将一个 Python Web 服务器、一个纯 JS 前端界面和一个 Bash 命令行工具打包成可在 fnOS 上安装的 `.fpk` 包。

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

测试 API 接口：

```bash
curl "http://localhost:17743/api/hash?path=/tmp&algo=sha256"
curl "http://localhost:17743/api/hash?path=/tmp/file.iso&algo=sha256,md5&expected=abc123"
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
config/resource       # 声明 fnOS 数据共享目录
wizard/install        # 安装时显示的配置界面
wizard/config         # 应用设置中显示的配置界面
cmd/main              # start/stop/status 生命周期脚本（由 fnOS 调用）
app/
  ui/config           # fnOS iframe 嵌入配置及文件类型关联
  www/                # 静态前端（index.html、app.js、style.css）
  server/
    server.py         # ThreadingUnixHTTPServer — 提供 www/ 静态文件及 GET /api/hash
    hashcli           # 独立 Bash CLI 工具（逻辑与 server.py 一致）
```

## 关键设计要点

- **无构建步骤** — 前端为纯 HTML/JS/CSS，不使用任何打包工具。
- **哈希计算** 通过 Python 中的 `subprocess.run` 和 Bash CLI 中的直接调用，委托给系统命令（`sha256sum`、`md5sum` 等）执行。
- **API** 只有一个接口 `GET /api/hash`，通过 query 参数传递：`path`、`algo`（逗号分隔或 `all`）、`recursive`、`expected`、`timeout`。
- **前端状态** 在 `app.js` 中使用 `Map<filePath, Map<algo, result>>` 存储；多次计算的结果会合并而非替换。
- **打包** — 使用 fnOS 开发者工具构建 `.fpk`（工具不在本仓库中）。`.gitignore` 已排除 `*.fpk`。
- **无 TCP 端口** — 服务器只监听 Unix Socket（`${TRIM_APPDEST}/app.sock`），不对外暴露 TCP 端口。
- **文件类型右键集成** — 在 `app/ui/config` 的 `fileTypes` 中添加扩展名，即可在 fnOS 文件管理器中启用"用 HashFile 打开"功能。
- **权限** — 默认以 `root` 运行以便无限制读取文件；可改为 `package`，并在 fnOS 应用设置中为指定文件夹授予只读权限。
- **统一网关与用户隔离** — `app/ui/config` 通过 `gatewaySocket`（`app.sock`）和 `gatewayPrefix`（`/app/HashFile`）注册到 fnOS 统一网关。网关在转发前完成登录校验并注入 `X-Trim-Userid` 等身份头。`server.py` 只监听位于 `${TRIM_APPDEST}/app.sock` 的 Unix Socket，并在路由前剥离 `gatewayPrefix`。历史记录按 `X-Trim-Userid`（即 uid，绝不信任客户端传入的 ID）存储与过滤，删除也限定本人 uid。前端 API 一律使用相对路径。
