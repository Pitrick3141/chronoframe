import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileTypeFromBlob } from 'file-type'
import ts from 'typescript'

const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
const loaderCode = compile('../app/libs/image-loader-manager.ts')
const composableCode = compile('../app/composables/useImageLoader.ts')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
  'base64',
)
const image = (bytes = png.length) =>
  new Blob([png, new Uint8Array(Math.max(0, bytes - png.length))], {
    type: 'image/png',
  })

function harness(detect = fileTypeFromBlob) {
  const requests = []
  const created = []
  const revoked = []
  class FakeXHR {
    status = 0
    aborted = false
    open(method, src) {
      this.method = method
      this.src = src
    }
    send() {
      requests.push(this)
    }
    abort() {
      this.aborted = true
      this.onabort?.()
    }
    progress(loaded, total) {
      this.onprogress?.({ lengthComputable: true, loaded, total })
    }
    async complete(blob = image(), status = 200) {
      this.response = blob
      this.status = status
      await this.onload?.()
    }
  }
  const exports = {}
  vm.runInNewContext(loaderCode, {
    exports,
    require: (name) => {
      assert.equal(name, 'file-type')
      return { fileTypeFromBlob: detect }
    },
    Blob,
    Error,
    DOMException,
    XMLHttpRequest: FakeXHR,
    URL: {
      createObjectURL(blob) {
        const url = `blob:test/${created.length}`
        created.push({ url, blob })
        return url
      },
      revokeObjectURL(url) {
        revoked.push(url)
      },
    },
  })
  const composableExports = {}
  vm.runInNewContext(composableCode, {
    exports: composableExports,
    require: () => exports,
    useNuxtApp: () => ({ $i18n: { t: (key) => key } }),
  })
  return { ...exports, ...composableExports, requests, created, revoked }
}

test('first load starts immediately, reports progress and gives the viewer its downloaded Blob URL', async () => {
  const h = harness()
  const manager = new h.ImageLoaderManager()
  const progress = []
  const states = []
  const pending = manager.loadImage('/photo/a?w=1920', {
    onProgress: (value) => progress.push(value),
    onUpdateLoadingState: (state) => states.push(state),
  })
  assert.equal(h.requests.length, 1, 'no artificial 300 ms wait')
  h.requests[0].progress(25, 100)
  await h.requests[0].complete()
  const result = await pending
  assert.equal(result.blobSrc, h.created[0].url)
  assert.match(
    result.blobSrc,
    /^blob:/,
    'WebGL must never re-fetch the source URL',
  )
  assert.deepEqual(progress, [25])
  assert.equal(states.at(-1).isVisible, false)
  assert.equal(h.requests.length, 1)
  manager.cleanup()
  const again = await manager.loadImage('/photo/a?w=1920')
  assert.equal(again.blobSrc, result.blobSrc)
  assert.equal(
    h.requests.length,
    1,
    'cache lookup precedes any network request',
  )
  manager.cleanup()
})

test('same URL shares one inflight request; cancelling one viewer does not abort the other', async () => {
  const h = harness()
  const a = new h.ImageLoaderManager()
  const b = new h.ImageLoaderManager()
  const aProgress = []
  const bProgress = []
  const first = a.loadImage('/shared', { onProgress: (p) => aProgress.push(p) })
  const firstCancelled = assert.rejects(first, { name: 'AbortError' })
  h.requests[0].progress(10, 100)
  const second = b.loadImage('/shared', {
    onProgress: (p) => bProgress.push(p),
  })
  assert.deepEqual(
    bProgress,
    [10],
    'a late subscriber receives current progress',
  )
  a.cleanup()
  await firstCancelled
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].aborted, false)
  h.requests[0].progress(50, 100)
  await h.requests[0].complete()
  const result = await second
  assert.deepEqual(aProgress, [10])
  assert.deepEqual(bProgress, [10, 50])
  assert.equal(h.created.length, 1)
  assert.equal(h.revoked.includes(result.blobSrc), false)
  b.cleanup()
})

test('shared successful consumers keep the Blob alive until the last lease is released', async () => {
  const h = harness()
  const a = new h.ImageLoaderManager()
  const b = new h.ImageLoaderManager()
  const first = a.loadImage('/shared-success')
  const second = b.loadImage('/shared-success')
  await h.requests[0].complete()
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.blobSrc, two.blobSrc)
  assert.equal(h.requests.length, 1)
  h.clearImageCache()
  a.cleanup()
  assert.equal(h.revoked.length, 0)
  b.cleanup()
  assert.deepEqual(h.revoked, [one.blobSrc])
  a.cleanup()
  b.cleanup()
  assert.equal(h.revoked.length, 1, 'repeated cleanup is safe')
})

test('last consumer cancellation settles the promise and ignores late callbacks after switching photos', async () => {
  const h = harness()
  const manager = new h.ImageLoaderManager()
  let oldUpdates = 0
  let errors = 0
  const old = manager.loadImage('/old', {
    onUpdateLoadingState: () => oldUpdates++,
    onError: () => errors++,
  })
  const cancelled = assert.rejects(old, { name: 'AbortError' })
  const lateLoad = h.requests[0].onload
  const lateProgress = h.requests[0].onprogress
  const current = manager.loadImage('/new')
  await cancelled
  assert.equal(h.requests[0].aborted, true)
  h.requests[0].status = 200
  h.requests[0].response = image()
  await lateLoad()
  lateProgress({ lengthComputable: true, loaded: 90, total: 100 })
  assert.equal(oldUpdates, 1)
  assert.equal(
    errors,
    0,
    'intentional cancellation is not a user-visible error',
  )
  await h.requests[1].complete()
  assert.equal((await current).blobSrc, h.created[0].url)
  assert.equal(h.created.length, 1)
  manager.cleanup()
})

test('cancellation during file validation cannot populate a stale cache entry', async () => {
  let finishDetection
  const h = harness(
    () =>
      new Promise((resolve) => {
        finishDetection = resolve
      }),
  )
  const manager = new h.ImageLoaderManager()
  const pending = manager.loadImage('/slow-parse')
  const cancelled = assert.rejects(pending, { name: 'AbortError' })
  const validating = h.requests[0].complete()
  manager.cleanup()
  finishDetection({ mime: 'image/png' })
  await Promise.all([validating, cancelled])
  assert.equal(h.created.length, 0)
  const retry = manager.loadImage('/slow-parse')
  const retryCancelled = assert.rejects(retry, { name: 'AbortError' })
  assert.equal(h.requests.length, 2)
  manager.cleanup()
  await retryCancelled
})

test('entry LRU skips active leases and evicts the oldest unused image', async () => {
  const h = harness()
  const managers = []
  const results = []
  for (let i = 0; i < 13; i++) {
    const manager = new h.ImageLoaderManager()
    managers.push(manager)
    const pending = manager.loadImage(`/image/${i}`)
    await h.requests.at(-1).complete()
    results.push(await pending)
    if (i !== 0) manager.cleanup()
  }
  assert.equal(
    h.revoked.includes(results[0].blobSrc),
    false,
    'active image stays valid past the former six-entry limit',
  )
  assert.deepEqual(h.revoked, [results[1].blobSrc])
  const revisit = new h.ImageLoaderManager()
  assert.equal(
    (await revisit.loadImage('/image/0')).blobSrc,
    results[0].blobSrc,
  )
  assert.equal(h.requests.length, 13)
  managers[0].cleanup()
  revisit.cleanup()
  h.clearImageCache()
  assert.equal(new Set(h.revoked).size, 13)
  assert.equal(h.revoked.length, 13, 'each object URL is revoked once')
})

test('byte budget evicts released large images while preserving all active Blob leases', async () => {
  const h = harness()
  const a = new h.ImageLoaderManager()
  const b = new h.ImageLoaderManager()
  const first = a.loadImage('/large/a')
  await h.requests.at(-1).complete(image(20 * 1024 * 1024))
  const firstResult = await first
  const second = b.loadImage('/large/b')
  await h.requests.at(-1).complete(image(20 * 1024 * 1024))
  const secondResult = await second
  assert.equal(h.revoked.length, 0)
  a.cleanup()
  assert.deepEqual(h.revoked, [firstResult.blobSrc])
  b.cleanup()
  const revisit = new h.ImageLoaderManager()
  assert.equal(
    (await revisit.loadImage('/large/b')).blobSrc,
    secondResult.blobSrc,
  )
  assert.equal(h.requests.length, 2)
  revisit.cleanup()
  h.clearImageCache()
})

test('session cache clear forces a refetch, cancels pending work and defers revocation of displayed images', async () => {
  const h = harness()
  const active = new h.ImageLoaderManager()
  const pending = active.loadImage('/private')
  await h.requests[0].complete()
  const result = await pending
  const other = new h.ImageLoaderManager()
  const otherPending = other.loadImage('/pending-private')
  const cancelled = assert.rejects(otherPending, { name: 'AbortError' })
  h.clearImageCache()
  await cancelled
  assert.equal(h.requests[1].aborted, true)
  assert.equal(h.revoked.includes(result.blobSrc), false)
  const revisit = new h.ImageLoaderManager()
  const next = revisit.loadImage('/private')
  assert.equal(h.requests.length, 3)
  active.cleanup()
  assert.equal(h.revoked.includes(result.blobSrc), true)
  await h.requests[2].complete()
  assert.notEqual((await next).blobSrc, result.blobSrc)
  revisit.cleanup()
  other.cleanup()
  h.clearImageCache()
})

test('HTTP, network and invalid-image failures remain retryable and never enter the cache', async () => {
  for (const failure of ['http', 'network', 'empty', 'svg', 'fake-mime']) {
    const h = harness()
    const manager = new h.ImageLoaderManager()
    let errors = 0
    const states = []
    const pending = manager.loadImage('/retry', {
      onError: () => errors++,
      onUpdateLoadingState: (state) => states.push(state),
    })
    const failed = assert.rejects(pending)
    if (failure === 'http') await h.requests[0].complete(image(), 403)
    if (failure === 'network') h.requests[0].onerror()
    if (failure === 'empty') await h.requests[0].complete(new Blob([]))
    if (failure === 'svg')
      await h.requests[0].complete(
        new Blob(['<svg></svg>'], { type: 'image/svg+xml' }),
      )
    if (failure === 'fake-mime')
      await h.requests[0].complete(
        new Blob(['<html>denied</html>'], { type: 'image/png' }),
      )
    await failed
    assert.equal(errors, 1, failure)
    assert.equal(states.at(-1).isVisible, false)
    assert.equal(h.created.length, 0)
    const retry = manager.loadImage('/retry')
    await h.requests[1].complete()
    assert.match((await retry).blobSrc, /^blob:/)
    manager.cleanup()
  }
})

test('composable ignores cancelled promises and completion queued before cleanup', async () => {
  const h = harness()
  const values = { src: [], loaded: [], error: [], complete: 0 }
  const start = (src) =>
    h.useImageLoader(
      src,
      true,
      false,
      false,
      null,
      undefined,
      undefined,
      (value) => values.src.push(value),
      (value) => values.loaded.push(value),
      (value) => values.error.push(value),
      undefined,
      () => values.complete++,
    )
  const first = start('/cancel')
  first.cleanup()
  await Promise.resolve()
  assert.deepEqual(values.error, [false])
  const second = start('/complete')
  await h.requests[1].complete()
  await Promise.resolve()
  second.cleanup()
  const third = start('/complete')
  third.cleanup()
  await Promise.resolve()
  assert.equal(
    values.complete,
    1,
    'cache-hit completion after cleanup cannot update the old photo',
  )
  assert.equal(values.src.filter(Boolean).length, 1)
  assert.equal(values.error.some(Boolean), false)
})
