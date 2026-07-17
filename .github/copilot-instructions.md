# ChronoFrame coding guidelines

ChronoFrame is a Nuxt 4 personal gallery deployed exclusively as a Cloudflare
Worker. Keep changes compatible with the Workers runtime and the fixed
Cloudflare storage architecture.

## Architecture

- `app/`: Vue 3/Nuxt UI, pages, stores, and composables.
- `server/`: Nitro API routes, D1 access, and Cloudflare service adapters.
- `packages/webgl-image/`: workspace WebGL image viewer package.
- `shared/`: types and utilities shared by client and server.
- `server/database/schema.ts`: Drizzle schema; tracked migrations live in
  `server/database/migrations/`.
- `wrangler.jsonc`: production entry point and binding declarations.

The production data boundaries are fixed:

| Data                                | Service                         | Binding        |
| ----------------------------------- | ------------------------------- | -------------- |
| Relational records and task state   | D1                              | `DB`           |
| Every uploaded image binary         | Cloudflare Images Hosted Images | `IMAGES`       |
| Every video binary and HLS playback | Cloudflare Stream               | `STREAM`       |
| Other non-image, non-video objects  | R2                              | `MEDIA_BUCKET` |
| Built Nuxt client files             | Workers Assets                  | `ASSETS`       |

Do not add S3, local-filesystem, OpenList, GitHub, native SQLite, or container
storage paths. Do not route image or video binaries into R2. Worker code must
not depend on writable disk, child processes, `better-sqlite3`, Sharp, or
ExifTool.

## Server conventions

- Use `useDB()` and the exports from `server/utils/db.ts`; all D1 operations are
  asynchronous. Add schema changes as Drizzle migrations and verify them with
  Wrangler.
- Access Cloudflare resources through the adapters in
  `server/services/cloudflare/` and the bindings in
  `server/utils/cloudflare-bindings.ts`.
- Image upload, delivery, transformation, and deletion use Hosted Images.
- Video upload intents create one-time Stream Direct Creator Upload URLs.
  Persist processing state in D1 and expose playback only after Stream reports
  the video ready with an HLS manifest.
- `/api/objects` is the admin-only catalog for non-media R2 objects. Validate
  filename, MIME type, and byte count before accepting data.
- Require `requireAdminSession(event)` for management and mutation routes.
  Serialize users with `toPublicSessionUser()`; never put password hashes or
  database-only fields in a session.
- Preserve hidden-album access controls on metadata and media routes.
- The first-run onboarding flow requires `CFRAME_BOOTSTRAP_TOKEN`.
  `NUXT_SESSION_PASSWORD` and the bootstrap token are Wrangler secrets, not D1
  settings or public runtime values.

## Frontend conventions

- Use Vue Composition API and shared types; avoid `any` unless an external API
  boundary makes it unavoidable.
- Keep Cloudflare service limits aligned between server validation and the
  upload UI. The current basic Stream POST flow is for files under 200 MB;
  larger files need a separate tus implementation.
- Use `useStreamVideo()` for HLS playback and destroy HLS instances when media
  leaves the viewport or a component unmounts.
- Preserve the WebGL viewer fallback and lazy-loading behavior when changing
  masonry or photo-viewer components.

## Commands

```bash
pnpm install
pnpm cf:typegen
pnpm d1:migrate:local
pnpm dev:worker
pnpm build:worker
pnpm lint
pnpm fmt:check
pnpm docs:build
```

Use `pnpm d1:generate` for schema changes and review the generated SQL before
applying it. `pnpm run deploy` builds the Worker, applies remote D1 migrations, and
deploys through Wrangler. Do not restore Docker build or image-publishing
workflows; the old container implementation is available from historical Git
tags for migration reference.
