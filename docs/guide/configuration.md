# Configuration Reference

Cloudflare resources are configured as bindings in `wrangler.jsonc`. Runtime secrets are stored with `wrangler secret put`; non-sensitive Nuxt values may be provided as Worker variables or build environment variables.

## Required bindings and secret

| Name                           | Kind                   | Required | Purpose                                                                         |
| ------------------------------ | ---------------------- | -------- | ------------------------------------------------------------------------------- |
| `DB`                           | D1 binding             | Yes      | Relational data                                                                 |
| `IMAGES`                       | Images binding         | Yes      | Hosted Images                                                                   |
| `STREAM`                       | Stream binding         | Yes      | All video storage, processing, and HLS delivery                                 |
| `MEDIA_BUCKET`                 | R2 binding             | Yes      | Other non-image, non-video objects                                              |
| `ASSETS`                       | Workers Assets binding | Yes      | Nuxt client assets                                                              |
| `NUXT_SESSION_PASSWORD`        | Worker secret          | Yes      | Session encryption; at least 32 random characters                               |
| `CFRAME_BOOTSTRAP_TOKEN`       | Worker secret          | Yes      | Authorizes first-run onboarding; at least 32 random characters                  |
| `CFRAME_STREAM_WEBHOOK_SECRET` | Worker secret          | Yes      | Verifies Stream `Webhook-Signature`; use the subscription API's `result.secret` |

Set secrets with `pnpm exec wrangler secret put <NAME>`. Generate independent session/bootstrap values, but copy the Stream webhook secret from Cloudflare exactly. Never commit secrets or put them in `wrangler.jsonc`.

## Application variables

| Variable                               | Description                     | Default                               |
| -------------------------------------- | ------------------------------- | ------------------------------------- |
| `NUXT_PUBLIC_APP_TITLE`                | Site title                      | `ChronoFrame`                         |
| `NUXT_PUBLIC_APP_SLOGAN`               | Site slogan                     | Empty                                 |
| `NUXT_PUBLIC_APP_AUTHOR`               | Site author                     | Empty                                 |
| `NUXT_PUBLIC_APP_AVATAR_URL`           | Site avatar URL                 | Empty                                 |
| `NUXT_PUBLIC_MAP_PROVIDER`             | `mapbox` or `maplibre`          | `maplibre`                            |
| `NUXT_PUBLIC_MAP_MAPLIBRE_STYLE`       | MapLibre style URL              | Empty                                 |
| `NUXT_PUBLIC_MAP_MAPBOX_STYLE`         | Mapbox style URL                | Empty                                 |
| `NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN`      | Browser-safe Mapbox token       | Empty                                 |
| `NUXT_MAPBOX_ACCESS_TOKEN`             | Server-side Mapbox token        | Empty                                 |
| `NUXT_NOMINATIM_BASE_URL`              | Reverse-geocoding API base URL  | `https://nominatim.openstreetmap.org` |
| `NUXT_PUBLIC_OAUTH_GITHUB_ENABLED`     | Enable GitHub OAuth             | `false`                               |
| `NUXT_OAUTH_GITHUB_CLIENT_ID`          | GitHub OAuth client ID          | Empty                                 |
| `NUXT_OAUTH_GITHUB_CLIENT_SECRET`      | GitHub OAuth client secret      | Empty                                 |
| `NUXT_PUBLIC_GTAG_ID`                  | Google Analytics measurement ID | Empty                                 |
| `NUXT_PUBLIC_ANALYTICS_MATOMO_ENABLED` | Enable Matomo                   | `false`                               |
| `NUXT_PUBLIC_ANALYTICS_MATOMO_URL`     | Matomo URL                      | Empty                                 |
| `NUXT_PUBLIC_ANALYTICS_MATOMO_SITE_ID` | Matomo site ID                  | Empty                                 |

Administrator passwords are submitted only during onboarding and stored as password hashes in D1; they are not Wrangler secrets. Treat server-side map tokens, OAuth client secrets, and other server-only credentials as Worker secrets even when optional.

## Upload configuration

| Variable                                         | Description                                                         | Default                             |
| ------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------- |
| `NUXT_PUBLIC_CLOUDFLARE_IMAGES_MAX_UPLOAD_BYTES` | UI ceiling for Hosted Images                                        | `10485760` (10 MiB)                 |
| `NUXT_PUBLIC_CLOUDFLARE_STREAM_MAX_UPLOAD_BYTES` | Application ceiling for Stream video uploads                        | `199999999` (strictly under 200 MB) |
| `NUXT_CLOUDFLARE_STREAM_MAX_DURATION_SECONDS`    | Maximum video duration reserved for Direct Creator Upload           | `600`                               |
| `NUXT_PUBLIC_CLOUDFLARE_R2_MAX_OBJECT_BYTES`     | Application ceiling for raw R2 uploads that pass through the Worker | `100000000` (100 MB)                |
| `NUXT_UPLOAD_MIME_WHITELIST_ENABLED`             | Validate upload MIME types                                          | `true`                              |
| `NUXT_UPLOAD_MIME_WHITELIST`                     | Comma-separated accepted MIME types                                 | See below                           |

Default whitelist:

```dotenv
NUXT_UPLOAD_MIME_WHITELIST=image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/heic,image/heif,video/quicktime,video/mp4
```

Disabling the application whitelist does not bypass service limits. Unsupported image formats and images larger than 10 MiB are still rejected by Hosted Images. Supported videos are sent directly to Stream and played through HLS; the binding's basic POST upload requires files under 200 MB. R2 is only for other non-image, non-video objects.

`STREAM` is a capability binding and needs no application token or additional CI secret. Stream usage is billed by stored and delivered video minutes.

Storage-provider variables from the Node/Docker line (`NUXT_STORAGE_PROVIDER`, `NUXT_PROVIDER_S3_*`, `NUXT_PROVIDER_LOCAL_*`, and `NUXT_PROVIDER_OPENLIST_*`) are obsolete. See [Cloudflare Storage Bindings](/configuration/storage-providers).
