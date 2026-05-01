import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "fs/promises"
import path from "path"

const sourceRoot = path.join(__dirname, "../../src")

describe("runtime platform boundaries", () => {
  test("runtime core does not import concrete platform packages", async () => {
    const files = await listTypeScriptFiles(sourceRoot)
    const offenders: string[] = []

    for (const file of files) {
      const content = await readFile(file, "utf8")
      if (content.includes("@nine1bot/platform-gitlab") || content.includes("platform-gitlab")) {
        offenders.push(path.relative(sourceRoot, file))
      }
    }

    expect(offenders).toEqual([])
  })
})

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return listTypeScriptFiles(fullPath)
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) return [fullPath]
      return []
    }),
  )
  return files.flat()
}
