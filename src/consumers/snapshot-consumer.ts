import { Env, OrderbookSnapshot } from '../types';

export async function snapshotConsumer(batch: MessageBatch<OrderbookSnapshot>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const snapshot = message.body;

    try {
      // TODO: Insert orderbook snapshot into ClickHouse
      console.log('TODO: Insert snapshot into ClickHouse', {
        condition_id: snapshot.condition_id,
        token_id: snapshot.token_id,
        timestamp: snapshot.timestamp,
        bids_count: snapshot.bids.length,
        asks_count: snapshot.asks.length,
        best_bid: snapshot.best_bid,
        best_ask: snapshot.best_ask,
        spread: snapshot.spread
      });

      // TODO: Write snapshot to R2 as Parquet file for cold storage
      // File naming convention: {condition_id}/{token_id}/{timestamp}.parquet
      const r2Key = `${snapshot.condition_id}/${snapshot.token_id}/${snapshot.timestamp}.json`;
      console.log('TODO: Write to R2 bucket:', r2Key);

      // Stub: Store as JSON for now (replace with Parquet later)
      // await env.ORDERBOOK_STORAGE.put(r2Key, JSON.stringify(snapshot));

      // Acknowledge message
      message.ack();
    } catch (error) {
      console.error('Error processing snapshot:', error);
      // Retry by not acking the message
      message.retry();
    }
  }
}
