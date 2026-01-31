#!/bin/bash
set -e

# ============================================
# Nine1Bot 启动测试脚本
# 用法: ./test-startup.sh <platform> <arch> <build_dir>
# 返回: 0 成功, 1 失败
# ============================================

PLATFORM=$1
ARCH=$2
BUILD_DIR=$3

if [ -z "$PLATFORM" ] || [ -z "$ARCH" ] || [ -z "$BUILD_DIR" ]; then
    echo "Usage: $0 <platform> <arch> <build_dir>"
    exit 1
fi

echo "Testing Nine1Bot startup for ${PLATFORM}-${ARCH}..."
echo "Build directory: $BUILD_DIR"

# 验证构建目录存在
if [ ! -d "$BUILD_DIR" ]; then
    echo "ERROR: Build directory does not exist: $BUILD_DIR"
    exit 1
fi

# 创建最小测试配置 (无需 API key)
TEST_CONFIG="$BUILD_DIR/nine1bot.config.jsonc"

cat > "$TEST_CONFIG" << 'EOF'
{
  "server": {
    "port": 4097,
    "hostname": "127.0.0.1",
    "openBrowser": false
  },
  "auth": {
    "enabled": false
  },
  "tunnel": {
    "enabled": false
  }
}
EOF

echo "Created test config: $TEST_CONFIG"

# 根据平台确定启动命令
if [ "$PLATFORM" = "windows" ]; then
    LAUNCHER="$BUILD_DIR/nine1bot.bat"
    BUN_EXE="$BUILD_DIR/runtime/bun.exe"
else
    LAUNCHER="$BUILD_DIR/nine1bot"
    BUN_EXE="$BUILD_DIR/runtime/bun"
fi

# 验证启动器存在
if [ ! -f "$LAUNCHER" ]; then
    echo "ERROR: Launcher not found: $LAUNCHER"
    exit 1
fi

# 验证 Bun 运行时存在
if [ ! -f "$BUN_EXE" ]; then
    echo "ERROR: Bun runtime not found: $BUN_EXE"
    exit 1
fi

echo "Launcher: $LAUNCHER"
echo "Bun runtime: $BUN_EXE"

# 超时设置
TIMEOUT_SECONDS=60
SUCCESS_PATTERN="Local:.*http"

# 启动服务器并捕获输出
LOG_FILE=$(mktemp)

echo "Starting Nine1Bot with test configuration..."
echo "Waiting for startup (timeout: ${TIMEOUT_SECONDS}s)..."

# 平台特定的启动方式
cd "$BUILD_DIR"
if [ "$PLATFORM" = "windows" ]; then
    # Windows: 通过 cmd 调用 bat 文件
    cmd //c "nine1bot.bat" > "$LOG_FILE" 2>&1 &
    PROC_PID=$!
else
    # Unix: 直接执行
    ./nine1bot > "$LOG_FILE" 2>&1 &
    PROC_PID=$!
fi

echo "Process started with PID: $PROC_PID"

# 监控启动状态
START_TIME=$(date +%s)
SUCCESS=0

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    # 检查进程是否还在运行
    if ! kill -0 "$PROC_PID" 2>/dev/null; then
        echo "Process exited unexpectedly"
        echo "=== Server Output ==="
        cat "$LOG_FILE"
        echo "===================="
        SUCCESS=0
        break
    fi

    # 检查成功模式
    if grep -qE "$SUCCESS_PATTERN" "$LOG_FILE" 2>/dev/null; then
        echo "SUCCESS: Server started successfully!"
        echo "=== Server Output ==="
        cat "$LOG_FILE"
        echo "===================="
        SUCCESS=1
        break
    fi

    # 检查超时
    if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
        echo "TIMEOUT: Server did not start within ${TIMEOUT_SECONDS} seconds"
        echo "=== Server Output ==="
        cat "$LOG_FILE"
        echo "===================="
        SUCCESS=0
        break
    fi

    sleep 1
done

# 清理: 终止服务器进程
echo "Stopping server..."
if [ "$PLATFORM" = "windows" ]; then
    taskkill //F //PID "$PROC_PID" //T 2>/dev/null || true
else
    kill "$PROC_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PROC_PID" 2>/dev/null || true
fi

# 清理临时文件
rm -f "$LOG_FILE" "$TEST_CONFIG"

# 返回结果
if [ "$SUCCESS" -eq 1 ]; then
    echo "Startup test PASSED for ${PLATFORM}-${ARCH}"
    exit 0
else
    echo "Startup test FAILED for ${PLATFORM}-${ARCH}"
    exit 1
fi
