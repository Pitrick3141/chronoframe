export default defineNitroPlugin(() => {
  // Workers must not create resident polling loops. Queue work is dispatched
  // explicitly by request/Cloudflare Queue handlers.
})
