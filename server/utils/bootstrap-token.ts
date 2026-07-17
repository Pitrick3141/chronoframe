import { createHash, timingSafeEqual } from 'node:crypto'
import { env as workerEnv } from 'cloudflare:workers'
import type { H3Event } from 'h3'

export const BOOTSTRAP_TOKEN_HEADER = 'x-chronoframe-bootstrap-token'

const MIN_BOOTSTRAP_TOKEN_LENGTH = 32

function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * Authorizes the one-time transition from an empty D1 database to an owned
 * ChronoFrame installation. The deployment secret is never persisted or
 * included in an API response.
 */
export function requireBootstrapToken(
  event: H3Event,
  bodyToken?: string,
): void {
  const configuredToken = (
    workerEnv as unknown as { CFRAME_BOOTSTRAP_TOKEN?: string }
  ).CFRAME_BOOTSTRAP_TOKEN

  if (
    !configuredToken ||
    configuredToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH
  ) {
    throw createError({
      statusCode: 503,
      statusMessage: 'First-run bootstrap is not configured',
    })
  }

  const suppliedToken = getHeader(event, BOOTSTRAP_TOKEN_HEADER) ?? bodyToken
  if (
    !suppliedToken ||
    !timingSafeEqual(hashToken(configuredToken), hashToken(suppliedToken))
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Invalid first-run bootstrap credentials',
    })
  }
}
