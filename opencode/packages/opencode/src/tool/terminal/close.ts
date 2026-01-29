import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"

export const TerminalCloseTool = Tool.define("terminal_close", {
  description: `Close a terminal session.

This will:
- Kill the terminal process (if still running)
- Release all resources
- Remove the terminal from the active list

Use this when you're done with a terminal to clean up resources.

Note: If you need to exit cleanly (e.g., log out of SSH properly),
use terminal_write to send "exit" or Ctrl+D first, then close.`,

  parameters: z.object({
    id: z.string().describe("Terminal session ID to close"),
  }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    const name = info.name
    const wasRunning = info.status === "running"

    const success = await AgentTerminal.close(params.id)
    if (!success) {
      throw new Error(`Failed to close terminal: ${params.id}`)
    }

    return {
      title: `Closed: ${name}`,
      output: `Terminal "${name}" (${params.id}) has been closed.${wasRunning ? "\nThe process was terminated." : ""}`,
      metadata: {
        terminalId: params.id,
        name,
        wasRunning,
      },
    }
  },
})
