// src/consumers/archive-consumer.ts
// Queue consumer for archive jobs - processes data archival to R2

import type { Env, ArchiveJob } from "../types";
import { processArchiveJob, ArchiveService } from "../services/archive-service";
import { ARCHIVE_TABLE_REGISTRY, getTablesForTrigger } from "../config/database";

/**
 * Process archive jobs from the archive queue
 * Handles both resolved market archives and aged data archives
 *
 * CRITICAL: Uses ctx.waitUntil() to ensure all archive operations complete
 * even if the worker response is returned early.
 */
export async function archiveConsumer(
  batch: MessageBatch<ArchiveJob>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  console.log(`[ArchiveConsumer] Processing batch of ${batch.messages.length} archive jobs`);

  // Process messages in parallel for better throughput
  const processingPromises = batch.messages.map(async (message) => {
    const job = message.body;

    try {
      const results = await processArchiveJob(job, env);

      // Check results for any failures
      const failures = results.filter((r) => !r.success);
      const successes = results.filter((r) => r.success);

      if (failures.length > 0) {
        const failedTables = failures.map((f) => `${f.database}.${f.table}: ${f.error || "unknown"}`);
        console.error(
          `[ArchiveConsumer] ${failures.length}/${results.length} archives failed for job:`,
          job,
          "\nFailed tables:",
          failedTables
        );

        // Retry if we haven't exceeded max attempts
        if (message.attempts < 3) {
          message.retry();
          return;
        }

        // Max retries exceeded with failures - send failed tables to DLQ
        // DO NOT ack - this would silently lose data
        console.error(
          `[ArchiveConsumer] CRITICAL: Max retries exceeded with ${failures.length} failed tables. ` +
          `Sending to dead letter queue for manual intervention.`,
          {
            job,
            attempts: message.attempts,
            failedTables,
            succeededTables: successes.map((s) => `${s.database}.${s.table}`),
          }
        );

        // Queue individual jobs for failed tables to DLQ for visibility
        // This ensures we have a record of exactly what failed
        try {
          const dlqMessages = failures.map((failure) => ({
            body: {
              originalJob: job,
              failedTable: `${failure.database}.${failure.table}`,
              error: failure.error,
              attempts: message.attempts,
              failedAt: new Date().toISOString(),
            },
          }));
          await env.DEAD_LETTER_QUEUE.sendBatch(dlqMessages);
        } catch (dlqError) {
          console.error("[ArchiveConsumer] Failed to send to DLQ:", dlqError);
        }

        // Now ack the original message since we've recorded the failures
        // The DLQ entries provide audit trail for manual retry
        message.ack();
        return;
      }

      // All tables succeeded - log summary and ack
      const totalRows = results.reduce((sum, r) => sum + r.rowsArchived, 0);
      if (totalRows > 0) {
        console.log(
          `[ArchiveConsumer] Successfully archived ${totalRows} rows for ${job.type} job` +
          (job.conditionId ? ` (market: ${job.conditionId.slice(0, 20)}...)` : "") +
          (job.table ? ` (table: ${job.table})` : "")
        );
      }

      message.ack();
    } catch (error) {
      console.error("[ArchiveConsumer] Job failed with exception:", error, job);

      // Retry up to 3 times (attempts counts from 1)
      if (message.attempts < 3) {
        message.retry();
      } else {
        // Max retries exceeded - send to DLQ for manual intervention
        console.error(
          "[ArchiveConsumer] CRITICAL: Max retries exceeded. Sending to dead letter queue.",
          { job, attempts: message.attempts, error: String(error) }
        );

        try {
          await env.DEAD_LETTER_QUEUE.send({
            originalJob: job,
            error: String(error),
            attempts: message.attempts,
            failedAt: new Date().toISOString(),
          });
        } catch (dlqError) {
          console.error("[ArchiveConsumer] Failed to send to DLQ:", dlqError);
        }

        // Ack after recording to DLQ
        message.ack();
      }
    }
  });

  // CRITICAL: Await all processing before returning
  // Queue consumers must complete all message.ack()/retry() calls
  // before the handler returns, otherwise acknowledgments may be lost
  await Promise.all(processingPromises);
}

/**
 * Queue all aged data archive jobs for daily cron
 * Called by the 2 AM UTC daily cron
 */
export async function queueDailyArchiveJobs(env: Env): Promise<number> {
  const queue = env.ARCHIVE_QUEUE;
  let jobsQueued = 0;

  // Calculate cutoff date (90 days ago)
  const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const cutoffDateStr = cutoffDate.toISOString();

  // Get all tables that use aged trigger
  const agedTables = getTablesForTrigger("aged");
  const blockRangeTables = getTablesForTrigger("block_range");

  // Queue jobs for aged tables
  for (const tableConfig of agedTables) {
    const job: ArchiveJob = {
      type: "aged",
      database: tableConfig.database,
      table: tableConfig.table,
      cutoffDate: cutoffDateStr,
    };

    await queue.send(job);
    jobsQueued++;
    console.log(`[ArchiveConsumer] Queued aged archive job for ${tableConfig.database}.${tableConfig.table}`);
  }

  // Queue jobs for block_range tables
  for (const tableConfig of blockRangeTables) {
    const job: ArchiveJob = {
      type: "aged", // Uses same processing path
      database: tableConfig.database,
      table: tableConfig.table,
      cutoffDate: cutoffDateStr,
    };

    await queue.send(job);
    jobsQueued++;
    console.log(`[ArchiveConsumer] Queued block_range archive job for ${tableConfig.database}.${tableConfig.table}`);
  }

  console.log(`[ArchiveConsumer] Queued ${jobsQueued} daily archive jobs`);
  return jobsQueued;
}

/**
 * Run backfill for all archivable resolved markets
 * One-time operation to catch up on historical data
 */
export async function runArchiveBackfill(env: Env): Promise<{
  marketsQueued: number;
  agedTablesQueued: number;
}> {
  const service = new ArchiveService(env);
  const queue = env.ARCHIVE_QUEUE;

  // Get all markets ready for archival
  const archivableMarkets = await service.getArchivableMarkets();
  console.log(`[ArchiveBackfill] Found ${archivableMarkets.length} markets ready for archival`);

  // Queue resolved market archives
  for (const conditionId of archivableMarkets) {
    await queue.send({
      type: "resolved",
      conditionId,
    });
  }

  // Queue aged data archives for all tables
  const agedJobsQueued = await queueDailyArchiveJobs(env);

  return {
    marketsQueued: archivableMarkets.length,
    agedTablesQueued: agedJobsQueued,
  };
}
