# Conversation history search

`GET /session/search?q=<literal substring>&limit=50` searches the project selected by the usual `x-opencode-directory` header (or directory query routing). It does not search other projects. Results include root sessions across directories within that project, excluding webhook and schedule sessions. The optional `clientSource=browser-extension` filter is applied before the result limit.

The response is `{ results: [{ session, messageID?, snippet }], hasMore }`. Results are deduplicated by session and ordered by most recently updated. A matching title takes precedence over a body match; otherwise the newest matching message and first matching part supply the excerpt and message ID. The default limit is 50, maximum 100. Queries must be nonblank and at most 500 characters. Matches are case-insensitive literal substrings, including Chinese, English, emoji, punctuation and code. There is no stemming, token-AND syntax, or regex syntax.

Only visible text parts belonging to user/assistant messages are indexed. Synthetic/ignored/hidden parts, assistant compaction summaries, tool output, reasoning and attachments are excluded. Undone messages/parts are suppressed while a session has a revert boundary. Streamed text becomes searchable when its buffered part is persisted.

## Local derived index

The source of truth remains the existing JSON storage. Bun's built-in SQLite provides an FTS5 trigram index at `$XDG_CACHE_HOME/opencode/session-search-v1.sqlite` (using the app's normal XDG default when that variable is unset). WAL/SHM siblings belong to this cache. First search backfills that project's history once; later searches use the persisted index. One- and two-character queries scan indexed text locally because the trigram index cannot accelerate them; they do not reread every conversation JSON file per query.

Storage writes, atomic writes, updates and deletes maintain the index, covering imports, renames, streaming persistence, message/part deletion and revert cleanup. Deletions purge corresponding derived documents. A persistent pending-write journal repairs an interrupted JSON/index update on the next search. Persistent per-key revisions prevent concurrent backfill from overwriting newer indexed records, including updates from another server process sharing the same cache. Searches leave another live process's unfinished write for that writer to complete.

Cache errors never prevent saving/deleting source records. Missing or corrupt caches are rebuilt automatically. To force a rebuild, stop processes using this data directory, remove only the `session-search-v1.sqlite`, `session-search-v1.sqlite-wal` and `session-search-v1.sqlite-shm` cache files, then restart and search. Do not remove JSON storage. The first query after rebuilding can take longer for large histories. This is a rebuildable local cache, not a separate backup, and is not an authorization boundary.

## Validation

From `opencode/packages/opencode`:

```
bun test test/session/search-index.test.ts test/server/session-search.test.ts test/storage/session-search.test.ts
bun run typecheck
```

Tests cover multilingual/code matching, filtered limits, stable excerpts, excluded content, historical backfill, persistence/recovery, deletion purging, concurrent index connections, project-scoped routing, mutation/revert correctness and cache failure isolation. SDK generation is coordinated with other route changes using `opencode/packages/sdk/js/script/build.ts`.
