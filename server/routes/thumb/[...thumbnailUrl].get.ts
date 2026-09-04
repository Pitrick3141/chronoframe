import { getImageVariant } from '../../../shared/utils/image-variants'

function safeThumbnailTarget(candidate: string, requestUrl: URL): URL | null {
  let target: URL
  try {
    target = new URL(candidate, requestUrl.origin)
  } catch {
    return null
  }

  if (target.username || target.password || target.hash) return null

  const isCloudflareDelivery =
    target.protocol === 'https:' &&
    target.hostname === 'imagedelivery.net' &&
    target.port === '' &&
    /^\/[^/]+\/[^/]+\/[^/]+$/.test(target.pathname)

  const localQueriesAllowed =
    [...target.searchParams.keys()].every(
      (key) => key === 'v' || key === 'w',
    ) &&
    target.searchParams.getAll('v').length <= 1 &&
    target.searchParams.getAll('w').length <= 1 &&
    (target.searchParams.get('v')?.length ?? 0) <= 128 &&
    getImageVariant(
      target.pathname.endsWith('/thumbnail') ? 'thumbnail' : 'display',
      target.searchParams.get('w') ?? undefined,
    ) !== null
  const isLocalHostedImage =
    target.origin === requestUrl.origin &&
    localQueriesAllowed &&
    /^\/media\/images\/[^/]+(?:\/thumbnail)?$/.test(target.pathname)

  return isCloudflareDelivery || isLocalHostedImage ? target : null
}

export default eventHandler((event) => {
  const rawUrl = getRouterParam(event, 'thumbnailUrl')
  if (!rawUrl) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid thumbnail URL',
    })
  }

  let decodedUrl: string
  try {
    decodedUrl = decodeURIComponent(rawUrl)
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid thumbnail URL',
    })
  }

  const target = safeThumbnailTarget(decodedUrl, getRequestURL(event))
  if (!target) {
    throw createError({
      statusCode: 410,
      statusMessage:
        'Legacy thumbnail proxy removed; use a Cloudflare Hosted Images URL.',
    })
  }

  return new Response(null, {
    status: 307,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'public, max-age=86400',
    },
  })
})
