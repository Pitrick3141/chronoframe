import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { useDB, tables, eq } from '~~/server/utils/db'
import { getCloudflareBindings } from '~~/server/utils/cloudflare-bindings'
import { requireBootstrapToken } from '~~/server/utils/bootstrap-token'
import { createInitialAdminAtomically } from '~~/server/utils/initial-admin'

const normalizedEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email(),
)

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.object({
      bootstrapToken: z.string().optional(),
      admin: z.object({
        email: normalizedEmailSchema,
        password: z.string().min(12),
        username: z.string().min(2).default('admin'),
      }),
      site: z.object({
        title: z.string().min(1),
        slogan: z.string().optional(),
        avatarUrl: z.string().optional(),
        author: z.string().optional(),
      }),
      // Accepted temporarily so older onboarding clients can finish while the
      // Cloudflare-only UI rolls out. Storage is configured by Worker bindings.
      storage: z.unknown().optional(),
      map: z.object({
        provider: z.enum(['mapbox', 'maplibre']),
        token: z.string().min(1),
        style: z.string().optional(),
      }),
    }).parse,
  )

  const bindings = getCloudflareBindings()
  const bindingStatus = {
    d1: Boolean(bindings.DB),
    images: Boolean(bindings.IMAGES),
    r2: Boolean(bindings.MEDIA_BUCKET),
    stream: Boolean(bindings.STREAM),
  }
  if (Object.values(bindingStatus).some((configured) => !configured)) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Required Cloudflare bindings are not configured',
      data: { bindings: bindingStatus },
    })
  }

  const db = useDB()
  const session = await getUserSession(event)

  // 1. Handle Admin User
  let adminUser: typeof tables.users.$inferSelect | undefined
  let existingUser = await db.select().from(tables.users).limit(1).get()
  let passwordHash: string | undefined

  if (!existingUser) {
    requireBootstrapToken(event, body.bootstrapToken)
    passwordHash = await hashPassword(body.admin.password)
    adminUser =
      (await createInitialAdminAtomically({
        email: body.admin.email,
        passwordHash,
        username: body.admin.username,
      })) ?? undefined

    if (!adminUser) {
      // A concurrent bootstrap request claimed the installation. Re-read the
      // owner and enforce the normal authenticated recovery rules below.
      existingUser = await db.select().from(tables.users).limit(1).get()
      if (!existingUser) {
        throw createError({
          statusCode: 409,
          message: 'Administrator ownership changed; please retry',
        })
      }
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

    if (existingUser.email.trim().toLowerCase() === body.admin.email) {
      adminUser = await db
        .update(tables.users)
        .set({
          password: passwordHash ?? (await hashPassword(body.admin.password)),
          username: body.admin.username,
          isAdmin: 1,
        })
        .where(eq(tables.users.id, existingUser.id))
        .returning()
        .get()
    } else {
      throw createError({
        statusCode: 400,
        message: 'User already exists',
      })
    }
  }

  if (!adminUser) {
    throw createError({ statusCode: 500, message: 'Failed to persist admin' })
  }

  // Establish ownership before later settings writes. If a transient D1 error
  // interrupts onboarding, the authenticated matching admin can safely retry.
  await setUserSession(event, { user: toPublicSessionUser(adminUser) })

  // 2. Handle Site Settings
  await settingsManager.set('app', 'title', body.site.title)
  if (body.site.slogan)
    await settingsManager.set('app', 'slogan', body.site.slogan)
  if (body.site.avatarUrl)
    await settingsManager.set('app', 'avatarUrl', body.site.avatarUrl)
  if (body.site.author)
    await settingsManager.set('app', 'author', body.site.author)

  // 3. Storage is provisioned through D1, Images and R2 Worker bindings.

  // 4. Handle Map Settings
  await settingsManager.set('map', 'provider', body.map.provider)
  if (body.map.provider === 'mapbox') {
    await settingsManager.set('map', 'mapbox.token', body.map.token)
    if (body.map.style)
      await settingsManager.set('map', 'mapbox.style', body.map.style)
  } else {
    await settingsManager.set('map', 'maplibre.token', body.map.token)
    if (body.map.style)
      await settingsManager.set('map', 'maplibre.style', body.map.style)
  }

  // 5. Mark Complete
  await settingsManager.set('system', 'firstLaunch', false, undefined, true)

  // 6. Auto-login the admin user
  return { success: true }
})
