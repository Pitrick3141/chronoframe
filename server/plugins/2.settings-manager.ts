import { DEFAULT_SETTINGS } from '../services/settings/contants'
import { settingsManager } from '../services/settings/settingsManager'

export default defineNitroPlugin((nitroApp) => {
  // Worker startup has no request context and must not perform D1 I/O. The
  // manager remembers only successful completion. Concurrent cold-start
  // requests use separate, idempotent D1 operations rather than sharing I/O.
  nitroApp.hooks.hook('request', async () => {
    await settingsManager.init(DEFAULT_SETTINGS)
  })
})
