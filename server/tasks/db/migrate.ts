export default defineTask({
  meta: {
    name: 'db:migrate',
    description: 'Report the deployment-managed D1 migration workflow',
  },
  async run() {
    logger.dynamic('db').info(
      'D1 migrations are applied with `wrangler d1 migrations apply DB`.',
    )

    return {
      result: 'skipped',
      message: 'D1 migrations are managed during deployment.',
    }
  },
})
