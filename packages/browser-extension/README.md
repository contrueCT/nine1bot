# Nine1Bot Browser Control Extension

Chrome 扩展，为 Nine1Bot 提供浏览器自动化能力。通过 MCP (Model Context Protocol) 协议暴露浏览器控制工具。

## 功能

- **截图** (`screenshot`) - 捕获标签页可见区域的截图
- **导航** (`navigate`) - 页面导航、前进、后退、刷新
- **读取页面** (`read_page`) - 获取 DOM/可访问性树
- **获取页面文本** (`get_page_text`) - 提取页面文本内容
- **查找元素** (`find`) - 自然语言查找页面元素
- **交互** (`computer`) - 鼠标点击、键盘输入、滚动等
- **表单输入** (`form_input`) - 设置表单元素值
- **标签页管理** (`tabs_context_mcp`, `tabs_create_mcp`) - 管理浏览器标签页

## 安装

### 开发模式

1. 构建扩展：

```bash
cd packages/browser-extension
npm install
npm run build
```

2. 在 Chrome 中加载：

   - 打开 `chrome://extensions/`
   - 启用"开发者模式"
   - 点击"加载已解压的扩展"
   - 选择 `packages/browser-extension/dist` 目录

### 从源码开发

```bash
# 监听模式构建
npm run dev

# 类型检查
npm run typecheck
```

## 使用方法

### 与 Nine1Bot 集成

扩展安装后，在 `nine1bot.config.jsonc` 中配置 MCP 连接：

```jsonc
{
  "mcp": {
    "browser-control": {
      "type": "remote",
      "url": "chrome-extension://YOUR_EXTENSION_ID",
      "enabled": true
    }
  }
}
```

### 直接调用工具

扩展通过 Chrome 消息 API 暴露工具。可以通过以下方式调用：

```javascript
// 从其他扩展或页面
chrome.runtime.sendMessage(
  EXTENSION_ID,
  {
    type: 'mcp-request',
    request: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'screenshot',
        arguments: { tabId: 123 }
      }
    }
  },
  (response) => {
    console.log(response)
  }
)
```

## 工具详情

### screenshot

捕获标签页可见区域的截图。

```json
{
  "name": "screenshot",
  "arguments": {
    "tabId": 123  // 可选，默认使用当前活动标签页
  }
}
```

### navigate

页面导航。

```json
{
  "name": "navigate",
  "arguments": {
    "tabId": 123,  // 可选
    "url": "https://example.com",  // goto 时必需
    "action": "goto"  // "goto" | "back" | "forward" | "reload"
  }
}
```

### read_page

读取页面 DOM 结构。

```json
{
  "name": "read_page",
  "arguments": {
    "tabId": 123,  // 可选
    "depth": 10,  // 遍历深度，默认 10
    "filter": "all",  // "all" | "interactive" | "visible"
    "ref_id": "ref_abc123",  // 聚焦特定元素
    "max_chars": 50000  // 最大输出字符数
  }
}
```

### computer

鼠标/键盘交互。

```json
{
  "name": "computer",
  "arguments": {
    "tabId": 123,  // 可选
    "action": "left_click",  // 见下方支持的动作
    "coordinate": [100, 200],  // 或使用 ref
    "ref": "ref_abc123",
    "text": "Hello",  // type/key 动作使用
    "scroll_direction": "down",  // scroll 动作使用
    "scroll_amount": 300
  }
}
```

支持的动作：
- `left_click`, `right_click`, `double_click`, `middle_click`
- `hover`, `drag`
- `scroll`
- `type`, `key`
- `wait`
- `screenshot`

### form_input

设置表单元素值。

```json
{
  "name": "form_input",
  "arguments": {
    "tabId": 123,  // 可选
    "ref": "ref_abc123",  // 元素引用 ID
    "value": "test@example.com"  // 要设置的值
  }
}
```

## 架构

```
┌─────────────────────┐         MCP Protocol          ┌──────────────────────┐
│    Nine1Bot         │ ◄───────────────────────────► │  Chrome Extension    │
│    Backend          │   (JSON-RPC over Messages)    │  (Service Worker)    │
└─────────────────────┘                               └──────────────────────┘
                                                               │
                                                               │ Chrome APIs
                                                               ▼
                                                    ┌──────────────────────┐
                                                    │   Browser Tabs       │
                                                    │   (Content Scripts)  │
                                                    └──────────────────────┘
```

## 权限说明

扩展需要以下权限：

- `tabs` - 管理标签页
- `activeTab` - 访问当前活动标签页
- `scripting` - 在页面中执行脚本
- `debugger` - 模拟鼠标/键盘输入
- `storage` - 存储配置
- `webNavigation` - 监听导航事件
- `<all_urls>` - 访问所有网站（用于内容脚本）

## 安全注意事项

- 扩展可以控制浏览器中打开的任何页面
- 不要在不信任的环境中使用
- 敏感操作（如支付）建议手动完成

## License

MIT
