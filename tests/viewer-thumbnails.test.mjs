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
const variantExports = {}
vm.runInNewContext(
  transpile(
    readFileSync(
      new URL('../app/utils/image-variants.ts', import.meta.url),
      'utf8',
    ),
  ),
  {
    exports: variantExports,
    URL,
    require: () => ({
      DISPLAY_IMAGE_SIZES: [1280, 1920, 2560, 4096],
      THUMBNAIL_IMAGE_SIZES: [360, 640, 960],
    }),
  },
)

function compileComponent(path, inlineTemplate = true) {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8')
  if (path.includes('Histogram'))
    source = source.replace(
      '<script lang="ts" setup>',
      '<script lang="ts" setup>\nimport { ref, watch, watchEffect, useTemplateRef, onUnmounted } from "vue"',
    )
  return transpile(
    compileScript(parse(source).descriptor, { id: path, inlineTemplate })
      .content,
  )
}

function makeRenderer(requests) {
  return vue.createRenderer({
    createElement: (tag) =>
      vue.markRaw({
        tag,
        props: {},
        children: [],
        parent: null,
        listeners: {},
        scrollLeft: 0,
        clientWidth: 420,
        get scrollWidth() {
          return this.children.length * 76 + 20
        },
        scrollTo({ left }) {
          this.scrollLeft = Math.min(
            Math.max(0, this.scrollWidth - this.clientWidth),
            left,
          )
        },
        addEventListener(name, callback) {
          this.listeners[name] = callback
        },
        removeEventListener(name) {
          delete this.listeners[name]
        },
      }),
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
      if (node.tag === 'img' && key === 'src' && value) requests.push(value)
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) =>
      node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert: (node, parent, anchor = null) => {
      if (node.parent)
        node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove: (node) => {
      if (node.parent)
        node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = null
    },
  })
}

function findAll(root, predicate) {
  return [
    root,
    ...(root.children || []).flatMap((node) => findAll(node, predicate)),
  ].filter(predicate)
}

test('filmstrip requests only the active neighborhood, follows scrolling and keeps every navigation button', async () => {
  const requests = []
  const exports = {}
  let observer
  const blurExports = {}
  const revealed = vue.ref({})
  vm.runInNewContext(
    transpile(
      readFileSync(
        new URL('../app/composables/usePhotoBlur.ts', import.meta.url),
        'utf8',
      ),
    ),
    {
      exports: blurExports,
      useState: () => revealed,
      useI18n: () => ({ t: (key) => key }),
    },
  )
  vm.runInNewContext(
    compileComponent('../app/components/photo/GalleryThumbnail.vue'),
    {
      exports,
      require: (id) => {
        if (id === '~/utils/image-variants') return variantExports
        if (id === 'motion-v')
          return {
            motion: {
              div: vue.defineComponent({
                setup:
                  (_props, { slots }) =>
                  () =>
                    vue.h('div', slots.default?.()),
              }),
            },
          }
        return require(id)
      },
      useMediaQuery: () => vue.ref(false),
      usePhotoBlur: blurExports.usePhotoBlur,
      ResizeObserver: class {
        constructor(callback) {
          observer = this
          this.callback = callback
          this.disconnected = false
        }
        observe() {}
        disconnect() {
          this.disconnected = true
        }
      },
    },
  )
  const props = vue.reactive({
    currentIndex: 50,
    photos: Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      title: `Photo ${index}`,
      thumbnailUrl: `/media/images/${index}/thumbnail?v=same`,
    })),
  })
  const root = { children: [] }
  const app = makeRenderer(requests).createApp({
    setup: () => () => vue.h(exports.default, props),
  })
  app.component('ThumbHash', { render: () => null })
  app.component('Icon', { render: () => null })
  app.config.globalProperties.$t = (key) => key
  app.mount(root)
  await vue.nextTick()
  assert.equal(findAll(root, (node) => node.tag === 'button').length, 100)
  assert.ok(requests.length <= 12)
  assert.ok(requests.includes('/media/images/50/thumbnail?v=same&w=360'))
  props.photos[50].blur = { reason: 'spoiler' }
  await vue.nextTick()
  const warningButton = findAll(
    root,
    (node) =>
      node.tag === 'button' &&
      node.props['aria-label'] === 'photoBlur.reasons.spoiler',
  )[0]
  assert.ok(warningButton)
  assert.equal(
    findAll(warningButton, (node) => node.tag === 'img')[0].props.style.filter,
    'blur(10px)',
  )
  blurExports.usePhotoBlur().revealPhoto(props.photos[50])
  await vue.nextTick()
  assert.equal(
    findAll(warningButton, (node) => node.tag === 'img')[0].props.style.filter,
    undefined,
  )
  assert.ok(
    !requests.some(
      (url) => url.includes('/images/0/') || url.includes('/images/99/'),
    ),
  )
  const container = findAll(root, (node) =>
    node.props?.class?.includes('gallery-scroll-area'),
  )[0]
  assert.ok(container.scrollLeft > 3000)
  container.scrollLeft = 0
  container.listeners.scroll()
  await vue.nextTick()
  assert.ok(requests.includes('/media/images/0/thumbnail?v=same&w=360'))
  assert.ok(!requests.some((url) => url.includes('/images/99/')))
  assert.ok(findAll(root, (node) => node.tag === 'img').length <= 12)
  props.currentIndex = 98
  await vue.nextTick()
  await vue.nextTick()
  assert.ok(container.scrollLeft > 6000)
  assert.ok(requests.includes('/media/images/98/thumbnail?v=same&w=360'))
  const active = findAll(
    root,
    (node) =>
      node.tag === 'button' && node.props.class.includes('thumbnail-active'),
  )
  assert.equal(active.length, 1)
  assert.equal(
    findAll(active[0], (node) => node.tag === 'img')[0].props.alt,
    'Photo 98',
  )
  app.unmount()
  assert.equal(observer.disconnected, true)
  assert.deepEqual(Object.keys(container.listeners), [])
})

test('histograms reuse stable360 URLs, attach handlers before src and only use CORS for external images', async () => {
  const images = []
  const exports = {}
  let calculations = 0
  vm.runInNewContext(
    compileComponent('../app/components/Histogram.vue', false),
    {
      exports,
      require: (id) => {
        if (id === '~/utils/image-variants') return variantExports
        if (id === '~/libs/histogram')
          return {
            calculateHistogramCompressed: () => {
              calculations++
              return {}
            },
            drawHistogramToCanvas: () => {},
          }
        return require(id)
      },
      URL,
      window: { location: { origin: 'https://gallery.test' } },
      document: {
        createElement: () => ({
          getContext: () => ({ drawImage() {}, getImageData: () => ({}) }),
        }),
      },
      console,
      Image: class {
        constructor() {
          this.width = 360
          this.height = 240
          images.push(this)
        }
        set src(value) {
          assert.equal(typeof this.onload, 'function')
          assert.equal(typeof this.onerror, 'function')
          this.url = value
        }
        removeAttribute(name) {
          if (name === 'src') this.cancelled = true
        }
      },
    },
  )
  const setupHistogram = exports.default.setup
  exports.default.setup = (props, context) => {
    setupHistogram(props, context)
    return () => null
  }
  const props = vue.reactive({
    thumbnailUrl: '/media/images/50/thumbnail?v=same',
  })
  const app = makeRenderer([]).createApp({
    setup: () => () => vue.h(exports.default, props),
  })
  app.mount({ children: [] })
  assert.equal(images[0].url, '/media/images/50/thumbnail?v=same&w=360')
  assert.equal(images[0].crossOrigin, undefined)
  images[0].onload()
  await vue.nextTick()
  assert.equal(calculations, 1)
  assert.equal(images.length, 1)
  props.thumbnailUrl = '/media/images/51/thumbnail?v=same'
  await vue.nextTick()
  props.thumbnailUrl = 'https://external.test/photo.jpg?v=original'
  await vue.nextTick()
  assert.equal(images[1].cancelled, true)
  assert.equal(images[1].onload, null)
  assert.equal(images[2].url, props.thumbnailUrl)
  assert.equal(images[2].crossOrigin, 'anonymous')
  assert.ok(images.every((image) => !image.url.includes('_cors')))
  app.unmount()
  assert.equal(images[2].cancelled, true)
})
