export interface ShellGlobalEventEnvelope {
  directory?: string
  payload: {
    type: string
    properties: Record<string, any>
  }
}

type Listener = (event: ShellGlobalEventEnvelope) => void

export class ShellGlobalEvents {
  private listeners = new Set<Listener>()
  private projectContextRevision = new Map<string, number>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: ShellGlobalEventEnvelope): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  emitProjectUpdated(project: any, directory?: string): void {
    const updatedAt = Date.now()
    this.emit({
      directory: directory ?? project?.rootDirectory ?? project?.worktree,
      payload: {
        type: 'project.updated',
        properties: {
          ...project,
          rootDirectory: project?.rootDirectory ?? project?.worktree,
          time: {
            ...(project?.time || {}),
            updated: updatedAt,
            configUpdated: updatedAt,
          },
        },
      },
    })
  }

  emitProjectContextUpdated(projectID: string, changed: string[], directory?: string): void {
    const revision = (this.projectContextRevision.get(projectID) ?? 0) + 1
    this.projectContextRevision.set(projectID, revision)

    this.emit({
      directory,
      payload: {
        type: 'project.context.updated',
        properties: {
          projectID,
          revision,
          changed: [...new Set(changed)],
          updatedAt: Date.now(),
        },
      },
    })
  }
}
