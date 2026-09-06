import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'

const require = createRequire(import.meta.url)
const source = readFileSync(
  new URL('../app/components/ui/ThumbImage.vue', import.meta.url),
  'utf8',
)
// Nuxt inserts these auto-imports before Vue compiles template refs.
const { descriptor } = parse(
  source.replace(
    '<script lang="ts" setup>',
    '<script lang="ts" setup>\nimport { computed, ref, watch, useTemplateRef } from "vue"',
  ),
)
const compiled = ts.transpileModule(
  compileScript(descriptor, { id: 'thumbnail-test', inlineTemplate: true })
    .content,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText

// A Vue host renderer exercises actual SFC updates and event handlers without
// requiring a DOM package or fetching external image URLs.
const renderer = vue.createRenderer({
  createElement: (tag) =>
    vue.markRaw({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, parent: null }),
  createComment: (text) => ({ comment: text, parent: null }),
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

async function mountThumbnail(initialProps = {}) {
  const observers = []
  const events = []
  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    require,
    ...vue,
    useIntersectionObserver: (_element, callback, options) => {
      const observer = { callback, options, stopped: false }
      observers.push(observer)
      return {
        stop: () => {
          observer.stopped = true
        },
      }
    },
  })
  const props = vue.reactive({
    src: '/media/images/test/thumbnail',
    alt: 'Test photo',
    ...initialProps,
  })
  const root = { children: [] }
  const app = renderer.createApp({
    setup: () => () =>
      vue.h(exports.default, {
        ...props,
        onLoad: () => events.push('load'),
        onError: () => events.push('error'),
      }),
  })
  app.component('ThumbHash', { render: () => null })
  app.component('Icon', { render: () => null })
  app.config.globalProperties.$t = (key) => key
  app.mount(root)
  await vue.nextTick()
  const find = (tag, node = root) => {
    if (node.tag === tag) return node
    for (const child of node.children || []) {
      const result = find(tag, child)
      if (result) return result
    }
  }
  return { app, props, root, events, observers, find }
}

test('offscreen thumbnails create no image request until entering the preload margin', async (t) => {
  const fixture = await mountThumbnail({ rootMargin: '800px 0px' })
  t.after(() => fixture.app.unmount())
  const observer = fixture.observers[0]
  assert.equal(observer.options.rootMargin, '800px 0px')
  assert.equal(fixture.find('img'), undefined)
  observer.callback([{ isIntersecting: false }])
  await vue.nextTick()
  assert.equal(fixture.find('img'), undefined)
  observer.callback([{ isIntersecting: true }])
  await vue.nextTick()
  assert.equal(fixture.find('img').props.src, fixture.props.src)
  assert.equal(observer.stopped, true)
  // A final queued observer callback must not remove an already requested image.
  observer.callback([{ isIntersecting: false }])
  await vue.nextTick()
  assert.ok(fixture.find('img'))
})

test('eager thumbnails immediately expose browser priority and responsive choices', async (t) => {
  const fixture = await mountThumbnail({
    lazy: false,
    fetchpriority: 'high',
    srcset:
      '/media/images/test/thumbnail?w=360 360w, /media/images/test/thumbnail?w=640 640w',
    sizes: '310px',
  })
  t.after(() => fixture.app.unmount())
  const img = fixture.find('img')
  assert.equal(img.props.loading, 'eager')
  assert.equal(img.props.fetchpriority, 'high')
  assert.equal(img.props.srcset, fixture.props.srcset)
  assert.equal(img.props.sizes, '310px')
  assert.equal(fixture.observers[0].options.immediate, false)
  img.props.onLoad({ currentTarget: img })
  await vue.nextTick()
  assert.match(img.props.class, /opacity-100/)
  assert.deepEqual(fixture.events, ['load'])
})

test('replacing a source clears previous error/loading state and ignores stale image events', async (t) => {
  const fixture = await mountThumbnail({ lazy: false })
  t.after(() => fixture.app.unmount())
  const oldImage = fixture.find('img')
  oldImage.props.onError({ currentTarget: oldImage })
  await vue.nextTick()
  assert.ok(fixture.find('p'))
  fixture.props.src = '/media/images/replacement/thumbnail'
  await vue.nextTick()
  const newImage = fixture.find('img')
  assert.notEqual(newImage, oldImage)
  assert.equal(fixture.find('p'), undefined)
  assert.match(newImage.props.class, /opacity-0/)
  oldImage.props.onLoad({ currentTarget: oldImage })
  oldImage.props.onError({ currentTarget: oldImage })
  await vue.nextTick()
  assert.deepEqual(fixture.events, ['error'])
  assert.match(newImage.props.class, /opacity-0/)
  newImage.props.onLoad({ currentTarget: newImage })
  await vue.nextTick()
  assert.match(newImage.props.class, /opacity-100/)
  assert.deepEqual(fixture.events, ['error', 'load'])
})

test('empty URLs never request the document, and switching to eager releases a waiting image', async (t) => {
  const fixture = await mountThumbnail({ src: '' })
  t.after(() => fixture.app.unmount())
  fixture.props.lazy = false
  await vue.nextTick()
  assert.equal(fixture.find('img'), undefined)
  fixture.props.src = '/media/images/later/thumbnail'
  await vue.nextTick()
  assert.equal(fixture.find('img').props.loading, 'eager')
})

const photoSource = readFileSync(
  new URL('../app/components/masonry/item/Photo.vue', import.meta.url),
  'utf8',
)
const photoDescriptor = parse(
  photoSource.replace(
    '<script setup lang="ts">',
    '<script setup lang="ts">\nimport { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue"',
  ),
).descriptor
const photoCompiled = ts.transpileModule(
  compileScript(photoDescriptor, { id: 'gallery-photo-test' }).content,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText

async function flushPhotoWork() {
  for (let index = 0; index < 5; index++) await vue.nextTick()
}

async function mountLivePhoto(prepareResult, blur = null) {
  const calls = { prepared: 0, attached: 0, detached: 0, imagePreloads: 0 }
  const observers = []
  const exports = {}
  const blurExports = {}
  const revealed = vue.ref({})
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL('../app/composables/usePhotoBlur.ts', import.meta.url),
        'utf8',
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports: blurExports,
      useState: () => revealed,
      useI18n: () => ({ t: (key) => key }),
    },
  )
  vm.runInNewContext(photoCompiled, {
    exports,
    require: (id) => {
      if (id === '~/utils/camera') return { formatCameraInfo: () => '' }
      if (id === '~/utils/image-variants')
        return { thumbnailSrcSet: () => undefined }
      if (id === 'motion-v') return { motion: {}, useDomRef: () => vue.ref() }
      return require(id)
    },
    console,
    setTimeout,
    clearTimeout,
    useGtag: () => ({ gtag: () => {} }),
    usePhotoBlur: blurExports.usePhotoBlur,
    useMediaQuery: () => vue.ref(false),
    useLivePhotoProcessor: () => ({
      getProcessingState: () => vue.ref(null),
      prepareLivePhoto: async (url) => {
        calls.prepared++
        return prepareResult ? await prepareResult : url
      },
    }),
    useStreamVideo: () => ({
      isLoading: vue.ref(false),
      isReady: vue.ref(false),
      attachStreamVideo: async () => {
        calls.attached++
        return true
      },
      detachStreamVideo: () => {
        calls.detached++
      },
    }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      constructor(callback, options) {
        observers.push({ callback, options })
      }
      observe() {}
      disconnect() {}
    },
    Image: class {
      constructor() {
        calls.imagePreloads++
      }
    },
  })
  let state
  const setupPhoto = exports.default.setup
  exports.default.setup = (props, context) => {
    state = setupPhoto(props, context)
    // Only substitute the layout. Photo's actual mounting, observers, state,
    // callbacks and async attachment cancellation run unchanged.
    return () =>
      vue.h('div', { ref: state.photoRef }, [
        vue.h('video', { ref: state.videoRef }),
      ])
  }
  const app = renderer.createApp(exports.default, {
    photo: {
      id: 'live-test',
      blur,
      thumbnailUrl: '/media/images/live-test/thumbnail',
      isLivePhoto: 1,
      livePhotoVideoUrl: '/media/videos/live-test/manifest/video.m3u8',
    },
    index: 12,
  })
  app.mount({ children: [] })
  await flushPhotoWork()
  Object.assign(state.videoRef.value, {
    paused: true,
    play: async () => {},
    pause: () => {},
  })
  return { app, state, calls, observer: observers[0] }
}

test('blurred Live Photos do not prepare or play on visibility, hover or touch before reveal', async (t) => {
  const fixture = await mountLivePhoto(undefined, { reason: 'spoiler' })
  t.after(() => fixture.app.unmount())
  fixture.observer.callback([{ isIntersecting: true }])
  fixture.state.handleImageLoad()
  await fixture.state.handleMouseEnter()
  fixture.state.handleTouchStart({ touches: [{}] })
  fixture.state.playLivePhotoVideo()
  await flushPhotoWork()
  assert.equal(fixture.state.isBlurred.value, true)
  assert.equal(fixture.calls.prepared, 0)
  assert.equal(fixture.calls.attached, 0)
  assert.equal(fixture.state.isVideoPlaying.value, false)
  fixture.state.handleClick({})
  await flushPhotoWork()
  assert.equal(fixture.state.isBlurred.value, false)
  assert.equal(fixture.calls.prepared, 1)
})

test('gallery mounting never preloads pixels and automatic video preparation waits for a visible loaded image', async (t) => {
  const fixture = await mountLivePhoto()
  t.after(() => fixture.app.unmount())
  assert.equal(fixture.calls.imagePreloads, 0)
  assert.equal(fixture.observer.options.rootMargin, '0px')
  fixture.observer.callback([{ isIntersecting: true }])
  await flushPhotoWork()
  assert.equal(fixture.calls.prepared, 0)
  fixture.state.handleImageLoad()
  await flushPhotoWork()
  assert.equal(fixture.calls.prepared, 1)
  assert.equal(fixture.calls.attached, 1)
  fixture.observer.callback([{ isIntersecting: false }])
  await flushPhotoWork()
  assert.equal(fixture.calls.detached, 1)
})

test('deliberate hover can prepare video before pixels load, while leaving cancels pending attachment', async (t) => {
  let finishPreparation
  const pending = new Promise((resolve) => {
    finishPreparation = resolve
  })
  const fixture = await mountLivePhoto(pending)
  t.after(() => fixture.app.unmount())
  fixture.observer.callback([{ isIntersecting: true }])
  await flushPhotoWork()
  await fixture.state.handleMouseEnter()
  assert.equal(fixture.calls.prepared, 1)
  fixture.observer.callback([{ isIntersecting: false }])
  finishPreparation('/media/videos/live-test/manifest/video.m3u8')
  await flushPhotoWork()
  assert.equal(fixture.calls.attached, 0)
  assert.equal(fixture.calls.detached, 1)
})
