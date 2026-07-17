type CompatibleHeaders = Record<string, string | string[] | undefined> & {
  get?: (name: string) => string | null
}

type CompatibleEvent = {
  url?: URL
  req?: {
    url?: string
    headers?: CompatibleHeaders
  }
  node?: {
    req?: {
      url?: string
      headers?: CompatibleHeaders
    }
  }
}

/**
 * Nitro currently exposes Node-style request headers through the H3 event on
 * the Cloudflare module preset. Some Nuxt modules resolve H3 v2 helpers, which
 * expect Fetch API Headers and call `.get()`. Add only that missing method and
 * keep it non-enumerable so H3 v1/Node-style header iteration is unchanged.
 */
function addHeadersGet(headers: unknown): void {
  if (!headers || typeof headers !== 'object') return

  const compatible = headers as CompatibleHeaders
  if (typeof compatible.get === 'function') return

  Object.defineProperty(compatible, 'get', {
    configurable: true,
    enumerable: false,
    value(name: string): string | null {
      const value = compatible[name.toLowerCase()] ?? compatible[name]
      if (value === undefined) return null
      return Array.isArray(value) ? value.join(', ') : String(value)
    },
  })
}

/**
 * H3 v2 also reads `event.url` when a request has no forwarded-protocol
 * header. Nitro's H3 v1 compatibility event only exposes the (often relative)
 * Node request URL, which makes `new URL(event.req.url)` fail during SSR
 * subrequests. Materialize the absolute URL expected by H3 v2 helpers.
 */
function addEventUrl(event: unknown): void {
  const compatible = event as CompatibleEvent
  if (compatible.url instanceof URL) return

  const request = compatible.req ?? compatible.node?.req
  if (!request?.url) return

  try {
    compatible.url = new URL(request.url)
    return
  } catch {
    // Relative Node request URLs need an origin assembled from proxy headers.
  }

  const forwardedProtocol = request.headers
    ?.get?.('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
  const protocol = forwardedProtocol === 'http' ? 'http' : 'https'
  const host =
    request.headers?.get?.('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers?.get?.('host') ||
    'localhost'

  try {
    compatible.url = new URL(request.url, `${protocol}://${host}`)
  } catch {
    compatible.url = new URL(request.url, `${protocol}://localhost`)
  }
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    addHeadersGet(event.node.req.headers)

    // H3 v1 compatibility events may expose `req` separately from `node.req`.
    const requestHeaders = (event as unknown as { req?: { headers?: unknown } })
      .req?.headers
    if (requestHeaders !== event.node.req.headers) {
      addHeadersGet(requestHeaders)
    }

    addEventUrl(event)
  })
})
