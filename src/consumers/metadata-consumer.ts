import {
  Env,
  MetadataFetchJob,
  PolymarketMarket,
  MarketMetadataRecord,
  MarketEventRecord,
} from "../types";
import { DB_CONFIG } from "../config/database";

export async function metadataConsumer(
  batch: MessageBatch<MetadataFetchJob>,
  env: Env
): Promise<void> {
  try {
    // Step 1: Extract all unique clob_token_ids from the batch
    const tokenIds = Array.from(
      new Set(batch.messages.map((msg) => msg.body.clob_token_id))
    );

    console.log(`Processing ${tokenIds.length} unique token IDs`);

    // Step 2: Check KV cache to filter out tokens we already have
    const uncachedTokenIds: string[] = [];
    for (const tokenId of tokenIds) {
      const cached = await env.MARKET_CACHE.get(`market:${tokenId}`);
      if (!cached) {
        uncachedTokenIds.push(tokenId);
      }
    }

    console.log(`${uncachedTokenIds.length} tokens not in cache`);

    // If all tokens are cached, ack all messages and return
    if (uncachedTokenIds.length === 0) {
      for (const message of batch.messages) {
        message.ack();
      }
      return;
    }

    // Step 3: Make batch API request to Polymarket
    const markets = await fetchMarketsFromPolymarket(uncachedTokenIds, env);

    console.log(`Fetched ${markets.length} markets from Polymarket`);

    // Step 4: Insert into ClickHouse
    if (markets.length > 0) {
      await insertMarketsIntoClickHouse(markets, env);
    }

    // Step 5: Update KV cache
    for (const market of markets) {
      // Parse clob_token_ids array and cache each token
      const tokenIdArray = JSON.parse(market.clobTokenIds);
      for (const tokenId of tokenIdArray) {
        await env.MARKET_CACHE.put(
          `market:${tokenId}`,
          JSON.stringify(market),
          { expirationTtl: 86400 } // 24 hours
        );
      }
    }

    // Step 6: Acknowledge all messages
    for (const message of batch.messages) {
      message.ack();
    }
  } catch (error) {
    console.error("Error processing metadata batch:", error);
    // Retry all messages on failure
    for (const message of batch.messages) {
      message.retry();
    }
  }
}

async function fetchMarketsFromPolymarket(
  tokenIds: string[],
  env: Env
): Promise<PolymarketMarket[]> {
  // Build URL with multiple clob_token_ids parameters
  const params = tokenIds.map((id) => `clob_token_ids=${id}`).join("&");
  const url = `${env.GAMMA_API_URL}/markets?${params}`;

  console.log(`Fetching from Polymarket: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Polymarket API request failed: ${response.status} ${response.statusText}`
    );
  }

  const markets: PolymarketMarket[] = await response.json();
  return markets;
}

async function insertMarketsIntoClickHouse(
  markets: PolymarketMarket[],
  env: Env
): Promise<void> {
  const metadataRecords: MarketMetadataRecord[] = [];
  const eventRecords: MarketEventRecord[] = [];

  // Transform Polymarket data to ClickHouse records
  for (const market of markets) {
    metadataRecords.push({
      id: market.id,
      question: market.question,
      condition_id: market.conditionId,
      slug: market.slug,
      resolution_source: market.resolutionSource || "",
      end_date: market.endDate,
      start_date: market.startDate,
      created_at: market.createdAt,
      submitted_by: market.submitted_by,
      resolved_by: market.resolvedBy || "",
      restricted: market.restricted ? 1 : 0,
      enable_order_book: market.enableOrderBook ? 1 : 0,
      order_price_min_tick_size: market.orderPriceMinTickSize,
      order_min_size: market.orderMinSize,
      clob_token_ids: market.clobTokenIds,
      neg_risk: market.negRisk ? 1 : 0,
      neg_risk_market_id: market.negRiskMarketID || "",
      neg_risk_request_id: market.negRiskRequestID || "",
    });

    // Extract events
    for (const event of market.events) {
      eventRecords.push({
        event_id: event.id,
        market_id: market.id,
        title: event.title,
      });
    }
  }

  // Insert market_metadata
  if (metadataRecords.length > 0) {
    await insertIntoClickHouse(
      env,
      "market_metadata",
      metadataRecords,
      [
        "id",
        "question",
        "condition_id",
        "slug",
        "resolution_source",
        "end_date",
        "start_date",
        "created_at",
        "submitted_by",
        "resolved_by",
        "restricted",
        "enable_order_book",
        "order_price_min_tick_size",
        "order_min_size",
        "clob_token_ids",
        "neg_risk",
        "neg_risk_market_id",
        "neg_risk_request_id",
      ]
    );
    console.log(`Inserted ${metadataRecords.length} market metadata records`);
  }

  // Insert market_events
  if (eventRecords.length > 0) {
    await insertIntoClickHouse(
      env,
      "market_events",
      eventRecords,
      ["event_id", "market_id", "title"]
    );
    console.log(`Inserted ${eventRecords.length} event records`);
  }
}

async function insertIntoClickHouse(
  env: Env,
  table: string,
  records: unknown[],
  columns: string[]
): Promise<void> {
  // Build INSERT query with database name
  const columnsList = columns.join(", ");

  // Using JSONEachRow format for bulk insert
  const query = `INSERT INTO ${DB_CONFIG.DATABASE}.${table} (${columnsList}) FORMAT JSONEachRow`;

  // Convert records to NDJSON (newline-delimited JSON)
  const body = records.map((record) => JSON.stringify(record)).join("\n");

  // Append query parameter to URL and specify database
  const url = `${env.CLICKHOUSE_URL}?database=${DB_CONFIG.DATABASE}&query=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": env.CLICKHOUSE_USER || "default",
      "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
      "Content-Type": "application/x-ndjson",
    },
    body: body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ClickHouse insert failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  console.log(`Successfully inserted ${records.length} records into ${DB_CONFIG.DATABASE}.${table}`);
}
