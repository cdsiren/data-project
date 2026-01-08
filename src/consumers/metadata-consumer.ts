import { Env, MetadataFetchJob } from '../types';

export async function metadataConsumer(batch: MessageBatch<MetadataFetchJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;

    try {
      // Fetch market metadata from Gamma API
      const url = `${env.GAMMA_API_URL}/markets?condition_id=${job.condition_id}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Gamma API request failed: ${response.status}`);
      }

      const marketData = await response.json();

      // Store result in KV cache
      const cacheKey = `market:${job.condition_id}`;
      await env.MARKET_CACHE.put(cacheKey, JSON.stringify(marketData), {
        expirationTtl: 86400 // 24 hours
      });

      // TODO: Insert market metadata into ClickHouse
      console.log('TODO: Insert into ClickHouse', {
        condition_id: job.condition_id,
        market_data: marketData
      });

      // Acknowledge message
      message.ack();
    } catch (error) {
      console.error('Error processing metadata job:', error);
      // Retry by not acking the message
      message.retry();
    }
  }
}
