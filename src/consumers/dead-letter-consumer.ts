// src/consumers/dead-letter-consumer.ts
// Stores failed messages to ClickHouse for analysis and potential recovery

import type { Env, DeadLetterMessage } from "../types";
import { getFullTableName } from "../config/database";
import { buildAsyncInsertUrl, buildClickHouseHeaders } from "../services/clickhouse-client";

/**
 * Dead Letter Queue Consumer
 *
 * Stores failed messages from all queues for:
 * 1. Debugging and root cause analysis
 * 2. Potential manual recovery
 * 3. Monitoring and alerting on failure rates
 */
export async function deadLetterConsumer(
  batch: MessageBatch<DeadLetterMessage>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  console.warn(
    `[DLQ] Processing ${batch.messages.length} failed messages`
  );

  const rows = batch.messages.map((m) => {
    const msg = m.body;
    return {
      original_queue: msg.original_queue,
      message_type: msg.message_type,
      payload: JSON.stringify(msg.payload),
      error: msg.error,
      failed_at: msg.failed_at,
      retry_count: msg.retry_count,
      received_at: new Date().toISOString().replace("T", " ").slice(0, 23),
    };
  });

  // Log summary by queue for monitoring
  const byQueue = rows.reduce((acc, r) => {
    acc[r.original_queue] = (acc[r.original_queue] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.warn(`[DLQ] Failed messages by queue:`, JSON.stringify(byQueue));

  const body = rows.map((r) => JSON.stringify(r)).join("\n");

  try {
    const response = await fetch(
      buildAsyncInsertUrl(env.CLICKHOUSE_URL, getFullTableName("DEAD_LETTER")),
      {
        method: "POST",
        headers: buildClickHouseHeaders(env.CLICKHOUSE_USER, env.CLICKHOUSE_TOKEN),
        body,
      }
    );

    if (!response.ok) {
      // If we can't even store to DLQ, log the error but don't retry
      // (would cause infinite loop)
      console.error(
        `[DLQ] ClickHouse insert failed: ${await response.text()}`
      );
    }

    // Always ack DLQ messages - we've done our best to store them
    for (const msg of batch.messages) msg.ack();

    console.warn(
      `[DLQ] Stored ${batch.messages.length} failed messages for analysis`
    );
  } catch (error) {
    console.error("[DLQ] Failed to store dead letter messages:", error);
    // Still ack to prevent infinite loop
    for (const msg of batch.messages) msg.ack();
  }
}
