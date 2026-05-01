import z from "zod"
import path from "path"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { RuntimeSourceRegistry } from "@/runtime/source/registry"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Source = z.object({
    owner: z.object({
      id: z.string(),
      kind: z.enum(["core", "user", "project", "platform", "capability"]),
    }),
    sourceID: z.string(),
    visibility: z.enum(["default", "declared-only"]),
  })
  export type Source = z.infer<typeof Source>

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    source: Source.optional(),
  })
  export type Info = z.infer<typeof Info>
  export type ListOptions = {
    includeDeclaredOnly?: boolean
  }

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const OPENCODE_SKILL_GLOB = new Bun.Glob("{skill,skills}/**/SKILL.md")
  const CLAUDE_SKILL_GLOB = new Bun.Glob("skills/**/SKILL.md")
  const NINE1BOT_SKILL_GLOB = new Bun.Glob("**/SKILL.md")

  // Skills 热更新缓存
  let cachedSkills: Record<string, Info> | null = null
  let skillsLastLoadTime: number = 0
  let skillsLastCacheKey: string | undefined
  const SKILLS_CACHE_TTL = 30000 // 30秒

  /**
   * 扫描所有技能目录
   */
  async function scanSkillDirectories(): Promise<Record<string, Info>> {
    const skills: Record<string, Info> = {}

    const addSkill = async (match: string, source: Source, options?: { emitParseErrors?: boolean }) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        if (options?.emitParseErrors !== false) {
          Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        }
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      const existing = skills[parsed.data.name]
      if (existing && sourceVisibility(existing) === "default" && source.visibility === "declared-only") {
        log.debug("skip declared-only skill override over default skill", {
          name: parsed.data.name,
          existing: existing.location,
          skipped: match,
        })
        return
      }

      // Later sources override earlier ones (higher priority sources scanned last)
      // No warning for duplicates - this is expected when user overrides builtin skills
      if (existing) {
        log.debug("skill override", {
          name: parsed.data.name,
          previous: existing.location,
          newLocation: match,
        })
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        source,
      }
    }

    const addMatches = async (matches: string[], source: Source, options?: { emitParseErrors?: boolean }) => {
      for (const match of matches) {
        await addSkill(match, source, options)
      }
    }

    // Scan order: lowest priority first, highest priority last
    // Priority: builtin < global < project (later scans override earlier ones)
    // This allows users to override builtin skills with their own versions

    // 1. Scan Nine1Bot built-in skills (lowest priority)
    const nine1botBuiltinSkillsDir = process.env.NINE1BOT_BUILTIN_SKILLS_DIR
    if (nine1botBuiltinSkillsDir && await Filesystem.isDir(nine1botBuiltinSkillsDir)) {
      const matches = await Array.fromAsync(
        NINE1BOT_SKILL_GLOB.scan({
          cwd: nine1botBuiltinSkillsDir,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        }),
      ).catch((error) => {
        log.error("failed nine1bot builtin skills directory scan", { dir: nine1botBuiltinSkillsDir, error })
        return []
      })
      await addMatches(matches, defaultSource("core", "nine1bot-builtin", "nine1bot-builtin"))
    }

    await scanRuntimeSkillSources(skills)

    // 2. Scan Nine1Bot global skills (medium priority - user can override builtin)
    // Global: ~/.config/nine1bot/skills/
    const nine1botGlobalSkillsDir = process.env.NINE1BOT_SKILLS_DIR
    if (nine1botGlobalSkillsDir && await Filesystem.isDir(nine1botGlobalSkillsDir)) {
      const matches = await Array.fromAsync(
        NINE1BOT_SKILL_GLOB.scan({
          cwd: nine1botGlobalSkillsDir,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        }),
      ).catch((error) => {
        log.error("failed nine1bot global skills directory scan", { dir: nine1botGlobalSkillsDir, error })
        return []
      })
      await addMatches(matches, defaultSource("user", "nine1bot-global", "nine1bot-global"))
    }

    // 3. Project-level: .nine1bot/skills/ (highest priority)
    const nine1botProjectSkillsDir = path.join(Instance.directory, ".nine1bot", "skills")
    if (await Filesystem.isDir(nine1botProjectSkillsDir)) {
      const matches = await Array.fromAsync(
        NINE1BOT_SKILL_GLOB.scan({
          cwd: nine1botProjectSkillsDir,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        }),
      ).catch((error) => {
        log.error("failed nine1bot project skills directory scan", { dir: nine1botProjectSkillsDir, error })
        return []
      })
      await addMatches(matches, defaultSource("project", "nine1bot-project", "nine1bot-project"))
    }

    // Scan .claude/skills/ directories (project-level)
    const claudeDirs = await Array.fromAsync(
      Filesystem.up({
        targets: [".claude"],
        start: Instance.directory,
        stop: Instance.worktree,
      }),
    )
    // Also include global ~/.claude/skills/
    const globalClaude = `${Global.Path.home}/.claude`
    if (await Filesystem.isDir(globalClaude)) {
      claudeDirs.push(globalClaude)
    }

    if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) {
      for (const dir of claudeDirs) {
        const matches = await Array.fromAsync(
          CLAUDE_SKILL_GLOB.scan({
            cwd: dir,
            absolute: true,
            onlyFiles: true,
            followSymlinks: true,
            dot: true,
          }),
        ).catch((error) => {
          log.error("failed .claude directory scan for skills", { dir, error })
          return []
        })

        await addMatches(matches, defaultSource("user", "claude-code", "claude-code"))
      }
    }

    // Scan .opencode/skill/ directories (if not disabled)
    if (!Flag.OPENCODE_DISABLE_OPENCODE_SKILLS) {
      for (const dir of await Config.directories()) {
        for await (const match of OPENCODE_SKILL_GLOB.scan({
          cwd: dir,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        })) {
          await addSkill(match, defaultSource("core", "opencode", "opencode"))
        }
      }
    }

    return skills
  }

  async function scanRuntimeSkillSources(skills: Record<string, Info>) {
    const addSkill = async (match: string, source: Source) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        log.error("failed to load runtime skill source item", { skill: match, err })
        return undefined
      })
      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      const existing = skills[parsed.data.name]
      if (existing && sourceVisibility(existing) === "default" && source.visibility === "declared-only") {
        log.debug("skip declared-only runtime skill override over default skill", {
          name: parsed.data.name,
          existing: existing.location,
          skipped: match,
        })
        return
      }
      if (existing) {
        log.debug("skill override", {
          name: parsed.data.name,
          previous: existing.location,
          newLocation: match,
        })
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        source,
      }
    }

    for (const runtimeSource of RuntimeSourceRegistry.list().skills) {
      if (!runtimeSource.owner.enabled) continue
      if (!(await Filesystem.isDir(runtimeSource.directory))) {
        log.debug("skip missing runtime skill source directory", {
          owner: runtimeSource.owner.id,
          source: runtimeSource.id,
          directory: runtimeSource.directory,
        })
        continue
      }

      const matches = await Array.fromAsync(
        NINE1BOT_SKILL_GLOB.scan({
          cwd: runtimeSource.directory,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        }),
      ).catch((error) => {
        log.error("failed runtime skill source directory scan", {
          owner: runtimeSource.owner.id,
          source: runtimeSource.id,
          directory: runtimeSource.directory,
          error,
        })
        return []
      })

      const source: Source = {
        owner: {
          id: runtimeSource.owner.id,
          kind: runtimeSource.owner.kind,
        },
        sourceID: runtimeSource.id,
        visibility: runtimeSource.visibility,
      }

      for (const match of matches) {
        await addSkill(match, source)
      }
    }
  }

  /**
   * 获取技能列表（带定时缓存，支持热更新）
   */
  async function getSkillsWithCache(): Promise<Record<string, Info>> {
    const now = Date.now()
    const cacheKey = getCacheKey()

    // 检查缓存是否有效
    if (cachedSkills !== null && skillsLastCacheKey === cacheKey && now - skillsLastLoadTime < SKILLS_CACHE_TTL) {
      return cachedSkills
    }

    // 重新扫描技能目录
    log.info("Scanning skill directories...")
    cachedSkills = await scanSkillDirectories()
    skillsLastLoadTime = now
    skillsLastCacheKey = cacheKey
    log.info("Skills loaded", { count: Object.keys(cachedSkills).length })

    return cachedSkills
  }

  function defaultSource(ownerKind: Source["owner"]["kind"], ownerID: string, sourceID: string): Source {
    return {
      owner: {
        id: ownerID,
        kind: ownerKind,
      },
      sourceID,
      visibility: "default",
    }
  }

  function sourceVisibility(skill: Info) {
    return skill.source?.visibility ?? "default"
  }

  function getCacheKey() {
    return JSON.stringify({
      directory: Instance.directory,
      worktree: Instance.worktree,
      builtin: process.env.NINE1BOT_BUILTIN_SKILLS_DIR,
      global: process.env.NINE1BOT_SKILLS_DIR,
      home: process.env.OPENCODE_TEST_HOME,
      configDir: Flag.OPENCODE_CONFIG_DIR,
      globalConfig: Flag.OPENCODE_DISABLE_GLOBAL_CONFIG,
      projectConfig: Flag.OPENCODE_DISABLE_PROJECT_CONFIG,
      claude: Flag.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,
      opencode: Flag.OPENCODE_DISABLE_OPENCODE_SKILLS,
      runtimeSources: RuntimeSourceRegistry.version(),
    })
  }

  function filterByVisibility(skills: Info[], options?: ListOptions) {
    if (options?.includeDeclaredOnly) return skills
    return skills.filter((skill) => sourceVisibility(skill) === "default")
  }

  // 保留原 state() 用于向后兼容
  export const state = Instance.state(async () => {
    return getSkillsWithCache()
  })

  export async function get(name: string, options?: ListOptions) {
    const skills = await getSkillsWithCache()
    const skill = skills[name]
    if (!skill) return undefined
    if (!options?.includeDeclaredOnly && sourceVisibility(skill) === "declared-only") return undefined
    return skill
  }

  export async function all(options?: ListOptions) {
    const skills = await getSkillsWithCache()
    return filterByVisibility(Object.values(skills), options)
  }

  export async function defaultVisible() {
    return all()
  }
}
