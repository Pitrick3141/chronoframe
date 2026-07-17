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

  const isLocalHostedImage =
    target.origin === requestUrl.origin &&
    target.search === '' &&
    /^\/media\/images\/[^/]+(?:\/thumbnail)?$/.test(target.pathname)

  return isCloudflareDelivery || isLocalHostedImage ? target : null
}

export default eventHandler((event) => {
  const rawUrl = getRouterParam(event, 'thumbnailUrl')
  if (!rawUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid thumbnail URL' })
  }

  let decodedUrl: string
  try {
    decodedUrl = decodeURIComponent(rawUrl)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid thumbnail URL' })
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
