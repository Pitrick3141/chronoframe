import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The same production database is declared for this Worker in wrangler.jsonc.
// Reject a misconfigured preview trigger before the D1 migration command runs.
if (
  process.env.WORKERS_CI === '1' &&
  process.env.WORKERS_CI_BRANCH !== 'main'
) {
  throw new Error(
    'Cloudflare production deployments must run from the main branch.',
  )
}

for (const [relativePath, kind] of [
  ['../.output/server/index.mjs', 'file'],
  ['../.output/public', 'directory'],
]) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const entry = await stat(path).catch(() => null)
  if (!entry || (kind === 'file' ? !entry.isFile() : !entry.isDirectory())) {
    throw new Error(
      'Worker build artifacts are missing. Run the build command before deploying.',
    )
  }
}
