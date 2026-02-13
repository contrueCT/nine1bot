# Nine1Bot

[简体中文](./README.zh.md)

A versatile personal AI assistant featuring a web interface and tunnel support for remote access.

Supports programming, file management, information retrieval, content creation, and more through natural language interaction.

> **Security Warning**
>
> Nine1Bot can execute system commands and read/write files. Security is not fully guaranteed yet:
>
> - Avoid running complex tasks on devices with important data
> - Don't let AI access sensitive files or credentials
> - Consider using in a virtual machine or test environment
> - Back up important data regularly

## Features

### Core Capabilities

- **Programming** - Code writing, debugging, refactoring, code review, supporting multiple languages and frameworks
- **File Management** - Read, create, edit, organize files, batch rename, directory structure management
- **File Preview** - Preview images, code, Markdown, HTML, Office documents in Web UI
- **File Upload** - Upload files directly through the web interface for AI processing
- **Command Execution** - Run system commands, script writing, environment configuration, automation
- **Information Retrieval** - Web search, data analysis, content extraction and summarization
- **Content Creation** - Document writing, report generation, email drafting, translation, copywriting
- **Office Tasks** - Meeting notes, scheduling, spreadsheet processing, format conversion
- **Task Management** - Todo tracking, work breakdown, progress management, reminders
- **Q&A** - Technical consulting, solution suggestions, troubleshooting, tutoring

### Product Features

- **Web Interface** - Modern chat interface with Markdown rendering, code highlighting, agent console monitoring
- **Multi-Model Support** - Anthropic Claude, OpenAI, Google Gemini, OpenRouter, and more
- **Session Working Directory** - Each session can have its own working directory with built-in directory browsing
- **User Preferences** - Record personal preferences, AI follows your habits across all sessions
- **Terminal History** - Scrollback history support for terminal output
- **Tunnel Support** - Built-in ngrok and NATAPP support for public access
- **Password Protection** - Optional web access password protection (username: `nine1bot`)
- **Parallel Sessions** - Run up to 10 AI sessions simultaneously
- **Hot Reload** - Skills and MCP config changes take effect automatically without restart
- **Ready to Use** - Download and run, includes Bun runtime

### Built-in Skills

Nine1Bot includes several built-in skills, invoked via `/skill-name`:

| Skill            | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `/remember`      | Record user preferences, AI follows them in all sessions |
| `/pdf`           | PDF processing: extract text, merge/split, form filling  |
| `/docx`          | Word document creation, editing, revision tracking       |
| `/pptx`          | PowerPoint presentation creation and editing             |
| `/mcp-builder`   | Development guide for creating MCP servers               |
| `/skill-creator` | Development guide for creating custom Skills             |

You can also add custom Skills in `~/.config/nine1bot/skills/`.

### Configuration Compatibility

Nine1Bot supports integrating configurations from:

| Config Type        | OpenCode | Claude Code | Notes                                                              |
| ------------------ | -------- | ----------- | ------------------------------------------------------------------ |
| MCP Servers        | ✅       | ✅          | Can inherit MCP config from OpenCode and Claude Code               |
| Skills             | ✅       | ✅          | Can inherit custom skills from OpenCode and Claude Code            |
| Provider Auth      | ✅       | ❌          | Can inherit API Keys and OAuth from OpenCode                       |
| Official Providers | ❌       | -           | OpenCode official providers not supported (requires authorization) |

Control inheritance through config:

```jsonc
{
  "isolation": {
    "inheritOpencode": true, // Inherit OpenCode config
    "inheritClaudeCode": true, // Inherit Claude Code config
  },
}
```

## Installation

### Option 1: Download Release (Recommended)

Download from [Releases](https://github.com/contrueCT/nine1bot/releases):

| Platform | Architecture  | Filename                              |
| -------- | ------------- | ------------------------------------- |
| Linux    | x64           | `nine1bot-linux-x64-vX.X.X.tar.gz`    |
| Linux    | ARM64         | `nine1bot-linux-arm64-vX.X.X.tar.gz`  |
| macOS    | Apple Silicon | `nine1bot-darwin-arm64-vX.X.X.tar.gz` |
| Windows  | x64           | `nine1bot-windows-x64-vX.X.X.zip`     |

**Linux / macOS:**

```bash
# Download and extract (Linux x64 example)
curl -fsSL https://github.com/contrueCT/nine1bot/releases/latest/download/nine1bot-linux-x64.tar.gz | tar -xz
cd nine1bot-linux-x64

# Run
./nine1bot
```

**Windows:**

1. Download `nine1bot-windows-x64-vX.X.X.zip`
2. Extract to any directory
3. Double-click `nine1bot.bat` or run from command line

### Option 2: One-Line Install Script (Linux / macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/contrueCT/nine1bot/main/install.sh | bash
```

After installation, run `nine1bot` from any directory.

### Option 3: Install from Source

Requires [Bun](https://bun.sh).

```bash
# Clone repository
git clone https://github.com/contrueCT/nine1bot.git
cd nine1bot

# Install dependencies
cd opencode && bun install && cd ..
cd packages/nine1bot && bun install && cd ../..
cd web && bun install && cd ..

# Build web frontend
cd web && bun run build && cd ..

# Run
bun run nine1bot
```

## Usage

### First Run

On first run, you'll be prompted to run the setup wizard:

```
Welcome to Nine1Bot! Would you like to run the setup wizard?
```

The wizard guides you through:

- Server port (default 4096)
- Password protection (optional)
- Tunnel configuration (optional, for public access)
- AI Provider API Key

You can skip and run `nine1bot setup` later.

### Command Line

```bash
# Start server (default command)
nine1bot

# Specify port
nine1bot --port 8080
nine1bot -p 8080

# Enable tunnel
nine1bot --tunnel
nine1bot -t

# Don't open browser automatically
nine1bot --no-browser

# Run setup wizard
nine1bot setup

# View config
nine1bot config show

# Set config value
nine1bot config set server.port 8080

# Edit config file
nine1bot config edit

# Show help
nine1bot --help
```

### Web Interface

After starting, open `http://127.0.0.1:4096` (or your configured port) in browser.

Features:

- Create multiple sessions with independent working directories
- Browse and select working directories per session
- Upload files for AI processing
- Switch AI models
- View and manage files
- Watch AI thinking process in real-time
- Abort running tasks

### User Preferences

Nine1Bot can remember your personal preferences. AI will automatically follow these preferences in all sessions.

#### Setting Preferences

**Option 1: Web Interface**

Click the "Preferences" tab in settings panel to add, edit, or delete preferences.

**Option 2: Use /remember command in chat**

Tell AI your preferences directly in conversation:

```
/remember Reply in English
/remember Use 4-space indentation for code
/remember Don't use emoji
```

#### Preference Examples

- `Reply in English` - AI will respond in English
- `Use 4-space indentation for code` - Generated code uses 4-space indentation
- `Give detailed code explanations` - AI provides more detailed code explanations
- `Write commit messages in English` - Git commit messages will be in English

Preferences are automatically injected into every conversation prompt.

## Configuration

Config file locations:

- **Project config**: `nine1bot.config.jsonc` (installation directory)
- **Global config**: `~/.config/nine1bot/config.jsonc` (Linux/macOS) or `%APPDATA%\nine1bot\config.jsonc` (Windows)

### Config Example

```jsonc
{
  // Server config
  "server": {
    "port": 4096,
    "hostname": "127.0.0.1",
    "openBrowser": true,
  },

  // Password protection (username is fixed as "nine1bot")
  "auth": {
    "enabled": true,
    "password": "your-password",
  },

  // Tunnel config
  "tunnel": {
    "enabled": true,
    "provider": "ngrok", // or "natapp"
    "ngrok": {
      "authToken": "your-ngrok-token",
    },
  },

  // AI Provider config
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-ant-xxxxx",
      },
    },
  },

  // Default model
  "model": "anthropic/claude-sonnet-4-20250514",
}
```

### Environment Variables

Config files support environment variable substitution:

```jsonc
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}",
      },
    },
  },
}
```

### Tunnel Configuration

> **Tunnel Security Warning**
>
> Enabling tunnel exposes your Nine1Bot instance to the internet. Please note:
>
> - **Strongly recommended to enable password protection**: Without a password, anyone can access and control your AI assistant
> - **Tunnel URLs are logged**: Services like ngrok/NATAPP record access logs
> - **Don't share tunnel URLs**: Unless you trust the recipient
> - **Close unused tunnels promptly**: Prolonged public exposure increases attack risk
> - **Avoid processing sensitive data in tunnel mode**: Public transmission may be intercepted

#### ngrok (International)

1. Register at [ngrok](https://ngrok.com)
2. Get [authtoken](https://dashboard.ngrok.com/authtokens)
3. Configure:

```jsonc
{
  "tunnel": {
    "enabled": true,
    "provider": "ngrok",
    "ngrok": {
      "authToken": "your-ngrok-token",
    },
  },
}
```

#### NATAPP (China)

1. Register at [NATAPP](https://natapp.cn)
2. Create tunnel, get authtoken
3. Download NATAPP client and add to PATH
4. Configure:

```jsonc
{
  "tunnel": {
    "enabled": true,
    "provider": "natapp",
    "natapp": {
      "authToken": "your-natapp-token",
    },
  },
}
```

## Update

### Release Installation

```bash
# Run update script
./scripts/update.sh
```

### Source Installation

```bash
cd ~/.nine1bot  # or your installation directory
git pull
cd opencode && bun install && cd ..
cd packages/nine1bot && bun install && cd ../..
cd web && bun install && bun run build && cd ..
```

## Uninstall

### Release Installation

Simply delete the extracted directory.

### Script Installation

```bash
~/.nine1bot/scripts/uninstall.sh
```

Or manually:

```bash
rm -rf ~/.nine1bot
rm ~/.local/bin/nine1bot
```

## System Requirements

- **OS**: Linux, macOS, Windows
- **Memory**: 4GB+ recommended
- **Network**: Access to AI Provider APIs required

## FAQ

### Port in use

Use `--port` to specify another port:

```bash
nine1bot --port 8080
```

### Command not found

If `nine1bot` command not found after script installation:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

Or restart your terminal.

### Run in background

```bash
nohup nine1bot --no-browser > nine1bot.log 2>&1 &
```

Or use systemd service (see [INSTALL.md](./INSTALL.md)).

## Development

```bash
# Start development mode
bun run dev

# Start web dev server
bun run web

# Build web frontend
bun run build:web
```

## Contributing

Welcome to contribute to Nine1Bot!

- Submit Issues for bugs or suggestions
- Submit Pull Requests to contribute code
- Share usage experiences and best practices
- Help improve documentation and translations

## Acknowledgments

Thanks to the [OpenCode](https://github.com/opencode-ai/opencode) community. Nine1Bot is built on OpenCode.

## License

[MIT](./LICENSE)
