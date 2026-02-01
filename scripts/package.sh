#!/bin/bash
set -e

# ============================================
# 打包 Nine1Bot Release（使用编译后的二进制）
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
VERSION=$(grep '"version"' "$PROJECT_ROOT/packages/nine1bot/package.json" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
BUILD_NAME="nine1bot-${PLATFORM}-${ARCH}"
BUILD_DIR="$PROJECT_ROOT/dist/$BUILD_NAME"

echo "Packaging Nine1Bot v${VERSION} for ${PLATFORM}-${ARCH}..."

# 1. 检查二进制是否存在，如果不存在则编译
if [ "$PLATFORM" = "windows" ]; then
    BINARY="$BUILD_DIR/nine1bot.exe"
else
    BINARY="$BUILD_DIR/nine1bot"
fi

if [ ! -f "$BINARY" ]; then
    echo "Binary not found, compiling..."
    bun run "$SCRIPT_DIR/build.ts" --platform=$PLATFORM --arch=$ARCH
fi

# 2. 复制 skills
echo "Copying skills..."
mkdir -p "$BUILD_DIR/skills"
cp -r "$PROJECT_ROOT/packages/nine1bot/skills/"* "$BUILD_DIR/skills/"

# 3. 复制 web/dist
echo "Copying web assets..."
mkdir -p "$BUILD_DIR/web"
if [ -d "$PROJECT_ROOT/web/dist" ]; then
    cp -r "$PROJECT_ROOT/web/dist" "$BUILD_DIR/web/"
else
    echo "ERROR: web/dist not found! Run 'bun run build:web' first."
    exit 1
fi

# 4. 复制更新脚本
echo "Copying update script..."
mkdir -p "$BUILD_DIR/scripts"
cp "$PROJECT_ROOT/scripts/update.sh" "$BUILD_DIR/scripts/"
chmod +x "$BUILD_DIR/scripts/update.sh" 2>/dev/null || true

# 5. 写入 VERSION 文件
echo "v${VERSION}" > "$BUILD_DIR/VERSION"

# 6. 下载并捆绑 ripgrep
echo "Downloading ripgrep for ${PLATFORM}-${ARCH}..."
RG_VERSION="14.1.1"
mkdir -p "$BUILD_DIR/bin"

case "${PLATFORM}-${ARCH}" in
    linux-x64)
        curl -sL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz" | \
            tar xz --strip-components=1 -C "$BUILD_DIR/bin" --wildcards "*/rg"
        ;;
    linux-arm64)
        curl -sL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz" | \
            tar xz --strip-components=1 -C "$BUILD_DIR/bin" --wildcards "*/rg"
        ;;
    darwin-arm64)
        curl -sL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz" | \
            tar xz --strip-components=1 -C "$BUILD_DIR/bin" --include="*/rg"
        ;;
    windows-x64)
        curl -sL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip" -o "$BUILD_DIR/bin/rg.zip"
        unzip -j "$BUILD_DIR/bin/rg.zip" "*/rg.exe" -d "$BUILD_DIR/bin"
        rm "$BUILD_DIR/bin/rg.zip"
        ;;
    *)
        echo "WARNING: Unsupported platform ${PLATFORM}-${ARCH} for ripgrep bundling"
        ;;
esac

if [ -f "$BUILD_DIR/bin/rg" ] || [ -f "$BUILD_DIR/bin/rg.exe" ]; then
    chmod +x "$BUILD_DIR/bin/rg" 2>/dev/null || true
    echo "Ripgrep bundled successfully"
else
    echo "WARNING: Failed to bundle ripgrep. Users will need to install it manually or have network access."
fi

# 7. 创建发布包
echo "Creating archive..."
cd "$PROJECT_ROOT/dist"

if [ "$PLATFORM" = "windows" ]; then
    ARCHIVE_NAME="nine1bot-${PLATFORM}-${ARCH}-v${VERSION}.zip"
    if command -v zip &> /dev/null; then
        zip -r "$ARCHIVE_NAME" "$BUILD_NAME"
    elif command -v 7z &> /dev/null; then
        7z a -tzip "$ARCHIVE_NAME" "$BUILD_NAME"
    elif [ -f "/c/Program Files/7-Zip/7z.exe" ]; then
        "/c/Program Files/7-Zip/7z.exe" a -tzip "$ARCHIVE_NAME" "$BUILD_NAME"
    else
        echo "ERROR: No zip tool found (zip, 7z). Cannot create archive."
        exit 1
    fi
else
    ARCHIVE_NAME="nine1bot-${PLATFORM}-${ARCH}-v${VERSION}.tar.gz"
    tar -czvf "$ARCHIVE_NAME" "$BUILD_NAME"
fi

echo ""
echo "Package created: $PROJECT_ROOT/dist/$ARCHIVE_NAME"
ls -lh "$PROJECT_ROOT/dist/$ARCHIVE_NAME"
