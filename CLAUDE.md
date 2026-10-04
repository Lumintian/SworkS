# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SworkS is a single-user, local-only tutor workbench (家教工作台) for collecting and organising exam problems (题目) and source materials (资料), classifying them with custom properties (题型, 难度, the 考点 tree…) and nested `/` tags, and logging students' attempts (学生 + 作答流水). One Node process serves the API, the attachments and the built React UI, bound to 127.0.0.1. User-facing text, docs and code comments are in Chinese; keep them that way.

Read these before non-trivial changes:
- `docs/architecture.md`: runtime, data model, save model, remote images, search, backup/restore, security and frontend structure, plus the design trade-offs.
- `docs/development.md`: commands, dev mode, test conventions, dependency policy, and the checklist for schema changes.
- `docs/schema.md` and `docs/backup-format.md`.
- `docs/search-syntax.md` (query language), `docs/mcp.md`, `docs/plugins.md` (plugin API design; types only so far).

## Commands

Use pnpm only. Native deps must stay listed under `allowBuilds` in `pnpm-workspace.yaml`.

```bash
pnpm install --frozen-lockfile
pnpm dev                                # API on :4822 (tsx watch, --no-web) + Vite on :5173 proxying /api
pnpm typecheck                          # server, web and test tsconfigs
pnpm test                               # Vitest: tests/server + tests/render
pnpm build && pnpm test:e2e             # Playwright runs against dist/, so rebuild first
pnpm test:all
pnpm exec vitest run tests/server/backup.test.ts -t "篡改附件"      # single Vitest test
pnpm exec playwright test tests/e2e/capture.spec.ts -g "两个页面"   # single e2e test
pnpm start -- --data-dir ./sworks-data
pnpm restore -- --input <backup.sworks.zip> --data-dir <new-empty-dir>
pnpm mcp -- --data-dir ./sworks-data   # MCP stdio bridge to a running server
```

Server code compiles with NodeNext ESM, so relative imports need `.js` extensions. Web code resolves `@shared/*` through the Vite, Vitest and tsconfig aliases.

## Invariants that are easy to break

- **Markdown source is authoritative.** Saving, reordering, previewing or archiving remote images must never rewrite it. Remote images resolve through the `remote_images` URL → asset mapping; only the Markdown export rewrites URLs.
- **Saves.** Problems and materials are saved as whole aggregates in one transaction (`services/entities.ts`).
  - IDs are generated on the client, so creates are idempotent.
  - Updates require `expectedVersion`; a mismatch returns 409.
  - A real change bumps `write_version`/`updated_at`; a no-op save must not.
  - Notes omitted from a save are soft-deleted.
  - `properties` in a save is optional (omitted = untouched); when present, omitted live properties are cleared. Archived / non-applicable property values stay frozen.
  - Nothing is ever hard-deleted, and attachments are never garbage-collected. (Only exception: unreferenced tag rows after a tag delete in 数据管理.)
- **Batch and management ops** (`services/batch.ts`, `taxonomy.ts`, `properties.ts`) that change a problem/material must bump `write_version` + `updated_at` and `reindex()` for each really changed item in the same transaction, so stale editors get 409 instead of writing old tags/values back. Option rename/move only reindexes. Student attempts (`services/students.ts`) and lessons (`services/lessons.ts`, which reference problems and carry their own `write_version`) never bump the problem version.
- **Versions and change events.** `services/versioning.ts#bumpVersion` is the only place that bumps `write_version`/`updated_at`; it also records a change. Every service write must record what it changed (`record*()` from `events/changes.ts`) inside the same transaction, so rolled-back writes emit nothing and committed ones reach the EventBus / SSE (`GET /api/events`). Writes from MCP/plugins go through `ops/` (`invokeOp`, `patchProblem`), never a new write path.
- **Search index.** `search_index` is derived and excluded from backups. Call `reindex()` inside the same write transaction.
- **Schema changes.** Never edit released migrations (`schema-v1.ts` … `schema-v5.ts`). A schema change also means a new frozen `RECORD_TABLES_Vn`, a `BACKUP_VERSIONS` row and a backup format version bump (see the checklist in `docs/development.md`). Restore builds the backup's schema version first, inserts, then migrates, so old backups stay restorable.
- **List filters** are encoded/decoded only by `src/shared/listFilters.ts` (used by both the URL and the server). All conditions live in the query text `q`; the query language is in `src/shared/query/` (shared by server and web, used through `listFilters.ts`). Compiled leaf conditions must be NULL-safe (evaluate to 0/1) so negation is correct. Index text and query terms both go through `normText()`; bump `SEARCH_INDEX_VERSION` when indexing rules change. Tag hierarchy is derived from names via `src/shared/tagPath.ts`; always compare tags with `tagKey()`.
- **Routes** live in `http/routes/*.ts` (each exports `register(app, ctx)`) and only validate input and call services; `app.ts` only composes them. Error codes are shared in `src/shared/errors.ts`; never return raw SQLite messages.
- **Image ingest.** New images are stored only through `services/imageConvert.ts#prepareForStorage` (called by `ingest.ts`). Stored assets are only PNG/JPEG/WebP/GIF; HEIC/HEIF/AVIF are input-only and always converted. Keep the ICC profile and never colour-convert; strip other metadata. Remote images stay byte-identical unless input-only. Existing assets are never re-encoded.
- **Security.** Mutating routes rely on `http/security.ts`: loopback Host, same-origin Origin and the `x-sworks-csrf` token. Never add CORS headers or a non-loopback bind. `/mcp` auth lives only in `security.ts` (enabled flag, no Origin, Bearer token); the token file `mcp.json` never goes into backups. MCP tools are generated from `ops/`; add capabilities there, not as ad-hoc tools. Remote downloads must go through `services/remoteFetch.ts`, which validates every hop and pins the connection to the validated address.
- **"已保存" (saved) in the UI** appears only after a 2xx response. Failed saves keep the draft intact.
- **Markdown rendering.** All rendering uses the single plugin chain in `src/web/markdown/plugins.ts`.
- **Theme.** Follow the tokens in `src/web/styles/app.css`. Never crop or tint original images (`object-fit: contain`).

## Tests

- `tests/helpers/server.ts#makeTestApp` builds a real library in a temp dir and calls the Hono app with correct Host, Origin and CSRF headers.
- Remote-image tests must not hit the internet. They inject `fetchPolicy.isAddressAllowed`/`resolve` against a local HTTP server.
- E2E tests spawn the built CLI as real processes and simulate clipboard pastes with `DataTransfer`.
