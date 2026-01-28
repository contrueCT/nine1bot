#!/bin/bash
set -e

# ============================================
# 下载 Bun 运行时
# 用法: ./download-bun.sh <platform> <arch>
# 平台: linux, darwin, windows
# 架构: x64, arm64
# ============================================

PLATFORM=$1
ARCH=$2
OUTPUT_DIR=${3:-"runtime"}

if [ -z "$PLATFORM" ] || [ -z "$ARCH" ]; then
    echo "Usage: $0 <platform> <arch> [output_dir]"
    echo "  platform: linux, darwin, windows"
    echo "  arch: x64, arm64"
    exit 1
fi

# 转换架构名称（Bun 使用 aarch64 而不是 arm64）
BUN_ARCH=$ARCH
if [ "$ARCH" = "arm64" ]; then
    BUN_ARCH="aarch64"
fi

# 构建下载 URL
BUN_URL="https://github.com/oven-sh/bun/releases/latest/download/bun-${PLATFORM}-${BUN_ARCH}.zip"

echo "Downloading Bun for ${PLATFORM}-${ARCH}..."
echo "URL: $BUN_URL"

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 下载并解压
TEMP_ZIP=$(mktemp)
curl -fsSL "$BUN_URL" -o "$TEMP_ZIP"

# 解压到临时目录，然后移动文件
TEMP_DIR=$(mktemp -d)
unzip -q "$TEMP_ZIP" -d "$TEMP_DIR"

# Bun 的 zip 包内有一个 bun-xxx 目录，里面包含 bun 可执行文件
BUN_INNER_DIR=$(ls "$TEMP_DIR")
if [ "$PLATFORM" = "windows" ]; then
    mv "$TEMP_DIR/$BUN_INNER_DIR/bun.exe" "$OUTPUT_DIR/"
else
    mv "$TEMP_DIR/$BUN_INNER_DIR/bun" "$OUTPUT_DIR/"
    chmod +x "$OUTPUT_DIR/bun"
fi

# 清理
rm -f "$TEMP_ZIP"
rm -rf "$TEMP_DIR"

echo "Bun downloaded to $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
