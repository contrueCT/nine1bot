#!/bin/bash
set -e

# ============================================
# Nine1Bot 更新脚本
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="${NINE1BOT_INSTALL_DIR:-$HOME/.nine1bot}"

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 确保 Bun 在 PATH 中
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if [ ! -d "$INSTALL_DIR" ]; then
    log_error "Nine1Bot 未安装，请先运行安装脚本"
    exit 1
fi

cd "$INSTALL_DIR"

log_info "正在更新 Nine1Bot..."

# 拉取最新代码
log_info "拉取最新代码..."
git pull origin main || git pull origin master

# 更新依赖
log_info "更新 opencode 依赖..."
cd opencode && bun install && cd ..

log_info "更新 nine1bot 依赖..."
cd packages/nine1bot && bun install && cd ../..

log_info "更新 web 依赖..."
cd web && bun install && cd ..

# 重新构建 Web
log_info "重新构建 Web 前端..."
cd web && bun run build && cd ..

log_success "Nine1Bot 更新完成!"
echo ""
echo -e "运行 ${CYAN}nine1bot${NC} 启动服务"
