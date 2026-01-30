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

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
  })
  export type Info = z.infer<typeof Info>

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
  const SKILLS_CACHE_TTL = 30000 // 30秒

  /**
   * 扫描所有技能目录
   */
  async function scanSkillDirectories(): Promise<Record<string, Info>> {
    const skills: Record<string, Info> = {}

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // Later sources override earlier ones (higher priority sources scanned last)
      // No warning for duplicates - this is expected when user overrides builtin skills
      if (skills[parsed.data.name]) {
        log.debug("skill override", {
          name: parsed.data.name,
          previous: skills[parsed.data.name].location,
          newLocation: match,
        })
      }

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
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
      for (const match of matches) {
        await addSkill(match)
      }
    }

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
      for (const match of matches) {
        await addSkill(match)
      }
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
      for (const match of matches) {
        await addSkill(match)
      }
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

        for (const match of matches) {
          await addSkill(match)
        }
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
          await addSkill(match)
        }
      }
    }

    return skills
  }

  /**
   * 获取技能列表（带定时缓存，支持热更新）
   */
  async function getSkillsWithCache(): Promise<Record<string, Info>> {
    const now = Date.now()

    // 检查缓存是否有效
    if (cachedSkills !== null && now - skillsLastLoadTime < SKILLS_CACHE_TTL) {
      return cachedSkills
    }

    // 重新扫描技能目录
    log.info("Scanning skill directories...")
    cachedSkills = await scanSkillDirectories()
    skillsLastLoadTime = now
    log.info("Skills loaded", { count: Object.keys(cachedSkills).length })

    return cachedSkills
  }

  // 保留原 state() 用于向后兼容
  export const state = Instance.state(async () => {
    return getSkillsWithCache()
  })

  export async function get(name: string) {
    const skills = await getSkillsWithCache()
    return skills[name]
  }

  export async function all() {
    const skills = await getSkillsWithCache()
    return Object.values(skills)
  }
}
