import { Hono } from 'hono'
import { addPreference, deletePreference, formatPreferencesAsPrompt, getPreferences, loadPreferences, updatePreference } from '../../preferences'

function resolveProjectDir(request: Request, defaultProjectDir: string): string {
  const url = new URL(request.url)
  return (
    url.searchParams.get('directory') ||
    request.headers.get('x-opencode-directory') ||
    process.env.NINE1BOT_PROJECT_DIR ||
    defaultProjectDir
  )
}

export function createPreferencesRoutes(defaultProjectDir: string) {
  return new Hono()
    .get('/', async (c) => {
      const projectDir = resolveProjectDir(c.req.raw, defaultProjectDir)
      const state = await loadPreferences(projectDir, true)
      return c.json({
        preferences: state.merged,
        global: state.global,
        project: state.project,
      })
    })
    .post('/', async (c) => {
      const projectDir = resolveProjectDir(c.req.raw, defaultProjectDir)
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (!content) {
        return c.json({ error: 'content is required' }, 400)
      }
      const scope = body.scope === 'project' ? 'project' : 'global'
      const source = body.source === 'ai' ? 'ai' : 'user'
      return c.json(await addPreference({ content, scope, source }, projectDir))
    })
    .patch('/:id', async (c) => {
      const projectDir = resolveProjectDir(c.req.raw, defaultProjectDir)
      const { id } = c.req.param()
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (!content) {
        return c.json({ error: 'content is required' }, 400)
      }
      const updated = await updatePreference(id, { content }, projectDir)
      if (!updated) {
        return c.json({ error: 'Preference not found' }, 404)
      }
      return c.json(updated)
    })
    .delete('/:id', async (c) => {
      const projectDir = resolveProjectDir(c.req.raw, defaultProjectDir)
      const { id } = c.req.param()
      const deleted = await deletePreference(id, projectDir)
      if (!deleted) {
        return c.json({ error: 'Preference not found' }, 404)
      }
      return c.json(true)
    })
    .get('/prompt', async (c) => {
      const projectDir = resolveProjectDir(c.req.raw, defaultProjectDir)
      const preferences = await getPreferences(projectDir)
      return c.json({ prompt: formatPreferencesAsPrompt(preferences) })
    })
}
