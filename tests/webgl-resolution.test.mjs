import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const quietConsole = { log() {}, warn() {}, error() {} }
const plain = (value) => JSON.parse(JSON.stringify(value))
function evaluate(path, imports = {}) {
  const exports = {}
  vm.runInNewContext(
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports,
      Error,
      URL,
      console: quietConsole,
      self: { location: { origin: 'http://localhost' } },
      cancelAnimationFrame() {},
      require(name) {
        assert.ok(name in imports, `Unexpected import: ${name}`)
        return imports[name]
      },
    },
  )
  return exports
}
const constants = evaluate('../packages/webgl-image/src/constants.ts')
const types = evaluate('../packages/webgl-image/src/types/index.ts')
const utils = evaluate('../packages/webgl-image/src/core/utils.ts')
const { WebGLImageViewerEngine } = evaluate(
  '../packages/webgl-image/src/core/WebGLImageViewerEngine.ts',
  {
    '../types': types,
    '../constants': constants,
    './utils': utils,
    '../shaders': {},
    '../workers/image-decoder.worker?raw': '',
  },
)

function engine() {
  // Exercise the production loading/transform code; only GPU and DOM drawing are stubbed.
  const viewer = Object.create(WebGLImageViewerEngine.prototype)
  Object.assign(viewer, {
    canvas: { width: 1000, height: 600 },
    config: { ...constants.DEFAULT_CONFIG },
    image: { width: 1000, height: 600 },
    initialScale: 1,
    transform: { scale: 2, translateX: -300, translateY: -50 },
    animation: null,
    animationId: null,
    imageLoadId: 0,
    imageLoadingResolve: null,
    imageLoadingReject: null,
    worker: { postMessage() {} },
    shouldUseTiles: () => false,
    createTexture: () => ({}),
    render() {},
  })
  return viewer
}

test('upgrading resolution preserves the latest zoom and pan at decode completion', async () => {
  const viewer = engine()
  const loading = viewer.loadImage('blob:high-resolution', true)
  // The user keeps panning and zooming while the next resolution downloads.
  viewer.transform = { scale: 3, translateX: -750, translateY: -400 }
  await viewer.handleWorkerImageLoaded({
    requestId: 1,
    imageBitmap: { width: 2000, height: 1200 },
  })
  await loading
  assert.equal(viewer.getRelativeScale(), 3)
  assert.deepEqual(plain(viewer.transform), {
    scale: 1.5,
    translateX: -750,
    translateY: -400,
  })
})

test('a new photo resets its view by default, and preserving on first load still centers', () => {
  const viewer = engine()
  assert.equal(viewer.applyDecodedImage({ width: 2000, height: 1200 }), true)
  assert.equal(viewer.getRelativeScale(), 1)
  assert.deepEqual(plain(viewer.transform), {
    scale: 0.5,
    translateX: 0,
    translateY: 0,
  })
  viewer.image = null
  viewer.applyDecodedImage({ width: 600, height: 1200 }, true)
  assert.deepEqual(plain(viewer.transform), {
    scale: 0.5,
    translateX: 350,
    translateY: 0,
  })
})

test('preservation uses the final GPU texture dimensions and still enforces bounds', () => {
  const viewer = engine()
  viewer.transform = { scale: 2, translateX: 400, translateY: -900 }
  viewer.createTexture = () => {
    // Simulate the GPU fallback reducing an oversized source.
    viewer.image = { width: 1500, height: 900 }
    return {}
  }
  viewer.applyDecodedImage({ width: 4000, height: 2400 }, true)
  assert.equal(viewer.getRelativeScale(), 2)
  assert.deepEqual(plain(viewer.transform), {
    scale: 4 / 3,
    translateX: 0,
    translateY: -600,
  })
})

test('an in-progress zoom animation continues in the new source coordinate system', () => {
  const viewer = engine()
  viewer.animation = {
    startTime: 123,
    duration: 200,
    easing: (t) => t,
    startTransform: { scale: 1, translateX: 0, translateY: 0 },
    targetTransform: { scale: 2, translateX: -500, translateY: -300 },
  }
  viewer.applyDecodedImage({ width: 2000, height: 1200 }, true)
  assert.equal(viewer.animation.startTime, 123)
  assert.equal(viewer.animation.duration, 200)
  assert.deepEqual(plain(viewer.animation.startTransform), {
    scale: 0.5,
    translateX: 0,
    translateY: 0,
  })
  assert.deepEqual(plain(viewer.animation.targetTransform), {
    scale: 1,
    translateX: -500,
    translateY: -300,
  })
})

test('out-of-order worker completions cannot replace a newer photo or settle its promise', async () => {
  const viewer = engine()
  const first = viewer.loadImage('blob:first', true)
  const firstRejected = assert.rejects(first, { name: 'AbortError' })
  const second = viewer.loadImage('blob:second')
  let staleClosed = false
  await viewer.handleWorkerImageLoaded({
    requestId: 1,
    imageBitmap: {
      width: 4000,
      height: 2400,
      close() {
        staleClosed = true
      },
    },
  })
  assert.equal(staleClosed, true)
  assert.equal(viewer.image.width, 1000)
  assert.notEqual(viewer.imageLoadingResolve, null)
  await viewer.handleWorkerImageLoaded({
    requestId: 2,
    imageBitmap: { width: 800, height: 1200 },
  })
  await Promise.all([firstRejected, second])
  assert.equal(viewer.image.width, 800)
  assert.equal(viewer.getRelativeScale(), 1)
})

test('an obsolete main-thread fallback cannot overwrite a newer decoded source', async () => {
  const viewer = engine()
  viewer.worker = null
  const decodes = new Map()
  viewer.decodeImageOnMainThread = (src) =>
    new Promise((resolve) => decodes.set(src, resolve))
  const first = viewer.loadImage('blob:first', true)
  const firstRejected = assert.rejects(first, { name: 'AbortError' })
  const second = viewer.loadImage('blob:second')
  decodes.get('blob:second')({ width: 800, height: 1200 })
  await second
  decodes.get('blob:first')({ width: 4000, height: 2400 })
  await firstRejected
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(viewer.image.width, 800)
  assert.equal(viewer.getRelativeScale(), 1)
})

test('decoder worker returns the request ID on both success and failure', async () => {
  const messages = []
  const self = {
    location: { origin: 'http://localhost' },
    postMessage(message) {
      messages.push(message)
    },
  }
  vm.runInNewContext(
    readFileSync(
      new URL(
        '../packages/webgl-image/src/workers/image-decoder.worker.js',
        import.meta.url,
      ),
      'utf8',
    ),
    {
      self,
      URL,
      Error,
      fetch: async (src) => ({
        ok: !src.includes('bad'),
        status: 404,
        blob: async () => ({}),
      }),
      createImageBitmap: async () => ({ width: 800, height: 600 }),
    },
  )
  await self.onmessage({
    data: { type: 'load', payload: { src: '/image', requestId: 12 } },
  })
  await self.onmessage({
    data: { type: 'load', payload: { src: '/bad', requestId: 13 } },
  })
  assert.equal(messages[0].type, 'loaded')
  assert.equal(messages[0].payload.requestId, 12)
  assert.equal(messages[1].type, 'load-error')
  assert.equal(messages[1].payload.requestId, 13)
})
