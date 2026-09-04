import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const exports = {}
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    { exports, URL, require: (name) => dependencies[name] },
  )
  return exports
}
const shared = load('../shared/utils/image-variants.ts')
const { imageVariantUrl, thumbnailSrcSet, selectDisplaySize } = load(
  '../app/utils/image-variants.ts',
  {
    '~~/shared/utils/image-variants': shared,
  },
)

test('variants preserve revision keys and do not rewrite external or source-download URLs', () => {
  assert.equal(
    imageVariantUrl('/media/images/photo?v=one&w=4096', 1280),
    '/media/images/photo?v=one&w=1280',
  )
  for (const url of [
    'https://example.com/photo.webp',
    '//example.com/photo',
    '/media/images/a/source',
    'blob:photo',
    '',
  ]) {
    assert.equal(imageVariantUrl(url, 1280), url)
    assert.equal(thumbnailSrcSet(url), undefined)
  }
  assert.equal(
    thumbnailSrcSet('/media/images/a/thumbnail?v=1'),
    [360, 640, 960]
      .map((size) => `/media/images/a/thumbnail?v=1&w=${size} ${size}w`)
      .join(', '),
  )
})

test('fitted sizes follow viewport, pixel density, orientation and source resolution', () => {
  assert.equal(selectDisplaySize(7008, 4672, 1440, 900, 1), 1920)
  assert.equal(selectDisplaySize(7008, 4672, 390, 844, 3), 1280)
  // The portrait height fits the viewport rather than allocating 4096px width.
  assert.equal(selectDisplaySize(4330, 6495, 390, 844, 2), 1280)
  assert.equal(selectDisplaySize(7008, 4672, 1440, 900, 2), 4096)
  assert.equal(selectDisplaySize(800, 600, 1440, 900, 2, 4), 1280)
  assert.equal(selectDisplaySize(undefined, undefined, 1440, 900, 1), 1920)
})

test('zoom requests higher detail only through bounded server-supported sizes', () => {
  assert.equal(selectDisplaySize(7008, 4672, 390, 844, 2, 2), 1920)
  assert.equal(selectDisplaySize(7008, 4672, 390, 844, 2, 3), 2560)
  assert.equal(selectDisplaySize(7008, 4672, 390, 844, 2, 12), 4096)
  for (const zoom of [1, 1.2, 2, 4, 12]) {
    assert.ok(
      shared.DISPLAY_IMAGE_SIZES.includes(
        selectDisplaySize(7008, 4672, 1365, 900, 1, zoom),
      ),
    )
  }
})
