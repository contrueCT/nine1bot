import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"
import { Instance } from "../../project/instance"

export const TerminalCreateTool = Tool.define("terminal_create", {
  description: `Create a new persistent terminal session.

Use this to start interactive terminal sessions for tasks like:
- SSH connections to remote servers
- Running interactive CLI tools (vim, htop, docker exec -it, etc.)
- Long-running processes you need to monitor
- Any task requiring persistent shell state across multiple commands

The terminal maintains full screen state, so you can use vim, htop, and other full-screen applications.

Returns a session ID to use with other terminal tools (terminal_view, terminal_write, etc.).

Example usage:
- Create a terminal: terminal_create({ name: "ssh-prod" })
- Create with specific size: terminal_create({ name: "editor", rows: 40, cols: 120 })`,

  parameters: z.object({
    name: z.string().optional().describe("Name for this terminal (e.g., 'ssh-prod', 'docker-logs')"),
    cwd: z.string().optional().describe("Working directory (defaults to project root)"),
    rows: z.number().optional().describe("Terminal height in rows (default: 24)"),
    cols: z.number().optional().describe("Terminal width in columns (default: 120)"),
  }),

  async execute(params, ctx) {
    const terminal = await AgentTerminal.create({
      name: params.name,
      sessionID: ctx.sessionID,
      cwd: params.cwd || ctx.cwd,
      rows: params.rows,
      cols: params.cols,
    })

    const screen = AgentTerminal.getScreen(terminal.id) || ""
    const info = AgentTerminal.getScreenInfo(terminal.id)

    return {
      title: `Created terminal: ${terminal.name}`,
      output: `Terminal "${terminal.name}" created successfully.
Session ID: ${terminal.id}
Size: ${info?.cols || 120}x${info?.rows || 24}
PID: ${terminal.pid}

Initial screen:
${"─".repeat(Math.min(info?.cols || 80, 80))}
${screen}
${"─".repeat(Math.min(info?.cols || 80, 80))}`,
      metadata: {
        terminalId: terminal.id,
        name: terminal.name,
        pid: terminal.pid,
        rows: terminal.rows,
        cols: terminal.cols,
      },
    }
  },
})
