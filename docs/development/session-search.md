# Conversation history search

`GET /session/search?q=<literal substring>&limit=50` searches the project selected by the usual `x-opencode-directory` header (or directory query routing). It does not search other projects. Results include root sessions across directories within that project, excluding webhook and schedule sessions. The optional `clientSource=browser-extension` filter is applied before the result limit.

The response is `{ results: [{ session, messageID?, snippet }], hasMore }`. Results are deduplicated by session and ordered by most recently updated. A matching title takes precedence over a body match; otherwise the newest matching message and first matching part supply the excerpt and message ID. The default limit is 50, maximum 100. Queries must be nonblank and at most 500 characters. Matches are case-insensitive literal substrings, including Chinese, English, emoji, punctuation and code. There is no stemming, token-AND syntax, or regex syntax.

Only visible text parts belonging to user/assistant messages are indexed. Synthetic/ignored/hidden parts, assistant compaction summaries, tool output, reasoning and attachments are excluded. Undone messages/parts are suppressed while a session has a revert boundary. Streamed text becomes searchable on the next query after its buffered part is persisted.

## Local derived index

The source of truth remains the existing JSON storage. Bun's built-in SQLite provides an FTS5 trigram index at `$XDG_CACHE_HOME/opencode/session-search-v1.sqlite` (using the app's normal XDG default when that variable is unset). WAL/SHM siblings belong to this cache. First search backfills that project's history once; later searches use the persisted index. One- and two-character queries scan indexed text locally because the trigram index cannot accelerate them; they do not reread every conversation JSON file per query.

Storage writes, atomic writes, updates and deletes durably mark affected keys dirty both before and after source mutation. Query-time reconciliation reads canonical JSON instead of trusting a writer's completion payload, so overlapping writers that finish out of order cannot publish obsolete text. Completed writes are reconciled before returning subsequent queries. A query overlapping an unfinished write may see the preceding or new canonical value; it retains that write's dirty marker so later queries repair it, including after a writer crash.

The mutation journal is stored separately at `$XDG_DATA_HOME/opencode/session-search-journal-v1.sqlite`, outside the disposable cache. Automatic FTS/cache recovery never removes it. Per-operation writer tokens survive in this journal, while completion advances the key revision even if the cache was replaced between begin and finish. Readers retry snapshots invalidated by either boundary. Newly indexed parents refresh their descendants; ordinary known-parent title/timestamp/message metadata edits only reread their dirty keys. Initial project backfill recursively visits history. Message/session deletion eagerly purges derived text and keeps reconciliation dirty in case another writer already recreated the canonical record. If journal completion temporarily fails, the owning process retains the exact completed tokens and retries with bounded backoff (50 ms up to 5 seconds), without retiring other active writers. Every terminal source operation, including failed writes, atomic writes, removals and corrupted-record cleanup, retires its exact writer token in a finally block while keeping canonical reconciliation dirty. These paths cover imports, renames, streaming persistence, message/part deletion and revert cleanup.

Each derived-cache generation has a persistent UUID bound to an epoch in the durable journal. Rebuilds and derived commits share the journal lock; readers validate their generation and physical file identity inside that lock before applying data or consuming dirty markers. This also works without usable inode numbers. A reader whose cache was closed/replaced retries once on the current generation; repeated replacement returns an error without discarding provenance.

Cache errors never prevent saving/deleting source records. Missing or corrupt caches are rebuilt automatically. To force a rebuild, stop processes using this data directory, remove only the `session-search-v1.sqlite`, `session-search-v1.sqlite-wal` and `session-search-v1.sqlite-shm` cache files, then restart and search. Do not remove JSON storage or the separate mutation journal when rebuilding the cache. If the durable journal itself cannot be opened, source writes remain available while search reports an error rather than discarding provenance. The first query after rebuilding can take longer for large histories. This is a rebuildable local cache, not a separate backup, and is not an authorization boundary.

## Validation

From `opencode/packages/opencode`:

```
bun test test/session/search-index.test.ts test/server/session-search.test.ts test/storage/session-search.test.ts
bun run typecheck
```

Tests cover multilingual/code matching, filtered limits, stable excerpts, excluded content, historical backfill, persistence/recovery, deletion purging, concurrent index connections, project-scoped routing, mutation/revert correctness and cache failure isolation. SDK generation is coordinated with other route changes using `opencode/packages/sdk/js/script/build.ts`.
