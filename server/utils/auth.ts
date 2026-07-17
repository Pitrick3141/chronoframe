import type { H3Event } from 'h3'

import type { PublicSessionUser } from '~~/shared/types/auth'

/**
 * Whitelist the user fields that may be serialized into a client session.
 * Keeping this projection explicit also prevents future database-only fields
 * from becoming public by accident.
 */
export function toPublicSessionUser(
  user: PublicSessionUser,
): PublicSessionUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    createdAt: user.createdAt,
    isAdmin: user.isAdmin,
  }
}

export async function requireAdminSession(event: H3Event) {
  const session = await requireUserSession(event)

  if (session.user.isAdmin !== 1) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Admin privileges required',
    })
  }

  return session
}
