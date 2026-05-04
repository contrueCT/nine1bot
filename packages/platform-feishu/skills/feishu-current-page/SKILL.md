---
name: feishu-current-page
version: 0.1.0
description: "Use the current Feishu/Lark browser page context and metadata. Prefer focused document snippets and drive search through official lark-cli skills."
metadata:
  requires:
    bins: ["lark-cli"]
---

# Feishu Current Page

Use this skill when the user is working from a Feishu/Lark browser side panel and asks about the current page, current document, or nearby Feishu context.

## Context Sources

First inspect the current page context and the `page:feishu-metadata` block if present. Useful fields include:

- Page URL and browser title.
- `raw.feishu.route`, `raw.feishu.token`, `raw.feishu.objType`.
- `raw.feishu.tableId` and `raw.feishu.viewId` for Base pages.
- `raw.feishu.metadata` and `raw.feishu.enrichment.resolvedObjType` / `resolvedObjToken` from metadata enrichment.
- `raw.feishu.enrichment.spaceId` for Wiki pages.

For Wiki pages, the URL token is a wiki node token. Do not treat it as a document/file token. Prefer the resolved object type and token from metadata. If metadata is unavailable, resolve it first:

```bash
lark-cli wiki spaces get_node --params @params.json --as user --format json
```

where `params.json` contains:

```json
{"token":"<wiki_node_token>"}
```

## Current Document Snippets

For `docx` pages and Wiki nodes resolved to `docx`, use focused reads with the official docs command:

```bash
lark-cli docs +fetch --api-version v2 --doc "<url-or-docx-token>" --scope outline --detail simple --doc-format text --as user --format json
```

Prefer snippet modes before reading a whole document:

- `--scope outline` to inspect structure.
- `--scope keyword --keyword "<terms>"` to find relevant sections.
- `--scope range --start-block-id "<block_id>" --end-block-id "<block_id-or--1>"` after IDs are known.
- `--scope section --start-block-id "<heading_block_id>"` for one section.

Use `--detail simple` and `--doc-format text` by default to keep context small. Only fetch the whole document when the user clearly asks for full content.

For sheets, Base, slides, files, and folders, prefer the matching official skills:

- `lark-sheets` for spreadsheets.
- `lark-base` for Base / bitable pages.
- `lark-slides` for slides.
- `lark-drive` for files and folders.

## Search Related Feishu Context

Use Drive search when the user asks to find related documents or broader Feishu context:

```bash
lark-cli drive +search --query "<keywords>" --doc-types docx,wiki,sheet,bitable,slides,file --page-size 10 --as user --format json
```

Use scope hints when available:

- If the current page is a folder, add `--folder-tokens "<folder_token>"`.
- If the current page metadata has a Wiki space id, add `--space-ids "<space_id>"`.

Search results are for locating likely context. Do not automatically read every result. Read only the relevant item or ask the user to choose when multiple results look plausible.

## Write Operations

When the user asks you to create, update, move, delete, share, or otherwise modify Feishu/Lark content, first make the intended change explicit:

- Target object: current page, resolved object token/type, or a search result chosen by the user.
- Action type: create, append, replace, move, delete, permission change, share setting, or another operation.
- Impact scope: one block, one document, selected records, one folder, or a batch.
- Current-page dependency: whether the change is based on the active browser page, current selection, or metadata from `page:feishu-metadata`.

Prefer official `lark-cli` shortcuts and raw API commands. If the specific command supports `--dry-run`, run dry-run first, summarize the planned change, and wait for the normal Nine1Bot/tool permission flow or the user's confirmation before executing the real write. Do not invent dry-run behavior for commands that do not support it.

For commands without dry-run, reduce risk by using narrow parameters and explicit object tokens. Do not build a Nine1Bot-specific wrapper, do not reinterpret the entire CLI schema, and do not bypass the official CLI's own prompts or the existing Nine1Bot permission mechanism.

For Wiki pages, writes must use the resolved object type and token from metadata whenever available. If metadata is missing, resolve the wiki node first with `wiki spaces get_node`; never use a wiki node token directly as a docx/file token for writes.

Permission changes, bulk deletes, bulk moves, and public sharing need especially clear impact summaries, but they do not require a separate Nine1Bot high-risk API confirmation layer. Follow the official CLI behavior and existing shell/tool permission flow.

## Safety

Do not ask the user to copy access tokens, cookies, or CLI private config. The official `lark-cli` owns authentication. If CLI auth is missing, guide the user through official CLI login instead of inventing a separate auth flow.
