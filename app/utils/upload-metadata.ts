import type { ExpandedTags } from 'exifreader'

export type UploadMetadataKind = 'camera' | 'people' | 'gps'
export type UploadMetadataIndicators = Record<UploadMetadataKind, boolean>
export type UploadMetadataResult =
  | { status: 'ready'; indicators: UploadMetadataIndicators }
  | { status: 'unavailable'; reason: 'unsupported' | 'tooLarge' | 'readError' }

const CAMERA_KEYS = new Set([
  'make',
  'model',
  'cameramake',
  'cameramodel',
  'cameramodelname',
  'uniquecameramodel',
  'lens',
  'lensmake',
  'lensmodel',
  'lensinfo',
  'bodyserialnumber',
  'cameraserialnumber',
  'lensserialnumber',
  'exposuretime',
  'fnumber',
  'focallength',
  'focallengthin35mmfilm',
  'focallengthin35mmformat',
  'iso',
  'isospeedratings',
  'photographicsensitivity',
  'shutterspeedvalue',
  'aperturevalue',
  'exposureprogram',
])
const PEOPLE_KEYS = new Set([
  'artist',
  'author',
  'xpauthor',
  'creator',
  'ownername',
  'cameraownername',
  'copyright',
  'copyrightnotice',
  'byline',
  'bylinetitle',
  'credit',
  'rights',
  'copyrightowner',
  'copyrightownername',
  'creatorcontactinfo',
  'personinimage',
  'personinimagewdetails',
  'personname',
  'persondisplayname',
])
const GPS_KEYS = new Set([
  'gpslatitude',
  'gpslatituderef',
  'gpslongitude',
  'gpslongituderef',
  'gpsaltitude',
  'gpsaltituderef',
  'gpsposition',
  'gpscoordinates',
  'gpsdestlatitude',
  'gpsdestlongitude',
  'gpsimgdirection',
  'gpsdatestamp',
  'gpstimestamp',
  'gpsspeed',
  'gpstrack',
])

const normalizeKey = (key: string) =>
  key
    .replace(/^.*:/, '')
    .replace(/[\s_-]/g, '')
    .toLowerCase()
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !ArrayBuffer.isView(value)

function tagValue(value: unknown): unknown {
  return record(value) && 'value' in value ? value.value : value
}

function hasValue(value: unknown, depth = 0): boolean {
  if (depth > 24) return false
  const raw = tagValue(value)
  if (typeof raw === 'string') return raw.split('\0').join('').trim().length > 0
  if (typeof raw === 'number') return Number.isFinite(raw) // GPS at 0° is valid.
  if (typeof raw === 'boolean') return raw
  if (Array.isArray(raw)) return raw.some((item) => hasValue(item, depth + 1))
  if (record(raw))
    return Object.entries(raw).some(
      ([key, child]) =>
        !['attributes', 'description', '_raw'].includes(key) &&
        hasValue(child, depth + 1),
    )
  return false
}

/** Inspect structured metadata only; never infer people from pixels or generic keywords. */
export function classifyUploadMetadata(
  tags: ExpandedTags,
): UploadMetadataIndicators {
  const result = { camera: false, people: false, gps: false }
  const seen = new WeakSet<object>()
  let visited = 0
  function visit(value: unknown, path: string[], depth = 0) {
    if (depth > 24 || ++visited > 50_000)
      throw new Error('Metadata structure is too complex')
    if (
      !value ||
      typeof value !== 'object' ||
      ArrayBuffer.isView(value) ||
      seen.has(value)
    )
      return
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (['attributes', 'description', '_raw', 'MakerNote'].includes(key))
        continue
      const normalized = normalizeKey(key)
      // XPAuthor is UTF-16 bytes; its decoded description distinguishes an
      // empty NUL-padded field from actual author data.
      const present =
        normalized === 'xpauthor' &&
        record(child) &&
        typeof child.description === 'string'
          ? hasValue(child.description)
          : hasValue(child)
      if (present) {
        if (CAMERA_KEYS.has(normalized)) result.camera = true
        if (PEOPLE_KEYS.has(normalized)) result.people = true
        if (
          GPS_KEYS.has(normalized) ||
          (path[0] === 'gps' &&
            ['latitude', 'longitude', 'altitude'].includes(normalized))
        )
          result.gps = true
        const inRegion = path.some((part) =>
          ['regions', 'regioninfo', 'regionlist'].includes(part),
        )
        if (
          inRegion &&
          ['type', 'regiontype'].includes(normalized) &&
          String(tagValue(child)).toLowerCase() === 'face'
        )
          result.people = true
      }
      visit(child, [...path, normalized], depth + 1)
    }
  }
  for (const group of [
    'exif',
    'iptc',
    'xmp',
    'gps',
    'makerNotes',
    'pngText',
    'png',
  ] as const) {
    visit(tags[group], [normalizeKey(group)])
  }
  return result
}

export function isMetadataImage(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    /\.(jpe?g|png|webp|heic|heif|hif|avif|tiff?|gif|svg)$/i.test(file.name)
  )
}

const MAX_METADATA_FILE_BYTES = 100 * 1024 * 1024

async function inspect(file: File): Promise<UploadMetadataResult> {
  if (
    !isMetadataImage(file) ||
    /^(image\/gif|image\/svg\+xml)$/.test(file.type) ||
    /\.(gif|svg)$/i.test(file.name)
  ) {
    return { status: 'unavailable', reason: 'unsupported' }
  }
  if (file.size > MAX_METADATA_FILE_BYTES)
    return { status: 'unavailable', reason: 'tooLarge' }
  try {
    // File input uses local File.slice/FileReader, never the library's URL
    // loader. Keep metadata values out of Vue state; retain only three flags.
    const { load } = await import('exifreader')
    const options = {
      expanded: true,
      async: true,
      includeOffsets: true,
      excludeTags: { mpf: true, thumbnail: true, icc: true, composite: true },
      decompress: { maxDecompressedSize: 8 * 1024 * 1024 },
    } as const
    let tags: ExpandedTags
    try {
      tags = await load(file, { ...options, length: 'auto' })
    } catch (error) {
      // TIFF has no leading metadata container for adaptive reads.
      if (
        !(error instanceof Error) ||
        !error.message.includes('length: "auto"')
      )
        throw error
      tags = await load(file, options)
    }
    if (tags.metadataRange?.complete === false)
      return { status: 'unavailable', reason: 'readError' }
    return { status: 'ready', indicators: classifyUploadMetadata(tags) }
  } catch {
    return { status: 'unavailable', reason: 'readError' }
  }
}

type ReadJob = {
  file: File
  signal: AbortSignal
  resolve: (result: UploadMetadataResult | null) => void
}
const cache = new WeakMap<File, UploadMetadataResult>()
const waiting: ReadJob[] = []
let active = 0

function drain() {
  while (active < 2 && waiting.length) {
    const job = waiting.shift()!
    if (job.signal.aborted) {
      job.resolve(null)
      continue
    }
    active++
    void inspect(job.file)
      .then((result) => {
        if (!job.signal.aborted) {
          if (result.status === 'ready') cache.set(job.file, result)
          job.resolve(result)
        } else job.resolve(null)
      })
      .finally(() => {
        active--
        drain()
      })
  }
}

/** Bounded reads, identity-based caching, and cancellation for removed files. */
export function readUploadMetadata(
  file: File,
  signal: AbortSignal,
): Promise<UploadMetadataResult | null> {
  if (typeof File === 'undefined' || !(file instanceof File)) {
    return Promise.resolve({ status: 'unavailable', reason: 'unsupported' })
  }
  if (signal.aborted) return Promise.resolve(null)
  const cached = cache.get(file)
  if (cached) return Promise.resolve(cached)
  return new Promise((resolve) => {
    waiting.push({ file, signal, resolve })
    drain()
  })
}
