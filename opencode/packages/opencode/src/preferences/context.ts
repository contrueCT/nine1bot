import { Instance } from "../project/instance"
import type { Preferences } from "."

/** Match the cached executor identity used by sessions, HTTP routes and prompts. */
export async function preferenceContext(workingDirectory: string): Promise<Preferences.Context> {
  const directory = await Instance.normalizeDirectory(workingDirectory)
  return Instance.provide({
    directory,
    fn: () => ({ projectID: Instance.project.id, directory: Instance.project.rootDirectory, workingDirectory: directory }),
  })
}
