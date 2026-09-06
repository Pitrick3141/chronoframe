import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { z } from 'zod'
import { ref } from 'vue'

function load(file, globals = {}, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports,
      URLSearchParams,
      require: (name) => {
        assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
        return dependencies[name]
      },
      ...globals,
    },
  )
  return exports
}

const dto = load('server/utils/photo-response.ts')
const plain = (value) => JSON.parse(JSON.stringify(value))

function editor(admin = true) {
  const original = {
    id: 'photo-1',
    title: 'Original',
    blur: null,
    exif: {},
    tags: ['trip'],
  }
  let row = { ...original }
  const writes = []
  let bodyReads = 0
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ get: async () => row }) }),
    }),
    update: () => ({
      set: (data) => ({
        where: async () => {
          writes.push(plain(data))
          row = { ...row, ...data }
        },
      }),
    }),
  }
  const handler = load(
    'server/api/photos/[photoId]/index.put.ts',
    {
      eventHandler: (fn) => fn,
      requireAdminSession: async () => {
        if (!admin) throw new Error('Unauthorized')
      },
      useTranslation: async () => (key) => key,
      readBody: async (event) => {
        bodyReads++
        return event.body
      },
      useDB: () => db,
      tables: { photos: { id: 'id' } },
      createError: (details) =>
        Object.assign(new Error(details.statusMessage), details),
    },
    {
      zod: { z },
      'drizzle-orm': { eq: () => true },
      '../../../utils/photo-response': dto,
    },
  ).default
  return {
    update: (body) =>
      handler({ context: { params: { photoId: 'photo-1' } }, body }),
    writes,
    get row() {
      return row
    },
    get bodyReads() {
      return bodyReads
    },
  }
}

test('admin can set either preset, persist custom text, edit metadata and remove blur', async () => {
  const api = editor()
  for (const reason of ['disturbing', 'spoiler']) {
    const result = await api.update({ blur: { reason } })
    assert.deepEqual(plain(result.photo.blur), { reason })
    assert.deepEqual(plain(dto.photoForClient(api.row).blur), { reason })
    assert.equal(api.row.title, 'Original')
    assert.deepEqual(api.row.tags, ['trip'])
  }
  await api.update({
    blur: { reason: 'custom', message: '  Season finale\nSpoilers ahead  ' },
  })
  await api.update({ title: 'Updated title' })
  assert.deepEqual(plain(api.row.blur), {
    reason: 'custom',
    message: 'Season finale\nSpoilers ahead',
  })
  assert.equal(api.row.title, 'Updated title')
  assert.ok(
    !('blur' in api.writes.at(-1)),
    'unrelated edits preserve the warning',
  )
  await api.update({ blur: null })
  assert.equal(api.row.blur, null)
  assert.equal(dto.photoForClient(api.row).blur, null)
  assert.equal(dto.photoForClient({ id: 'legacy-photo' }).blur, null)
})

test('invalid warnings are rejected without writing and admin authorization precedes body access', async () => {
  const api = editor()
  for (const blur of [
    true,
    'spoiler',
    {},
    { reason: 'unknown' },
    { reason: 'custom' },
    { reason: 'custom', message: '' },
    { reason: 'custom', message: ' \n ' },
    { reason: 'custom', message: 'x'.repeat(201) },
  ]) {
    await assert.rejects(api.update({ blur }))
  }
  assert.equal(api.writes.length, 0)
  await api.update({ blur: { reason: 'custom', message: 'x'.repeat(200) } })
  assert.equal(api.writes.length, 1)
  const anonymous = editor(false)
  await assert.rejects(anonymous.update({ blur: null }), /Unauthorized/)
  assert.equal(anonymous.writes.length, 0)
  assert.equal(anonymous.bodyReads, 0)
})

test('reveals are per photo, shared across surfaces, reset for changed warnings and fresh visits', () => {
  const visit = () => {
    const states = new Map()
    return load('app/composables/usePhotoBlur.ts', {
      useState: (key, init) => {
        if (!states.has(key)) states.set(key, ref(init()))
        return states.get(key)
      },
      useI18n: () => ({ t: (key) => key }),
    }).usePhotoBlur
  }
  const useBlur = visit()
  const gallery = useBlur()
  const viewer = useBlur()
  const a = { id: 'a', blur: { reason: 'spoiler' } }
  const b = { id: 'b', blur: { reason: 'spoiler' } }
  assert.equal(gallery.isPhotoBlurred({ id: 'unflagged' }), false)
  assert.equal(gallery.isPhotoBlurred(a), true)
  gallery.revealPhoto(a)
  assert.equal(viewer.isPhotoBlurred(a), false)
  assert.equal(viewer.isPhotoBlurred(b), true)
  a.blur = { reason: 'custom', message: '<b>New warning</b>' }
  assert.equal(viewer.isPhotoBlurred(a), true)
  assert.equal(viewer.blurLabel(a.blur), '<b>New warning</b>')
  assert.equal(viewer.blurLabel(b.blur), 'photoBlur.reasons.spoiler')
  viewer.revealPhoto(a)
  assert.equal(gallery.isPhotoBlurred(a), false)
  assert.equal(visit()().isPhotoBlurred(a), true)
})
