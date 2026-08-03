#!/bin/sh
# 构建两个 fpk 安装包：
#   HashFile.fpk       标准版（run-as: package，需在应用设置中授予文件夹权限）
#   HashFile-root.fpk  root 版（应用 root 分支的改动：run-as: root + 文件类型右键关联）
# 均基于已提交的 HEAD 内容构建，未提交的改动不会进包。
set -eu

# 仓库内通过 Git LFS 管理的二进制（app/server/bin/b3sum 等）。
# git archive 通常会自动 smudge 解析指针，但不同 git-lfs 版本或关闭
# smudge 时可能输出原始指针文本（~130 字节），打包后会导致二进制无法执行。
# 这里在导出后显式兜底：检测到指针就用 git lfs smudge 还原真实内容。
LFS_BINARIES="app/server/bin/b3sum"
LFS_PTR_MAGIC="version https://git-lfs.github.com/spec/v1"

materialize_lfs() {
    # $1 = 导出的源码树根目录
    local tree="$1"
    command -v git >/dev/null 2>&1 || return 0
    for rel in $LFS_BINARIES; do
        local f="$tree/$rel"
        [ -f "$f" ] || continue
        # 指针文件首行即 LFS magic；真实二进制（ELF/PNG 等）不会匹配
        if head -n 1 "$f" 2>/dev/null | grep -q "^$LFS_PTR_MAGIC"; then
            git lfs smudge "$rel" < "$f" > "$f.real" 2>/dev/null \
                && mv "$f.real" "$f" \
                && chmod +x "$f" \
                || { echo "错误：LFS 还原失败：$rel（确认已 git lfs fetch）" >&2; rm -f "$f.real"; exit 1; }
            echo "已还原 LFS 二进制：$rel"
        fi
    done
}

REPO="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

# manifest 为 CRLF 行尾，需去掉行尾的 \r，否则版本号会带回车符弄乱终端输出
VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$REPO/manifest" | tr -d '[:space:]')"

# 从 HEAD 导出干净源码树，避免把 .git、旧 fpk 等杂物打进包
export_tree() {
    mkdir -p "$1"
    git -C "$REPO" archive HEAD | tar -x -C "$1"
    materialize_lfs "$1"
}

# $1 = 源码目录  $2 = 输出文件名
build_one() {
    (cd "$1" && fnpack build -d .)
    fpk="$(find "$1" -maxdepth 1 -name '*.fpk' | head -n 1)"
    if [ -z "$fpk" ]; then
        echo "错误：fnpack 未在 $1 生成 .fpk 产物" >&2
        exit 1
    fi
    mv "$fpk" "$REPO/$2"
    echo "已生成 $2 (v$VERSION)"
}

# 标准版
export_tree "$BUILD/std"
build_one "$BUILD/std" HashFile.fpk

# root 版：在干净树上叠加 root 分支相对 main 的改动
export_tree "$BUILD/root"
git -C "$REPO" diff main...root > "$BUILD/root.patch"
git -C "$BUILD/root" apply "$BUILD/root.patch"
build_one "$BUILD/root" HashFile-root.fpk
