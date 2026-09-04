import { requireCloudflareBinding } from '../../utils/cloudflare-bindings'
import { HOSTED_IMAGE_MAX_BYTES } from './hosted-images'
import { IMAGE_COMPRESSION_MAX_INPUT_BYTES } from './image-upload-policy'

const ATTEMPTS = [
  { quality: 85 },
  { quality: 70 },
  { quality: 60, size: 4096 },
  { quality: 55, size: 3072 },
  { quality: 45, size: 2048 },
  { quality: 35, size: 1280 },
] as const

async function readCompressedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!response.ok || !response.body)
    throw new Error('Image transformation failed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel('Compressed image still exceeds upload limit')
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (size === 0) throw new Error('Image transformation returned an empty body')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function compressImageForUpload(
  source: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  if (source.byteLength > IMAGE_COMPRESSION_MAX_INPUT_BYTES)
    throw new Error('Image exceeds compression input limit')
  const target = Math.min(maxBytes, HOSTED_IMAGE_MAX_BYTES)
  if (!Number.isFinite(target) || target <= 0)
    throw new Error('Invalid image upload limit')
  const images = requireCloudflareBinding('IMAGES')
  for (const attempt of ATTEMPTS) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source)
        controller.close()
      },
    })
    let image = images.input(stream)
    if ('size' in attempt) {
      image = image.transform({
        width: attempt.size,
        height: attempt.size,
        fit: 'scale-down',
      })
    }
    // WebP retains transparency and animated frames, unlike a JPEG conversion.
    const output = await image.output({
      format: 'image/webp',
      quality: attempt.quality,
      anim: true,
    })
    const bytes = await readCompressedBody(output.response(), target)
    if (bytes) return bytes
  }
  throw new Error('Image could not be compressed below the upload limit')
}
