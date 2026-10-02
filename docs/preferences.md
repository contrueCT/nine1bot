# Scoped preferences

Nine1Bot uses one preference store for the Web API, system prompt, launcher compatibility API and built-in `remember` tool. New preferences are saved to `NINE1BOT_PREFERENCES_PATH` (normally `~/.config/nine1bot/preferences.json`). The existing version-1 format remains supported.

- Global entries apply to every project.
- New project entries include the server-resolved `projectID`. The HTTP API uses the active directory's project, and `remember` uses the session executor's working directory. Caller-supplied project IDs are not accepted.
- Prompt injection includes only global entries and entries belonging to that project. Reads do not reuse an unkeyed cache, so edits apply on the next turn.
- Historical project entries in the central file without `projectID` remain unchanged and appear under “未分配的历史项目偏好”. They are excluded from prompts until a user explicitly assigns them to the displayed project. No ownership is guessed.
- Historical `.nine1bot/preferences.json` and `nine1bot.preferences.json` files under the project root remain readable and editable in place, in that priority order. Their location establishes their project. They are not automatically moved or deleted.
- Mutations use the shared `JsonFile` helper for in-process serialization, validation and atomic file replacement. Unknown fields are preserved; malformed JSON and unsupported versions fail without replacing the file. This is not an inter-process lock: separate Nine1Bot processes should not write the same preference file concurrently.

## Web settings

The preferences panel shows the resolved project directory and all three groups. Actions stay pinned to that displayed project even if another client changes the active session. “重新加载当前项目” loads the currently selected project; it is disabled while a draft, edit or delete confirmation is open. Failed writes keep drafts/confirmations available to retry. A successful write updates the displayed list directly and does not become a false failure because of a subsequent reload.

## Remember tool

The built-in `remember` tool requires both `content` (1–4096 non-whitespace characters) and `scope` (`global` or `project`). It is only offered when Nine1Bot preferences are enabled. It requests the `remember` permission before writing; the default agent asks for approval, and the plan agent denies it by default. It uses the same store directly, without a hardcoded HTTP port, browser login, or exposing server credentials to the model. The bundled `/remember` skill instructs the assistant to save only explicitly requested preferences and never fall back to shell access after a denial.

Existing HTTP endpoints are retained. `GET /preferences` additionally returns `unresolved`, `projectID` and `directory`. `PATCH /preferences/:id` supports `{ "assignToCurrentProject": true }` only for unresolved historical records. Records owned by other projects return 404 for update/delete requests. These project boundaries are preference scoping, not multi-user access control; authenticated clients still have the server's normal ability to select a directory.
