export default defineNitroPlugin(() => {
  // D1 migrations are applied during deployment (`wrangler d1 migrations
  // apply`). Running filesystem-backed migrations during isolate startup is
  // both unsafe and unsupported on Workers.
})
