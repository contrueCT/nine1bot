import { Hono } from 'hono'
import type { EngineManager } from '../../engine'
import { ProjectEnvironment } from '../../project/environment'
import { ProjectSharedFiles } from '../../project/shared-files'
import { ShellGlobalEvents } from '../events'

interface ProjectContextRoutesOptions {
  engineManager: EngineManager
  globalEvents: ShellGlobalEvents
}

interface ProjectInfo {
  id: string
  worktree: string
  rootDirectory: string
  time?: {
    created?: number
    updated?: number
    initialized?: number
    configUpdated?: number
  }
  [key: string]: any
}

async function fetchProject(engineManager: EngineManager, projectID: string): Promise<ProjectInfo> {
  const response = await fetch(`${engineManager.currentBaseUrl()}/project/${encodeURIComponent(projectID)}`)
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(message || `Failed to load project ${projectID}`)
  }
  return response.json() as Promise<ProjectInfo>
}

function emitProjectContextChanged(globalEvents: ShellGlobalEvents, project: ProjectInfo, changed: string[]) {
  globalEvents.emitProjectUpdated(project, project.rootDirectory)
  globalEvents.emitProjectContextUpdated(project.id, changed, project.rootDirectory)
}

export function createProjectContextRoutes(options: ProjectContextRoutesOptions) {
  return new Hono()
    .get('/:projectID/environment', async (c) => {
      const { projectID } = c.req.param()
      await fetchProject(options.engineManager, projectID)
      const variables = await ProjectEnvironment.getAll(projectID)
      return c.json({
        keys: Object.keys(variables).sort(),
        variables,
      })
    })
    .put('/:projectID/environment', async (c) => {
      const { projectID } = c.req.param()
      const project = await fetchProject(options.engineManager, projectID)
      const body = await c.req.json().catch(() => ({})) as Record<string, any>
      const variables = await ProjectEnvironment.setAll(projectID, body.variables || {})
      emitProjectContextChanged(options.globalEvents, project, ['environment'])
      return c.json(variables)
    })
    .patch('/:projectID/environment/:key', async (c) => {
      const { projectID, key } = c.req.param()
      const project = await fetchProject(options.engineManager, projectID)
      const body = await c.req.json().catch(() => ({})) as Record<string, any>
      if (typeof body.value !== 'string') {
        return c.json({ error: 'value is required' }, 400)
      }
      const variables = await ProjectEnvironment.set(projectID, key, body.value)
      emitProjectContextChanged(options.globalEvents, project, ['environment'])
      return c.json(variables)
    })
    .delete('/:projectID/environment/:key', async (c) => {
      const { projectID, key } = c.req.param()
      const project = await fetchProject(options.engineManager, projectID)
      const variables = await ProjectEnvironment.remove(projectID, key)
      emitProjectContextChanged(options.globalEvents, project, ['environment'])
      return c.json(variables)
    })
    .get('/:projectID/shared-files', async (c) => {
      const { projectID } = c.req.param()
      const project = await fetchProject(options.engineManager, projectID)
      return c.json(await ProjectSharedFiles.list(project.rootDirectory))
    })
    .post('/:projectID/shared-files', async (c) => {
      const { projectID } = c.req.param()
      const project = await fetchProject(options.engineManager, projectID)
      const body = await c.req.json().catch(() => ({})) as Record<string, any>
      if (typeof body.filename !== 'string' || typeof body.url !== 'string') {
        return c.json({ error: 'filename and url are required' }, 400)
      }
      const file = await ProjectSharedFiles.save(project.rootDirectory, {
        filename: body.filename,
        url: body.url,
        mime: typeof body.mime === 'string' ? body.mime : undefined,
      })
      emitProjectContextChanged(options.globalEvents, project, ['shared_files'])
      return c.json(file)
    })
    .delete('/:projectID/shared-files', async (c) => {
      const { projectID } = c.req.param()
      const project = await fetchProject(options.engineManager, projectID)
      const body = await c.req.json().catch(() => ({})) as Record<string, any>
      if (typeof body.relativePath !== 'string') {
        return c.json({ error: 'relativePath is required' }, 400)
      }
      await ProjectSharedFiles.remove(project.rootDirectory, body.relativePath)
      emitProjectContextChanged(options.globalEvents, project, ['shared_files'])
      return c.json(true)
    })
}
