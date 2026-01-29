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

# 获取版本号
VERSION=$(node -p "require('$PROJECT_ROOT/packages/nine1bot/package.json').version")
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

# 2. 复制 packages/nine1bot
echo "Copying nine1bot package..."
mkdir -p "$BUILD_DIR/packages/nine1bot"
cp -r "$PROJECT_ROOT/packages/nine1bot/src" "$BUILD_DIR/packages/nine1bot/"
cp -r "$PROJECT_ROOT/packages/nine1bot/node_modules" "$BUILD_DIR/packages/nine1bot/" 2>/dev/null || true
cp "$PROJECT_ROOT/packages/nine1bot/package.json" "$BUILD_DIR/packages/nine1bot/"
cp "$PROJECT_ROOT/packages/nine1bot/tsconfig.json" "$BUILD_DIR/packages/nine1bot/" 2>/dev/null || true

# 3. 复制 opencode
echo "Copying opencode..."
mkdir -p "$BUILD_DIR/opencode"
cp -r "$PROJECT_ROOT/opencode/packages" "$BUILD_DIR/opencode/"
cp -r "$PROJECT_ROOT/opencode/node_modules" "$BUILD_DIR/opencode/" 2>/dev/null || true
cp "$PROJECT_ROOT/opencode/package.json" "$BUILD_DIR/opencode/"
cp "$PROJECT_ROOT/opencode/tsconfig.json" "$BUILD_DIR/opencode/" 2>/dev/null || true
cp "$PROJECT_ROOT/opencode/bunfig.toml" "$BUILD_DIR/opencode/" 2>/dev/null || true

# 4. 复制 web/dist
echo "Copying web assets..."
mkdir -p "$BUILD_DIR/web"
cp -r "$PROJECT_ROOT/web/dist" "$BUILD_DIR/web/"

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
    # Windows 使用 zip
    ARCHIVE_NAME="nine1bot-${PLATFORM}-${ARCH}-v${VERSION}.zip"
    zip -r "$DIST_DIR/$ARCHIVE_NAME" "$BUILD_NAME"
else
    # Linux/macOS 使用 tar.gz
    ARCHIVE_NAME="nine1bot-${PLATFORM}-${ARCH}-v${VERSION}.tar.gz"
    tar -czvf "$DIST_DIR/$ARCHIVE_NAME" "$BUILD_NAME"
fi

echo ""
echo "Package created: $DIST_DIR/$ARCHIVE_NAME"
ls -lh "$DIST_DIR/$ARCHIVE_NAME"
