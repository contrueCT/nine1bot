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

const allTargets: Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "arm64" },
  { os: "windows", arch: "x64" },
  { os: "windows", arch: "x64", avx2: false },
]

// 确定要构建的目标
let targets: Target[]

// 将 Node.js 平台名称转换为我们的目标名称
const currentPlatform = process.platform === "win32" ? "windows" : process.platform

if (singleFlag) {
  // 只构建当前平台（非 baseline 版本）
  targets = allTargets.filter(t =>
    t.os === currentPlatform &&
    t.arch === process.arch &&
    t.avx2 !== false
  )
} else if (platformArg && archArg) {
  // 构建指定平台
  targets = allTargets.filter(t =>
    t.os === platformArg &&
    t.arch === archArg &&
    t.avx2 !== false
  )
} else {
  // 构建所有平台
  targets = allTargets
}

if (targets.length === 0) {
  console.error("No matching targets found")
  process.exit(1)
}

console.log(`Building Nine1Bot v${version}`)
console.log(`Targets: ${targets.map(t => `${t.os}-${t.arch}${t.avx2 === false ? "-baseline" : ""}`).join(", ")}`)
console.log("")

// 清理输出目录
await $`rm -rf dist`

// 构建每个目标
for (const target of targets) {
  const osName = target.os === "win32" ? "windows" : target.os
  const suffix = target.avx2 === false ? "-baseline" : ""
  const buildName = `nine1bot-${osName}-${target.arch}${suffix}`
  const bunTarget = `bun-${osName}-${target.arch}${suffix}`
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
