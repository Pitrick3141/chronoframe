const MIN_PASSWORD_LENGTH = 32

function isValidSessionPassword(
  password: string | undefined,
): password is string {
  return Boolean(password && password.length >= MIN_PASSWORD_LENGTH)
}

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig() as {
    session?: { password?: string }
  }

  if (!isValidSessionPassword(config.session?.password)) {
    throw new Error(
      'NUXT_SESSION_PASSWORD must be configured as a Cloudflare Worker secret with at least 32 characters.',
    )
  }
})
