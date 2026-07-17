import { z } from 'zod'
import { requireBootstrapToken } from '~~/server/utils/bootstrap-token'
import { createInitialAdminAtomically } from '~~/server/utils/initial-admin'

const normalizedEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email(),
)

export default eventHandler(async (event) => {
  const db = useDB()
  const session = await getUserSession(event)
  const { bootstrapToken, email, password, username } = await readValidatedBody(
    event,
    z.object({
      bootstrapToken: z.string().optional(),
      email: normalizedEmailSchema,
      password: z.string().min(12),
      username: z.string().min(2).default('admin'),
    }).parse,
  )

  // Check if any user exists. The creation path below still uses a single
  // conditional INSERT because this read alone cannot serialize bootstrap
  // requests from separate Worker invocations.
  let existingUser = await db.select().from(tables.users).limit(1).get()
  let passwordHash: string | undefined

  if (!existingUser) {
    requireBootstrapToken(event, bootstrapToken)
    passwordHash = await hashPassword(password)

    const claimedAdmin = await createInitialAdminAtomically({
      email,
      passwordHash,
      username,
    })
    if (claimedAdmin) {
      await setUserSession(event, { user: toPublicSessionUser(claimedAdmin) })
      return { success: true }
    }

    // Another bootstrap request won the atomic INSERT. Re-read and apply the
    // same ownership rules as every subsequent onboarding request.
    existingUser = await db.select().from(tables.users).limit(1).get()
    if (!existingUser) {
      throw createError({
        statusCode: 409,
        message: 'Administrator ownership changed; please retry',
      })
    }
  }

  if (existingUser) {
    const ownsSession = Boolean(
      session.user?.isAdmin && Number(session.user.id) === existingUser.id,
    )

    if (!ownsSession) {
      throw createError({
        statusCode: 403,
        message: 'Onboarding is already owned by an administrator',
      })
    }

    // If users exist, we might want to update the admin or throw error
    // For wizard, let's assume we are setting up the first user.
    // If a user exists, maybe we just update the password if it's the same email?
    // Or throw error.
    // Let's throw error for now to be safe, or maybe just allow updating the first user if it matches.
    if (existingUser.email.trim().toLowerCase() === email) {
      // Update existing
      const adminUser = await db
        .update(tables.users)
        .set({
          password: passwordHash ?? (await hashPassword(password)),
          username,
          isAdmin: 1,
        })
        .where(eq(tables.users.id, existingUser.id))
        .returning()
        .get()

      if (!adminUser) {
        throw createError({
          statusCode: 500,
          message: 'Failed to update admin',
        })
      }

      await setUserSession(event, {
        user: toPublicSessionUser(adminUser),
      })
      return { success: true }
    }

    throw createError({
      statusCode: 400,
      message: 'User already exists',
    })
  }
})
