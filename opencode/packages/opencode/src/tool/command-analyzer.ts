import { lazy } from "../util/lazy"
import { Language } from "web-tree-sitter"
import { $ } from "bun"
import { fileURLToPath } from "url"
import { Filesystem } from "../util/filesystem"
import { BashArity } from "../permission/arity"
import { Log } from "../util/log"

export namespace CommandAnalyzer {
  const log = Log.create({ service: "command-analyzer" })

  /** Commands that may access external file paths */
  export const DANGEROUS_PATH_COMMANDS = [
    "cd",
    "rm",
    "cp",
    "mv",
    "mkdir",
    "touch",
    "chmod",
    "chown",
    "cat",
  ] as const

  /** Information about a parsed command */
  export interface CommandInfo {
    /** Command name (first token) */
    name: string
    /** All tokens in the command */
    tokens: string[]
    /** Full command string for permission pattern */
    pattern: string
    /** Command prefix with wildcard for always-allow pattern */
    alwaysPattern: string
  }

  /** Result of command analysis */
  export interface AnalysisResult {
    /** Whether the input appears to be a command (vs interactive input) */
    isCommand: boolean
    /** Parsed commands found in the input */
    commands: CommandInfo[]
    /** Paths outside the project directory that need permission */
    externalDirectories: string[]
    /** Whether this input requires permission approval */
    requiresPermission: boolean
  }

  /** Resolve WASM asset path */
  const resolveWasm = (asset: string) => {
    if (asset.startsWith("file://")) return fileURLToPath(asset)
    if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
    const url = new URL(asset, import.meta.url)
    return fileURLToPath(url)
  }

  /** Lazy-loaded tree-sitter bash parser */
  const parser = lazy(async () => {
    const { Parser } = await import("web-tree-sitter")
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    const treePath = resolveWasm(treeWasm)
    await Parser.init({
      locateFile() {
        return treePath
      },
    })
    const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
      with: { type: "wasm" },
    })
    const bashPath = resolveWasm(bashWasm)
    const bashLanguage = await Language.load(bashPath)
    const p = new Parser()
    p.setLanguage(bashLanguage)
    return p
  })

  /**
   * Check if input appears to be a command (vs interactive input like passwords, y/n, etc.)
   *
   * Heuristics:
   * - Control sequences (escape codes) -> not a command
   * - Very short inputs (1-2 chars) -> likely interactive response
   * - Common confirmations (y, n, yes, no) -> not a command
   * - Contains shell operators (|, &, ;, >) -> likely a command
   * - Starts with known command -> likely a command
   */
  export function isLikelyCommand(input: string): boolean {
    const trimmed = input.trim()

    // Empty or whitespace-only - not a command
    if (!trimmed) return false

    // Control sequences (Ctrl+C, arrow keys, etc.) - not a command
    if (/^[\x00-\x1f]+$/.test(input)) return false

    // Arrow keys, function keys (escape sequences)
    if (/^\x1b\[/.test(input)) return false

    // Single escape key
    if (input === "\x1b") return false

    // Common confirmation patterns - not a command
    if (/^(y|n|yes|no|Y|N|YES|NO)$/i.test(trimmed)) {
      return false
    }

    // Very short inputs without Enter are likely interactive
    // But if it ends with newline, it might be a short command
    if (trimmed.length <= 2) {
      // Single/double char without newline - likely interactive
      if (!input.endsWith("\n") && !input.endsWith("\r")) {
        return false
      }
      // Even with newline, single non-alpha chars are interactive
      if (!/^[a-zA-Z]{1,2}$/.test(trimmed)) {
        return false
      }
    }

    // Contains shell-like patterns - likely a command
    if (/[|&;><$`]/.test(trimmed)) return true

    // Starts with known command names - likely a command
    const knownCommands = [
      "sudo",
      "cd",
      "ls",
      "cat",
      "rm",
      "mv",
      "cp",
      "mkdir",
      "touch",
      "chmod",
      "chown",
      "git",
      "npm",
      "yarn",
      "pnpm",
      "bun",
      "docker",
      "kubectl",
      "python",
      "node",
      "go",
      "cargo",
      "make",
      "curl",
      "wget",
      "ssh",
      "scp",
      "rsync",
      "tar",
      "zip",
      "unzip",
      "grep",
      "find",
      "awk",
      "sed",
      "echo",
      "export",
      "source",
      "bash",
      "sh",
      "zsh",
    ]

    const firstWord = trimmed.split(/\s+/)[0] ?? ""
    if (firstWord && knownCommands.includes(firstWord)) {
      return true
    }

    // If it has spaces and ends with newline, probably a command
    if (/\s/.test(trimmed) && (input.endsWith("\n") || input.endsWith("\r"))) {
      return true
    }

    // Default: if it ends with newline and has word characters, likely a command
    if ((input.endsWith("\n") || input.endsWith("\r")) && /\w/.test(trimmed)) {
      return true
    }

    return false
  }

  /**
   * Normalize path for the current platform (handle Windows Git Bash paths)
   */
  function normalizePathForPlatform(resolved: string): string {
    if (process.platform === "win32" && resolved.match(/^\/[a-z]\//)) {
      return resolved
        .replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
        .replace(/\//g, "\\")
    }
    return resolved
  }

  /**
   * Analyze a command string for security requirements
   *
   * @param command - The command string to analyze
   * @param cwd - Working directory for path resolution
   * @returns Analysis result with commands, external directories, and permission requirements
   */
  export async function analyze(
    command: string,
    cwd: string
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = {
      isCommand: true,
      commands: [],
      externalDirectories: [],
      requiresPermission: false,
    }

    // Check if this looks like a command
    if (!isLikelyCommand(command)) {
      return { ...result, isCommand: false }
    }

    // Parse with tree-sitter
    const p = await parser()
    const tree = p.parse(command.trim())
    if (!tree) {
      return { ...result, isCommand: false }
    }

    const directories = new Set<string>()

    // Extract commands from AST
    for (const node of tree.rootNode.descendantsOfType("command")) {
      if (!node) continue

      const tokens: string[] = []
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child) continue
        if (
          child.type !== "command_name" &&
          child.type !== "word" &&
          child.type !== "string" &&
          child.type !== "raw_string" &&
          child.type !== "concatenation"
        ) {
          continue
        }
        tokens.push(child.text)
      }

      if (tokens.length === 0) continue

      const commandName = tokens[0]!

      // Check for path-accessing commands
      if (DANGEROUS_PATH_COMMANDS.includes(commandName as typeof DANGEROUS_PATH_COMMANDS[number])) {
        for (const arg of tokens.slice(1)) {
          // Skip flags
          if (arg.startsWith("-") || (commandName === "chmod" && arg.startsWith("+"))) {
            continue
          }

          // Resolve the path
          const resolved = await $`realpath ${arg}`
            .cwd(cwd)
            .quiet()
            .nothrow()
            .text()
            .then((x) => x.trim())

          log.info("resolved path", { arg, resolved })

          if (resolved) {
            const normalized = normalizePathForPlatform(resolved)
            if (!Filesystem.contains(cwd, normalized)) {
              directories.add(normalized)
            }
          }
        }
      }

      // Build command patterns (skip cd as it's covered by directory check)
      if (commandName !== "cd") {
        result.commands.push({
          name: commandName,
          tokens,
          pattern: tokens.join(" "),
          alwaysPattern: BashArity.prefix(tokens).join(" ") + "*",
        })
      }
    }

    result.externalDirectories = Array.from(directories)
    result.requiresPermission =
      result.externalDirectories.length > 0 || result.commands.length > 0

    return result
  }

  /**
   * Get the lazy-loaded parser instance (for reuse by bash.ts)
   */
  export function getParser() {
    return parser()
  }
}
