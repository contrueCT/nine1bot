#!/bin/bash
set -e

# ============================================
# Nine1Bot 完整构建脚本
# 用法: ./build-release.sh <platform> <arch>
# 或者: ./build-release.sh all  (构建所有平台)
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

build_single() {
    local PLATFORM=$1
    local ARCH=$2

    echo ""
    echo "============================================"
    echo "Building for ${PLATFORM}-${ARCH}"
    echo "============================================"
    echo ""

    # 1. 下载 Bun 运行时
    echo "Step 1: Downloading Bun runtime..."
    mkdir -p "$PROJECT_ROOT/build/runtime"
    "$SCRIPT_DIR/download-bun.sh" "$PLATFORM" "$ARCH" "$PROJECT_ROOT/build/runtime"

    # 2. 打包
    echo "Step 2: Packaging..."
    "$SCRIPT_DIR/package.sh" "$PLATFORM" "$ARCH"

    # 清理临时 runtime
    rm -rf "$PROJECT_ROOT/build/runtime"

    echo ""
    echo "Build complete for ${PLATFORM}-${ARCH}"
}

build_all() {
    echo "Building for all platforms..."

    # Linux
    build_single linux x64
    build_single linux arm64

    # macOS
    build_single darwin x64
    build_single darwin arm64

    # Windows
    build_single windows x64

    echo ""
    echo "============================================"
    echo "All builds complete!"
    echo "============================================"
    ls -la "$PROJECT_ROOT/dist/"
}

# 确保依赖已安装
check_dependencies() {
    echo "Checking dependencies..."

    # 检查 web 是否已构建
    if [ ! -d "$PROJECT_ROOT/web/dist" ]; then
        echo "Building web frontend..."
        cd "$PROJECT_ROOT/web"
        bun install
        bun run build
        cd "$PROJECT_ROOT"
    fi

    # 检查 opencode 依赖
    if [ ! -d "$PROJECT_ROOT/opencode/node_modules" ]; then
        echo "Installing opencode dependencies..."
        cd "$PROJECT_ROOT/opencode"
        bun install
        cd "$PROJECT_ROOT"
    fi

    # 检查 nine1bot 依赖
    if [ ! -d "$PROJECT_ROOT/packages/nine1bot/node_modules" ]; then
        echo "Installing nine1bot dependencies..."
        cd "$PROJECT_ROOT/packages/nine1bot"
        bun install
        cd "$PROJECT_ROOT"
    fi

    echo "Dependencies OK"
}

# 主入口
main() {
    cd "$PROJECT_ROOT"

    if [ "$1" = "all" ]; then
        check_dependencies
        build_all
    elif [ -n "$1" ] && [ -n "$2" ]; then
        check_dependencies
        build_single "$1" "$2"
    else
        echo "Usage: $0 <platform> <arch>"
        echo "   or: $0 all"
        echo ""
        echo "Platforms: linux, darwin, windows"
        echo "Architectures: x64, arm64"
        echo ""
        echo "Examples:"
        echo "  $0 linux x64      # Build for Linux x64"
        echo "  $0 darwin arm64   # Build for macOS ARM64"
        echo "  $0 all            # Build for all platforms"
        exit 1
    fi
}

main "$@"
