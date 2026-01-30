---
name: remember
description: 记住用户偏好设置。使用此技能来保存用户的工作偏好、代码风格、输出格式等偏好，这些偏好将在后续所有会话中自动应用。
---

## 使用场景

当用户明确表达希望你记住某个偏好时，使用此技能来保存。例如：

- "记住我喜欢简洁的代码风格"
- "以后回复都用中文"
- "不要在代码中添加过多注释"
- "/remember 使用 TypeScript 严格模式"

## 偏好保存方法

通过 HTTP API 调用保存偏好：

```bash
# 添加全局偏好（所有项目生效）
curl -X POST http://localhost:4096/preferences \
  -H "Content-Type: application/json" \
  -d '{"content": "偏好内容", "scope": "global", "source": "ai"}'

# 添加项目偏好（仅当前项目生效）
curl -X POST http://localhost:4096/preferences \
  -H "Content-Type: application/json" \
  -d '{"content": "偏好内容", "scope": "project", "source": "ai"}'
```

## 操作步骤

1. **识别偏好**：从用户消息中提取偏好内容
2. **确认范围**：询问用户是全局偏好还是项目偏好（如果不确定）
3. **保存偏好**：使用 Bash 工具调用 curl 命令保存偏好
4. **确认结果**：告知用户偏好已保存

## 偏好格式建议

- 使用简洁、明确的语言描述偏好
- 避免过于具体的项目细节
- 使用积极的陈述（"使用 X" 而不是 "不使用 Y"）

## 示例对话

**用户**: /remember 我喜欢使用 TypeScript 严格模式

**AI**: 好的，我将为您记录这个偏好。这是全局偏好（所有项目生效）还是仅针对当前项目？

**用户**: 全局

**AI**:
```bash
curl -X POST http://localhost:4096/preferences \
  -H "Content-Type: application/json" \
  -d '{"content": "使用 TypeScript 严格模式", "scope": "global", "source": "ai"}'
```

已为您保存偏好：**使用 TypeScript 严格模式**（全局）。这个偏好将在后续所有会话中自动应用。

## 查看和管理偏好

用户可以通过以下方式管理偏好：
- 在 Nine1Bot Web 界面的「设置 → 偏好」中查看和编辑
- 使用 API 直接管理（GET/DELETE /preferences/:id）

## 注意事项

- 偏好会在每次对话开始时自动注入到系统提示词中
- 项目偏好会覆盖同类型的全局偏好
- 建议保持偏好数量适中，避免过多偏好导致冲突
