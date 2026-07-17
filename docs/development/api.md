# API Documentation

## R2 object catalog

The `/api/objects` endpoints are admin-only and store non-image, non-video
files in the `MEDIA_BUCKET` R2 binding. Images and videos are rejected even
when only their filename extension or MIME type identifies them as media.

1. `POST /api/objects` with `{ "filename", "contentType", "size" }` creates a
   pending D1 record and returns a raw `PUT` URL.
2. `PUT /api/objects/:objectId/upload` uploads the exact number of bytes to R2.
   Use the `Content-Type` returned by the first request.
3. `POST /api/objects/:objectId/finalize` HEADs R2 and records authoritative
   size, ETag, version, and upload time in D1.
4. `GET /api/objects` lists metadata; `GET /api/objects/:objectId` reads one
   object and `DELETE /api/objects/:objectId` deletes it idempotently.

Finalized responses include a `downloadUrl` served by the existing streaming,
range-aware R2 delivery route.
