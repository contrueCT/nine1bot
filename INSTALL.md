# Nine1Bot 安装指南

## 快速安装（Linux/macOS）

```bash
# 一行命令安装
curl -fsSL https://raw.githubusercontent.com/contrueCT/nine1bot/main/install.sh | bash
```

安装脚本会自动完成：
1. 检测并安装 Bun 运行时
2. 下载 Nine1Bot 源码
3. 安装所有依赖
4. 构建 Web 前端
5. 创建全局命令 `nine1bot`

## 手动安装

如果自动安装失败，可以手动安装：

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc  # 或 source ~/.zshrc
```

### 2. 克隆项目

```bash
git clone https://github.com/contrueCT/nine1bot.git ~/.nine1bot
cd ~/.nine1bot
```

### 3. 安装依赖

```bash
# opencode 依赖
cd opencode && bun install && cd ..

# nine1bot 依赖
cd packages/nine1bot && bun install && cd ../..

# web 依赖
cd web && bun install && cd ..
```

### 4. 构建 Web 前端

```bash
cd web && bun run build && cd ..
```

### 5. 创建启动脚本

```bash
mkdir -p ~/.local/bin

cat > ~/.local/bin/nine1bot << 'EOF'
#!/bin/bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
exec bun run "$HOME/.nine1bot/packages/nine1bot/src/index.ts" "$@"
EOF

chmod +x ~/.local/bin/nine1bot
```

### 6. 添加到 PATH

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.bashrc
source ~/.bashrc
```

## 使用方法

```bash
# 启动服务（首次运行会触发配置向导）
nine1bot

# 运行配置向导
nine1bot setup

# 查看配置
nine1bot config show

# 启动并开启隧道
nine1bot start --tunnel

# 指定端口
nine1bot start --port 8080

# 查看帮助
nine1bot --help
```

## 更新

```bash
~/.nine1bot/scripts/update.sh
```

或手动更新：

```bash
cd ~/.nine1bot
git pull
cd opencode && bun install && cd ..
cd packages/nine1bot && bun install && cd ../..
cd web && bun install && bun run build && cd ..
```

## 卸载

```bash
~/.nine1bot/scripts/uninstall.sh
```

或手动卸载：

```bash
rm -rf ~/.nine1bot
rm ~/.local/bin/nine1bot
```

## 配置文件

运行 `nine1bot config show` 查看实际生效配置与来源。全局配置默认位于 `~/.config/nine1bot/config.jsonc`（Windows 为 `%USERPROFILE%\.config\nine1bot\config.jsonc`）；项目配置可能覆盖全局配置。

```json
{
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
```

在设置向导或 Web「设置 → 模型」中从当前可用目录选择模型。保存 API Key 不代表已验证凭据或模型权限；向导不会执行付费模型请求。已有默认模型不会被静默替换，失效时请重新选择。

## 隧道配置

公开隧道要求启用 Web 访问认证。先运行以下命令，交互设置密码并仅存储 Argon2id 哈希，再开启隧道：

```bash
nine1bot config set-password
```

旧配置中的明文 `auth.password` 可通过 `nine1bot config migrate-auth` 迁移。不要将密码写进配置示例或 shell 命令参数。

### ngrok（国际）

1. 注册 [ngrok](https://ngrok.com) 账号
2. 获取 authtoken
3. 配置：

```json
{
  "tunnel": {
    "enabled": true,
    "provider": "ngrok",
    "ngrok": {
      "authToken": "your-ngrok-token"
    }
  }
}
```

### NATAPP（国内）

1. 注册 [NATAPP](https://natapp.cn) 账号
2. 创建隧道，获取 authtoken
3. 下载 NATAPP 客户端并添加到 PATH
4. 配置：

```json
{
  "tunnel": {
    "enabled": true,
    "provider": "natapp",
    "natapp": {
      "authToken": "your-natapp-token"
    }
  }
}
```

## 系统要求

- **操作系统**: Linux、macOS；Windows 可从 [Releases](https://github.com/contrueCT/nine1bot/releases) 下载预编译发行包
- **运行时**: 源码安装需要 Bun（安装脚本会自动安装）；预编译发行包不需要单独安装运行时
- **网络**: 需要访问 AI 提供商 API

## 常见问题

### Q: 安装后 `nine1bot` 命令找不到

运行 `source ~/.bashrc` 或重新打开终端。

### Q: 端口被占用

使用 `--port` 参数指定其他端口：

```bash
nine1bot start --port 8080
```

### Q: 如何在后台运行

使用 `nohup` 或 `screen`：

```bash
nohup nine1bot start --no-browser > nine1bot.log 2>&1 &
```

或使用 systemd 服务（见下方）。

## systemd 服务（可选）

创建 `/etc/systemd/system/nine1bot.service`：

```ini
[Unit]
Description=Nine1Bot AI Assistant
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/your-username/.nine1bot
ExecStart=/home/your-username/.local/bin/nine1bot start --no-browser
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable nine1bot
sudo systemctl start nine1bot
```
