import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"

export const TerminalViewTool = Tool.define("terminal_view", {
  description: `View the current content of a terminal session.

This shows you exactly what a human would see looking at the terminal:
- Current screen content (the visible terminal area)
- Optionally include scrollback history
- Cursor position and terminal state

Use this to:
- Check command output after running a command
- See if a process is still running or has completed
- Read prompts, error messages, or interactive menus
- Monitor the state of long-running tasks
- View full-screen applications like vim or htop

The output is formatted to clearly show terminal boundaries.`,

  parameters: z.object({
    id: z.string().describe("Terminal session ID (from terminal_create or terminal_list)"),
    includeHistory: z.boolean().optional().describe("Include scrollback history above current screen (default: false)"),
    historyLines: z.number().optional().describe("Number of history lines to include (default: 50, only used if includeHistory is true)"),
  }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    const screenInfo = AgentTerminal.getScreenInfo(params.id)
    let content: string

    if (params.includeHistory) {
      content = AgentTerminal.getFullView(params.id, params.historyLines || 50) || ""
    } else {
      content = AgentTerminal.getScreen(params.id) || ""
    }

    const cursor = AgentTerminal.getCursor(params.id)
    const width = Math.min(screenInfo?.cols || 80, 80)

    const stateInfo = [
      `Terminal: ${info.name}`,
      `Size: ${screenInfo?.cols}x${screenInfo?.rows}`,
      `Cursor: row ${cursor?.row}, col ${cursor?.col}`,
      `Status: ${info.status}`,
      screenInfo?.scrollbackLength ? `History: ${screenInfo.scrollbackLength} lines` : null,
    ]
      .filter(Boolean)
      .join(" | ")

    return {
      title: `View: ${info.name}`,
      output: `[${stateInfo}]
${"─".repeat(width)}
${content}
${"─".repeat(width)}`,
      metadata: {
        terminalId: params.id,
        name: info.name,
        status: info.status,
        cursor,
        rows: screenInfo?.rows,
        cols: screenInfo?.cols,
      },
    }
  },
})
