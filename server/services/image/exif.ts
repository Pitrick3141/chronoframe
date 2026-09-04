import type { NeededExif, PhotoInfo } from '../../../shared/types/photo'
import { compactExif, parseJpegMetadata, setExif } from './jpeg-metadata.js'

export const extractExifData = async (
  imageBytes: Uint8Array,
  rawImageBytes?: Uint8Array,
  log?: Logger[keyof Logger],
): Promise<NeededExif | null> => {
  try {
    const metadata =
      parseJpegMetadata(imageBytes) ??
      (rawImageBytes ? parseJpegMetadata(rawImageBytes) : null)
    if (!metadata) {
      log?.debug('No Worker-compatible JPEG EXIF metadata found.')
      return null
    }
    const exif: Record<string, unknown> = {
      ...(metadata.xmp ?? {}),
      ...(metadata.exif ?? {}),
    }
    setExif(exif, 'ImageWidth', exif.ImageWidth ?? metadata.width)
    setExif(exif, 'ImageHeight', exif.ImageHeight ?? metadata.height)
    setExif(exif, 'ColorSpace', exif.ColorSpace ?? metadata.colorSpace)
    if (!exif.ColorSpace) exif.ColorSpace = 'sRGB'
    const result = compactExif(exif) as NeededExif | null
    if (result)
      log?.debug('Extracted JPEG EXIF metadata in Worker-compatible parser.')
    return result
  } catch (error) {
    log?.warn('Worker-compatible EXIF extraction failed:', error)
    return null
  }
}

const basenameWithoutExtension = (key: string): string => {
  const normalized = key.replaceAll('\\', '/')
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  const extensionIndex = fileName.lastIndexOf('.')
  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
}

const normalizeText = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeText(item)
      if (normalized) return normalized
    }
    return undefined
  }

  const text = String(value).trim()
  return text.length > 0 ? text : undefined
}

const collectTextValues = (
  value: unknown,
  splitDelimited = false,
): string[] => {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((item) => {
    const text = normalizeText(item)
    if (!text) return []
    return splitDelimited
      ? text
          .split(/[;,]/)
          .map((part) => part.trim())
          .filter(Boolean)
      : [text]
  })
}

const pickFirstText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
}

export const extractPhotoInfo = (
  storageKey: string,
  exifData?: NeededExif | null,
): PhotoInfo => {
  const fileName = basenameWithoutExtension(storageKey)
  const tags = new Set<string>([
    ...collectTextValues(exifData?.Subject),
    ...collectTextValues(exifData?.Keywords),
    ...collectTextValues(exifData?.XPKeywords, true),
  ])

  let dateTaken = new Date().toISOString()
  if (exifData?.DateTimeOriginal) {
    const parsed = new Date(exifData.DateTimeOriginal)
    if (!Number.isNaN(parsed.getTime())) dateTaken = parsed.toISOString()
  } else {
    const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/)
    const matchedDate = dateMatch?.[1]
    if (matchedDate) {
      const parsed = new Date(matchedDate)
      if (!Number.isNaN(parsed.getTime())) dateTaken = parsed.toISOString()
    }
  }

  const cleanedFileName = fileName
    .replaceAll(/\d{4}-\d{2}-\d{2}[_-]?/g, '')
    .replaceAll(/[_-]?\d+views?/gi, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim()

  const title =
    pickFirstText(
      exifData?.Title,
      exifData?.XPTitle,
      exifData?.Description,
      exifData?.ImageDescription,
      exifData?.CaptionAbstract,
    ) ||
    cleanedFileName ||
    fileName

  const description =
    pickFirstText(
      exifData?.Description,
      exifData?.ImageDescription,
      exifData?.CaptionAbstract,
      exifData?.XPComment,
      exifData?.UserComment,
    ) || ''

  return { title, dateTaken, tags: [...tags], description }
}
