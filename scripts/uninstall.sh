#!/bin/bash
set -e

# ============================================
# Nine1Bot 卸载脚本
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="${NINE1BOT_INSTALL_DIR:-$HOME/.nine1bot}"
BIN_DIR="${NINE1BOT_BIN_DIR:-$HOME/.local/bin}"

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

echo ""
echo -e "${YELLOW}确定要卸载 Nine1Bot 吗？${NC}"
echo -e "这将删除: ${RED}$INSTALL_DIR${NC}"
echo ""
read -p "输入 'yes' 确认卸载: " confirm

if [ "$confirm" != "yes" ]; then
    echo "卸载已取消"
    exit 0
fi

log_info "正在卸载 Nine1Bot..."

# 删除启动脚本
if [ -f "$BIN_DIR/nine1bot" ]; then
    rm -f "$BIN_DIR/nine1bot"
    log_info "已删除启动脚本"
fi

# 删除安装目录
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log_info "已删除安装目录"
fi

log_success "Nine1Bot 已卸载"
echo ""
log_warning "注意: Bun 运行时未被卸载，如需卸载请手动删除 ~/.bun"
log_warning "注意: ~/.bashrc 或 ~/.zshrc 中的 PATH 配置需要手动删除"
