# Deploy to Cloudflare Workers

ChronoFrame runs as a Nuxt application on Cloudflare Workers. D1 stores relational data, Cloudflare Images Hosted Images stores all image binaries, Cloudflare Stream stores and delivers every video, R2 stores other non-image/non-video objects, and Workers Assets serves the built client.

## Prerequisites

- Node.js 22.12 or newer and pnpm 10.
- A Cloudflare account with Workers, D1, R2, and Stream enabled.
- A Workers Paid plan. The current Wrangler bundle is larger than the Workers Free 3 MB compressed script limit; Paid allows up to 10 MB. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size).
- A [paid Cloudflare Images storage plan](https://developers.cloudflare.com/images/pricing/). Cloudflare does not provision Hosted Images from `wrangler`; enable it in the dashboard first.
- Cloudflare Stream capacity. Stream is billed by [minutes of video stored and minutes delivered](https://developers.cloudflare.com/stream/pricing/).
- Wrangler authentication: run `pnpm exec wrangler login`, or provide an API token in CI.

:::warning Image upload limits
Hosted Images accepts at most **10 MiB per stored image**. Supported inputs are JPEG, PNG, GIF, WebP, SVG, and HEIC; AVIF input is limited to Enterprise. ChronoFrame accepts a compound JPEG Motion Photo up to **25 MiB** only so the Worker can extract its appended video into Stream before upload; the remaining static JPEG must still be 10 MiB or smaller. Cloudflare also enforces dimension and pixel-area limits. Review the current [Cloudflare Images limits](https://developers.cloudflare.com/images/get-started/limits/) before importing a library.
:::

:::warning Video direct-upload limits
The `STREAM` binding currently creates a basic POST Direct Creator Upload URL, which Cloudflare supports for videos **under 200 MB**. ChronoFrame therefore defaults to **199999999 bytes**. Larger uploads require the tus protocol, which this upload flow does not implement. The default maximum duration is **600 seconds**.
:::

## 1. Install and authenticate

```bash
pnpm install
pnpm exec wrangler login
```

## 2. Create the Cloudflare resources

Create D1 and copy the returned UUID into `wrangler.jsonc`, replacing the placeholder `database_id`:

```bash
pnpm d1:create
```

Create the R2 bucket declared by `wrangler.jsonc`:

```bash
pnpm exec wrangler r2 bucket create chronoframe-storage
```

Enable Cloudflare Images in the Cloudflare dashboard. No account-level delivery variant is required: `/media/images/:id` enforces D1 visibility and returns a metadata-stripped WebP display image capped at 4096 px, while `/media/images/:id/thumbnail` returns a 600 px WebP thumbnail. Raw Hosted Image bytes are available only to administrators through `/media/images/:id/source`.

Do not expose an always-public Hosted Images variant for ChronoFrame media. It would bypass the hidden-album ACL enforced by the same-origin Worker routes. If an external integration needs direct Images delivery, it must preserve signed-URL protection and implement equivalent authorization.

Enable Cloudflare Stream in the dashboard. The `STREAM` binding is the application's authorization to Stream; do not create or store a Stream API token in ChronoFrame settings.

## 3. Verify bindings

The Worker expects these exact binding names:

| Binding        | Cloudflare resource             | Purpose                                                 |
| -------------- | ------------------------------- | ------------------------------------------------------- |
| `DB`           | D1 database `chronoframe-db`       | Users, settings, photo metadata, albums, and task state |
| `IMAGES`       | Cloudflare Images Hosted Images | Every uploaded image                                    |
| `STREAM`       | Cloudflare Stream               | Every video, including Live/Motion Photo companions     |
| `MEDIA_BUCKET` | R2 bucket `chronoframe-storage`   | Other non-image, non-video objects                      |
| `ASSETS`       | `.output/public`                | Nuxt client assets                                      |

Do not add storage access keys to Nuxt settings. These resources are available to the Worker through bindings.

### Video upload and playback

For a video upload, the authenticated Worker calls `STREAM.createDirectUpload()` with `requireSignedURLs: true` and a default `maxDurationSeconds` of 600. The binding returns a one-time URL and Stream video ID, then the browser sends the multipart file directly to Cloudflare Stream without exposing an API token. Once Stream finishes processing, D1 stores only the same-origin `/media/streams/:photoId/manifest.m3u8` playback route. That route applies the photo/album visibility policy, generates a short-lived token through the Stream binding, and redirects to the signed HLS manifest. Direct Cloudflare HLS/DASH URLs are not returned by photo APIs. See [Direct Creator Uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/).

The duration reservation counts against Stream storage capacity while the upload URL is pending. After processing, billing uses the video's actual stored duration; playback is billed in delivered minutes.

## 4. Configure bootstrap secrets

Generate two independent high-entropy values with at least 32 characters for
sessions and onboarding before the first deployment:

```bash
openssl rand -base64 32
pnpm exec wrangler secret put NUXT_SESSION_PASSWORD
openssl rand -base64 32
pnpm exec wrangler secret put CFRAME_BOOTSTRAP_TOKEN
```

The Stream webhook secret is added after the first deployment in section 5, once the public callback URL is known. For local development only, place the available values in an uncommitted `.dev.vars` file:

```dotenv
NUXT_SESSION_PASSWORD=replace-with-at-least-32-random-characters
CFRAME_BOOTSTRAP_TOKEN=replace-with-a-different-32-character-random-token
CFRAME_STREAM_WEBHOOK_SECRET=copy-result-secret-from-stream-webhook-api
```

The bootstrap token authorizes the first-run onboarding requests; it is not an administrator password and must not be stored in D1 or a plaintext Wrangler `vars` entry. Use `wrangler secret put` for any other server-only credentials. Public `NUXT_PUBLIC_*` build values can be configured as appropriate for the site.

Enter this token on the onboarding completion page. The browser sends it in the `X-Chronoframe-Bootstrap-Token` header for that request and does not persist it. API clients may use the same header or the compatible top-level `bootstrapToken` body field.

## 5. Apply D1 migrations and deploy

For cloud deployments, configure [Cloudflare GitHub integration](#cloudflare-github-integration) below. The following command is for a manual local deployment.

The deploy command builds first, then applies tracked D1 migrations immediately before deploying the matching Worker artifact:

```bash
pnpm run deploy
```

`pnpm run deploy` builds the workspace dependency and Nuxt Worker bundle before invoking Wrangler. The checked-in configuration deploys to `photograph.pitrick.dev` and disables `workers.dev`. Manage the domain under **Workers & Pages > chronoframe > Settings > Domains & Routes** and keep `wrangler.jsonc` aligned.

### Register the Stream webhook

Before accepting any video uploads, register the account-level webhook using the deployed HTTPS URL. The setup token used by this API call needs Stream Edit permission and may be separate from the CI token:

```bash
curl --request PUT \
  --url "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/webhook" \
  --header "Authorization: Bearer <STREAM_EDIT_API_TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{"notificationUrl":"https://<CHRONOFRAME_HOST>/api/webhooks/cloudflare-stream"}'

# Paste the API response's result.secret unchanged.
pnpm exec wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET
```

`wrangler secret put` publishes a Worker version containing the encrypted secret. Cloudflare allows one Stream webhook per account; updating the subscription rotates the returned secret, so update the Worker secret at the same time. Do not enable video uploads until this step is complete.

### Protect the login endpoint

Before accepting public traffic, attach a production custom domain and create a [Cloudflare WAF rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) for the exact `/api/login` path. Count by source IP and use a managed challenge or block action; a practical starting point is five attempts per minute with a ten-minute mitigation timeout, adjusted from production analytics. Where the zone plan supports method matching, restrict the rule to `POST`.

Disable the public `workers.dev` route and preview URLs after cutover so they cannot provide an alternate path around the zone rule. ChronoFrame does not use in-memory Worker counters because isolates do not share durable rate-limit state.

If the Stream webhook was initially registered against the `workers.dev` URL, update its `notificationUrl` to the production custom domain **before** disabling `workers.dev`. That update rotates `result.secret`, so immediately run `wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET` with the new value.

## Local development

Generate binding types, initialize local D1, and start Wrangler's local runtime:

```bash
pnpm cf:typegen
pnpm d1:migrate:local
pnpm dev:worker
```

Local D1 and R2 state is kept in Wrangler's local state directory. The Hosted Images binding uses Wrangler's local mock; local uploads do not populate the production Images account. Validate the account-backed Direct Creator Upload and HLS playback flow against a deployed preview before release.

When a migration is added, re-run `pnpm d1:migrate:local`. Use `pnpm exec wrangler d1 execute DB --local --command "SELECT 1"` for a quick binding check.

## Cloudflare GitHub integration {#cloudflare-github-integration}

Cloud deployments use **Cloudflare Workers Builds**, connected directly to GitHub. The repository has no GitHub Actions deployment workflow.

For this existing installation, open **Workers & Pages > chronoframe > Settings > Builds > Connect**, authorize the Cloudflare GitHub App for `Pitrick3141/chronoframe`, and select that repository. Connect the existing Worker whose name matches `wrangler.jsonc` rather than creating another Worker.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` (repository root) |
| Build command | `pnpm run build:cloudflare` |
| Deploy command | `pnpm run deploy:cloudflare` |
| Non-production branch builds | Disabled |
| Non-production deploy command, if enabled later | `pnpm exec wrangler deploy --dry-run --config wrangler.jsonc` (validation only) |
| Build variable | `PNPM_VERSION=10.34.1` |
| Node.js | `.node-version` selects Node 22 |

Workers Builds installs dependencies from the checked-in pnpm lockfile. `build:cloudflare` generates binding types, checks local D1 migrations, lints, builds the workspace dependency, type-checks, builds Nuxt, and runs Wrangler dry-run. It does not mutate the production database.

`deploy:cloudflare` verifies the build artifacts, applies pending **remote D1 migrations**, then publishes the already-built Worker. Do not use the full local `pnpm run deploy` as the cloud deploy command, because it would build a second time. The deployment guard rejects Workers Builds branches other than `main` before any remote migration runs.

All Wrangler commands used by these scripts explicitly select the root `wrangler.jsonc`. This keeps the D1 migration directory and production compatibility flags correct even when Nuxt generates a redirected build configuration.

Choose the deployment API token in **Settings > Builds > API token**. Ensure it has **D1 Edit** in addition to Worker deployment permissions; Cloudflare's automatically generated build token does not include D1 in its documented default permissions. Retain the Workers Routes permission for the configured custom domain. The deployment token and GitHub App authorization are managed in Cloudflare, not GitHub Actions secrets.

Resource IDs, binding names, and `photograph.pitrick.dev` are defined in `wrangler.jsonc`. For a new account, edit that file to reference its resources before connecting Git. There is no CI substitution of `CLOUDFLARE_D1_DATABASE_ID`.

Runtime secrets remain under **Settings > Variables & Secrets**: `NUXT_SESSION_PASSWORD`, `CFRAME_BOOTSTRAP_TOKEN`, and `CFRAME_STREAM_WEBHOOK_SECRET`. Build variables are a separate scope and do not become runtime secrets. Preserve the existing values and Stream webhook subscription when connecting this installation. The `STREAM` capability binding requires no application-level `STREAM_API_TOKEN`.

Commit and push the deployment scripts and workflow removal to `main` before the first integrated build. Subsequent pushes trigger Cloudflare builds; logs and retries are available in the Worker's Builds page. For a new installation, complete resource/secret setup and Stream webhook registration described above.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [build image and tool versions](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/), [GitHub App connection](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/).

## Migrating from legacy Docker releases

The current branch has removed `Dockerfile`, `docker-compose.yml`, and the image-publishing workflow. Those entry points cannot provide the D1, Images, Stream, R2, and Assets bindings required by this Workers-only version. If you need to inspect the old container layout while migrating, use a pre-Workers release or Git tag.

If upgrading an existing Docker installation, follow [Migrate an existing installation](/guide/migrate-to-workers) before switching traffic.
