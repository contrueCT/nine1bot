#!/usr/bin/env node

import { readFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(process.argv[3] || path.join(scriptDir, ".."))
const manifestPath = path.join(projectRoot, "engine.manifest.json")

const fallbackManifest = {
  entry: {
    command: "bun",
    args: [
      "run",
      "--cwd",
      "{installDir}/opencode/packages/opencode",
      "src/index.ts",
      "--",
      "serve",
      "--port",
      "{port}",
      "--hostname",
      "{host}",
    ],
  },
}

function loadManifest() {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch {
    return fallbackManifest
  }
}

function interpolate(value) {
  return String(value).replaceAll("{installDir}", projectRoot)
}

function getEntryCwd(manifest) {
  const args = Array.isArray(manifest?.entry?.args) ? manifest.entry.args : fallbackManifest.entry.args
  const cwdIndex = args.indexOf("--cwd")
  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    return path.resolve(interpolate(args[cwdIndex + 1]))
  }
  return path.resolve(projectRoot, "opencode", "packages", "opencode")
}

function getWorkspaceRoot(packageCwd) {
  const marker = `${path.sep}packages${path.sep}`
  const index = packageCwd.lastIndexOf(marker)
  if (index !== -1) {
    return packageCwd.slice(0, index)
  }
  return path.dirname(packageCwd)
}

const command = process.argv[2]
const packageCwd = getEntryCwd(loadManifest())

switch (command) {
  case "package-cwd":
    console.log(packageCwd)
    break
  case "workspace-root":
    console.log(getWorkspaceRoot(packageCwd))
    break
  default:
    console.error("Usage: engine-manifest.mjs <package-cwd|workspace-root> [projectRoot]")
    process.exit(1)
}
