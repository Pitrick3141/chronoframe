import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import ExifReader from 'exifreader'
import {
  exifTiff,
  metadataPng,
  metadataJpeg,
  peopleXmp,
} from './fixtures/metadata-images.mjs'

const source = readFileSync(
  new URL('../app/utils/upload-metadata.ts', import.meta.url),
  'utf8',
)
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
function utility(reader = ExifReader) {
  const exports = {}
  vm.runInNewContext(code, {
    exports,
    File,
    ArrayBuffer,
    Error,
    console,
    require: (name) => {
      assert.equal(name, 'exifreader')
      return reader
    },
  })
  return exports
}
const plain = (object) => JSON.parse(JSON.stringify(object))
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('real JPEG and PNG EXIF indicate camera/author/GPS, including coordinates at zero', async () => {
  const { classifyUploadMetadata } = utility()
  const bytes = exifTiff({ camera: true, people: true, gps: true })
  for (const image of [metadataJpeg(bytes), metadataPng({ exif: bytes })]) {
    const tags = await ExifReader.load(image, { expanded: true, async: true })
    assert.equal(tags.gps.Latitude, 0)
    assert.equal(tags.gps.Longitude, 0)
    assert.deepEqual(plain(classifyUploadMetadata(tags)), {
      camera: true,
      people: true,
      gps: true,
    })
  }
})

test('XMP people and author fields are detected without mistaking keywords/software for people or cameras', async () => {
  const { classifyUploadMetadata } = utility()
  const tags = await ExifReader.load(metadataPng({ xmp: peopleXmp }), {
    expanded: true,
    async: true,
  })
  assert.equal(classifyUploadMetadata(tags).people, true)
  const empty = classifyUploadMetadata({
    exif: {
      Software: { value: 'Photo Editor' },
      Orientation: { value: 1 },
      GPSVersionID: { value: [2, 3, 0, 0] },
    },
    xmp: { Subject: { value: 'Alice portrait camera GPS' } },
  })
  assert.deepEqual(plain(empty), { camera: false, people: false, gps: false })
  assert.equal(
    classifyUploadMetadata({ iptc: { 'By-line': { value: ['Photographer'] } } })
      .people,
    true,
  )
  assert.equal(
    classifyUploadMetadata({ xmp: { rights: { value: 'Copyright Example' } } })
      .people,
    true,
  )
})

test('face-region metadata, empty tags, and malformed coordinates are distinguished', () => {
  const { classifyUploadMetadata } = utility()
  assert.equal(
    classifyUploadMetadata({
      xmp: {
        Regions: {
          value: {
            RegionList: { value: [{ value: { Type: { value: 'Face' } } }] },
          },
        },
      },
    }).people,
    true,
  )
  assert.equal(
    classifyUploadMetadata({
      xmp: {
        Regions: {
          value: {
            RegionList: { value: [{ value: { Type: { value: 'Pet' } } }] },
          },
        },
      },
    }).people,
    false,
  )
  assert.deepEqual(
    plain(
      classifyUploadMetadata({
        exif: {
          Make: { value: ' \0 ' },
          Artist: { value: [] },
          XPAuthor: { value: [0, 0], description: '\0' },
          GPSLatitude: { value: NaN },
          GPSLongitude: { value: null },
        },
      }),
    ),
    { camera: false, people: false, gps: false },
  )
})

test('plain images have absent flags and metadata beyond 128 KiB is still detected', async () => {
  const { classifyUploadMetadata } = utility()
  const tags = await ExifReader.load(metadataPng(), {
    expanded: true,
    async: true,
  })
  assert.deepEqual(plain(classifyUploadMetadata(tags)), {
    camera: false,
    people: false,
    gps: false,
  })
  const late = metadataPng({
    exif: exifTiff({ camera: true }),
    late: true,
    size: 256,
  })
  assert.ok(late.length > 128 * 1024)
  const lateTags = await ExifReader.load(late, {
    expanded: true,
    async: true,
    includeOffsets: true,
  })
  assert.equal(classifyUploadMetadata(lateTags).camera, true)
})

test('reader passes only local File objects, reports corrupt/incomplete data as unknown, and does not accept URLs', async () => {
  const calls = []
  const helper = utility({
    load: async (file, options) => {
      calls.push({ file, options })
      if (file.name === 'broken.png') throw new Error('Invalid image format')
      return {
        metadataRange: { complete: false },
        exif: { Make: { value: 'Camera' } },
      }
    },
  })
  for (const name of ['broken.png', 'partial.png']) {
    const file = new File(['fixture'], name, { type: 'image/png' })
    const result = await helper.readUploadMetadata(
      file,
      new AbortController().signal,
    )
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'readError')
  }
  assert.equal(
    (
      await helper.readUploadMetadata(
        'https://example.com/image.jpg',
        new AbortController().signal,
      )
    ).reason,
    'unsupported',
  )
  assert.equal(calls.length, 2)
  assert.ok(
    calls.every(
      (call) => call.file instanceof File && call.options.length === 'auto',
    ),
  )
})

test('inspection is bounded to two files, caches by File identity, and drops cancelled work', async () => {
  const pending = []
  const helper = utility({
    load: (file) => new Promise((resolve) => pending.push({ file, resolve })),
  })
  const a = new File(['a'], 'same.jpg', { type: 'image/jpeg' })
  const b = new File(['b'], 'same.jpg', { type: 'image/jpeg' })
  const c = new File(['c'], 'cancel.jpg', { type: 'image/jpeg' })
  const ac = new AbortController(),
    bc = new AbortController(),
    cc = new AbortController()
  const ar = helper.readUploadMetadata(a, ac.signal)
  const br = helper.readUploadMetadata(b, bc.signal)
  const cr = helper.readUploadMetadata(c, cc.signal)
  await tick()
  assert.equal(pending.length, 2)
  cc.abort()
  pending[0].resolve({ exif: { Make: { value: 'Camera' } } })
  pending[1].resolve({ exif: { Artist: { value: 'Author' } } })
  assert.equal((await ar).indicators.camera, true)
  assert.equal((await br).indicators.people, true)
  assert.equal(await cr, null)
  assert.equal(pending.length, 2)
  assert.equal(
    (await helper.readUploadMetadata(a, ac.signal)).indicators.camera,
    true,
  )
  assert.equal(pending.length, 2)
})

test('unsupported/large files and in-flight cancellation never produce misleading absence flags', async () => {
  let calls = 0,
    finish
  const helper = utility({
    load: () => {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const svg = new File(['<svg/>'], 'file.svg', { type: 'image/svg+xml' })
  assert.equal(
    (await helper.readUploadMetadata(svg, new AbortController().signal)).reason,
    'unsupported',
  )
  const huge = new File([], 'huge.jpg', { type: 'image/jpeg' })
  Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 })
  assert.equal(
    (await helper.readUploadMetadata(huge, new AbortController().signal))
      .reason,
    'tooLarge',
  )
  assert.equal(calls, 0)
  const controller = new AbortController()
  const promise = helper.readUploadMetadata(
    new File(['a'], 'a.jpg'),
    controller.signal,
  )
  await tick()
  controller.abort()
  finish({ exif: { Make: { value: 'Camera' } } })
  assert.equal(await promise, null)
})
