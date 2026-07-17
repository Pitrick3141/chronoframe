export default defineTask({
  meta: {
    name: 'db:seed',
    description: 'Report the D1 bootstrap workflow',
  },
  async run() {
    logger.dynamic('db').info(
      'Automatic default-user seeding is disabled on Workers; complete onboarding through the application.',
    )

    return {
      result: 'skipped',
      message: 'Use the onboarding flow to create the first administrator.',
    }
  },
})
