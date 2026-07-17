# Migrate an Existing Installation

There is currently **no automatic migration command** from the legacy SQLite/S3/local/OpenList deployment. Treat the move as a controlled data migration and keep the old installation read-only until validation is complete.

## 1. Inventory and freeze

1. Record the exact ChronoFrame version and storage provider.
2. Stop uploads, edits, album changes, and reactions on the old site.
3. Back up the SQLite database. Docker installations normally use `./data/app.sqlite3` through the `/app/data` volume, but verify `DATABASE_URL` for your installation.
4. Export a complete object listing with object key, size, content type, and checksum where available.
5. Count users, photos, albums, album-photo relations, reactions, settings, and pending tasks.

Example SQLite backup:

```bash
mkdir -p backup
sqlite3 ./data/app.sqlite3 ".backup './backup/app.sqlite3'"
sqlite3 ./backup/app.sqlite3 "PRAGMA integrity_check;"
```

Keep an independent copy of the underlying S3, local, or OpenList objects. A database backup alone is not a gallery backup.

## 2. Provision the empty Workers deployment

Follow [Deploy to Cloudflare Workers](/guide/getting-started) to create D1 and R2, enable Hosted Images and Stream, and verify all five bindings. Apply the checked-in migrations before importing records:

```bash
pnpm d1:migrate:remote
```

Do not point production traffic at the new Worker yet.

## 3. Transform relational data

Export and transform data table by table rather than applying an unreviewed SQLite `.dump` directly. A legacy dump may contain local transaction statements, `PRAGMA` directives, internal SQLite tables, and schema definitions that conflict with the D1 migrations.

Recommended import order:

1. `users`
2. `settings` and `settings_storage_providers` only after removing obsolete storage credentials
3. `photos`
4. `albums`
5. `album_photos`
6. `photo_reactions`

Do not import stale `pipeline_queue` rows as runnable work. Reconcile or discard them explicitly. Preserve primary keys and timestamps, validate JSON columns, and translate legacy date/boolean representations to the current D1 schema.

After reviewing the generated SQL, import it with Wrangler:

```bash
pnpm exec wrangler d1 execute DB --remote --file=./migration/import.sql
```

The current repository provides the destination schema and migrations, but it does not generate `migration/import.sql`.

## 4. Move image binaries to Hosted Images

For every legacy photo:

1. Resolve `storage_key` to its original binary and verify it is an image.
2. Convert unsupported inputs before upload. Each destination image must meet the Hosted Images 10 MiB and format/dimension limits.
3. If irreversible location removal is required, strip EXIF/GPS from the binary **before** upload. Clearing D1 fields does not rewrite the Hosted Image original.
4. Upload through the Cloudflare Images API or a reviewed one-time Worker using the `IMAGES` Hosted Images binding.
5. Let Hosted Images generate the image ID and persist the returned ID in `cloudflare_image_id`. Do not use a custom ID: ChronoFrame requires `requireSignedURLs: true`, and custom IDs are incompatible with that private-image policy.
6. Update the photo's source filename, MIME type, size, image ID, and Worker delivery URLs.
7. Do not migrate legacy generated thumbnail files; the Worker creates WebP thumbnails dynamically through the Images binding.

Keep a manifest containing legacy key, photo ID, destination Hosted Image ID, source size, checksum, and migration status. Retry from this manifest so uploads remain idempotent.

## 5. Move all videos to Cloudflare Stream

Every legacy video must move to Stream, including Live/Motion Photo MOV/MP4 companions previously stored beside images. Do not copy video binaries to R2.

For each video:

1. Resolve the legacy key to the original binary and preserve its filename, MIME type, size, related photo ID, duration, and checksum in the manifest.
2. Confirm it fits the current upload contract: basic POST Direct Creator Upload requires a file under 200 MB, so ChronoFrame defaults to `199999999` bytes and `maxDurationSeconds: 600`. Convert or split anything outside the accepted boundary; tus migration is not implemented here.
3. Use a reviewed importer or deployed ChronoFrame upload endpoint to call `STREAM.createDirectUpload()` with `requireSignedURLs: true`, then POST the multipart video directly to the returned one-time URL.
4. Retain the returned Stream ID, poll until processing is ready, and verify the signed HLS manifest plays through ChronoFrame.
5. Set `cloudflare_stream_id` and `live_photo_video_key` to the same Stream ID, set `live_photo_video_url` to `/media/streams/<URL-encoded-photo-id>/manifest.m3u8`, set `stream_status` to `ready`, and leave `stream_dash_url` null unless a separate authorized DASH route is implemented. Other non-playback metadata such as thumbnail and duration may be copied from Stream.
6. Match Live/Motion Photo videos to images by the original basename and verify each pair explicitly.

Configure the account-level Stream webhook after the Worker has a public HTTPS
URL. The API response contains the signing secret; copy `result.secret` into the
Worker secret without changing it:

The token used for this API call needs the Cloudflare Stream Edit permission. It may be a separate, short-lived setup token rather than the CI deployment token.

```bash
curl --request PUT \
  --url "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/webhook" \
  --header "Authorization: Bearer <API_TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{"notificationUrl":"https://<CHRONOFRAME_HOST>/api/webhooks/cloudflare-stream"}'

pnpm exec wrangler secret put CFRAME_STREAM_WEBHOOK_SECRET
```

Cloudflare permits one Stream webhook subscription per account. Updating this
subscription replaces its notification URL/secret, so update the Worker secret
at the same time. ChronoFrame verifies the raw-body HMAC and a five-minute
timestamp window before a notification can change D1. A valid terminal webhook
closes the matching durable queue task even when the upload browser is gone.

ChronoFrame does not automatically make legacy public Stream assets private. An asset created with `requireSignedURLs: false` remains directly playable by its known Cloudflare URL even if D1 is changed to the same-origin route. Re-upload it as a signed asset, or explicitly update that Stream asset to require signed URLs through a reviewed migration, then verify direct unsigned playback fails before removing the legacy URL from the migration manifest.

Stream charges by stored and delivered minutes. Include total source duration and expected playback in migration capacity planning; pending Direct Creator URLs temporarily reserve their configured maximum duration.

## 6. Move other objects to R2

Only objects that are neither images nor videos belong in `chronoframe-media`. Import them through the administrator-only [`/api/objects` catalog workflow](/development/api): create an intent, upload the exact byte count to its generated `/upload` endpoint, and finalize it after R2 confirms the object. The catalog assigns an opaque `objects/catalog/<uuid>` key and records authoritative size, ETag, and version metadata in D1.

Do not use `wrangler r2 object put` for application-managed objects: a direct write bypasses media classification, create-only protection, and the authoritative D1 catalog. A reviewed bulk importer must reproduce the same key, validation, and finalize invariants. Never upload an image or video binary to R2.

## 7. Validate before cutover

- Compare row counts for every imported table.
- Compare the migration manifest to Hosted Images, Stream video, and R2 object counts.
- Check at least one image of each source format and several large/rotated images.
- Verify both `/media/images/:id` and `/media/images/:id/thumbnail` delivery.
- Verify Stream processing status and HLS playback for representative MOV/MP4 videos.
- Verify albums, reactions, map coordinates, authentication, deletes, and a matching Live Photo pair backed by Stream.
- Confirm failed and oversized files are accounted for; do not silently omit them.
- Run the new installation read-only while checks are performed, then switch DNS/route traffic.

Retain the frozen source database and object backup until the new deployment has been exercised and a D1/Images/Stream/R2 backup and inventory policy is in place.
