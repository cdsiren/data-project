// src/services/cron-error-tracker.ts
// Tracks cron job errors in KV for observability
// Enables external monitoring via /cron/health endpoint

/**
 * Structure of a cron error entry stored in KV
 */
export interface CronError {
  timestamp: string;
  cron_pattern: string;
  job_name: string;
  error_message: string;
  stack_trace?: string;
}

/**
 * Health check response for cron jobs
 */
export interface CronHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  recent_errors: CronError[];
  error_count: number;
  oldest_error?: string;
  newest_error?: string;
}

/**
 * Service for tracking cron job errors in KV storage.
 * Errors are stored with TTL for automatic cleanup.
 */
export class CronErrorTracker {
  private readonly KV_PREFIX = "cron_error:";
  private readonly TTL_SECONDS = 86400; // 24 hours

  constructor(private kv: KVNamespace) {}

  /**
   * Record a cron job error to KV storage
   */
  async recordError(
    cronPattern: string,
    jobName: string,
    error: unknown
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const errorKey = `${this.KV_PREFIX}${timestamp}_${jobName}`;

    const cronError: CronError = {
      timestamp,
      cron_pattern: cronPattern,
      job_name: jobName,
      error_message: error instanceof Error ? error.message : String(error),
      stack_trace: error instanceof Error ? error.stack : undefined,
    };

    try {
      await this.kv.put(errorKey, JSON.stringify(cronError), {
        expirationTtl: this.TTL_SECONDS,
      });
      console.error(
        `[CronErrorTracker] Recorded error for ${jobName} (${cronPattern}):`,
        cronError.error_message
      );
    } catch (kvError) {
      // Don't let KV failures mask the original error
      console.error(
        `[CronErrorTracker] Failed to record error to KV:`,
        kvError
      );
    }
  }

  /**
   * Get all recent cron errors for health check
   * Returns errors sorted by timestamp (newest first)
   */
  async getRecentErrors(limit: number = 20): Promise<CronError[]> {
    const list = await this.kv.list({ prefix: this.KV_PREFIX });
    const errors: CronError[] = [];

    // Fetch all error entries (limited by list size)
    const keysToFetch = list.keys.slice(0, limit);

    const results = await Promise.all(
      keysToFetch.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        try {
          return JSON.parse(data) as CronError;
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) errors.push(result);
    }

    // Sort by timestamp descending (newest first)
    return errors.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * Get health status of cron jobs
   * Considers system unhealthy if >5 errors in last 24h
   */
  async getHealthStatus(): Promise<CronHealthStatus> {
    const errors = await this.getRecentErrors(50);

    let status: "healthy" | "degraded" | "unhealthy";
    if (errors.length === 0) {
      status = "healthy";
    } else if (errors.length <= 5) {
      status = "degraded";
    } else {
      status = "unhealthy";
    }

    return {
      status,
      recent_errors: errors.slice(0, 10), // Return top 10 for response
      error_count: errors.length,
      oldest_error: errors.length > 0 ? errors[errors.length - 1].timestamp : undefined,
      newest_error: errors.length > 0 ? errors[0].timestamp : undefined,
    };
  }

  /**
   * Clear all cron errors (for testing/admin purposes)
   */
  async clearErrors(): Promise<number> {
    const list = await this.kv.list({ prefix: this.KV_PREFIX });
    let cleared = 0;

    for (const key of list.keys) {
      await this.kv.delete(key.name);
      cleared++;
    }

    return cleared;
  }
}

/**
 * Wrapper function to execute a cron job with error tracking.
 * Use this to wrap cron job handlers for automatic error persistence.
 *
 * Example usage:
 * ```typescript
 * ctx.waitUntil(
 *   withCronErrorTracking(
 *     env.MARKET_CACHE,
 *     "0 * * * *",  // hourly cron pattern
 *     "my-job",
 *     async () => { ... }
 *   )
 * );
 * ```
 */
export async function withCronErrorTracking(
  kv: KVNamespace,
  cronPattern: string,
  jobName: string,
  handler: () => Promise<void>
): Promise<void> {
  const tracker = new CronErrorTracker(kv);

  try {
    await handler();
  } catch (error) {
    await tracker.recordError(cronPattern, jobName, error);
    // Re-throw to maintain original behavior (error is still logged to console)
    throw error;
  }
}
