import type { NeededExif } from '~~/shared/types/photo'

const MAX_XMP_SCAN_BYTES = 1024 * 1024
const MAX_FTYP_FALLBACK_BYTES = 10 * 1024 * 1024
const MAX_TOP_LEVEL_BOXES = 4096

export type MotionPhotoExtractionResult =
  | { status: 'not-motion' }
  | {
      status: 'extracted'
      video: Uint8Array
      offset: number
      presentationTimestampUs?: number
    }
  | { status: 'malformed'; reason: string }

interface BmffValidation {
  end: number
}

interface ContainerItem {
  semantic: string
  length: number | null
  padding: number | null
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

function toNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function xmpValue(text: string, localName: string): string | null {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const attribute = text.match(
    new RegExp(`(?:[\\w.-]+:)?${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'),
  )
  if (attribute?.[1] !== undefined) return attribute[1]

  const element = text.match(
    new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>\\s*([^<]+)\\s*</`, 'i'),
  )
  return element?.[1] ?? null
}

function extractContainerItems(xmp: string): ContainerItem[] {
  const items: ContainerItem[] = []
  const tagPattern = /<(?:[\w.-]+:)?(?:Item|li)\b[^>]*>/gi

  for (const match of xmp.matchAll(tagPattern)) {
    const tag = match[0]
    const semantic = xmpValue(tag, 'Semantic')
    if (!semantic) continue

    const rawLength = xmpValue(tag, 'Length')
    const rawPadding = xmpValue(tag, 'Padding')
    items.push({
      semantic,
      length: toNonNegativeInteger(rawLength),
      padding: rawPadding === null ? 0 : toNonNegativeInteger(rawPadding),
    })
  }

  return items
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  )
}

function readBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  )
}

function printableBoxType(type: string): boolean {
  return [...type].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 0x20 && code <= 0x7e
  })
}

function validateIsoBmff(
  bytes: Uint8Array,
  start: number,
  declaredEnd: number,
  allowRecognizedTrailer: boolean,
): BmffValidation | null {
  if (start < 0 || declaredEnd > bytes.byteLength || declaredEnd - start < 32) {
    return null
  }

  let cursor = start
  let lastValidEnd = start
  let boxCount = 0
  let hasMoov = false
  let hasMdat = false

  while (cursor < declaredEnd && boxCount < MAX_TOP_LEVEL_BOXES) {
    if (declaredEnd - cursor < 8) {
      break
    }

    const size32 = readUint32(bytes, cursor)
    const type = readBoxType(bytes, cursor + 4)
    if (!printableBoxType(type)) break

    let headerSize = 8
    let boxSize = size32
    if (size32 === 1) {
      if (declaredEnd - cursor < 16) break
      const high = readUint32(bytes, cursor + 8)
      const low = readUint32(bytes, cursor + 12)
      // A 64-bit BMFF box size is safe to represent as a JavaScript number
      // only when its high word fits within the remaining 21 integer bits.
      if (high > 0x1f_ffff) break
      boxSize = high * 0x1_0000_0000 + low
      headerSize = 16
    } else if (size32 === 0) {
      boxSize = declaredEnd - cursor
    }

    if (boxSize < headerSize || boxSize > declaredEnd - cursor) break
    if (boxCount === 0) {
      if (
        type !== 'ftyp' ||
        boxSize < 16 ||
        (boxSize - 16) % 4 !== 0 ||
        !printableBoxType(readBoxType(bytes, cursor + headerSize))
      ) {
        return null
      }
    }

    hasMoov ||= type === 'moov'
    hasMdat ||= type === 'mdat'
    cursor += boxSize
    lastValidEnd = cursor
    boxCount += 1
    if (size32 === 0) break
  }

  if (!hasMoov || !hasMdat || boxCount < 3) return null
  if (lastValidEnd === declaredEnd) return { end: lastValidEnd }

  const trailer = bytes.subarray(lastValidEnd, declaredEnd)
  const isPadding = trailer.every((value) => value === 0 || value === 0xff)
  if (isPadding || allowRecognizedTrailer) return { end: lastValidEnd }
  return null
}

function asciiIndexOf(bytes: Uint8Array, value: string, from = 0): number {
  const needle = new TextEncoder().encode(value)
  const last = bytes.byteLength - needle.byteLength
  outer: for (let index = Math.max(0, from); index <= last; index += 1) {
    for (let cursor = 0; cursor < needle.byteLength; cursor += 1) {
      if (bytes[index + cursor] !== needle[cursor]) continue outer
    }
    return index
  }
  return -1
}

function candidateResult(
  bytes: Uint8Array,
  start: number,
  end: number,
  presentationTimestampUs: number | null,
  allowRecognizedTrailer = false,
): MotionPhotoExtractionResult | null {
  const valid = validateIsoBmff(bytes, start, end, allowRecognizedTrailer)
  if (!valid) return null
  return {
    status: 'extracted',
    video: bytes.slice(start, valid.end),
    offset: start,
    ...(presentationTimestampUs === null ? {} : { presentationTimestampUs }),
  }
}

/**
 * Extracts the ISO-BMFF video appended to a Google/Samsung Motion Photo.
 * The function is Workers-safe and never performs storage or filesystem I/O.
 */
export function extractMotionPhotoVideo(
  rawImageBytes: Uint8Array,
  exifData?: NeededExif | null,
): MotionPhotoExtractionResult {
  const bytes =
    rawImageBytes.byteOffset === 0 &&
    rawImageBytes.byteLength === rawImageBytes.buffer.byteLength
      ? rawImageBytes
      : rawImageBytes.slice()
  const xmp = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.byteLength, MAX_XMP_SCAN_BYTES)),
  )
  const samsungMarker = asciiIndexOf(bytes, 'MotionPhoto_Data') >= 0
  const xmpMotionFlag =
    toBoolean(xmpValue(xmp, 'MotionPhoto')) ||
    toBoolean(xmpValue(xmp, 'MicroVideo'))
  const exifMotionFlag =
    toBoolean(exifData?.MotionPhoto) || toBoolean(exifData?.MicroVideo)
  const containerItems = extractContainerItems(xmp)
  const motionItemIndexes = containerItems
    .map((item, index) =>
      item.semantic.trim().toLowerCase() === 'motionphoto' ? index : -1,
    )
    .filter((index) => index >= 0)

  const xmpOffset = toNonNegativeInteger(xmpValue(xmp, 'MicroVideoOffset'))
  const exifOffset = toNonNegativeInteger(exifData?.MicroVideoOffset)
  const detectedMotion =
    samsungMarker ||
    xmpMotionFlag ||
    exifMotionFlag ||
    motionItemIndexes.length > 0 ||
    (xmpOffset !== null && xmpOffset > 0) ||
    (exifOffset !== null && exifOffset > 0)

  if (!detectedMotion) return { status: 'not-motion' }
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return {
      status: 'malformed',
      reason: 'Motion Photo metadata was found, but the source is not JPEG',
    }
  }

  const presentationTimestampUs =
    toNonNegativeInteger(
      exifData?.MotionPhotoPresentationTimestampUs ??
        exifData?.MicroVideoPresentationTimestampUs,
    ) ??
    toNonNegativeInteger(xmpValue(xmp, 'MotionPhotoPresentationTimestampUs')) ??
    toNonNegativeInteger(xmpValue(xmp, 'MicroVideoPresentationTimestampUs'))

  for (const motionIndex of motionItemIndexes) {
    const item = containerItems[motionIndex]!
    if (item.length === null || item.length <= 0 || item.padding === null) {
      continue
    }

    const followingItems = containerItems.slice(motionIndex + 1)
    if (
      followingItems.some(
        (candidate) => candidate.length === null || candidate.padding === null,
      )
    ) {
      continue
    }

    const followingBytes = followingItems.reduce(
      (total, candidate) => total + candidate.length! + candidate.padding!,
      0,
    )
    const candidateEnds = new Set([
      bytes.byteLength - followingBytes,
      bytes.byteLength - followingBytes - item.padding,
    ])
    for (const end of candidateEnds) {
      const result = candidateResult(
        bytes,
        end - item.length,
        end,
        presentationTimestampUs,
      )
      if (result) return result
    }
  }

  for (const offset of new Set([exifOffset, xmpOffset])) {
    if (offset === null || offset <= 0 || offset >= bytes.byteLength) continue
    const result = candidateResult(
      bytes,
      bytes.byteLength - offset,
      bytes.byteLength,
      presentationTimestampUs,
      samsungMarker,
    )
    if (result) return result
  }

  // Fallback is deliberately both tail-bounded and gated by positive Motion
  // Photo metadata. A random `ftyp` string in an ordinary JPEG is never enough.
  const fallbackStart = Math.max(4, bytes.byteLength - MAX_FTYP_FALLBACK_BYTES)
  for (let index = fallbackStart; index <= bytes.byteLength - 4; index += 1) {
    if (
      bytes[index] !== 0x66 ||
      bytes[index + 1] !== 0x74 ||
      bytes[index + 2] !== 0x79 ||
      bytes[index + 3] !== 0x70
    ) {
      continue
    }
    const result = candidateResult(
      bytes,
      index - 4,
      bytes.byteLength,
      presentationTimestampUs,
      samsungMarker,
    )
    if (result) return result
  }

  return {
    status: 'malformed',
    reason:
      'Motion Photo metadata was found, but no valid ftyp/moov/mdat video was present',
  }
}

/** Backwards-compatible pure alias retained for older imports. */
export const processMotionPhotoFromXmp = extractMotionPhotoVideo
