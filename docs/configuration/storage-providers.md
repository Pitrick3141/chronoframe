# Cloudflare Storage Bindings

The Workers version of ChronoFrame has a fixed storage architecture. Storage is configured with Cloudflare bindings in `wrangler.jsonc`, not by selecting an S3, local-filesystem, or OpenList provider in the dashboard.

## Storage map

| Data                                 | Service                         | Binding        |
| ------------------------------------ | ------------------------------- | -------------- |
| Application state and photo metadata | D1                              | `DB`           |
| All image binaries                   | Cloudflare Images Hosted Images | `IMAGES`       |
| All video binaries and playback      | Cloudflare Stream               | `STREAM`       |
| Other non-image, non-video objects   | R2                              | `MEDIA_BUCKET` |
| Built Nuxt client files              | Workers Assets                  | `ASSETS`       |

Binding names are part of the application contract. If a resource name changes, update its target in `wrangler.jsonc` without renaming the binding.

## D1

Create the database and place its returned UUID in `wrangler.jsonc`:

```bash
pnpm d1:create
pnpm d1:migrate:remote
```

D1 contains records only; it does not contain image or video bodies. Back it up before schema upgrades or bulk imports.

## Cloudflare Images Hosted Images

Hosted Images must be enabled on a [paid storage plan](https://developers.cloudflare.com/images/pricing/). The `IMAGES` binding lets the Worker upload, inspect, deliver, and delete images without storing an Images API token in application settings.

The application does not require account-level delivery variants. `/media/images/:id` enforces D1 visibility and returns a metadata-stripped WebP display image capped at 4096 px; `/media/images/:id/thumbnail` returns a 600 px WebP thumbnail. Raw Hosted Image bytes are administrator-only at `/media/images/:id/source`. Do not create an always-public variant for ChronoFrame media, because direct delivery would bypass hidden-album authorization.

Hosted Images accepts stored images up to **10 MiB**. ChronoFrame may receive a compound JPEG Motion Photo up to **25 MiB**, but splits it before storage: only the static JPEG (still limited to 10 MiB) enters Hosted Images and the validated embedded MP4 enters Stream. Supported input formats are JPEG, PNG, GIF, WebP, SVG, and HEIC. AVIF input requires Enterprise. Dimension, pixel-area, and animated-image limits also apply; see the [current Images limits](https://developers.cloudflare.com/images/get-started/limits/).

Images that exceed these limits or use a different source format must be converted or resized before upload. Non-image files must never be uploaded through `IMAGES`.

## Cloudflare Stream

Every supported video, including Live/Motion Photo companions, is stored and delivered by Stream. The `STREAM` binding creates a one-time [Direct Creator Upload](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/) URL; the browser then sends the multipart body directly to Cloudflare, without receiving an API token. After processing, ChronoFrame uses Stream's HLS manifest for playback.

The binding currently provisions basic POST uploads. Cloudflare requires those files to be **under 200 MB**, so ChronoFrame defaults to **199999999 bytes**. Files at or above 200 MB require tus, which the current upload flow does not implement. `NUXT_CLOUDFLARE_STREAM_MAX_DURATION_SECONDS` defaults to **600**.

Stream is billed by [minutes stored and minutes delivered](https://developers.cloudflare.com/stream/pricing/), rather than R2 bytes or egress. A Direct Creator Upload reserves `maxDurationSeconds` of storage capacity until it is completed, expires, or fails; completed videos consume their actual duration.

The Worker needs no Stream API token for binding operations. Binding `STREAM` grants that capability and keeps API credentials out of application code and the browser. A separate `CFRAME_STREAM_WEBHOOK_SECRET`, copied from the webhook subscription response, is still required to verify processing notifications.

## R2

Create the bucket declared in `wrangler.jsonc`:

```bash
pnpm exec wrangler r2 bucket create chronoframe-media
```

The application accesses R2 through `MEDIA_BUCKET`, so S3 access keys, endpoints, public buckets, and browser-to-bucket CORS rules are not required. The admin-only `/api/objects` flow keeps object lifecycle metadata in D1, verifies the R2 object during finalization, and delivers downloads through controlled Worker routes rather than a public R2 hostname.

R2 is reserved strictly for objects that are neither images nor videos. Images belong in Hosted Images and all videos belong in Stream.

## Local development

Wrangler supplies local implementations for D1, R2, and Hosted Images:

```bash
pnpm d1:migrate:local
pnpm dev:worker
```

Local D1/R2/Images data is separate from production. Test Stream Direct Creator Upload and HLS playback against an account-backed preview. Do not use remote resources during routine development unless you intend to modify them.

## Legacy providers

S3-compatible providers, local filesystem storage, and OpenList belonged to the previous Node/Docker architecture. They are not selectable storage providers in the Workers version. Existing images must move to Hosted Images, videos to Stream, and remaining objects to R2 through an explicit, verified migration; see [Migrate an existing installation](/guide/migrate-to-workers).
