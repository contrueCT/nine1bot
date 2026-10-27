import fs from "node:fs/promises"
import path from "node:path"

/** Each attachment owns its directory, including while an upload is incomplete. */
export namespace SessionUploads {
  export function filename(input?: string) {
    return path.basename((input || "").replace(/\0/g, "")).trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "") || "upload"
  }

  export async function createTarget(root: string, input?: string) {
    await fs.mkdir(root, { recursive: true })
    // mkdtemp atomically allocates ownership across requests and processes.
    // Keep the original display name without sharing a destination pathname.
    const directory = await fs.mkdtemp(path.join(root, "attachment-"))
    const name = filename(input)
    return {
      directory,
      filename: name,
      filePath: path.join(directory, name),
      tempFilePath: path.join(directory, ".upload.part"),
    }
  }
}
