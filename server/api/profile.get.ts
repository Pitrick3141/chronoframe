export default eventHandler(async (event) => {
  const { user } = await getUserSession(event)
  return user ? toPublicSessionUser(user) : undefined
})
