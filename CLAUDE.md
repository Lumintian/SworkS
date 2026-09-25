# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SworkS is a single-user, local-only workbench for collecting and organising exam problems (题目) and source materials (资料). One Node process serves the API, the attachments and the built React UI, bound to 127.0.0.1. User-facing text, docs and code comments are in Chinese; keep them that way.

Read these before non-trivial changes:
- `docs/architecture.md`: runtime, data model, save model, remote images, search, backup/restore, security and frontend structure, plus the design trade-offs.
- `docs/development.md`: commands, dev mode, test conventions, dependency policy, and the checklist for schema changes.
- `docs/schema.md` and `docs/backup-format.md`.

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
```

Server code compiles with NodeNext ESM, so relative imports need `.js` extensions. Web code resolves `@shared/*` through the Vite, Vitest and tsconfig aliases.

## Invariants that are easy to break

- **Markdown source is authoritative.** Saving, reordering, previewing or archiving remote images must never rewrite it. Remote images resolve through the `remote_images` URL → asset mapping; only the Markdown export rewrites URLs.
- **Saves.** Problems and materials are saved as whole aggregates in one transaction (`services/entities.ts`).
  - IDs are generated on the client, so creates are idempotent.
  - Updates require `expectedVersion`; a mismatch returns 409.
  - A real change bumps `write_version`/`updated_at`; a no-op save must not.
  - Notes omitted from a save are soft-deleted.
  - Nothing is ever hard-deleted, and attachments are never garbage-collected.
- **Search index.** `search_index` is derived and excluded from backups. Call `reindex()` inside the same write transaction.
- **Schema changes.** Never edit released migrations such as `schema-v1.ts`. A schema change also means updating `RECORD_TABLES`, the backup format version and the restore path (see the checklist in `docs/development.md`).
- **Security.** Mutating routes rely on `http/security.ts`: loopback Host, same-origin Origin and the `x-sworks-csrf` token. Never add CORS headers or a non-loopback bind. Remote downloads must go through `services/remoteFetch.ts`, which validates every hop and pins the connection to the validated address.
- **"已保存" (saved) in the UI** appears only after a 2xx response. Failed saves keep the draft intact.
- **Markdown rendering.** All rendering uses the single plugin chain in `src/web/markdown/plugins.ts`.
- **Theme.** Follow the tokens in `src/web/styles/app.css`. Never crop or tint original images (`object-fit: contain`).

## Tests

- `tests/helpers/server.ts#makeTestApp` builds a real library in a temp dir and calls the Hono app with correct Host, Origin and CSRF headers.
- Remote-image tests must not hit the internet. They inject `fetchPolicy.isAddressAllowed`/`resolve` against a local HTTP server.
- E2E tests spawn the built CLI as real processes and simulate clipboard pastes with `DataTransfer`.
