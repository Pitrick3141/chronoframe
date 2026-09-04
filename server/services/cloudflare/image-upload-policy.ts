import { settingsManager } from '../settings/settingsManager'
import {
  HOSTED_IMAGE_MAX_BYTES,
  MOTION_PHOTO_SOURCE_MAX_BYTES,
} from './hosted-images'

// The Images binding accepts at most 20 MB of input, independently of the
// 10 MiB Hosted Images storage limit. Use decimal MB to stay within that cap.
export const IMAGE_COMPRESSION_MAX_INPUT_BYTES = 20_000_000
export type OversizedImageMode = 'compress' | 'skip' | 'block'
type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string

export async function getOversizedImageMode(): Promise<OversizedImageMode> {
  const mode = await settingsManager.get<string>(
    'system',
    'upload.oversizedImage.mode',
  )
  return mode === 'compress' || mode === 'skip' ? mode : 'block'
}

export function imageSourceMaxBytes(
  contentType: string,
  mode: OversizedImageMode,
  hostedLimit: number,
): number {
  // The appended Motion Photo video is removed before testing the static image.
  if (contentType === 'image/jpeg') return MOTION_PHOTO_SOURCE_MAX_BYTES
  return mode === 'compress' ? IMAGE_COMPRESSION_MAX_INPUT_BYTES : hostedLimit
}

export function skippedOversizedImage(
  t: Translate,
  fileName: string,
  maxBytes: number,
) {
  return {
    ok: true as const,
    skipped: true as const,
    oversized: true as const,
    fileKey: null,
    title: t('upload.oversized.skippedTitle'),
    message: t('upload.oversized.skippedMessage', {
      fileName,
      maxSize: maxBytes / 1024 / 1024,
    }),
  }
}

export function oversizedImageError(
  t: Translate,
  fileName: string,
  maxBytes = HOSTED_IMAGE_MAX_BYTES,
  reason: 'blocked' | 'compressionLimit' | 'compressionFailed' = 'blocked',
) {
  const title = t('upload.oversized.blockedTitle')
  return createError({
    statusCode: 413,
    statusMessage: title,
    data: {
      oversized: true,
      reason,
      title,
      message: t(
        `upload.oversized.${reason === 'blocked' ? 'blockedMessage' : reason}`,
        {
          fileName,
          maxSize: maxBytes / 1024 / 1024,
        },
      ),
    },
  })
}
