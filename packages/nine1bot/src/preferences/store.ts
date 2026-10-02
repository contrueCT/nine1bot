/** Compatibility API backed by the same atomic store as routes, prompts and tools. */
import { join } from 'path'
import { getGlobalConfigDir } from '../config/loader'
import { Preferences } from '../../../../opencode/packages/opencode/src/preferences'
import { Project } from '../../../../opencode/packages/opencode/src/project/project'
import { Instance } from '../../../../opencode/packages/opencode/src/project/instance'
import type { AddPreferenceInput, UpdatePreferenceInput, Preference, PreferencesState } from './types'

export function getGlobalPreferencesPath(): string {
  return process.env.NINE1BOT_PREFERENCES_PATH || join(getGlobalConfigDir(), 'preferences.json')
}

/** Location of historical project-local preferences, still read and editable in place. */
export function getProjectPreferencesPath(projectDir = process.env.NINE1BOT_PROJECT_DIR || process.cwd()): string {
  return join(projectDir, '.nine1bot/preferences.json')
}

async function context(projectDir = process.env.NINE1BOT_PROJECT_DIR || process.cwd()): Promise<Preferences.Context> {
  const directory = await Instance.normalizeDirectory(projectDir)
  const { project } = await Project.fromDirectory(directory)
  return { projectID: project.id, directory: project.rootDirectory, workingDirectory: directory }
}

export async function loadPreferences(projectDir?: string, _forceReload = false): Promise<PreferencesState> {
  const state = await Preferences.list(await context(projectDir), getGlobalPreferencesPath())
  return { ...state, merged: state.preferences }
}

export async function getPreferences(projectDir?: string): Promise<Preference[]> {
  return (await loadPreferences(projectDir)).merged
}

export async function getPreference(id: string, projectDir?: string): Promise<Preference | null> {
  const matches = (await getPreferences(projectDir)).filter((preference) => preference.id === id)
  if (matches.length > 1) throw new Preferences.AmbiguousError()
  return matches[0] ?? null
}

export async function addPreference(input: AddPreferenceInput, projectDir?: string): Promise<Preference> {
  return Preferences.add(input, await context(projectDir), getGlobalPreferencesPath())
}

export async function updatePreference(id: string, input: UpdatePreferenceInput, projectDir?: string): Promise<Preference | null> {
  return await Preferences.update(id, input, await context(projectDir), getGlobalPreferencesPath()) ?? null
}

export async function deletePreference(id: string, projectDir?: string): Promise<boolean> {
  return Preferences.remove(id, await context(projectDir), getGlobalPreferencesPath())
}

/** Kept for callers of the old API; reads no longer cache project-sensitive data. */
export function clearCache(): void {}

export function formatPreferencesAsPrompt(preferences: Preference[]): string {
  return Preferences.format(preferences)
}
