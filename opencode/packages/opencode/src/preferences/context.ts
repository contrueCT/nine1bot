import { Instance } from "../project/instance"
import { Project } from "../project/project"
import type { Preferences } from "."

export function projectPreferenceContext(project: Project.Info, workingDirectory: string): Preferences.Context {
  return {
    projectID: project.id,
    directory: project.rootDirectory,
    workingDirectory,
    // A directory project can acquire a Git identity. Only these exact known
    // paths are recoverable; adopting their records still needs explicit action.
    recoverableProjectIDs: [...new Set([project.rootDirectory, workingDirectory])].map(Project.directoryProjectID),
  }
}

/** Reuse an executor's identity without seeding an uninitialized server cache. */
export async function preferenceContext(workingDirectory: string): Promise<Preferences.Context> {
  const directory = await Instance.normalizeDirectory(workingDirectory)
  const existing = await Instance.existing(directory)
  const project = existing?.project ?? (await Project.fromDirectory(directory)).project
  return projectPreferenceContext(project, directory)
}
