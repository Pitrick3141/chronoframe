import { r2 } from '../../../services/cloudflare/r2'
import { requireReadyR2ObjectKey } from '../../../utils/r2-object-access'

function webHeaders(event: Parameters<typeof getRequestHeaders>[0]): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(getRequestHeaders(event))) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)
  const key = await requireReadyR2ObjectKey(
    event,
    getRouterParam(event, 'key'),
  )
  return r2.response(key, webHeaders(event), {
    authenticated: true,
    headOnly: true,
  })
})
