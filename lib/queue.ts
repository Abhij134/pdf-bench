/**
 * lib/queue.ts
 * BullMQ queue definitions.
 *
 * Queues:
 *   - extraction-queue: one job per (documentId, engine) pair
 *   - metric-queue: triggered after all engines finish for a BenchmarkRun
 *
 * Workers are NOT started inside Next.js — run them as separate processes
 * or use a worker server. For this system, Python workers handle extraction;
 * metric computation is triggered via HTTP from the API route.
 */
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
})

export const extractionQueue = new Queue('extraction-queue', { connection })
export const metricQueue = new Queue('metric-queue', { connection })

export { connection as redisConnection }
