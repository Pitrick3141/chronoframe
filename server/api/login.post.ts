import { z } from 'zod'
import { sql } from 'drizzle-orm'

const normalizedEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email(),
)

let dummyPasswordHash: Promise<string> | undefined

function getDummyPasswordHash() {
  dummyPasswordHash ??= hashPassword('chronoframe-dummy-login-password')
  return dummyPasswordHash
}

function invalidCredentialsError() {
  return createError({
    statusCode: 401,
    message: 'Invalid credentials',
  })
}

export default eventHandler(async (event) => {
  const db = useDB()
  const { email, password } = await readValidatedBody(
    event,
    z.object({
      email: normalizedEmailSchema,
      password: z.string().min(6),
    }).parse,
  )

  const [user, fallbackPasswordHash] = await Promise.all([
    db
      .select()
      .from(tables.users)
      .where(sql`lower(trim(${tables.users.email})) = ${email}`)
      .get(),
    getDummyPasswordHash(),
  ])

  const passwordMatches = await verifyPassword(
    user?.password || fallbackPasswordHash,
    password,
  )

  if (!user || !user.password || !passwordMatches) {
    throw invalidCredentialsError()
  }

  await setUserSession(event, { user: toPublicSessionUser(user) })

  return setResponseStatus(event, 201)
})
