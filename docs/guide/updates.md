# Updating ChronoFrame on Workers

ChronoFrame builds the release first, then applies pending database migrations immediately before deploying code that depends on them. Keep a recent D1 export and inventories/backups for Hosted Images, Stream videos, and R2 objects before significant upgrades.

## Automatic updates through Cloudflare GitHub integration

Commit and push reviewed changes to `main` in the connected repository. Cloudflare Workers Builds runs `pnpm run build:cloudflare`, then `pnpm run deploy:cloudflare` to apply remote D1 migrations and publish the Worker. View logs and retry builds from the Cloudflare dashboard's Builds page.

See [GitHub integration setup](/guide/getting-started#cloudflare-github-integration) for the initial connection and permissions.

## Manual local update

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm cf:typegen
pnpm run deploy
```

Review the migration SQL and release notes before deploying. `pnpm run deploy` builds before mutating D1, then Wrangler records applied migrations and only applies pending files before publishing the Worker.

## Rollback expectations

Deploying an earlier Worker version does not reverse a D1 migration. Prefer backward-compatible migrations and a staged release. If a schema rollback is unavoidable, restore or transform D1 deliberately rather than deleting migration records.

Images, Stream videos, and R2 object mutations are also independent of Worker code deployment. Keep a migration manifest for bulk changes so every service can be reconciled. A code rollback does not undo Stream uploads or delivered-minute usage.

## From the legacy Docker line

Do not use the Docker update procedure to move to this version. The Docker build and image-publishing files have been removed from the current branch because the legacy Node runtime cannot provide D1, Hosted Images, Stream, R2, or Assets bindings. Use [Migrate an existing installation](/guide/migrate-to-workers) instead; consult a pre-Workers release or Git tag only when you need the old container layout.
