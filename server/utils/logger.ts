import { createConsola } from 'consola'

const mConsola = createConsola({
  formatOptions: {
    date: true,
    colors: true,
    compact: false,
  },
})

// Workers have no durable local filesystem. Console output is collected by
// Cloudflare Workers Logs / Observability instead of being mirrored to a file.

export const logger = {
  chrono: mConsola.withTag('cframe/main'),
  storage: mConsola.withTag('cframe/storage'),
  fs: mConsola.withTag('cframe/fs'),
  image: mConsola.withTag('cframe/image'),
  location: mConsola.withTag('cframe/location'),
  dynamic: (id: string) => mConsola.withTag(`cframe/${id}`),
}

export type Logger = Omit<typeof logger, 'dynamic'>
export type DynamicLogger = typeof logger.dynamic
