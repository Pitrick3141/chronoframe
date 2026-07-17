export default defineNitroPlugin(() => {
  // Cloudflare's Nitro preset exposes Fetch API Request/Headers natively.
  // The former Node IncomingMessage compatibility shim is intentionally gone.
})
