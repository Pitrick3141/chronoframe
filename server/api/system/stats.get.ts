import { gte, sql } from 'drizzle-orm'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const db = useDB()
  const now = new Date()

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)

  const monthStart = new Date(today)
  monthStart.setDate(1)

  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)

  const [totalPhotos, todayPhotos, weekPhotos, monthPhotos, storageStats] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(tables.photos)
        .get(),
      db
        .select({ count: sql<number>`count(*)` })
        .from(tables.photos)
        .where(gte(tables.photos.dateTaken, today.toISOString()))
        .get(),
      db
        .select({ count: sql<number>`count(*)` })
        .from(tables.photos)
        .where(gte(tables.photos.dateTaken, weekAgo.toISOString()))
        .get(),
      db
        .select({ count: sql<number>`count(*)` })
        .from(tables.photos)
        .where(gte(tables.photos.dateTaken, monthStart.toISOString()))
        .get(),
      db
        .select({
          totalSize: sql<number>`COALESCE(sum(file_size), 0)`,
          avgSize: sql<number>`COALESCE(avg(file_size), 0)`,
          maxSize: sql<number>`COALESCE(max(file_size), 0)`,
        })
        .from(tables.photos)
        .get(),
    ])

  const rawTrendData = await db
    .select({
      date: sql<string>`DATE(${tables.photos.dateTaken})`,
      count: sql<number>`count(*)`,
    })
    .from(tables.photos)
    .where(gte(tables.photos.dateTaken, sevenDaysAgo.toISOString()))
    .groupBy(sql`DATE(${tables.photos.dateTaken})`)
    .orderBy(sql`DATE(${tables.photos.dateTaken}) ASC`)
    .all()

  const trends = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(sevenDaysAgo)
    date.setDate(date.getDate() + index)
    const dateString = date.toISOString().slice(0, 10)
    const row = rawTrendData.find((candidate) => candidate.date === dateString)
    return { date: dateString, count: row?.count ?? 0 }
  }).reverse()

  return {
    // Isolates have neither meaningful process uptime nor host memory metrics.
    uptime: 0,
    runningOn: 'cloudflare-workers',
    memory: null as { used: number; total: number } | null,
    photos: {
      total: totalPhotos?.count ?? 0,
      today: todayPhotos?.count ?? 0,
      thisWeek: weekPhotos?.count ?? 0,
      thisMonth: monthPhotos?.count ?? 0,
    },
    workerPool: {
      totalWorkers: 0,
      activeWorkers: 0,
      totalProcessed: 0,
      totalErrors: 0,
      averageSuccessRate: 0,
      workers: [],
    },
    storage: {
      totalSize: storageStats?.totalSize ?? 0,
      averageSize: storageStats?.avgSize ?? 0,
      maxSize: storageStats?.maxSize ?? 0,
    },
    trends,
    timestamp: now.toISOString(),
  }
})
