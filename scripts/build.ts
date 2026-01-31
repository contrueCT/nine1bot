#!/usr/bin/env bun

/**
 * Nine1Bot 编译脚本
 * 使用 Bun.build({ compile: true }) 将应用编译成独立可执行文件
 */

import path from "path"
import fs from "fs"
import { $ } from "bun"

const projectRoot = path.resolve(import.meta.dir, "..")
process.chdir(projectRoot)

// 读取版本号
const pkg = JSON.parse(fs.readFileSync(
  path.join(projectRoot, "packages/nine1bot/package.json"), "utf-8"
))
const version = process.env.NINE1BOT_VERSION || pkg.version

// 解析命令行参数
const args = process.argv.slice(2)
const singleFlag = args.includes("--single")
const platformArg = args.find(a => a.startsWith("--platform="))?.split("=")[1]
const archArg = args.find(a => a.startsWith("--arch="))?.split("=")[1]

// 目标平台配置
interface Target {
  os: string
  arch: "arm64" | "x64"
  avx2?: false
}

// 发布目标（Linux x64 使用 baseline 版本以确保兼容性）
const releaseTargets: Target[] = [
  { os: "linux", arch: "x64", avx2: false },   // baseline for older CPUs
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "arm64" },
  { os: "windows", arch: "x64" },              // Windows 不支持 baseline
]

// 本地开发目标（使用当前平台的优化版本）
const devTargets: Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "arm64" },
  { os: "windows", arch: "x64" },
]

// 确定要构建的目标
let targets: Target[]

// 将 Node.js 平台名称转换为我们的目标名称
const currentPlatform = process.platform === "win32" ? "windows" : process.platform

if (singleFlag) {
  // 本地开发：构建当前平台的优化版本
  targets = devTargets.filter(t =>
    t.os === currentPlatform &&
    t.arch === process.arch
  )
} else if (platformArg && archArg) {
  // CI 构建：使用 baseline 版本确保兼容性
  targets = releaseTargets.filter(t =>
    t.os === platformArg &&
    t.arch === archArg
  )
} else {
  // 构建所有发布目标
  targets = releaseTargets
}

if (targets.length === 0) {
  console.error("No matching targets found")
  process.exit(1)
}

console.log(`Building Nine1Bot v${version}`)
console.log(`Targets: ${targets.map(t => `${t.os}-${t.arch}${t.avx2 === false ? "-baseline" : ""}`).join(", ")}`)
console.log("")

// 清理输出目录（忽略错误，Windows 可能有文件锁定问题）
await $`rm -rf dist`.nothrow()

// 构建每个目标
for (const target of targets) {
  const osName = target.os === "win32" ? "windows" : target.os
  // 目录名不加 -baseline 后缀（发布版统一使用 baseline）
  const buildName = `nine1bot-${osName}-${target.arch}`
  // Bun target 需要 -baseline 后缀
  const bunTargetSuffix = target.avx2 === false ? "-baseline" : ""
  const bunTarget = `bun-${osName}-${target.arch}${bunTargetSuffix}`
  const outDir = path.join(projectRoot, "dist", buildName)
  const outfile = path.join(outDir, target.os === "win32" || target.os === "windows" ? "nine1bot.exe" : "nine1bot")

  console.log(`Building ${buildName}...`)

  // 创建输出目录
  fs.mkdirSync(outDir, { recursive: true })

  // 编译二进制到根目录
  try {
    const result = await Bun.build({
      entrypoints: [path.join(projectRoot, "packages/nine1bot/src/index.ts")],
      target: "bun",
      minify: false,
      sourcemap: "external",
      define: {
        NINE1BOT_VERSION: JSON.stringify(version),
        NINE1BOT_COMPILED: "true",
      },
      compile: {
        target: bunTarget as any,
        outfile,
      },
    })

    if (!result.success) {
      console.error(`Build failed for ${buildName}:`)
      for (const log of result.logs) {
        console.error(log)
      }
      process.exit(1)
    }

    console.log(`✓ Built ${buildName}`)
  } catch (error: any) {
    console.error(`Build failed for ${buildName}: ${error.message}`)
    process.exit(1)
  }
}

console.log("")
console.log("✅ Build complete!")
console.log(`Output: ${path.join(projectRoot, "dist")}`)
