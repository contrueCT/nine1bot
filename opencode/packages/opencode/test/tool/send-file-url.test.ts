import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SendFileTool } from "../../src/tool/send-file"
import { tmpdir } from "../fixture/fixture"

test("send_file encodes filenames and preserves literal URL punctuation", async () => {
  await using directory = await tmpdir()
  const tool = await SendFileTool.init()
  for (const filename of ["报告 1.txt", "file%20literal.txt", "report#1?.txt"]) {
    const path = join(directory.path, filename)
    await writeFile(path, "fixture")
    const result = await tool.execute({ path }, {
      sessionID: "test-session", messageID: "test-message", callID: "test-call", agent: "build",
      cwd: directory.path, messages: [], abort: new AbortController().signal, metadata() {}, ask: async () => {},
    })
    expect(result.attachments?.[0]?.filename).toBe(filename)
    expect(fileURLToPath(result.attachments![0].url)).toBe(path)
    expect(new URL(result.attachments![0].url).hash).toBe("")
    expect(new URL(result.attachments![0].url).search).toBe("")
  }
})
