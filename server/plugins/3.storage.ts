/**
 * Legacy storage-manager compatibility exports.
 *
 * Cloudflare bindings are request-safe globals and do not require a process
 * singleton or startup bootstrap. New code should use the R2/Images helpers
 * directly. These functions remain only so older administrative routes fail
 * clearly while the settings UI is being retired.
 */
export async function initializeStorageManagerFromActiveProvider(
  _reason = 'startup',
): Promise<boolean> {
  return false
}

export function getStorageManager(): never {
  throw createError({
    statusCode: 410,
    statusMessage:
      'Legacy storage providers are unavailable. Use the MEDIA_BUCKET R2 binding.',
  })
}

export default defineNitroPlugin(() => {
  // Bindings are resolved directly for each operation.
})
