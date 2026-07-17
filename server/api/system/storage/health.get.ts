import { getCloudflareBindings } from '../../../utils/cloudflare-bindings'

interface D1HealthBinding {
  prepare(query: string): {
    first<T>(): Promise<T | null>
  }
}

interface HostedImagesHealthBinding {
  list(options?: { perPage?: number }): Promise<unknown>
}

interface StreamHealthBinding {
  videos?: {
    list(options?: { limit?: number }): Promise<unknown>
  }
}

interface HealthBindings {
  DB?: D1HealthBinding
  IMAGES?: { hosted?: Partial<HostedImagesHealthBinding> }
  STREAM?: StreamHealthBinding
  MEDIA_BUCKET?: { head(key: string): Promise<unknown> }
}

interface BindingHealth {
  configured: boolean
  healthy: boolean
}

async function probe(
  configured: boolean,
  check: () => Promise<unknown>,
): Promise<BindingHealth> {
  if (!configured) return { configured: false, healthy: false }
  try {
    await check()
    return { configured: true, healthy: true }
  } catch (error) {
    logger.dynamic('bindings-health').warn('Binding health check failed', error)
    return { configured: true, healthy: false }
  }
}

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const bindings = getCloudflareBindings() as unknown as HealthBindings
  const imagesList = bindings.IMAGES?.hosted?.list
  const streamList = bindings.STREAM?.videos?.list

  const [d1, images, stream, r2] = await Promise.all([
    probe(Boolean(bindings.DB), async () => {
      const result = await bindings.DB!.prepare('SELECT 1 AS ok').first<{
        ok: number
      }>()
      if (result?.ok !== 1) throw new Error('Unexpected D1 probe response')
    }),
    probe(Boolean(bindings.IMAGES), async () => {
      if (typeof imagesList !== 'function') {
        throw new Error('Hosted Images management API is unavailable')
      }
      await imagesList.call(bindings.IMAGES!.hosted)
    }),
    probe(Boolean(bindings.STREAM), async () => {
      if (typeof streamList !== 'function') {
        throw new Error('Cloudflare Stream videos API is unavailable')
      }
      await streamList.call(bindings.STREAM!.videos, { limit: 1 })
    }),
    probe(Boolean(bindings.MEDIA_BUCKET), async () => {
      await bindings.MEDIA_BUCKET!.head('__chronoframe_healthcheck__')
    }),
  ])

  return {
    status:
      d1.configured && d1.healthy &&
      images.configured && images.healthy &&
      stream.configured && stream.healthy &&
      r2.configured && r2.healthy
        ? ('healthy' as const)
        : ('degraded' as const),
    bindings: { d1, images, stream, r2 },
  }
})
