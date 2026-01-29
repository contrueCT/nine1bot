import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"

export const TerminalListTool = Tool.define("terminal_list", {
  description: `List all active terminal sessions.

Shows all terminals created in this session, including:
- Terminal ID (needed for other terminal tools)
- Name
- Status (running/exited)
- Size (columns x rows)
- Last activity time
- Process ID

Use this to:
- Find terminal IDs for use with other tools
- Check which terminals are still running
- See all available terminals before deciding which to use`,

  parameters: z.object({}),

  async execute(params, ctx) {
    const terminals = AgentTerminal.list(ctx.sessionID)

    if (terminals.length === 0) {
      return {
        title: "No terminals",
        output: `No active terminal sessions found.

Use terminal_create to start a new terminal:
  terminal_create({ name: "my-terminal" })`,
        metadata: {
          count: 0,
          terminals: [] as { id: string; name: string; status: string }[],
        },
      }
    }

    const formatTime = (ts: number): string => {
      const diff = Date.now() - ts
      if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
      return `${Math.floor(diff / 3600000)}h ago`
    }

    const list = terminals
      .map((t) => {
        const status = t.status === "running" ? "running" : "exited"
        return `- ${t.name} (${t.id})
    Status: ${status} | Size: ${t.cols}x${t.rows} | PID: ${t.pid}
    Last activity: ${formatTime(t.lastActivity)}`
      })
      .join("\n\n")

    return {
      title: `${terminals.length} terminal(s)`,
      output: `Active terminal sessions:

${list}

Use terminal_view with the ID to see terminal content.`,
      metadata: {
        count: terminals.length,
        terminals: terminals.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
        })),
      },
    }
  },
})
