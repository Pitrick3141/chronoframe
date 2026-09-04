import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const createError = (details) =>
  Object.assign(new Error(details.statusMessage), details)

function load(file, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(file, root), 'utf8')
  const exports = {}
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  vm.runInNewContext(
    code,
    {
      exports,
      console,
      Response,
      Request,
      Headers,
      URL,
      URLSearchParams,
      TextEncoder,
      Uint8Array,
      performance,
      crypto: webcrypto,
      createError,
      require(name) {
        if (!(name in dependencies))
          throw new Error(`Unexpected dependency: ${name}`)
        return dependencies[name]
      },
      ...globals,
    },
    { filename: file, timeout: 2000 },
  )
  return exports
}

const variants = load('shared/utils/image-variants.ts')

function fixture({
  cacheMode = 'enabled',
  transformStatus = 200,
  sourceMissing = false,
  sourceInfo = { width: 2000, height: 3000, format: 'image/jpeg' },
} = {}) {
  const state = {
    imageId: 'immutable-image-1',
    hidden: false,
    hiddenCover: false,
    deleted: false,
    width: 7008,
    height: 4672,
  }
  const calls = {
    db: 0,
    cacheMatch: 0,
    cachePut: 0,
    source: 0,
    info: 0,
    transform: [],
  }
  const stored = new Map()
  const requests = []
  const cache = {
    async match(request) {
      calls.cacheMatch++
      requests.push(request)
      if (cacheMode === 'error') throw new Error('Cache unavailable')
      return stored.get(request.url)?.clone()
    },
    async put(request, response) {
      calls.cachePut++
      requests.push(request)
      if (cacheMode === 'write-error') throw new Error('Cache full')
      stored.set(
        request.url,
        new Response(await response.arrayBuffer(), {
          headers: response.headers,
        }),
      )
    },
  }
  const tables = Object.fromEntries(
    ['photos', 'albums', 'albumPhotos'].map((table) => [
      table,
      new Proxy(
        { name: table },
        {
          get: (value, key) => (key in value ? value[key] : `${table}.${key}`),
        },
      ),
    ]),
  )
  const drizzle = {
    eq: (key, value) => (row) => row[key] === value,
    and:
      (...conditions) =>
      (row) =>
        conditions.every((condition) => condition(row)),
    or:
      (...conditions) =>
      (row) =>
        conditions.some((condition) => condition(row)),
  }
  const db = {
    select(fields) {
      let table
      let condition = () => true
      const query = {
        from(value) {
          table = value.name
          return this
        },
        leftJoin() {
          return this
        },
        where(value) {
          condition = value
          return this
        },
        limit() {
          return this
        },
        async get() {
          calls.db++
          const row =
            table === 'photos'
              ? state.deleted
                ? undefined
                : {
                    'photos.id': 'photo-1',
                    'photos.cloudflareImageId': state.imageId,
                    'photos.storageKey': state.imageId,
                    'photos.sourceFilename': 'private-original.jpg',
                    'photos.sourceMimeType': 'image/jpeg',
                    'photos.width': state.width,
                    'photos.height': state.height,
                  }
              : {
                  'albums.id': 'album-1',
                  'albums.isHidden': state.hidden,
                  'albums.coverPhotoId': state.hiddenCover ? 'photo-1' : null,
                  'albumPhotos.photoId': state.hiddenCover ? null : 'photo-1',
                }
          if (!row || !condition(row)) return undefined
          return Object.fromEntries(
            Object.entries(fields).map(([name, column]) => [name, row[column]]),
          )
        },
      }
      return query
    },
  }
  const mediaAccess = load(
    'server/utils/media-access.ts',
    {
      'drizzle-orm': drizzle,
      './db': { tables, useDB: () => db },
    },
    { getUserSession: async (event) => ({ user: event.user }) },
  )
  const images = {
    hosted: {
      image(id) {
        assert.equal(id, state.imageId)
        return {
          async bytes() {
            calls.source++
            return sourceMissing
              ? null
              : new Response('source with private EXIF').body
          },
        }
      },
    },
    async info(source) {
      calls.info++
      assert.equal(
        await new Response(source).text(),
        'source with private EXIF',
      )
      if (sourceInfo instanceof Error) throw sourceInfo
      return sourceInfo
    },
    input(source) {
      const options = {}
      return {
        transform(value) {
          options.transform = value
          return this
        },
        async output(value) {
          assert.equal(
            await new Response(source).text(),
            'source with private EXIF',
          )
          options.output = value
          calls.transform.push(options)
          return {
            response: () =>
              new Response('encoded webp pixels', {
                status: transformStatus,
                headers: {
                  'Content-Type': 'image/webp',
                  'Content-Length': '19',
                  'Set-Cookie': 'session=secret',
                  Authorization: 'private',
                  'X-Source-Filename': 'private-original.jpg',
                  'Content-Disposition':
                    'attachment; filename="private-original.jpg"',
                  'Cache-Control': 'public, max-age=999999',
                },
              }),
          }
        },
      }
    },
  }
  const service = load(
    'server/services/cloudflare/image-delivery.ts',
    {
      '../../../shared/utils/image-variants': variants,
      '../../utils/cloudflare-bindings': {
        requireCloudflareBinding: () => images,
      },
      '../../utils/media-access': mediaAccess,
    },
    {
      caches: cacheMode === 'absent' ? undefined : { default: cache },
      getQuery: (event) => event.query ?? {},
      getHeader: (event, name) => event.headers?.[name],
      getRequestURL: () =>
        new URL('https://gallery.example/media/images/photo-1?v=revision'),
    },
  )
  const run = (event = {}, kind = 'display') =>
    service.deliverHostedImage(event, 'photo-1', kind)
  return { state, calls, stored, requests, service, run }
}

test('fixed variants accept only supported scalar sizes with stable defaults', () => {
  assert.equal(variants.getImageVariant('thumbnail').size, 640)
  assert.equal(variants.getImageVariant('thumbnail').quality, 80)
  assert.equal(variants.getImageVariant('thumbnail').height, null)
  assert.equal(variants.getImageVariant('display').size, 4096)
  assert.equal(variants.getImageVariant('display').height, 4096)
  for (const kind of ['thumbnail', 'display']) {
    const sizes =
      kind === 'thumbnail' ? [360, 640, 960] : [1280, 1920, 2560, 4096]
    for (const size of sizes)
      assert.equal(variants.getImageVariant(kind, String(size)).size, size)
    for (const bad of [
      null,
      '',
      '12000',
      '640.0',
      '-640',
      'NaN',
      ['640'],
      {},
      640,
      Symbol('w'),
    ]) {
      assert.equal(variants.getImageVariant(kind, bad), null)
    }
  }
})

test('warm images reuse a sanitized internal cache while every delivery rechecks the real ACL', async () => {
  const f = fixture()
  const first = await f.run(
    { headers: { cookie: 'secret', authorization: 'secret' } },
    'thumbnail',
  )
  const second = await f.run({}, 'thumbnail')
  assert.equal(first.headers.get('X-Image-Cache'), 'MISS')
  assert.equal(second.headers.get('X-Image-Cache'), 'HIT')
  assert.equal(await first.text(), 'encoded webp pixels')
  assert.equal(await second.text(), 'encoded webp pixels')
  assert.equal(f.calls.db, 4)
  assert.equal(f.calls.source, 1)
  assert.equal(f.calls.transform.length, 1)
  for (const response of [first, second]) {
    assert.equal(
      response.headers.get('Cache-Control'),
      'private, no-cache, must-revalidate',
    )
    assert.equal(response.headers.get('Vary'), 'Cookie')
    assert.equal(response.headers.get('Content-Type'), 'image/webp')
    assert.equal(
      response.headers.get('Cross-Origin-Resource-Policy'),
      'same-origin',
    )
    assert.match(response.headers.get('Server-Timing'), /acl;dur=/)
    assert.equal(response.headers.get('Set-Cookie'), null)
    assert.equal(response.headers.get('Authorization'), null)
    assert.equal(response.headers.get('X-Source-Filename'), null)
    assert.doesNotMatch(
      response.headers.get('Content-Disposition'),
      /private-original/,
    )
  }
  const cached = [...f.stored.values()][0]
  assert.equal(
    cached.headers.get('Cache-Control'),
    'public, max-age=604800, immutable',
  )
  assert.deepEqual([...cached.headers.keys()].sort(), [
    'cache-control',
    'content-length',
    'content-type',
  ])
  for (const request of f.requests) {
    assert.equal(request.method, 'GET')
    assert.equal([...request.headers].length, 0)
    assert.match(
      request.url,
      /^https:\/\/gallery.example\/__chronoframe_image_cache\/[a-f0-9]{64}$/,
    )
  }
})

test('conditional requests avoid source download only after checking live visibility', async () => {
  const f = fixture()
  const initial = await f.run()
  const etag = initial.headers.get('ETag')
  for (const validator of [
    etag,
    etag.replace('W/', ''),
    `"older", ${etag}`,
    '*',
  ]) {
    const response = await f.run({ headers: { 'if-none-match': validator } })
    assert.equal(response.status, 304)
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('X-Image-Cache'), 'REVALIDATED')
  }
  assert.equal(f.calls.db, 10)
  assert.equal(f.calls.cacheMatch, 1)
  assert.equal(f.calls.source, 1)
  f.state.hidden = true
  for (const event of [{}, { headers: { 'if-none-match': etag } }]) {
    await assert.rejects(
      () => f.run(event),
      (error) => error.statusCode === 404,
    )
  }
  assert.equal(f.calls.cacheMatch, 1)
  assert.equal(f.calls.source, 1)
  assert.equal(
    (await f.run({ user: { isAdmin: 1 } })).headers.get('X-Image-Cache'),
    'HIT',
  )
  f.state.hiddenCover = true
  await assert.rejects(
    () => f.run({ headers: { 'if-none-match': etag } }),
    (error) => error.statusCode === 404,
  )
  f.state.deleted = true
  await assert.rejects(
    () => f.run({ user: { isAdmin: 1 }, headers: { 'if-none-match': etag } }),
    (error) => error.statusCode === 404,
  )
})

test('an administrator warming a hidden photo does not authorize anonymous cache hits', async () => {
  const f = fixture()
  f.state.hidden = true
  f.state.hiddenCover = true
  const response = await f.run({ user: { isAdmin: 1 } })
  assert.equal(response.status, 200)
  await assert.rejects(
    () => f.run(),
    (error) => error.statusCode === 404,
  )
  assert.equal(f.calls.cacheMatch, 1)
})

test('landscape display transforms limit width, and variant/source/version revisions change identity', async () => {
  const f = fixture()
  const first = await f.run({ query: { w: '1280', v: 'metadata-revision-1' } })
  const same = await f.run({ query: { w: '1280', v: 'metadata-revision-2' } })
  assert.equal(first.headers.get('ETag'), same.headers.get('ETag'))
  assert.equal(same.headers.get('X-Image-Cache'), 'HIT')
  const larger = await f.run({ query: { w: '2560' } })
  assert.notEqual(first.headers.get('ETag'), larger.headers.get('ETag'))
  f.state.imageId = 'replacement-image-2'
  const replaced = await f.run({
    query: { w: '1280' },
    headers: { 'if-none-match': first.headers.get('ETag') },
  })
  assert.equal(replaced.status, 200)
  assert.notEqual(first.headers.get('ETag'), replaced.headers.get('ETag'))
  for (const { transform, output } of f.calls.transform) {
    assert.ok(transform.width > 0)
    assert.equal('height' in transform, false)
    assert.equal(transform.fit, 'scale-down')
    assert.equal(output.format, 'image/webp')
    assert.equal(output.quality, 85)
  }
  const variant = variants.getImageVariant('display', '1280')
  const identity = await f.service.imageVariantIdentity('image', variant, '1')
  assert.notEqual(
    identity,
    await f.service.imageVariantIdentity('image', variant, '2'),
  )
  assert.notEqual(
    identity,
    await f.service.imageVariantIdentity(
      'image',
      { ...variant, quality: 80 },
      '1',
    ),
  )
  assert.notEqual(
    identity,
    await f.service.imageVariantIdentity(
      'image',
      { ...variant, format: 'image/avif' },
      '1',
    ),
  )
})

test('portrait thumbnails retain requested pixel width while displays cap the longer axis', async () => {
  const f = fixture()
  f.state.width = 2000
  f.state.height = 3000
  await f.run({ query: { w: '640' } }, 'thumbnail')
  await f.run({ query: { w: '1280' } }, 'display')
  const thumbnail = f.calls.transform[0].transform
  const display = f.calls.transform[1].transform
  assert.equal(thumbnail.width, 640)
  assert.equal('height' in thumbnail, false)
  assert.equal('width' in display, false)
  assert.equal(display.height, 1280)
  // For a 2000 x 3000 portrait, these constraints produce 640 x 960 and
  // roughly 853 x 1280 respectively. A thumbnail height cap would break 640w.
  const portraitWidth = 2000
  const portraitHeight = 3000
  const ratio = (options) =>
    Math.min(
      1,
      options.width === undefined ? Infinity : options.width / portraitWidth,
      options.height === undefined ? Infinity : options.height / portraitHeight,
    )
  assert.equal(portraitWidth * ratio(thumbnail), 640)
  assert.equal(portraitHeight * ratio(display), 1280)
  const variant = variants.getImageVariant('thumbnail', '640')
  assert.notEqual(
    await f.service.imageVariantIdentity('portrait', variant),
    await f.service.imageVariantIdentity('portrait', {
      ...variant,
      height: 640,
    }),
  )
})

test('missing or invalid stored dimensions are inspected once on a miss without consuming transform bytes', async () => {
  for (const [width, height] of [
    [null, null],
    [0, 100],
    [NaN, Infinity],
    ['2000', '3000'],
  ]) {
    const f = fixture()
    Object.assign(f.state, { width, height })
    const first = await f.run({ query: { w: '1280' } })
    const second = await f.run({ query: { w: '1280' } })
    assert.equal(first.status, 200)
    assert.equal(second.headers.get('X-Image-Cache'), 'HIT')
    assert.equal(f.calls.info, 1)
    assert.equal(f.calls.source, 1)
    assert.equal(f.calls.transform[0].transform.height, 1280)
    assert.equal('width' in f.calls.transform[0].transform, false)
    const unchanged = await f.run({
      query: { w: '1280' },
      headers: { 'if-none-match': first.headers.get('ETag') },
    })
    assert.equal(unchanged.status, 304)
    assert.equal(f.calls.info, 1)
  }
})

test('SVG and unavailable dimension inspection retain width-only delivery; small sources are never enlarged', async () => {
  for (const sourceInfo of [
    { format: 'image/svg+xml' },
    new Error('No dimensions'),
  ]) {
    const f = fixture({ sourceInfo })
    Object.assign(f.state, { width: null, height: null })
    assert.equal((await f.run({ query: { w: '1280' } })).status, 200)
    assert.equal(f.calls.transform[0].transform.width, 1280)
    assert.equal('height' in f.calls.transform[0].transform, false)
  }
  for (const [width, height, axis, size] of [
    [300, 200, 'width', 300],
    [200, 300, 'height', 300],
  ]) {
    const f = fixture()
    Object.assign(f.state, { width, height })
    await f.run({ query: { w: '1280' } })
    assert.equal(f.calls.transform[0].transform[axis], size)
    assert.equal(Object.keys(f.calls.transform[0].transform).length, 2)
    assert.equal(f.calls.info, 0)
  }
})

test('correcting stored orientation invalidates cached pixels and ETags', async () => {
  const f = fixture()
  const first = await f.run({ query: { w: '1280' } })
  Object.assign(f.state, { width: 4672, height: 7008 })
  const corrected = await f.run({
    query: { w: '1280' },
    headers: { 'if-none-match': first.headers.get('ETag') },
  })
  assert.equal(corrected.status, 200)
  assert.equal(corrected.headers.get('X-Image-Cache'), 'MISS')
  assert.notEqual(first.headers.get('ETag'), corrected.headers.get('ETag'))
  assert.equal(f.calls.transform[0].transform.width, 1280)
  assert.equal(f.calls.transform[1].transform.height, 1280)
})

test('invalid sizes, missing assets and failed transforms never populate the cache', async () => {
  const invalid = fixture()
  for (const w of ['300', ['1280', '2560'], '1280&quality=100']) {
    await assert.rejects(
      () => invalid.run({ query: { w } }),
      (error) => error.statusCode === 400,
    )
  }
  assert.equal(invalid.calls.cacheMatch, 0)
  assert.equal(invalid.calls.source, 0)
  for (const [options, code] of [
    [{ sourceMissing: true }, 404],
    [{ transformStatus: 500 }, 502],
  ]) {
    const f = fixture(options)
    await assert.rejects(
      () => f.run(),
      (error) => error.statusCode === code,
    )
    assert.equal(f.calls.cachePut, 0)
  }
})

test('unavailable cache and failed cache writes preserve successful authorized delivery', async () => {
  for (const cacheMode of ['absent', 'error', 'write-error']) {
    const f = fixture({ cacheMode })
    const response = await f.run()
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'encoded webp pixels')
    assert.equal(
      response.headers.get('X-Image-Cache'),
      cacheMode === 'write-error' ? 'MISS' : 'BYPASS',
    )
  }
})

test('client URLs include an encoded metadata revision without exposing provider IDs or changing source paths', () => {
  const dto = load('server/utils/photo-response.ts')
  const photo = {
    id: 'photo /1',
    cloudflareImageId: 'private-id',
    lastModified: '2026-09-04T12:34:56+08:00',
  }
  for (const includeSource of [false, true]) {
    const response = dto.photoForClient(photo, { includeSource })
    for (const field of ['originalUrl', 'thumbnailUrl']) {
      const url = new URL(response[field], 'https://gallery.example')
      assert.equal(url.searchParams.get('v'), photo.lastModified)
      assert.doesNotMatch(url.href, /private-id/)
    }
    if (includeSource)
      assert.equal(response.sourceUrl, '/media/images/photo%20%2F1/source')
    else assert.equal(response.cloudflareImageId, undefined)
  }
  assert.equal(dto.imageDisplayPath(photo.id), '/media/images/photo%20%2F1')
  assert.equal(
    dto.imageThumbnailPath(photo.id),
    '/media/images/photo%20%2F1/thumbnail',
  )
  assert.equal(
    dto.photoForClient({ id: 'photo-1' }).originalUrl,
    '/media/images/photo-1',
  )
})

test('legacy thumbnail redirects permit only local fixed variants and revision query keys', () => {
  const handler = load(
    'server/routes/thumb/[...thumbnailUrl].get.ts',
    {
      '../../../shared/utils/image-variants': variants,
    },
    {
      eventHandler: (callback) => callback,
      getRouterParam: (event) => encodeURIComponent(event.target),
      getRequestURL: () => new URL('https://gallery.example/thumb'),
    },
  ).default
  const target =
    '/media/images/photo-1/thumbnail?v=2026-09-04T12%3A34%3A56Z&w=640'
  assert.equal(
    handler({ target }).headers.get('Location'),
    `https://gallery.example${target}`,
  )
  for (const suffix of [
    '?w=512',
    '?w=640&w=960',
    '?v=a&v=b',
    '?redirect=https://evil.example',
  ]) {
    assert.throws(
      () => handler({ target: `/media/images/photo-1/thumbnail${suffix}` }),
      (error) => error.statusCode === 410,
    )
  }
  assert.throws(
    () => handler({ target: 'https://evil.example/media/images/photo-1' }),
    (error) => error.statusCode === 410,
  )
})
