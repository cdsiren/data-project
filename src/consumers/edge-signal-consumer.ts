// src/consumers/edge-signal-consumer.ts
// Queue consumer for graph edge signals

import type { Env } from "../types";
import type { GraphQueueMessage, EdgeSignalMessage, NegativeCycleMessage } from "../services/graph/types";
import { isEdgeSignalMessage, isNegativeCycleMessage } from "../services/graph/types";

/**
 * Edge signal row for ClickHouse insertion.
 */
interface EdgeSignalRow {
  market_a: string;
  market_b: string;
  edge_type: string;
  signal_source: string;
  user_id: string;
  strength: number;
  metadata: string;
  created_at: string;
  created_date: string;
}

/**
 * Process a batch of graph queue messages.
 *
 * Message types:
 * - edge_signal: Insert into graph_edge_signals table
 * - negative_cycle_detected: Log cycle and optionally trigger alerts
 *
 * @param batch - Message batch from the queue
 * @param env - Worker environment
 */
export async function edgeSignalConsumer(
  batch: MessageBatch<GraphQueueMessage>,
  env: Env
): Promise<void> {
  const edgeSignals: EdgeSignalRow[] = [];
  const cycleAlerts: NegativeCycleMessage[] = [];

  // Categorize messages
  for (const message of batch.messages) {
    const msg = message.body;

    if (isEdgeSignalMessage(msg)) {
      const now = new Date();
      edgeSignals.push({
        market_a: msg.market_a,
        market_b: msg.market_b,
        edge_type: msg.edge_type,
        signal_source: msg.signal_source,
        user_id: msg.user_id || "",
        strength: msg.strength,
        metadata: JSON.stringify(msg.metadata || {}),
        created_at: now.toISOString().replace("T", " ").replace("Z", ""),
        created_date: now.toISOString().split("T")[0],
      });
    } else if (isNegativeCycleMessage(msg)) {
      cycleAlerts.push(msg);
    }
  }

  // Process edge signals
  if (edgeSignals.length > 0) {
    await insertEdgeSignals(env, edgeSignals);
  }

  // Process cycle alerts (logging for now, could trigger webhooks)
  if (cycleAlerts.length > 0) {
    for (const alert of cycleAlerts) {
      console.log(
        `[EdgeSignalConsumer] Negative cycle detected: ${alert.cycle.join(" -> ")} ` +
        `(weight: ${alert.weight.toFixed(4)}, type: ${alert.opportunity_type})`
      );
    }
  }

  // Acknowledge all messages
  for (const message of batch.messages) {
    message.ack();
  }
}

/**
 * Insert edge signals into ClickHouse.
 */
async function insertEdgeSignals(
  env: Env,
  signals: EdgeSignalRow[]
): Promise<void> {
  if (signals.length === 0) return;

  const rows = signals.map(s => JSON.stringify(s)).join("\n");

  const query = "INSERT INTO trading_data.graph_edge_signals FORMAT JSONEachRow";

  try {
    const response = await fetch(
      `${env.CLICKHOUSE_URL}?query=${encodeURIComponent(query)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-ClickHouse-User": env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
        },
        body: rows,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ClickHouse insert failed: ${text}`);
    }

    console.log(`[EdgeSignalConsumer] Inserted ${signals.length} edge signals`);
  } catch (error) {
    console.error("[EdgeSignalConsumer] Error inserting signals:", error);
    throw error; // Will cause retry
  }
}

/**
 * Helper function to create an edge signal message.
 * Use this when emitting signals from other parts of the codebase.
 */
export function createEdgeSignalMessage(params: {
  market_a: string;
  market_b: string;
  edge_type: "correlation" | "hedge" | "causal" | "arbitrage";
  signal_source:
    | "user_analysis"
    | "user_trigger"
    | "trigger_fire"
    | "trigger_miss"
    | "cron_correlation"
    | "metadata_tag"
    | "bellman_ford_cycle";
  user_id?: string;
  strength?: number;
  metadata?: Record<string, unknown>;
}): EdgeSignalMessage {
  // Ensure canonical ordering (market_a < market_b) so signals for the same
  // pair aggregate correctly in ClickHouse GROUP BY (market_a, market_b)
  const [market_a, market_b] = params.market_a < params.market_b
    ? [params.market_a, params.market_b]
    : [params.market_b, params.market_a];

  return {
    type: "edge_signal",
    market_a,
    market_b,
    edge_type: params.edge_type,
    signal_source: params.signal_source,
    user_id: params.user_id || "",
    strength: params.strength ?? 1.0,
    metadata: params.metadata || {},
  };
}

/**
 * Helper to emit edge signals for all pairs of markets.
 * Used when a user creates an analysis or trigger involving multiple markets.
 */
export async function emitEdgeSignalsForMarkets(
  env: Env,
  marketIds: string[],
  edgeType: "correlation" | "hedge" | "causal",
  signalSource:
    | "user_analysis"
    | "user_trigger"
    | "trigger_fire"
    | "trigger_miss",
  userId: string,
  strength: number = 1.0,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (marketIds.length < 2) return;

  // Generate all pairs
  for (let i = 0; i < marketIds.length; i++) {
    for (let j = i + 1; j < marketIds.length; j++) {
      const message = createEdgeSignalMessage({
        market_a: marketIds[i],
        market_b: marketIds[j],
        edge_type: edgeType,
        signal_source: signalSource,
        user_id: userId,
        strength,
        metadata,
      });

      try {
        await env.GRAPH_QUEUE.send(message);
      } catch (error) {
        console.error(
          `[EdgeSignalConsumer] Error emitting edge signal for ${marketIds[i]} - ${marketIds[j]}:`,
          error
        );
      }
    }
  }
}
