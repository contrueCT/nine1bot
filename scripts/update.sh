#!/bin/bash
set -e

# ============================================
# Nine1Bot 更新脚本
# 支持 Git 安装和 Release 安装两种方式
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 配置
GITHUB_REPO="contrueCT/nine1bot"
INSTALL_DIR="${NINE1BOT_INSTALL_DIR:-$HOME/.nine1bot}"

# 如果脚本在安装目录内运行，自动检测安装目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../VERSION" ] || [ -d "$SCRIPT_DIR/../runtime" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$SCRIPT_DIR/../packages/nine1bot/package.json" ]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

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

# 检测安装类型
detect_install_type() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "git"
    elif [ -f "$INSTALL_DIR/runtime/bun" ] || [ -f "$INSTALL_DIR/runtime/bun.exe" ]; then
        echo "release"
    elif [ -f "$INSTALL_DIR/VERSION" ]; then
        echo "release"
    else
        echo "unknown"
    fi
}

# 检测平台
detect_platform() {
    case "$(uname -s)" in
        Linux*)     echo "linux";;
        Darwin*)    echo "darwin";;
        MINGW*|MSYS*|CYGWIN*) echo "windows";;
        *)          echo "unknown";;
    esac
}

# 检测架构
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)   echo "x64";;
        aarch64|arm64)  echo "arm64";;
        *)              echo "unknown";;
    esac
}

# 确保 Bun 在 PATH 中
setup_bun() {
    # 优先使用内嵌的 Bun
    if [ -f "$INSTALL_DIR/runtime/bun" ]; then
        export PATH="$INSTALL_DIR/runtime:$PATH"
    elif [ -f "$INSTALL_DIR/runtime/bun.exe" ]; then
        export PATH="$INSTALL_DIR/runtime:$PATH"
    else
        # 使用系统 Bun
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
    fi
}

# Git 方式更新
update_git() {
    log_info "检测到 Git 安装，使用 git pull 更新..."

    cd "$INSTALL_DIR"

    # 检查是否有未提交的更改
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        log_warning "检测到本地修改，建议先提交或暂存"
        read -p "是否继续更新? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "更新已取消"
            exit 0
        fi
    fi

    # 拉取最新代码
    log_info "拉取最新代码..."
    git pull origin main || git pull origin master || {
        log_error "git pull 失败"
        exit 1
    }

    setup_bun

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

    log_success "更新完成!"
}

# Release 方式更新
update_release() {
    log_info "检测到 Release 安装，从 GitHub 下载更新..."

    local platform=$(detect_platform)
    local arch=$(detect_arch)

    if [ "$platform" = "unknown" ] || [ "$arch" = "unknown" ]; then
        log_error "不支持的平台: $(uname -s) $(uname -m)"
        exit 1
    fi

    # 获取当前版本
    local current_version="v0.0.0"
    if [ -f "$INSTALL_DIR/VERSION" ]; then
        current_version=$(cat "$INSTALL_DIR/VERSION" | tr -d '[:space:]')
    fi
    log_info "当前版本: $current_version"

    # 获取最新版本
    log_info "检查最新版本..."
    local api_response
    api_response=$(curl -s "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null)

    if [ -z "$api_response" ]; then
        log_error "无法连接到 GitHub API"
        exit 1
    fi

    local latest_version
    latest_version=$(echo "$api_response" | grep '"tag_name"' | head -1 | cut -d'"' -f4)

    if [ -z "$latest_version" ]; then
        log_error "无法获取最新版本信息"
        log_info "API 响应: $api_response"
        exit 1
    fi

    log_info "最新版本: $latest_version"

    # 对比版本
    if [ "$current_version" = "$latest_version" ]; then
        log_success "已是最新版本，无需更新"
        return 0
    fi

    log_info "发现新版本: $current_version -> $latest_version"

    # 构建下载 URL
    local archive_ext="tar.gz"
    [ "$platform" = "windows" ] && archive_ext="zip"

    local download_url="https://github.com/$GITHUB_REPO/releases/download/$latest_version/nine1bot-$platform-$arch-$latest_version.$archive_ext"
    log_info "下载地址: $download_url"

    # 创建临时目录
    local tmp_dir="/tmp/nine1bot-update-$$"
    mkdir -p "$tmp_dir"

    # 备份配置文件
    local config_backup="$tmp_dir/config-backup"
    mkdir -p "$config_backup"

    log_info "备份配置文件..."
    cp "$INSTALL_DIR/nine1bot.config.jsonc" "$config_backup/" 2>/dev/null || \
    cp "$INSTALL_DIR/nine1bot.config.json" "$config_backup/" 2>/dev/null || true

    # 下载新版本
    log_info "下载新版本..."
    local archive_file="$tmp_dir/nine1bot.$archive_ext"

    if ! curl -fsSL "$download_url" -o "$archive_file"; then
        log_error "下载失败"
        rm -rf "$tmp_dir"
        exit 1
    fi

    # 解压
    log_info "解压文件..."
    if [ "$archive_ext" = "zip" ]; then
        unzip -q "$archive_file" -d "$tmp_dir"
    else
        tar -xzf "$archive_file" -C "$tmp_dir"
    fi

    # 找到解压后的目录
    local extracted_dir=$(find "$tmp_dir" -maxdepth 1 -type d -name "nine1bot-*" | head -1)
    if [ -z "$extracted_dir" ]; then
        log_error "解压失败，未找到目标目录"
        rm -rf "$tmp_dir"
        exit 1
    fi

    # 替换文件
    log_info "更新文件..."

    # 使用 rsync 或 cp 替换文件（排除配置）
    if command -v rsync >/dev/null 2>&1; then
        rsync -av --delete \
            --exclude='nine1bot.config.jsonc' \
            --exclude='nine1bot.config.json' \
            "$extracted_dir/" "$INSTALL_DIR/"
    else
        # 备份配置
        local temp_config="/tmp/nine1bot-config-temp-$$"
        mkdir -p "$temp_config"
        cp "$INSTALL_DIR/nine1bot.config.jsonc" "$temp_config/" 2>/dev/null || \
        cp "$INSTALL_DIR/nine1bot.config.json" "$temp_config/" 2>/dev/null || true

        # 替换所有文件
        rm -rf "$INSTALL_DIR"/*
        cp -r "$extracted_dir"/* "$INSTALL_DIR/"

        # 恢复配置
        cp "$temp_config"/* "$INSTALL_DIR/" 2>/dev/null || true
        rm -rf "$temp_config"
    fi

    # 恢复配置文件（如果被覆盖）
    if [ -f "$config_backup/nine1bot.config.jsonc" ]; then
        cp "$config_backup/nine1bot.config.jsonc" "$INSTALL_DIR/"
    elif [ -f "$config_backup/nine1bot.config.json" ]; then
        cp "$config_backup/nine1bot.config.json" "$INSTALL_DIR/"
    fi

    # 确保脚本可执行
    chmod +x "$INSTALL_DIR/nine1bot" 2>/dev/null || true
    chmod +x "$INSTALL_DIR/runtime/bun" 2>/dev/null || true
    chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true

    # 清理
    rm -rf "$tmp_dir"

    log_success "更新完成: $latest_version"
    echo ""
    echo -e "运行 ${CYAN}nine1bot${NC} 启动服务"
}

# 显示帮助
show_help() {
    echo "Nine1Bot 更新脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  -h, --help     显示帮助信息"
    echo "  -f, --force    强制更新（跳过版本检查）"
    echo "  -c, --check    仅检查是否有新版本"
    echo ""
    echo "环境变量:"
    echo "  NINE1BOT_INSTALL_DIR  安装目录 (默认: ~/.nine1bot)"
    echo "  GITHUB_REPO           GitHub 仓库地址"
}

# 仅检查更新
check_update() {
    local install_type=$(detect_install_type)

    if [ "$install_type" = "release" ]; then
        local current_version="v0.0.0"
        if [ -f "$INSTALL_DIR/VERSION" ]; then
            current_version=$(cat "$INSTALL_DIR/VERSION" | tr -d '[:space:]')
        fi

        local api_response
        api_response=$(curl -s "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null)
        local latest_version
        latest_version=$(echo "$api_response" | grep '"tag_name"' | head -1 | cut -d'"' -f4)

        echo "当前版本: $current_version"
        echo "最新版本: $latest_version"

        if [ "$current_version" = "$latest_version" ]; then
            echo "已是最新版本"
        else
            echo "有新版本可用!"
        fi
    else
        log_info "Git 安装，请使用 git fetch 检查更新"
        cd "$INSTALL_DIR"
        git fetch
        git status
    fi
}

# 主函数
main() {
    # 解析参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -c|--check)
                check_update
                exit 0
                ;;
            -f|--force)
                FORCE_UPDATE=true
                shift
                ;;
            *)
                log_error "未知选项: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # 检查安装目录
    if [ ! -d "$INSTALL_DIR" ]; then
        log_error "Nine1Bot 未安装，安装目录不存在: $INSTALL_DIR"
        exit 1
    fi

    log_info "安装目录: $INSTALL_DIR"

    # 检测安装类型并更新
    local install_type=$(detect_install_type)
    log_info "安装类型: $install_type"

    case "$install_type" in
        git)
            update_git
            ;;
        release)
            update_release
            ;;
        *)
            log_error "无法检测安装类型"
            log_info "提示: Git 安装应有 .git 目录，Release 安装应有 runtime/bun 或 VERSION 文件"
            exit 1
            ;;
    esac
}

main "$@"
