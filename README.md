# Nine1Bot

多功能个人 AI 助手，基于 OpenCode 构建，提供 Web 界面和隧道支持，可远程访问。

支持编程开发、文件管理、信息检索、内容创作等多种任务，通过自然语言交互完成复杂操作。

> **安全警告**
>
> Nine1Bot 具备执行系统命令、读写文件等能力。目前的安全性尚未得到完全保障，请注意：
> - 避免在存储重要数据的设备上执行复杂任务
> - 不要让 AI 访问敏感文件或凭据
> - 建议在虚拟机或测试环境中使用
> - 定期备份重要数据

## 功能特点

### 核心能力

- **编程开发** - 代码编写、调试、重构、代码审查，支持多种编程语言和框架
- **文件管理** - 读取、创建、编辑、整理文件，批量重命名，目录结构管理
- **命令执行** - 运行系统命令，脚本编写，环境配置，自动化任务
- **信息检索** - 网页搜索，资料整理，数据分析，内容提取与总结
- **内容创作** - 文档撰写，报告生成，邮件起草，翻译润色，文案优化
- **日常办公** - 会议纪要整理，日程规划，数据表格处理，格式转换
- **任务管理** - 待办事项跟踪，工作拆解，进度管理，提醒备忘
- **问题解答** - 技术咨询，方案建议，故障排查，学习辅导

### 产品特性

- **Web 界面** - 现代化的聊天界面，支持 Markdown 渲染、代码高亮、agent控制台监控
- **多模型支持** - Anthropic Claude、OpenAI、Google Gemini、OpenRouter 等
- **隧道支持** - 内置 ngrok 和 NATAPP 支持，可从公网访问
- **密码保护** - 可选的 Web 访问密码保护
- **并行会话** - 支持同时运行至多10个 AI 会话
- **开箱即用** - 下载即可运行，内置 Bun 运行时

### 配置兼容性

Nine1Bot 支持集成以下配置：

| 配置类型 | OpenCode | Claude Code | 说明 |
|---------|----------|-------------|------|
| MCP 服务器 | ✅ | ✅ | 可继承 OpenCode 和 Claude Code 的 MCP 配置 |
| Skills 技能 | ✅ | ✅ | 可继承 OpenCode 和 Claude Code 的自定义技能 |
| 服务商认证 | ✅ | ❌ | 可继承 OpenCode 的 API Key 和 OAuth 认证 |
| 官方服务商 | ❌ | - | 不支持 OpenCode 官方服务商（需要官方授权） |

可通过配置文件控制是否继承这些配置：

```jsonc
{
  "isolation": {
    "inheritOpencode": true,      // 是否继承 OpenCode 配置
    "inheritClaudeCode": true     // 是否继承 Claude Code 配置
  }
}
```

## 安装

### 方式一：下载 Release（推荐）

从 [Releases](https://github.com/contrueCT/nine1bot/releases) 下载对应平台的压缩包：

| 平台 | 架构 | 文件名 |
|------|------|--------|
| Linux | x64 | `nine1bot-linux-x64-vX.X.X.tar.gz` |
| Linux | ARM64 | `nine1bot-linux-aarch64-vX.X.X.tar.gz` |
| macOS | Intel | `nine1bot-darwin-x64-vX.X.X.tar.gz` |
| macOS | Apple Silicon | `nine1bot-darwin-aarch64-vX.X.X.tar.gz` |
| Windows | x64 | `nine1bot-windows-x64-vX.X.X.zip` |

**Linux / macOS:**

```bash
# 下载并解压（以 Linux x64 为例）
curl -fsSL https://github.com/contrueCT/nine1bot/releases/latest/download/nine1bot-linux-x64.tar.gz | tar -xz
cd nine1bot-linux-x64

# 运行
./nine1bot
```

**Windows:**

1. 下载 `nine1bot-windows-x64-vX.X.X.zip`
2. 解压到任意目录
3. 双击 `nine1bot.bat` 或在命令行运行

### 方式二：一键安装脚本（Linux / macOS）

```bash
curl -fsSL https://raw.githubusercontent.com/contrueCT/nine1bot/main/install.sh | bash
```

安装完成后，可以在任意目录运行 `nine1bot` 命令。

### 方式三：从源码安装

需要先安装 [Bun](https://bun.sh)。

```bash
# 克隆仓库
git clone https://github.com/contrueCT/nine1bot.git
cd nine1bot

# 安装依赖
cd opencode && bun install && cd ..
cd packages/nine1bot && bun install && cd ../..
cd web && bun install && cd ..

# 构建 Web 前端
cd web && bun run build && cd ..

# 运行
bun run nine1bot
```

## 使用

### 首次运行

首次运行时，会提示是否运行配置向导：

```
Welcome to Nine1Bot! Would you like to run the setup wizard?
```

配置向导会引导你设置：
- 服务端口（默认 4096）
- 密码保护（可选）
- 隧道配置（可选，用于公网访问）
- AI Provider API Key

你也可以跳过向导，之后运行 `nine1bot setup` 单独配置。

### 命令行

```bash
# 启动服务（默认命令）
nine1bot

# 指定端口
nine1bot --port 8080
nine1bot -p 8080

# 启用隧道
nine1bot --tunnel
nine1bot -t

# 不自动打开浏览器
nine1bot --no-browser

# 运行配置向导
nine1bot setup

# 查看配置
nine1bot config show

# 设置配置项
nine1bot config set server.port 8080

# 编辑配置文件
nine1bot config edit

# 查看帮助
nine1bot --help
```

### Web 界面

启动后，在浏览器打开 `http://127.0.0.1:4096`（或配置的端口）。

功能：
- 创建多个会话
- 切换不同的 AI 模型
- 查看和管理文件
- 实时查看 AI 思考过程
- 中止正在运行的任务

## 配置

配置文件位置：
- **项目配置**：`nine1bot.config.jsonc`（安装目录）
- **全局配置**：`~/.config/nine1bot/config.jsonc`（Linux/macOS）或 `%APPDATA%\nine1bot\config.jsonc`（Windows）

### 配置示例

```jsonc
{
  // 服务器配置
  "server": {
    "port": 4096,
    "hostname": "127.0.0.1",
    "openBrowser": true
  },

  // 密码保护
  "auth": {
    "enabled": true,
    "password": "your-password"
  },

  // 隧道配置
  "tunnel": {
    "enabled": true,
    "provider": "ngrok",  // 或 "natapp"
    "ngrok": {
      "authToken": "your-ngrok-token"
    }
  },

  // AI Provider 配置
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-ant-xxxxx"
      }
    }
  },

  // 默认模型
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

### 环境变量

配置文件支持环境变量替换：

```jsonc
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### 隧道配置

> **隧道安全警告**
>
> 启用隧道会将你的 Nine1Bot 实例暴露到公网，请务必注意以下风险：
> - **强烈建议启用密码保护**：未设置密码时，任何人都可以通过隧道 URL 访问并控制你的 AI 助手
> - **隧道 URL 会被记录**：ngrok/NATAPP 等服务商会记录你的隧道访问日志
> - **不要分享隧道 URL**：除非你信任对方，否则不要将隧道地址分享给他人
> - **及时关闭不使用的隧道**：长时间暴露在公网增加被攻击的风险
> - **避免在隧道模式下处理敏感数据**：公网传输存在被拦截的可能

#### ngrok（国际）

1. 注册 [ngrok](https://ngrok.com) 账号
2. 获取 [authtoken](https://dashboard.ngrok.com/authtokens)
3. 配置：

```jsonc
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

#### NATAPP（国内）

1. 注册 [NATAPP](https://natapp.cn) 账号
2. 创建隧道，获取 authtoken
3. 下载 NATAPP 客户端并添加到 PATH
4. 配置：

```jsonc
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

## 更新

### Release 安装方式

```bash
# 运行更新脚本
./scripts/update.sh
```

### 源码安装方式

```bash
cd ~/.nine1bot  # 或你的安装目录
git pull
cd opencode && bun install && cd ..
cd packages/nine1bot && bun install && cd ../..
cd web && bun install && bun run build && cd ..
```

## 卸载

### Release 安装方式

直接删除解压的目录即可。

### 脚本安装方式

```bash
~/.nine1bot/scripts/uninstall.sh
```

或手动删除：

```bash
rm -rf ~/.nine1bot
rm ~/.local/bin/nine1bot
```

## 系统要求

- **操作系统**：Linux、macOS、Windows
- **内存**：建议 4GB 以上
- **网络**：需要能访问 AI Provider API

## 常见问题

### 端口被占用

使用 `--port` 参数指定其他端口：

```bash
nine1bot --port 8080
```

### 命令找不到

如果使用脚本安装后 `nine1bot` 命令找不到，运行：

```bash
source ~/.bashrc  # 或 source ~/.zshrc
```

或重新打开终端。

### 后台运行

```bash
nohup nine1bot --no-browser > nine1bot.log 2>&1 &
```

或使用 systemd 服务（参见 [INSTALL.md](./INSTALL.md)）。

## 开发

```bash
# 启动开发模式
bun run dev

# 启动 Web 开发服务器
bun run web

# 构建 Web 前端
bun run build:web
```

## 参与贡献

欢迎参与 Nine1Bot 的开发，一起丰富国内 Agent 生态！

- 提交 Issue 反馈问题或建议
- 提交 Pull Request 贡献代码
- 分享使用经验和最佳实践
- 帮助完善文档和翻译

## 致谢

感谢 [OpenCode](https://github.com/opencode-ai/opencode) 社区的开源贡献，Nine1Bot 基于 OpenCode 构建。

## License

[MIT](./LICENSE)
