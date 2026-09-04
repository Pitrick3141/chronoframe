import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { z } from 'zod'

const root = new URL('../', import.meta.url)
const hostedLimit = 10 * 1024 * 1024
const hostConstants = {
  HOSTED_IMAGE_MAX_BYTES: hostedLimit,
  MOTION_PHOTO_SOURCE_MAX_BYTES: 25 * 1024 * 1024,
}
const createError = (details) =>
  Object.assign(new Error(details.statusMessage), details)
const translate = (key, values) => `${key}:${JSON.stringify(values ?? {})}`

function load(file, dependencies = {}, globals = {}, omitFunctions = []) {
  let source = readFileSync(new URL(file, root), 'utf8')
  if (omitFunctions.length) {
    const parsed = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const filtered = ts.factory.updateSourceFile(
      parsed,
      parsed.statements.filter(
        (node) =>
          !ts.isFunctionDeclaration(node) ||
          !omitFunctions.includes(node.name?.text),
      ),
    )
    source = ts.createPrinter().printFile(filtered)
  }
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
      URLSearchParams,
      Uint8Array,
      ArrayBuffer,
      Date,
      Error,
      Response,
      ReadableStream,
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

function policyFor(mode) {
  return load('server/services/cloudflare/image-upload-policy.ts', {
    '../settings/settingsManager': {
      settingsManager: { get: async () => mode },
    },
    './hosted-images': hostConstants,
  })
}

test('policy defaults safely and retains the distinct storage, transform and Motion Photo limits', async () => {
  for (const value of [null, 'unknown', 'block'])
    assert.equal(await policyFor(value).getOversizedImageMode(), 'block')
  for (const value of ['compress', 'skip'])
    assert.equal(await policyFor(value).getOversizedImageMode(), value)
  const policy = policyFor('compress')
  assert.equal(
    policy.imageSourceMaxBytes('image/png', 'compress', hostedLimit),
    20_000_000,
  )
  assert.equal(
    policy.imageSourceMaxBytes('image/png', 'skip', hostedLimit),
    hostedLimit,
  )
  assert.equal(
    policy.imageSourceMaxBytes('image/jpeg', 'block', hostedLimit),
    25 * 1024 * 1024,
  )
})

test('compression retries quality/dimensions, preserves animation and cancels oversized output', async () => {
  const attempts = []
  let cancellations = 0
  const images = {
    input() {
      const attempt = {}
      attempts.push(attempt)
      return {
        transform(options) {
          attempt.transform = options
          return this
        },
        async output(options) {
          attempt.output = options
          const size = attempts.length < 3 ? 1025 : 512
          return {
            response: () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(size))
                    if (size <= 1024) controller.close()
                  },
                  cancel() {
                    cancellations++
                  },
                }),
              ),
          }
        },
      }
    },
  }
  const { compressImageForUpload } = load(
    'server/services/cloudflare/image-compression.ts',
    {
      '../../utils/cloudflare-bindings': {
        requireCloudflareBinding: () => images,
      },
      './hosted-images': hostConstants,
      './image-upload-policy': policyFor('compress'),
    },
  )
  const output = await compressImageForUpload(new Uint8Array(1500), 1024)
  assert.equal(output.byteLength, 512)
  assert.equal(attempts.length, 3)
  assert.equal(cancellations, 2)
  assert.equal(attempts[0].output.quality, 85)
  assert.equal(attempts[1].output.quality, 70)
  assert.equal(attempts[2].transform.width, 4096)
  for (const attempt of attempts) {
    assert.equal(attempt.output.format, 'image/webp')
    assert.equal(attempt.output.anim, true)
  }
  await assert.rejects(
    () => compressImageForUpload(new Uint8Array(20_000_001), 1024),
    /input limit/,
  )
  assert.equal(attempts.length, 3)
})

test('compression stops after six attempts and rejects empty or failed transformations', async () => {
  for (const scenario of ['oversize', 'empty', 'error']) {
    let calls = 0
    const images = {
      input: () => ({
        transform() {
          return this
        },
        async output() {
          calls++
          return {
            response: () =>
              new Response(new Uint8Array(scenario === 'oversize' ? 1025 : 0), {
                status: scenario === 'error' ? 500 : 200,
              }),
          }
        },
      }),
    }
    const { compressImageForUpload } = load(
      'server/services/cloudflare/image-compression.ts',
      {
        '../../utils/cloudflare-bindings': {
          requireCloudflareBinding: () => images,
        },
        './hosted-images': hostConstants,
        './image-upload-policy': policyFor('compress'),
      },
    )
    await assert.rejects(() =>
      compressImageForUpload(new Uint8Array(1500), 1024),
    )
    assert.equal(calls, scenario === 'oversize' ? 6 : 1)
  }
})

function uploadFixture({
  mode,
  size = 1500,
  staticSize,
  compressionFails = false,
  admin = true,
}) {
  const effects = { hosted: [], streams: [], compressed: [], completed: [] }
  const intent = {
    id: '11111111-1111-4111-8111-111111111111',
    creatorId: 1,
    filename: 'camera.jpg',
    contentType: 'image/jpeg',
    expectedSize: size,
    expiresAt: new Date(Date.now() + 3600_000),
    status: 'pending',
    attemptCount: 0,
    embeddedStreamId: null,
    eraseLocation: false,
    lastModified: null,
  }
  const fields = new Proxy({}, { get: (_, property) => property })
  const tables = {
    imageUploadIntents: fields,
    photos: fields,
    pipelineQueue: fields,
  }
  const drizzle = {
    eq: (key, value) => (row) => row[key] === value,
    and:
      (...conditions) =>
      (row) =>
        conditions.filter(Boolean).every((condition) => condition(row)),
    or:
      (...conditions) =>
      (row) =>
        conditions.some((condition) => condition(row)),
    inArray: (key, values) => (row) => values.includes(row[key]),
    isNull: (key) => (row) => row[key] == null,
    lte: (key, value) => (row) => row[key] <= value,
    desc: (value) => value,
    sql: () => ({ increment: true }),
  }
  const db = {
    select: () => ({
      from: () => ({
        where: (condition) => ({
          get: async () => (condition(intent) ? { ...intent } : undefined),
        }),
      }),
    }),
    update: () => ({
      set: (update) => ({
        where: (condition) => {
          const apply = async () => {
            if (!condition(intent)) return undefined
            for (const [key, value] of Object.entries(update))
              intent[key] = value?.increment ? intent[key] + 1 : value
            return { ...intent }
          }
          return { run: apply, returning: () => ({ get: apply }) }
        },
      }),
    }),
  }
  const imagePolicy = policyFor(mode)
  const logger = {
    chrono: { warn() {}, error() {} },
    image: { warn() {}, debug() {} },
  }
  const exif = {
    Make: 'Sony',
    Model: 'A7',
    DateTimeOriginal: '2026-09-04T12:00:00Z',
    GPSLatitude: 1.3,
    GPSLongitude: 103.8,
  }
  const media = load('server/services/cloudflare/media-classification.ts')
  const source = new Uint8Array(size)
  const cloudflareStream = {
    createDirectUpload: async (options) => {
      effects.streams.push(options)
      return { id: 'video-id', uploadURL: 'https://stream.invalid' }
    },
    uploadFile: async () => {},
    delete: async () => true,
  }
  const completeUploadResponse = async (_db, persisted) => {
    effects.completed.push(persisted)
    return { ok: true, key: persisted.imageId, warning: undefined }
  }
  const handler = load(
    'server/api/photos/upload.put.ts',
    {
      'drizzle-orm': drizzle,
      '~~/server/services/cloudflare/hosted-images': {
        ...hostConstants,
        hostedImages: {
          upload: async (bytes, options) => {
            if (options.metadata.compression === 'webp') {
              assert.equal(
                intent.exif,
                exif,
                'EXIF must be durable before storing compressed bytes',
              )
            }
            effects.hosted.push({ bytes, options })
            return { id: 'image-id', fileSize: bytes.byteLength }
          },
        },
      },
      '~~/server/services/cloudflare/media-classification': media,
      '~~/server/services/cloudflare/stream': { cloudflareStream },
      '~~/server/services/cloudflare/finalize-upload': {},
      '~~/server/services/video/motion-photo': {
        extractMotionPhotoVideo: () =>
          staticSize === undefined
            ? { status: 'not-motion' }
            : {
                status: 'extracted',
                offset: staticSize,
                video: source.slice(staticSize),
              },
      },
      '~~/server/services/image/exif': {
        extractExifData: async (bytes) => {
          assert.equal(bytes.length, staticSize ?? size)
          return exif
        },
      },
      '~~/server/services/cloudflare/image-compression': {
        compressImageForUpload: async (bytes) => {
          effects.compressed.push(bytes.length)
          if (compressionFails) throw new Error('transform failure')
          return new Uint8Array(512)
        },
      },
      '~~/server/services/cloudflare/image-upload-policy': imagePolicy,
      '~~/server/utils/auth': {
        requireAdminSession: async () => {
          if (!admin) throw createError({ statusCode: 401 })
          return { user: { id: 1 } }
        },
      },
      '~~/server/utils/db': { tables, useDB: () => db },
      '~~/server/utils/logger': { logger },
    },
    {
      eventHandler: (callback) => callback,
      useTranslation: async () => translate,
      getQuery: () => ({ intent: intent.id }),
      getHeader: (_, name) =>
        name === 'content-type'
          ? 'image/jpeg'
          : name === 'content-length'
            ? String(size)
            : undefined,
      useRuntimeConfig: () => ({
        public: { cloudflare: { images: { maxUploadBytes: 1024 } } },
        cloudflare: { stream: { maxDurationSeconds: 600 } },
      }),
      toWebRequest: () => new Response(source),
      crypto: { randomUUID },
      setHeader() {},
      completeUploadResponse,
    },
    ['completeUploadResponse'],
  )
  return { run: () => handler.default({}), intent, effects, exif }
}

test('skip and block reject a large static image before any image, video or queue side effects', async () => {
  for (const mode of ['skip', 'block']) {
    const fixture = uploadFixture({ mode, size: 2000, staticSize: 1500 })
    if (mode === 'skip') assert.equal((await fixture.run()).skipped, true)
    else
      await assert.rejects(
        fixture.run,
        (error) => error.statusCode === 413 && error.data.oversized,
      )
    assert.equal(fixture.effects.hosted.length, 0)
    assert.equal(fixture.effects.streams.length, 0)
    assert.equal(fixture.effects.completed.length, 0)
    assert.equal(fixture.intent.leaseToken, null)
  }
})

test('compressed Motion Photo retains EXIF/video and reports the stored WebP filename and size', async () => {
  const fixture = uploadFixture({
    mode: 'compress',
    size: 2000,
    staticSize: 1500,
  })
  const result = await fixture.run()
  assert.match(result.warning, /upload.oversized.compressed/)
  assert.equal(fixture.effects.compressed[0], 1500)
  assert.equal(fixture.effects.streams.length, 1)
  assert.equal(fixture.effects.hosted.length, 1)
  assert.equal(fixture.effects.hosted[0].bytes.length, 512)
  assert.equal(fixture.effects.hosted[0].options.filename, 'camera.webp')
  assert.equal(fixture.effects.hosted[0].options.contentType, 'image/webp')
  assert.equal(
    fixture.effects.hosted[0].options.metadata.sourceFilename,
    'camera.jpg',
  )
  assert.equal(fixture.effects.hosted[0].options.metadata.sourceSize, '2000')
  assert.equal(fixture.intent.exif, fixture.exif)
  assert.equal(fixture.intent.embeddedStreamId, 'video-id')
  assert.equal(fixture.effects.completed.length, 1)
})

test('small/exact-limit images and Motion Photos with a small still are not compressed or skipped', async () => {
  for (const options of [
    { mode: 'compress', size: 1024 },
    { mode: 'skip', size: 2000, staticSize: 512 },
  ]) {
    const fixture = uploadFixture(options)
    assert.equal((await fixture.run()).ok, true)
    assert.equal(fixture.effects.compressed.length, 0)
    assert.equal(fixture.effects.hosted[0].options.contentType, 'image/jpeg')
  }
})

test('compression failure creates no hosted assets and releases the upload lease', async () => {
  const fixture = uploadFixture({
    mode: 'compress',
    staticSize: 1500,
    size: 2000,
    compressionFails: true,
  })
  await assert.rejects(
    fixture.run,
    (error) =>
      error.statusCode === 413 && error.data.reason === 'compressionFailed',
  )
  assert.equal(fixture.effects.hosted.length, 0)
  assert.equal(fixture.effects.streams.length, 0)
  assert.equal(fixture.intent.leaseToken, null)
})

test('upload policy cannot bypass administrator authorization', async () => {
  const fixture = uploadFixture({ mode: 'skip', admin: false })
  await assert.rejects(fixture.run, (error) => error.statusCode === 401)
  assert.equal(fixture.effects.hosted.length, 0)
})

test('preflight skips oversized files before creating an upload intent, and rejects inputs beyond compression capacity', async () => {
  const media = load('server/services/cloudflare/media-classification.ts')
  for (const mode of ['skip', 'block', 'compress']) {
    const handler = load(
      'server/api/photos/index.post.ts',
      {
        'drizzle-orm': {},
        zod: { z },
        '~~/server/services/cloudflare/hosted-images': hostConstants,
        '~~/server/services/cloudflare/image-upload-policy': policyFor(mode),
        '~~/server/services/cloudflare/media-classification': media,
        '~~/server/services/cloudflare/stream': {},
        '~~/server/services/cloudflare/stream-upload-task': {},
        '~~/server/utils/file-utils': {},
        '~~/server/services/settings/settingsManager': {},
      },
      {
        eventHandler: (callback) => callback,
        requireAdminSession: async () => ({ user: { id: 1 } }),
        useTranslation: async () => translate,
        useRuntimeConfig: () => ({
          public: { cloudflare: { images: { maxUploadBytes: hostedLimit } } },
        }),
        readValidatedBody: async (_, parse) =>
          parse({
            fileName: 'large.png',
            contentType: 'image/png',
            fileSize: 20_000_001,
          }),
        useDB: () => {
          throw new Error('Preflight must not create an intent')
        },
      },
    )
    if (mode === 'skip') assert.equal((await handler.default({})).skipped, true)
    else
      await assert.rejects(
        () => handler.default({}),
        (error) =>
          error.statusCode === 413 &&
          error.data.reason ===
            (mode === 'compress' ? 'compressionLimit' : 'blocked'),
      )
  }
})
