import z from "zod"
import path from "path"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"
import { CommandAnalyzer } from "../command-analyzer"
import { Instance } from "../../project/instance"

export const TerminalWriteTool = Tool.define("terminal_write", {
  description: `Send input to a terminal session.

Use this to:
- Type commands and press Enter
- Answer prompts (passwords, confirmations like y/n)
- Send special keys (Ctrl+C to interrupt, Ctrl+D for EOF, etc.)
- Interact with CLI applications and menus
- Navigate in vim, htop, or other interactive programs

After sending input, use terminal_view to see the result, or terminal_wait to wait for specific output.

Special key sequences (use these in the input string):
- \\n or \\r - Enter key
- \\x03 - Ctrl+C (interrupt/SIGINT)
- \\x04 - Ctrl+D (EOF)
- \\x1a - Ctrl+Z (suspend/SIGTSTP)
- \\t - Tab
- \\x1b[A - Up arrow
- \\x1b[B - Down arrow
- \\x1b[C - Right arrow
- \\x1b[D - Left arrow
- \\x1b - Escape key

Examples:
- Run a command: terminal_write({ id: "xxx", input: "ls -la" })
- Answer yes: terminal_write({ id: "xxx", input: "y" })
- Send password: terminal_write({ id: "xxx", input: "mypassword" })
- Interrupt process: terminal_write({ id: "xxx", input: "\\x03", pressEnter: false })
- Exit vim: terminal_write({ id: "xxx", input: ":q!", pressEnter: true })`,

  parameters: z.object({
    id: z.string().describe("Terminal session ID"),
    input: z.string().describe("Text or command to send to the terminal"),
    pressEnter: z.boolean().optional().describe("Append Enter key (\\n) after input (default: true)"),
  }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    if (info.status !== "running") {
      throw new Error(`Terminal has exited (status: ${info.status})`)
    }

    // Process escape sequences in input
    let input = params.input
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x1b/g, "\x1b")

    // Add Enter key if requested (default: true)
    if (params.pressEnter !== false && !input.endsWith("\n") && !input.endsWith("\r")) {
      input += "\n"
    }

    // Security check: analyze command and request permissions if needed
    const analysis = await CommandAnalyzer.analyze(input, Instance.directory)

    if (analysis.isCommand && analysis.requiresPermission) {
      // Request external_directory permission if accessing paths outside project
      if (analysis.externalDirectories.length > 0) {
        await ctx.ask({
          permission: "external_directory",
          patterns: analysis.externalDirectories,
          always: analysis.externalDirectories.map((x) => path.dirname(x) + "*"),
          metadata: {
            tool: "terminal_write",
            terminalId: params.id,
            terminalName: info.name,
          },
        })
      }

      // Request bash permission for command execution
      if (analysis.commands.length > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: analysis.commands.map((c) => c.pattern),
          always: analysis.commands.map((c) => c.alwaysPattern),
          metadata: {
            tool: "terminal_write",
            terminalId: params.id,
            terminalName: info.name,
          },
        })
      }
    }

    const success = AgentTerminal.write(params.id, input)
    if (!success) {
      throw new Error(`Failed to write to terminal: ${params.id}`)
    }

    // Brief wait for terminal to process input
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Get current screen for feedback
    const screen = AgentTerminal.getScreen(params.id) || ""

    return {
      title: `Sent to ${info.name}`,
      output: `Input sent to terminal "${info.name}".

Use terminal_view to see the full screen, or terminal_wait to wait for specific output.

Current screen preview:
${"─".repeat(60)}
${screen.split("\n").slice(-10).join("\n")}
${"─".repeat(60)}`,
      metadata: {
        terminalId: params.id,
        name: info.name,
        inputLength: input.length,
      },
    }
  },
})
