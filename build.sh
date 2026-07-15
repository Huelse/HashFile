#!/bin/sh
# 构建两个 fpk 安装包：
#   HashFile.fpk       标准版（run-as: package，需在应用设置中授予文件夹权限）
#   HashFile-root.fpk  root 版（应用 root 分支的改动：run-as: root + 文件类型右键关联）
# 均基于已提交的 HEAD 内容构建，未提交的改动不会进包。
set -eu

REPO="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

# manifest 为 CRLF 行尾，需去掉行尾的 \r，否则版本号会带回车符弄乱终端输出
VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$REPO/manifest" | tr -d '[:space:]')"

# 从 HEAD 导出干净源码树，避免把 .git、旧 fpk 等杂物打进包
export_tree() {
    mkdir -p "$1"
    git -C "$REPO" archive HEAD | tar -x -C "$1"
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
