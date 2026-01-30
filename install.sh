#!/bin/bash
set -e

# ============================================
# Nine1Bot 安装脚本
# 支持: Linux, macOS
# ============================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置
REPO_URL="https://github.com/contrueCT/nine1bot.git"
INSTALL_DIR="${NINE1BOT_INSTALL_DIR:-$HOME/.nine1bot}"
BIN_DIR="${NINE1BOT_BIN_DIR:-$HOME/.local/bin}"

# Logo
print_logo() {
    echo -e "${CYAN}"
    echo '  _   _ _            _ ____        _   '
    echo ' | \ | (_)_ __   ___/ | __ )  ___ | |_ '
    echo ' |  \| | | '\''_ \ / _ \ |  _ \ / _ \| __|'
    echo ' | |\  | | | | |  __/ | |_) | (_) | |_ '
    echo ' |_| \_|_|_| |_|\___|_|____/ \___/ \__|'
    echo -e "${NC}"
    echo ""
}

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检测操作系统
detect_os() {
    case "$(uname -s)" in
        Linux*)     OS="linux";;
        Darwin*)    OS="darwin";;
        *)          OS="unknown";;
    esac

    case "$(uname -m)" in
        x86_64)     ARCH="x64";;
        aarch64)    ARCH="aarch64";;
        arm64)      ARCH="aarch64";;
        *)          ARCH="unknown";;
    esac

    log_info "检测到系统: $OS ($ARCH)"
}

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 安装 Bun
install_bun() {
    if command_exists bun; then
        local bun_version=$(bun --version 2>/dev/null || echo "unknown")
        log_success "Bun 已安装 (版本: $bun_version)"
        return 0
    fi

    log_info "正在安装 Bun..."
    curl -fsSL https://bun.sh/install | bash

    # 加载 Bun 到当前 shell
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if command_exists bun; then
        log_success "Bun 安装成功"
    else
        log_error "Bun 安装失败，请手动安装: https://bun.sh"
        exit 1
    fi
}

# 安装 Git（如果需要）
check_git() {
    if ! command_exists git; then
        log_error "Git 未安装，请先安装 Git"
        if [ "$OS" = "darwin" ]; then
            log_info "macOS: xcode-select --install"
        elif [ "$OS" = "linux" ]; then
            log_info "Ubuntu/Debian: sudo apt install git"
            log_info "CentOS/RHEL: sudo yum install git"
        fi
        exit 1
    fi
}

# 下载 Nine1Bot
download_nine1bot() {
    if [ -d "$INSTALL_DIR" ]; then
        log_info "Nine1Bot 目录已存在，正在更新..."
        cd "$INSTALL_DIR"
        git pull origin main || git pull origin master || true
    else
        log_info "正在下载 Nine1Bot..."
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    log_success "Nine1Bot 下载完成"
}

# 从 Release 下载（备选方案）
download_from_release() {
    log_info "正在从 Release 下载..."

    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    # 下载最新 release
    local release_url="https://github.com/your-username/nine1bot/releases/latest/download/nine1bot-$OS-$ARCH.tar.gz"

    if command_exists curl; then
        curl -fsSL "$release_url" | tar -xz
    elif command_exists wget; then
        wget -qO- "$release_url" | tar -xz
    else
        log_error "需要 curl 或 wget"
        exit 1
    fi
}

# 安装依赖
install_dependencies() {
    log_info "正在安装依赖..."
    cd "$INSTALL_DIR"

    # 安装 opencode 依赖
    log_info "安装 opencode 依赖..."
    cd opencode
    bun install --frozen-lockfile || bun install
    cd ..

    # 安装 nine1bot 依赖
    log_info "安装 nine1bot 依赖..."
    cd packages/nine1bot
    bun install || npm install
    cd ../..

    # 安装 web 依赖
    log_info "安装 web 依赖..."
    cd web
    bun install || npm install
    cd ..

    log_success "依赖安装完成"
}

# 构建 Web 前端
build_web() {
    log_info "正在构建 Web 前端..."
    cd "$INSTALL_DIR/web"

    bun run build || npm run build

    if [ -d "dist" ]; then
        log_success "Web 前端构建完成"
    else
        log_error "Web 前端构建失败"
        exit 1
    fi
}

# 创建启动脚本
create_launcher() {
    log_info "正在创建启动脚本..."

    mkdir -p "$BIN_DIR"

    # 创建启动脚本
    cat > "$BIN_DIR/nine1bot" << EOF
#!/bin/bash
# Nine1Bot 启动脚本

# 确保 Bun 在 PATH 中
export BUN_INSTALL="\$HOME/.bun"
export PATH="\$BUN_INSTALL/bin:\$PATH"

# 运行 Nine1Bot
exec bun run "$INSTALL_DIR/packages/nine1bot/src/index.ts" "\$@"
EOF

    chmod +x "$BIN_DIR/nine1bot"

    log_success "启动脚本创建完成: $BIN_DIR/nine1bot"
}

# 配置 PATH
setup_path() {
    local shell_rc=""

    # 检测用户的 shell
    case "$SHELL" in
        */zsh)  shell_rc="$HOME/.zshrc";;
        */bash) shell_rc="$HOME/.bashrc";;
        *)      shell_rc="$HOME/.profile";;
    esac

    # 检查 PATH 是否已包含 BIN_DIR
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        log_info "正在将 $BIN_DIR 添加到 PATH..."

        echo "" >> "$shell_rc"
        echo "# Nine1Bot" >> "$shell_rc"
        echo "export PATH=\"\$PATH:$BIN_DIR\"" >> "$shell_rc"

        export PATH="$PATH:$BIN_DIR"

        log_success "PATH 已更新，请运行: source $shell_rc"
    fi
}

# 创建默认配置
create_default_config() {
    local config_file="$INSTALL_DIR/nine1bot.config.jsonc"

    if [ ! -f "$config_file" ]; then
        log_info "正在创建默认配置..."
        cat > "$config_file" << 'EOF'
{
  "$schema": "https://nine1bot.com/config.schema.json",
  "server": {
    "port": 4096,
    "hostname": "127.0.0.1",
    "openBrowser": true
  },
  "auth": {
    "enabled": false
  },
  "tunnel": {
    "enabled": false,
    "provider": "ngrok"
  }
}
EOF
        log_success "默认配置已创建"
    fi
}

# 显示安装完成信息
show_completion() {
    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}  Nine1Bot 安装完成!${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "安装目录: ${CYAN}$INSTALL_DIR${NC}"
    echo -e "可执行文件: ${CYAN}$BIN_DIR/nine1bot${NC}"
    echo ""
    echo -e "使用方法:"
    echo -e "  ${CYAN}nine1bot${NC}              启动服务"
    echo -e "  ${CYAN}nine1bot setup${NC}        运行配置向导"
    echo -e "  ${CYAN}nine1bot config show${NC}  查看配置"
    echo -e "  ${CYAN}nine1bot --help${NC}       查看帮助"
    echo ""
    echo -e "配置文件: ${CYAN}$INSTALL_DIR/nine1bot.config.jsonc${NC}"
    echo ""

    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        echo -e "${YELLOW}注意: 请运行以下命令使 PATH 生效:${NC}"
        echo -e "  ${CYAN}source ~/.bashrc${NC}  或  ${CYAN}source ~/.zshrc${NC}"
        echo ""
    fi
}

# 主函数
main() {
    print_logo

    log_info "开始安装 Nine1Bot..."
    echo ""

    detect_os

    if [ "$OS" = "unknown" ]; then
        log_error "不支持的操作系统"
        exit 1
    fi

    check_git
    install_bun
    download_nine1bot
    install_dependencies
    build_web
    create_launcher
    setup_path
    create_default_config

    show_completion
}

# 运行主函数
main "$@"
