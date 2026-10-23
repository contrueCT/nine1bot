import { Storage } from "../storage/storage"
import { ProjectEnvironment } from "./environment"
import type { Project } from "./project"
import type { Session } from "../session"

async function optional<T>(key: string[]) {
  return Storage.read<T>(key, { preserveCorrupted: true }).catch((error) => {
    if (Storage.NotFoundError.isInstance(error)) return undefined
    throw error
  })
}

/** Called under the project discovery lock before its instance starts. */
export async function migrateDirectoryProject(sourceID: string, target: Project.Info): Promise<Project.Info> {
  const marker = ["project_migration", sourceID, target.id]
  if ((await optional<{ complete: boolean }>(marker))?.complete) return target
  const source = await optional<Project.Info>(["project", sourceID])
  const sessions = await Storage.list(["session", sourceID], { strict: true })
  if (!source && sessions.length === 0) return target

  const backup = async (key: string[], value: unknown) => {
    const saved = ["project_migration_backup", sourceID, target.id, ...key]
    if (await optional(saved) === undefined) await Storage.writeAtomic(saved, value)
  }
  const copy = async (key: string[]) => {
    const value = await Storage.read(key, { preserveCorrupted: true })
    await backup(key, value)
    const destination = [key[0], target.id, ...key.slice(2)]
    if (await optional(destination) === undefined) await Storage.writeAtomic(destination, value)
  }

  // Keep all original values, including conflicts, in a separate recovery tree.
  // Atomic destination writes always precede removal of a canonical source key.
  if (source) {
    await backup(["project", sourceID], source)
    target = {
      ...target,
      name: target.name ?? source.name,
      icon: target.icon ?? source.icon,
      instructions: target.instructions ?? source.instructions,
      commands: target.commands ?? source.commands,
      sandboxes: [...new Set([...(source.sandboxes ?? []), ...(target.sandboxes ?? [])])],
      time: {
        ...target.time,
        created: Math.min(source.time.created, target.time.created),
        initialized: target.time.initialized ?? source.time.initialized,
        configUpdated: Math.max(source.time.configUpdated ?? 0, target.time.configUpdated ?? 0) || undefined,
      },
    }
  }
  await Storage.writeAtomic(["project", target.id], target)
  for (const namespace of ["runtime_profile", "context_state", "context_event"]) {
    for (const key of await Storage.list([namespace, sourceID], { strict: true })) await copy(key)
  }
  const revisionKey = ["project_config", sourceID]
  const revision = await optional<{ revision: number; updatedAt: number }>(revisionKey)
  if (revision) {
    await backup(revisionKey, revision)
    const current = await optional<typeof revision>(["project_config", target.id])
    await Storage.writeAtomic(["project_config", target.id], {
      revision: Math.max(revision.revision, current?.revision ?? 0),
      updatedAt: Math.max(revision.updatedAt, current?.updatedAt ?? 0),
    })
  }
  await ProjectEnvironment.migrate(sourceID, target.id)

  // Automation records have global IDs; update only their project reference.
  for (const namespace of ["scheduled_task", "scheduled_run", "webhook_source", "webhook_run"]) {
    for (const key of await Storage.list([namespace], { strict: true })) {
      const record = await Storage.read<{ projectID?: string }>(key, { preserveCorrupted: true })
      if (record.projectID !== sourceID) continue
      await backup(key, record)
      await Storage.updateAtomic<{ projectID?: string }>(key, (draft) => {
        if (draft.projectID === sourceID) draft.projectID = target.id
      })
    }
  }
  for (const key of sessions) {
    const session = await Storage.read<Session.Info>(key, { preserveCorrupted: true })
    await backup(key, session)
    const destination = ["session", target.id, session.id]
    // A prior interrupted attempt or subsequent target edit wins on retry.
    if (await optional(destination) === undefined) {
      await Storage.writeAtomic(destination, { ...session, projectID: target.id })
    }
    await Storage.remove(key)
  }
  const metaKey = ["project_meta", sourceID]
  const meta = await optional<Record<string, unknown>>(metaKey)
  if (meta) await backup(metaKey, meta)
  await Storage.writeAtomic(metaKey, { ...meta, hidden: true, migratedTo: target.id })
  await Storage.writeAtomic(marker, { complete: true, sourceID, targetID: target.id, completedAt: Date.now() })
  return target
}
