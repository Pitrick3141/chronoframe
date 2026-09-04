import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(
  new URL('../app/utils/photo-selection.ts', import.meta.url),
  'utf8',
)
const exports = {}
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  { exports },
)
const update = (...args) =>
  JSON.parse(JSON.stringify(exports.updatePhotoSelection(...args)))
const ids = ['a', 'b', 'c', 'd', 'e']

test('normal clicks toggle only the target and establish a new anchor', () => {
  assert.deepEqual(update({ a: true }, ids, 'a', 'c', true), {
    selected: { a: true, c: true },
    anchorId: 'c',
  })
  assert.deepEqual(update({ a: true, c: true }, ids, 'a', 'c', false), {
    selected: { a: true },
    anchorId: 'c',
  })
})

test('Shift selects inclusive ranges in either direction and preserves outside selections', () => {
  const original = Object.freeze({ a: true, e: true })
  for (const [anchor, target] of [
    ['b', 'd'],
    ['d', 'b'],
  ]) {
    assert.deepEqual(update(original, ids, anchor, target, true, true), {
      selected: { a: true, b: true, c: true, d: true, e: true },
      anchorId: anchor,
    })
  }
  assert.deepEqual(original, { a: true, e: true })
})

test('Shift on a selected target clears the range without clearing other selections', () => {
  assert.deepEqual(
    update(
      { a: true, b: true, c: true, d: true, e: true },
      ids,
      'd',
      'b',
      false,
      true,
    ),
    {
      selected: { a: true, e: true },
      anchorId: 'd',
    },
  )
})

test('range follows current sorted/filtered rows while keeping hidden selections by ID', () => {
  assert.deepEqual(
    update({ b: true, e: true }, ['e', 'c', 'a'], 'e', 'a', true, true),
    {
      selected: { a: true, b: true, c: true, e: true },
      anchorId: 'e',
    },
  )
  for (const anchor of [null, 'b']) {
    assert.deepEqual(
      update({ b: true }, ['e', 'c', 'a'], anchor, 'a', true, true),
      {
        selected: { a: true, b: true },
        anchorId: 'a',
      },
    )
  }
})

test('repeated Shift clicks keep the anchor and ignore a target no longer displayed', () => {
  const first = update({ b: true }, ids, 'b', 'c', true, true)
  assert.deepEqual(
    update(first.selected, ids, first.anchorId, 'e', true, true),
    {
      selected: { b: true, c: true, d: true, e: true },
      anchorId: 'b',
    },
  )
  assert.deepEqual(update(first.selected, ['a', 'b'], 'b', 'e', true, true), {
    selected: first.selected,
    anchorId: null,
  })
})
