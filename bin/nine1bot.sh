#!/bin/bash
# Nine1Bot 启动脚本 (Linux/macOS)

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 将内置 Bun 运行时添加到 PATH
export PATH="$SCRIPT_DIR/runtime:$PATH"

# 运行 Nine1Bot
exec "$SCRIPT_DIR/runtime/bun" run "$SCRIPT_DIR/packages/nine1bot/src/index.ts" "$@"
