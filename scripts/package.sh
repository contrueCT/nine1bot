#!/bin/bash
set -e

# ============================================
# 打包 Nine1Bot Release
# 用法: ./package.sh <platform> <arch>
# ============================================

PLATFORM=$1
ARCH=$2

if [ -z "$PLATFORM" ] || [ -z "$ARCH" ]; then
    echo "Usage: $0 <platform> <arch>"
    exit 1
fi

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 获取版本号（使用 grep/sed 替代 node 以避免 Windows 路径问题）
VERSION=$(grep '"version"' "$PROJECT_ROOT/packages/nine1bot/package.json" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
BUILD_NAME="nine1bot-${PLATFORM}-${ARCH}"
BUILD_DIR="$PROJECT_ROOT/build/$BUILD_NAME"
DIST_DIR="$PROJECT_ROOT/dist"

echo "Packaging Nine1Bot v${VERSION} for ${PLATFORM}-${ARCH}..."

# 清理并创建构建目录
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$DIST_DIR"

# 1. 复制 runtime（应该已经由 download-bun.sh 下载）
echo "Copying Bun runtime..."
mkdir -p "$BUILD_DIR/runtime"
if [ "$PLATFORM" = "windows" ]; then
    cp "$PROJECT_ROOT/runtime/bun.exe" "$BUILD_DIR/runtime/" 2>/dev/null || \
    cp "$PROJECT_ROOT/build/runtime/bun.exe" "$BUILD_DIR/runtime/"
else
    cp "$PROJECT_ROOT/runtime/bun" "$BUILD_DIR/runtime/" 2>/dev/null || \
    cp "$PROJECT_ROOT/build/runtime/bun" "$BUILD_DIR/runtime/"
    chmod +x "$BUILD_DIR/runtime/bun"
fi

# 2. 复制 packages/nine1bot（不包括 node_modules，之后用 bun install）
echo "Copying nine1bot package..."
mkdir -p "$BUILD_DIR/packages/nine1bot"
# 复制源代码
cp -r "$PROJECT_ROOT/packages/nine1bot/src" "$BUILD_DIR/packages/nine1bot/"
# 复制 skills 目录
if [ -d "$PROJECT_ROOT/packages/nine1bot/skills" ]; then
    cp -r "$PROJECT_ROOT/packages/nine1bot/skills" "$BUILD_DIR/packages/nine1bot/"
fi
# 复制配置文件
cp "$PROJECT_ROOT/packages/nine1bot/package.json" "$BUILD_DIR/packages/nine1bot/"
cp "$PROJECT_ROOT/packages/nine1bot/tsconfig.json" "$BUILD_DIR/packages/nine1bot/" 2>/dev/null || true
# 安装依赖
echo "Installing nine1bot dependencies..."
cd "$BUILD_DIR/packages/nine1bot"
bun install --frozen-lockfile 2>/dev/null || bun install
cd "$PROJECT_ROOT"

# 3. 复制 opencode（不包括 node_modules，之后用 bun install）
echo "Copying opencode..."
mkdir -p "$BUILD_DIR/opencode"
# 复制 packages 目录（排除 node_modules）
if command -v rsync &> /dev/null; then
    rsync -a --exclude='node_modules' "$PROJECT_ROOT/opencode/packages/" "$BUILD_DIR/opencode/packages/"
else
    # Windows 回退：手动复制排除 node_modules
    mkdir -p "$BUILD_DIR/opencode/packages"
    for dir in "$PROJECT_ROOT/opencode/packages"/*/; do
        pkg_name=$(basename "$dir")
        mkdir -p "$BUILD_DIR/opencode/packages/$pkg_name"
        # 复制除 node_modules 外的所有内容
        for item in "$dir"*; do
            item_name=$(basename "$item")
            if [ "$item_name" != "node_modules" ]; then
                cp -r "$item" "$BUILD_DIR/opencode/packages/$pkg_name/"
            fi
        done
    done
fi
# 复制配置文件
cp "$PROJECT_ROOT/opencode/package.json" "$BUILD_DIR/opencode/"
cp "$PROJECT_ROOT/opencode/bun.lock" "$BUILD_DIR/opencode/" 2>/dev/null || true
cp "$PROJECT_ROOT/opencode/bunfig.toml" "$BUILD_DIR/opencode/" 2>/dev/null || true
cp "$PROJECT_ROOT/opencode/tsconfig.json" "$BUILD_DIR/opencode/" 2>/dev/null || true
# 安装依赖
echo "Installing opencode dependencies..."
cd "$BUILD_DIR/opencode"
bun install --frozen-lockfile 2>/dev/null || bun install
cd "$PROJECT_ROOT"

# 4. 复制 web/dist
echo "Copying web assets..."
mkdir -p "$BUILD_DIR/web"
if [ -d "$PROJECT_ROOT/web/dist" ]; then
    cp -r "$PROJECT_ROOT/web/dist" "$BUILD_DIR/web/"
else
    echo "ERROR: web/dist not found! Run 'bun run build' in web first."
    exit 1
fi

# 5. 复制启动脚本
echo "Copying launcher scripts..."
if [ "$PLATFORM" = "windows" ]; then
    cp "$PROJECT_ROOT/bin/nine1bot.bat" "$BUILD_DIR/"
else
    cp "$PROJECT_ROOT/bin/nine1bot.sh" "$BUILD_DIR/nine1bot"
    chmod +x "$BUILD_DIR/nine1bot"
fi

# 6. 写入版本文件（用于更新检测）
echo "Writing VERSION file..."
echo "v${VERSION}" > "$BUILD_DIR/VERSION"

# 7. 复制更新脚本
echo "Copying update script..."
mkdir -p "$BUILD_DIR/scripts"
cp "$PROJECT_ROOT/scripts/update.sh" "$BUILD_DIR/scripts/"
chmod +x "$BUILD_DIR/scripts/update.sh" 2>/dev/null || true

# 8. 打包
echo "Creating archive..."
cd "$PROJECT_ROOT/build"

if [ "$PLATFORM" = "windows" ]; then
    # Windows 使用 zip 或 7z
    ARCHIVE_NAME="nine1bot-${PLATFORM}-${ARCH}-v${VERSION}.zip"
    if command -v zip &> /dev/null; then
        zip -r "$DIST_DIR/$ARCHIVE_NAME" "$BUILD_NAME"
    elif command -v 7z &> /dev/null; then
        # 7-Zip (available on GitHub Windows runners)
        7z a -tzip "$DIST_DIR/$ARCHIVE_NAME" "$BUILD_NAME"
    elif [ -f "/c/Program Files/7-Zip/7z.exe" ]; then
        # 7-Zip default install path on Windows
        "/c/Program Files/7-Zip/7z.exe" a -tzip "$DIST_DIR/$ARCHIVE_NAME" "$BUILD_NAME"
    else
        echo "ERROR: No zip tool found (zip, 7z). Cannot create archive."
        exit 1
    fi
else
    # Linux/macOS 使用 tar.gz
    ARCHIVE_NAME="nine1bot-${PLATFORM}-${ARCH}-v${VERSION}.tar.gz"
    tar -czvf "$DIST_DIR/$ARCHIVE_NAME" "$BUILD_NAME"
fi

echo ""
echo "Package created: $DIST_DIR/$ARCHIVE_NAME"
ls -lh "$DIST_DIR/$ARCHIVE_NAME"
