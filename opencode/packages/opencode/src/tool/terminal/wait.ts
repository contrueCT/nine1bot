import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"

export const TerminalWaitTool = Tool.define("terminal_wait", {
  description: `Wait for specific content to appear in the terminal.

Use this after sending commands to wait for:
- Command completion (look for shell prompt like "$ " or "# ")
- Specific output text or patterns
- Error messages
- Interactive prompts (password:, [y/n], etc.)
- Process completion indicators

This is more efficient than repeatedly calling terminal_view. The tool will check the terminal screen every 100ms until the pattern is found or timeout occurs.

Pattern tips:
- Use regex for flexible matching
- For shell prompts: "\\\\$\\\\s*$" or "#\\\\s*$"
- For password prompts: "password:" or "Password:"
- For yes/no prompts: "\\\\[y/n\\\\]" or "\\\\(yes/no\\\\)"
- For specific text: just use the literal text

Examples:
- Wait for shell prompt: terminal_wait({ id: "xxx", pattern: "\\\\$\\\\s*$" })
- Wait for password prompt: terminal_wait({ id: "xxx", pattern: "password:" })
- Wait for specific text: terminal_wait({ id: "xxx", pattern: "Build successful" })
- Wait with custom timeout: terminal_wait({ id: "xxx", pattern: "Done", timeout: 60000 })`,

  parameters: z.object({
    id: z.string().describe("Terminal session ID"),
    pattern: z.string().describe("Text or regex pattern to wait for"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 30000)"),
  }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    const timeout = params.timeout || 30000

    // Update metadata to show we're waiting
    ctx.metadata({
      title: `Waiting for pattern in ${info.name}`,
      metadata: {
        terminalId: params.id,
        pattern: params.pattern,
        status: "waiting",
      },
    })

    const result = await AgentTerminal.waitFor(params.id, params.pattern, timeout)

    const screenInfo = AgentTerminal.getScreenInfo(params.id)
    const width = Math.min(screenInfo?.cols || 80, 80)

    if (result.matched) {
      return {
        title: `Pattern found in ${info.name}`,
        output: `Pattern "${params.pattern}" found in terminal.

Current screen:
${"─".repeat(width)}
${result.screen || ""}
${"─".repeat(width)}`,
        metadata: {
          terminalId: params.id,
          pattern: params.pattern,
          matched: true,
          timedOut: false,
        },
      }
    } else {
      return {
        title: `Timeout waiting for pattern`,
        output: `Timeout after ${timeout}ms waiting for pattern "${params.pattern}".

Current screen:
${"─".repeat(width)}
${result.screen || ""}
${"─".repeat(width)}

The pattern was not found. You can:
- Check if the command is still running
- Use terminal_view to see the full screen
- Try a different pattern
- Increase the timeout`,
        metadata: {
          terminalId: params.id,
          pattern: params.pattern,
          matched: false,
          timedOut: true,
        },
      }
    }
  },
})
