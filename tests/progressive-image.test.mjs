import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

const require = createRequire(import.meta.url)
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
const loadTs = (path, dependencies = {}) => {
  const exports = {}
  vm.runInNewContext(
    transpile(readFileSync(new URL(path, import.meta.url), 'utf8')),
    { exports, URL, require: (id) => dependencies[id] ?? require(id) },
  )
  return exports
}
const variants = loadTs('../app/utils/image-variants.ts', {
  '~~/shared/utils/image-variants': loadTs('../shared/utils/image-variants.ts'),
})
const source = readFileSync(
  new URL('../app/components/photo/ProgressiveImage.vue', import.meta.url),
  'utf8',
)
const { descriptor } = parse(
  source
    .replaceAll('import.meta.env.DEV', 'false')
    .replaceAll('import.meta.env.VITE_SHOW_DEBUG_INFO', 'undefined')
    .replace(
      '<script setup lang="ts">',
      '<script setup lang="ts">\nimport { computed, ref, watch, onMounted, onUnmounted } from "vue"',
    ),
)
const compiled = transpile(
  compileScript(descriptor, {
    id: 'progressive-image-test',
    inlineTemplate: true,
  }).content,
)

// Exercise the real component's Vue watches and renderer lifetime, with only
// network/decode work controlled by the fixture.
const renderer = vue.createRenderer({
  createElement: (tag) =>
    vue.markRaw({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, parent: null }),
  createComment: (comment) => ({ comment, parent: null }),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
  },
  patchProp: (node, key, _old, value) => {
    node.props[key] = value
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    const siblings = node.parent?.children || []
    return siblings[siblings.indexOf(node) + 1] || null
  },
  insert: (node, parent, anchor = null) => {
    if (node.parent) {
      node.parent.children.splice(node.parent.children.indexOf(node), 1)
    }
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove: (node) => {
    if (node.parent) {
      node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = null
    }
  },
})

const LoadingState = {
  COMPLETE: 'complete',
  ERROR: 'error',
  LOADING: 'loading',
}
const settle = async () => {
  await Promise.resolve()
  await vue.nextTick()
}

async function mountProgressive(initialProps = {}, environment = {}) {
  const loaders = []
  const events = {
    blobs: [],
    errors: [],
    progress: [],
    loaded: [],
    states: [],
    zoom: [],
  }
  const dimensions = {
    width: vue.ref(environment.viewportWidth ?? 800),
    height: vue.ref(environment.viewportHeight ?? 600),
  }
  const elementSize = {
    width: vue.ref(environment.elementWidth ?? 0),
    height: vue.ref(environment.elementHeight ?? 0),
  }
  class ImageLoaderManager {
    isActive = false
    cleanups = 0
    constructor() {
      loaders.push(this)
    }
    loadImage(url, callbacks) {
      this.isActive = true
      this.url = url
      this.callbacks = callbacks
      return new Promise((resolve, reject) => {
        this.resolve = (blobSrc) => resolve({ blobSrc })
        this.reject = reject
      })
    }
    cleanup() {
      this.isActive = false
      this.cleanups++
      // Allow an already queued completion to arrive after cleanup. The real
      // component must reject stale results even if transport cancellation races.
    }
  }
  const WebGLImageViewer = vue.defineComponent({
    props: { src: String, preserveViewOnSourceChange: Boolean },
    emits: ['zoomChange', 'loadingStateChange'],
    setup:
      (props, { emit }) =>
      () =>
        vue.h('webgl-viewer', {
          src: props.src,
          preserveViewOnSourceChange: props.preserveViewOnSourceChange,
          zoom: (absolute, relative) => emit('zoomChange', absolute, relative),
          state: (loading, state) => emit('loadingStateChange', loading, state),
        }),
  })
  const exports = {}
  const dependencies = {
    '@chronoframe/webgl-image': { LoadingState, WebGLImageViewer },
    '~/libs/image-loader-manager': { ImageLoaderManager },
    '~/utils/image-variants': variants,
  }
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => dependencies[id] ?? require(id),
    ...vue,
    Error,
    window: {
      innerWidth: dimensions.width.value,
      innerHeight: dimensions.height.value,
      devicePixelRatio: 1,
    },
    useUserSession: () => ({ loggedIn: vue.ref(false) }),
    useSettingRef: () => vue.ref(false),
    useWindowSize: () => dimensions,
    useElementSize: () => elementSize,
    useWebGLWorkState:
      () =>
      (...args) =>
        events.states.push(args),
  })
  const props = vue.reactive({
    src: '/media/images/first',
    thumbnailSrc: '/media/images/first/thumbnail',
    width: 6000,
    height: 4000,
    loadingIndicatorRef: {
      updateLoadingState: (state) => events.states.push(state),
    },
    ...initialProps,
  })
  const root = { children: [] }
  const app = renderer.createApp({
    setup: () => () =>
      vue.h(exports.default, {
        ...props,
        onBlobSrcChange: (src) => events.blobs.push(src),
        onError: () => events.errors.push('error'),
        onProgress: (progress) => events.progress.push(progress),
        onImageLoaded: () => events.loaded.push('loaded'),
        onZoomChange: (...args) => events.zoom.push(args),
      }),
  })
  app.component('ThumbImage', { render: () => vue.h('thumbnail') })
  app.component('Icon', { render: () => null })
  app.config.globalProperties.$t = (key) => key
  app.mount(root)
  await settle()
  const find = (tag, node = root) => {
    if (node.tag === tag) return node
    for (const child of node.children || []) {
      const result = find(tag, child)
      if (result) return result
    }
  }
  return { app, props, loaders, events, dimensions, elementSize, find }
}

test('only the current image requests a viewport-fitted variant and renders the downloaded Blob', async (t) => {
  const fixture = await mountProgressive({ isCurrentImage: false })
  t.after(() => fixture.app.unmount())
  assert.equal(fixture.loaders.length, 0)
  fixture.props.isCurrentImage = true
  await settle()
  assert.equal(fixture.loaders.length, 1)
  const loader = fixture.loaders[0]
  assert.equal(loader.url, '/media/images/first?w=1280')
  assert.equal(
    fixture.find('thumbnail').props.src,
    '/media/images/first/thumbnail?w=360',
  )
  assert.equal(fixture.find('thumbnail').props.lazy, false)
  loader.callbacks.onProgress(25)
  loader.resolve('blob:fitted')
  await settle()
  assert.equal(fixture.find('webgl-viewer').props.src, 'blob:fitted')
  assert.equal(
    fixture.find('webgl-viewer').props.preserveViewOnSourceChange,
    true,
  )
  assert.deepEqual(fixture.events.progress, [25])
  assert.equal(loader.cleanups, 0)
  assert.ok(fixture.find('thumbnail'))
  fixture.find('webgl-viewer').props.state(false, LoadingState.COMPLETE)
  await settle()
  assert.equal(fixture.find('thumbnail'), undefined)
  assert.deepEqual(fixture.events.loaded, ['loaded'])
  assert.equal(fixture.loaders.length, 1)
})

test('opening a viewer requests one viewport-sized image despite transient slide layout sizes', async (t) => {
  for (const initialBoxWidth of [0, 320]) {
    const fixture = await mountProgressive(
      {},
      {
        viewportWidth: 1600,
        viewportHeight: 1000,
        elementWidth: initialBoxWidth,
        elementHeight: (initialBoxWidth * 2) / 3,
      },
    )
    t.after(() => fixture.app.unmount())
    assert.equal(fixture.loaders.length, 1)
    const initial = fixture.loaders[0]
    assert.equal(initial.url, '/media/images/first?w=1920')
    // Swiper can report zero or an intermediate slide box during mounting;
    // neither transition should cancel and restart the fitted image request.
    fixture.elementSize.width.value = 320
    fixture.elementSize.height.value = 200
    await settle()
    fixture.elementSize.width.value = 1600
    fixture.elementSize.height.value = 1000
    await settle()
    assert.equal(fixture.loaders.length, 1)
    assert.equal(initial.cleanups, 0)
    initial.resolve('blob:viewport-fitted')
    await settle()
    assert.equal(fixture.find('webgl-viewer').props.src, 'blob:viewport-fitted')
  }
})

test('zoom upgrades keep the previous Blob leased and viewer mounted until replacement rendering completes', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const first = fixture.loaders[0]
  first.resolve('blob:1280')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1.25, 2)
  await settle()
  const upgrade = fixture.loaders[1]
  assert.equal(upgrade.url, '/media/images/first?w=1920')
  assert.equal(viewer.props.src, 'blob:1280')
  assert.equal(first.cleanups, 0)
  upgrade.callbacks.onProgress(50)
  assert.deepEqual(fixture.events.progress, [])
  upgrade.resolve('blob:1920')
  await settle()
  assert.equal(fixture.find('webgl-viewer'), viewer)
  assert.equal(viewer.props.src, 'blob:1920')
  assert.equal(viewer.props.preserveViewOnSourceChange, true)
  assert.equal(first.cleanups, 0)
  assert.equal(fixture.find('thumbnail'), undefined)
  viewer.props.state(true, LoadingState.LOADING)
  assert.equal(first.cleanups, 0)
  viewer.props.state(false, LoadingState.COMPLETE)
  assert.equal(first.cleanups, 1)
  assert.equal(upgrade.cleanups, 0)
  assert.deepEqual(fixture.events.zoom, [[true, 2]])
  // Decoding a larger variant changes pixel scale, not the visible zoom badge.
  viewer.props.zoom(0.625, 2)
  assert.deepEqual(fixture.events.zoom, [
    [true, 2],
    [true, 2],
  ])
  viewer.props.zoom(0.6, 1)
  await settle()
  assert.equal(
    fixture.loaders.length,
    2,
    'zooming out must not fetch a smaller variant',
  )
})

test('failed upgrade preserves the rendered image and allows the next zoom to retry', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const first = fixture.loaders[0]
  first.resolve('blob:preview')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1, 2)
  await settle()
  fixture.loaders[1].reject(new Error('temporary network failure'))
  await settle()
  assert.equal(fixture.find('webgl-viewer'), viewer)
  assert.equal(viewer.props.src, 'blob:preview')
  assert.equal(first.cleanups, 0)
  assert.equal(fixture.loaders[1].cleanups, 1)
  assert.equal(fixture.find('p'), undefined)
  assert.deepEqual(fixture.events.errors, [])
  viewer.props.zoom(1, 2)
  await settle()
  assert.equal(fixture.loaders.length, 3)
  assert.equal(fixture.loaders[2].url, '/media/images/first?w=1920')
})

test('a failed upgrade decode restores the last rendered Blob without releasing its lease', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const original = fixture.loaders[0]
  original.resolve('blob:rendered-preview')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1, 2)
  await settle()
  const upgrade = fixture.loaders[1]
  upgrade.resolve('blob:decode-failure')
  await settle()
  assert.equal(viewer.props.src, 'blob:decode-failure')
  viewer.props.state(false, LoadingState.ERROR)
  await settle()
  assert.equal(fixture.find('webgl-viewer'), viewer)
  assert.equal(viewer.props.src, 'blob:rendered-preview')
  assert.equal(viewer.props.preserveViewOnSourceChange, true)
  assert.equal(upgrade.cleanups, 1)
  assert.equal(original.cleanups, 0)
  assert.equal(fixture.events.blobs.at(-1), 'blob:rendered-preview')
  assert.equal(fixture.find('p'), undefined)
  assert.deepEqual(fixture.events.errors, [])
  viewer.props.state(false, LoadingState.COMPLETE)
  await settle()
  assert.equal(original.cleanups, 0)
  assert.equal(fixture.find('thumbnail'), undefined)
  // If the recovered original itself can no longer render, show the error
  // instead of repeatedly attempting to recover the same failing source.
  viewer.props.state(false, LoadingState.ERROR)
  await settle()
  assert.equal(fixture.find('webgl-viewer'), undefined)
  assert.ok(fixture.find('p'))
  assert.ok(fixture.find('thumbnail'))
  assert.deepEqual(fixture.events.errors, ['error'])
})

test('decode recovery skips intermediate downloads that never finished rendering', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const original = fixture.loaders[0]
  original.resolve('blob:last-rendered')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1, 2)
  await settle()
  const intermediate = fixture.loaders[1]
  intermediate.resolve('blob:intermediate-not-rendered')
  await settle()
  viewer.props.zoom(2, 4)
  await settle()
  const upgrade = fixture.loaders[2]
  upgrade.resolve('blob:largest-not-rendered')
  await settle()
  viewer.props.state(false, LoadingState.ERROR)
  await settle()
  assert.equal(fixture.find('webgl-viewer'), viewer)
  assert.equal(viewer.props.src, 'blob:last-rendered')
  assert.equal(original.cleanups, 0)
  assert.equal(intermediate.cleanups, 1)
  assert.equal(upgrade.cleanups, 1)
  assert.deepEqual(fixture.events.errors, [])
  viewer.props.state(false, LoadingState.COMPLETE)
  await settle()
  assert.equal(original.cleanups, 0)
  assert.equal(fixture.find('p'), undefined)
})

test('external cache invalidation retries the current image but never restarts an inactive one', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const cancelled = fixture.loaders[0]
  cancelled.reject(
    Object.assign(new Error('cache invalidated after auth change'), {
      name: 'AbortError',
    }),
  )
  await settle()
  await settle()
  assert.equal(cancelled.cleanups, 1)
  assert.equal(fixture.loaders.length, 2)
  assert.equal(fixture.loaders[1].url, cancelled.url)
  assert.deepEqual(fixture.events.errors, [])
  assert.equal(fixture.find('p'), undefined)
  fixture.loaders[1].resolve('blob:after-auth-change')
  await settle()
  assert.equal(fixture.find('webgl-viewer').props.src, 'blob:after-auth-change')
  fixture.props.src = '/media/images/next'
  await settle()
  const inactive = fixture.loaders[2]
  fixture.props.isCurrentImage = false
  await settle()
  inactive.reject(Object.assign(new Error('inactive'), { name: 'AbortError' }))
  await settle()
  await settle()
  assert.equal(fixture.loaders.length, 3)
  assert.equal(fixture.find('webgl-viewer'), undefined)
  assert.deepEqual(fixture.events.errors, [])
})

test('cache invalidation during an upgrade retries its size while retaining the rendered preview', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const original = fixture.loaders[0]
  original.resolve('blob:preview')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1, 2)
  await settle()
  const cancelled = fixture.loaders[1]
  cancelled.reject(
    Object.assign(new Error('cache cleared'), { name: 'AbortError' }),
  )
  await settle()
  await settle()
  assert.equal(fixture.loaders.length, 3)
  assert.equal(fixture.loaders[2].url, '/media/images/first?w=1920')
  assert.equal(fixture.find('webgl-viewer'), viewer)
  assert.equal(viewer.props.src, 'blob:preview')
  assert.equal(original.cleanups, 0)
  assert.deepEqual(fixture.events.errors, [])
  fixture.loaders[2].resolve('blob:retried-upgrade')
  await settle()
  assert.equal(viewer.props.src, 'blob:retried-upgrade')
  viewer.props.state(false, LoadingState.COMPLETE)
  assert.equal(original.cleanups, 1)
})

test('switching photos ignores old progress, errors, and completed downloads', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  const old = fixture.loaders[0]
  fixture.props.src = '/media/images/second'
  await settle()
  assert.equal(old.cleanups, 1)
  const current = fixture.loaders[1]
  assert.equal(current.url, '/media/images/second?w=1280')
  old.callbacks.onProgress(99)
  old.resolve('blob:stale')
  await settle()
  assert.equal(fixture.find('webgl-viewer'), undefined)
  assert.deepEqual(fixture.events.progress, [])
  assert.ok(!fixture.events.blobs.includes('blob:stale'))
  current.resolve('blob:second')
  await settle()
  assert.equal(fixture.find('webgl-viewer').props.src, 'blob:second')
  fixture.props.src = '/media/images/third'
  await settle()
  const cancelled = fixture.loaders[2]
  fixture.props.src = '/media/images/fourth'
  await settle()
  cancelled.reject(
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  )
  await settle()
  await settle()
  assert.equal(
    fixture.loaders.length,
    4,
    'stale cancellation must not retry the current request',
  )
  assert.equal(cancelled.isActive, false)
  assert.deepEqual(fixture.events.errors, [])
  assert.equal(fixture.find('p'), undefined)
})

test('superseded zoom requests cannot replace the larger requested image', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  fixture.loaders[0].resolve('blob:initial')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1, 2)
  await settle()
  const smaller = fixture.loaders[1]
  viewer.props.zoom(2, 4)
  await settle()
  const larger = fixture.loaders[2]
  assert.equal(smaller.cleanups, 1)
  assert.equal(larger.url, '/media/images/first?w=4096')
  larger.resolve('blob:largest')
  await settle()
  smaller.resolve('blob:late-intermediate')
  await settle()
  assert.equal(viewer.props.src, 'blob:largest')
  assert.ok(!fixture.events.blobs.includes('blob:late-intermediate'))
})

test('unmount releases active, pending, and retired image leases and ignores late callbacks', async () => {
  const fixture = await mountProgressive()
  const first = fixture.loaders[0]
  first.resolve('blob:first')
  await settle()
  const viewer = fixture.find('webgl-viewer')
  viewer.props.state(false, LoadingState.COMPLETE)
  viewer.props.zoom(1, 2)
  await settle()
  const active = fixture.loaders[1]
  active.resolve('blob:second')
  await settle()
  viewer.props.zoom(2, 4)
  await settle()
  const pending = fixture.loaders[2]
  fixture.app.unmount()
  assert.equal(first.cleanups, 1)
  assert.equal(active.cleanups, 1)
  assert.equal(pending.cleanups, 1)
  const blobs = [...fixture.events.blobs]
  pending.callbacks.onProgress(100)
  pending.resolve('blob:after-unmount')
  await settle()
  assert.deepEqual(fixture.events.blobs, blobs)
  assert.equal(blobs.at(-1), null)
  assert.deepEqual(fixture.events.errors, [])
  assert.deepEqual(fixture.events.progress, [])
})

test('initial failure shows the fallback and hiding the current photo releases its request', async (t) => {
  const fixture = await mountProgressive()
  t.after(() => fixture.app.unmount())
  fixture.loaders[0].reject(new Error('image unavailable'))
  await settle()
  assert.ok(fixture.find('p'))
  assert.ok(fixture.find('thumbnail'))
  assert.equal(fixture.find('webgl-viewer'), undefined)
  assert.deepEqual(fixture.events.errors, ['error'])
  fixture.props.src = '/media/images/retry'
  await settle()
  const pending = fixture.loaders[1]
  fixture.props.isCurrentImage = false
  await settle()
  assert.equal(pending.cleanups, 1)
  pending.resolve('blob:no-longer-current')
  await settle()
  assert.equal(fixture.find('webgl-viewer'), undefined)
  assert.equal(fixture.find('p'), undefined)
  assert.ok(!fixture.events.blobs.includes('blob:no-longer-current'))
})
