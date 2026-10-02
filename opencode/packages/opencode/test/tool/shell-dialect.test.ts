import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { $ } from "bun"
import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { AgentTerminal } from "../../src/pty/agent-terminal"
import { Shell } from "../../src/shell/shell"
import { BashTool } from "../../src/tool/bash"
import { TerminalCreateTool } from "../../src/tool/terminal/create"
import { TerminalWriteTool } from "../../src/tool/terminal/write"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

function context(cwd: string, ruleset: PermissionNext.Ruleset = []): Tool.Context {
  return {
    sessionID: "session_dialect_test",
    messageID: "message_dialect_test",
    agent: "build",
    cwd,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async (request) => PermissionNext.ask({ ...request, sessionID: "session_dialect_test", ruleset }),
  }
}

const zshInputs = ["print -rl -- *.ts(N)", "for f (*.ts) print -r -- $f", "echo ${(@)array}"]

test.skipIf(!Bun.which("zsh"))("dialect regression inputs are valid zsh syntax", async () => {
  for (const command of zshInputs) {
    const result = await $`${Bun.which("zsh")!} -f -n -c ${command}`.quiet().nothrow()
    expect(result.exitCode).toBe(0)
  }
})

test("BashTool executes Bash rather than an incompatible interactive-shell preference", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const preferred = spyOn(Shell, "acceptable").mockReturnValue("/bin/zsh")
      try {
        const bash = await BashTool.init()
        expect(path.basename(Shell.bash())).toMatch(/^bash(?:\.exe)?$/)
        expect(bash.description).toContain("even when the user's interactive shell is zsh")
        const result = await bash.execute(
          { command: "printf '%s' \"$BASH_VERSION\"", description: "Check execution dialect" },
          {
            ...context(tmp.path),
            ask: async () => {},
          },
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toMatch(/^\d+\.\d+/)
      } finally {
        preferred.mockRestore()
      }
    },
  })
})

for (const command of zshInputs) {
  test(`unsupported grammar cannot hide a denied command: ${command}`, async () => {
    await using tmp = await tmpdir({
      config: { autonomous: { enabled: true, maxRetries: 3, askAfterRetries: true, allowDoomLoop: true } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const preferred = spyOn(Shell, "acceptable").mockReturnValue("/bin/zsh")
        try {
          const bash = await BashTool.init()
          await expect(
            bash.execute(
              { command: `${command}; touch denied-marker`, description: "Reject incomplete analysis" },
              context(tmp.path, [
                { permission: "bash", pattern: "*", action: "allow" },
                { permission: "bash", pattern: "touch *", action: "deny" },
              ]),
            ),
          ).rejects.toThrow("Bash-compatible syntax")
          expect(await Bun.file(path.join(tmp.path, "denied-marker")).exists()).toBe(false)
        } finally {
          preferred.mockRestore()
        }
      },
    })
  })
}

for (const command of [
  "cd .; > permission-marker",
  "cd . > permission-marker",
  "pwd; > permission-marker",
  "pwd > permission-marker",
  "touch first-marker; > permission-marker",
]) {
  test(`redirection is authorized independently of allowed command nodes: ${command}`, async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        await expect(
          bash.execute(
            { command, description: "Check redirection permission" },
            context(tmp.path, [
              { permission: "bash", pattern: "*", action: "allow" },
              { permission: "bash", pattern: "> *", action: "deny" },
            ]),
          ),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
        expect(await Bun.file(path.join(tmp.path, "permission-marker")).exists()).toBe(false)
        expect(await Bun.file(path.join(tmp.path, "first-marker")).exists()).toBe(false)
      },
    })
  })
}

test("mixed standalone assignments cannot inherit another command's permission", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const bash = await BashTool.init()
      await expect(
        bash.execute(
          { command: "pwd; VALUE=1", description: "Check assignment permission" },
          context(tmp.path, [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "VALUE=*", action: "deny" },
          ]),
        ),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("agent-created terminals use the analyzer's documented shell dialect", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const preferred = spyOn(Shell, "acceptable").mockReturnValue("/bin/zsh")
      const create = spyOn(AgentTerminal, "create").mockResolvedValue({ id: "agt_test", name: "test", pid: 1 } as never)
      const snapshot = spyOn(AgentTerminal, "getScreenSnapshot").mockResolvedValue(undefined)
      try {
        const tool = await TerminalCreateTool.init()
        await tool.execute({}, context(tmp.path))
        expect(create.mock.calls[0]?.[0].command).toBe(Shell.bash())
      } finally {
        preferred.mockRestore()
        create.mockRestore()
        snapshot.mockRestore()
      }
    },
  })
})

test("existing incompatible terminals reject unverified syntax but keep interactive controls", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const get = spyOn(AgentTerminal, "get").mockReturnValue({
        id: "agt_test",
        name: "test",
        status: "running",
        command: "/bin/zsh",
      } as never)
      const write = spyOn(AgentTerminal, "write").mockReturnValue(true)
      const snapshot = spyOn(AgentTerminal, "getScreenSnapshot").mockResolvedValue(undefined)
      try {
        const tool = await TerminalWriteTool.init()
        await expect(tool.execute({ id: "agt_test", input: "echo ${(@)array}" }, context(tmp.path))).rejects.toThrow(
          "Bash-compatible syntax",
        )
        expect(write).not.toHaveBeenCalled()
        await tool.execute({ id: "agt_test", input: "\\x03", pressEnter: false }, context(tmp.path))
        expect(write).toHaveBeenCalledWith("agt_test", "\x03", "session_dialect_test")
      } finally {
        get.mockRestore()
        write.mockRestore()
        snapshot.mockRestore()
      }
    },
  })
})

for (const shell of ["/bin/bash", "/bin/sh"]) {
  test(`compatible shell preferences remain supported: ${shell}`, () => {
    const preferred = spyOn(Shell, "acceptable").mockReturnValue(shell)
    try {
      expect(Shell.bash()).toBe(shell)
    } finally {
      preferred.mockRestore()
    }
  })
}

test("missing compatible shells fail explicitly instead of reverting to an unsupported dialect", () => {
  const preferred = spyOn(Shell, "acceptable").mockReturnValue("/bin/zsh")
  const which = spyOn(Bun, "which").mockReturnValue(null)
  try {
    expect(() => Shell.bash()).toThrow("Bash execution requires Bash or POSIX sh")
  } finally {
    preferred.mockRestore()
    which.mockRestore()
  }
})

for (const [command, denied] of [
  ["pwd; unset VALUE", "unset *"],
  ["cd .; ((VALUE=1))", "((VALUE=*"],
  ["cd .; export VALUE", "export *"],
]) {
  test(`other shell side effects cannot inherit the cd exception: ${command}`, async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        await expect(
          bash.execute(
            { command, description: "Check shell operation permission" },
            context(tmp.path, [
              { permission: "bash", pattern: "*", action: "allow" },
              { permission: "bash", pattern: denied, action: "deny" },
            ]),
          ),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })
}
