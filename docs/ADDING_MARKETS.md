# Adding New Markets to the Trading Data Infrastructure

This guide explains how to add support for a new market (exchange) to the multi-market trading data framework. The architecture follows adapter patterns from Nautilus Trader and CCXT.

## Overview

Each market requires implementing several interfaces:
- **IMarketConnector** - Main adapter orchestrating all components
- **IWebSocketHandler** - Parses market-specific WebSocket messages
- **IMetadataProvider** - Fetches instrument metadata from market APIs
- **IShardingStrategy** - Determines how instruments are distributed across Durable Objects

## Directory Structure

Create a new directory under `/src/adapters/{market_name}/`:

```
src/adapters/kalshi/
├── connector.ts          # KalshiConnector implements IMarketConnector
├── websocket-handler.ts  # KalshiWebSocketHandler implements IWebSocketHandler
├── metadata-provider.ts  # KalshiMetadataProvider implements IMetadataProvider
├── sharding-strategy.ts  # KalshiShardingStrategy implements IShardingStrategy
├── types.ts              # Market-specific type definitions
├── normalizers.ts        # Functions to convert market types → canonical types
└── index.ts              # Re-exports
```

## Step-by-Step Implementation

### Step 1: Define Market-Specific Types

Create `types.ts` with the market's raw WebSocket and API response types:

```typescript
// src/adapters/kalshi/types.ts

/**
 * Kalshi WebSocket message types
 */
export interface KalshiOrderbookSnapshot {
  type: "orderbook_snapshot";
  market_id: string;
  ts: number;
  yes: Array<[number, number]>;  // [price_cents, quantity]
  no: Array<[number, number]>;
}

export interface KalshiOrderbookDelta {
  type: "orderbook_delta";
  market_id: string;
  ts: number;
  side: "yes" | "no";
  price: number;
  delta: number;
}

export interface KalshiTrade {
  type: "trade";
  market_id: string;
  ts: number;
  side: "yes" | "no";
  price: number;
  count: number;
  taker_side: "buy" | "sell";
}

export type KalshiWSEvent =
  | KalshiOrderbookSnapshot
  | KalshiOrderbookDelta
  | KalshiTrade;

/**
 * Kalshi API response types
 */
export interface KalshiMarket {
  ticker: string;
  title: string;
  status: "open" | "closed" | "settled";
  close_time: string;
  result?: "yes" | "no";
  // ... other fields
}
```

### Step 2: Create Normalizer Functions

Create `normalizers.ts` to convert market-specific types to canonical types:

```typescript
// src/adapters/kalshi/normalizers.ts

import type { BBOSnapshot, TradeTick } from "../../core/orderbook";
import type { KalshiOrderbookSnapshot, KalshiTrade } from "./types";

/**
 * Convert Kalshi orderbook snapshot to canonical BBO
 */
export function normalizeOrderbook(
  snapshot: KalshiOrderbookSnapshot,
  ingestionTs: number
): BBOSnapshot {
  // Find best bid (highest yes bid or lowest no ask)
  const bestBid = snapshot.yes.length > 0
    ? Math.max(...snapshot.yes.map(([p]) => p)) / 100  // Convert cents to dollars
    : null;

  const bestAsk = snapshot.no.length > 0
    ? (100 - Math.min(...snapshot.no.map(([p]) => p))) / 100
    : null;

  return {
    market_source: "kalshi",
    asset_id: snapshot.market_id,
    best_bid: bestBid,
    best_ask: bestAsk,
    bid_size: bestBid !== null
      ? snapshot.yes.find(([p]) => p / 100 === bestBid)?.[1] ?? null
      : null,
    ask_size: bestAsk !== null
      ? snapshot.no.find(([p]) => (100 - p) / 100 === bestAsk)?.[1] ?? null
      : null,
    mid_price: bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : null,
    spread_bps: bestBid !== null && bestAsk !== null && bestBid > 0
      ? ((bestAsk - bestBid) / bestBid) * 10000
      : null,
    source_ts: snapshot.ts,
    ingestion_ts: ingestionTs,
  };
}

/**
 * Convert Kalshi trade to canonical TradeTick
 */
export function normalizeTrade(
  trade: KalshiTrade,
  ingestionTs: number
): TradeTick {
  return {
    market_source: "kalshi",
    asset_id: trade.market_id,
    price: trade.price / 100,
    size: trade.count,
    side: trade.taker_side === "buy" ? "BUY" : "SELL",
    source_ts: trade.ts,
    ingestion_ts: ingestionTs,
  };
}
```

### Step 3: Implement WebSocket Handler

Create `websocket-handler.ts`:

```typescript
// src/adapters/kalshi/websocket-handler.ts

import { BaseWebSocketHandler, type WebSocketConfig, type ParsedMessage } from "../base/websocket-handler";
import type { InstrumentID } from "../../core/instrument";
import { buildInstrumentID } from "../../core/instrument";
import type { KalshiWSEvent } from "./types";

export class KalshiWebSocketHandler extends BaseWebSocketHandler {
  readonly marketSource = "kalshi" as const;

  getConfig(): WebSocketConfig {
    return {
      url: "wss://trading-api.kalshi.com/v1/ws",
      heartbeatIntervalMs: 10000,
      reconnectBaseDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      connectionTimeoutMs: 10000,
      maxSubscriptionsPerConnection: 100,
    };
  }

  buildSubscriptionMessage(
    instruments: string[],
    channels: ("book" | "trades" | "ticker")[]
  ): unknown {
    return {
      type: "subscribe",
      markets: instruments,
      channels: channels.map(c => c === "book" ? "orderbook" : c),
    };
  }

  buildUnsubscriptionMessage(instruments: string[]): unknown {
    return {
      type: "unsubscribe",
      markets: instruments,
    };
  }

  parseMessage(rawMessage: string, ingestionTs: number): ParsedMessage[] {
    try {
      const parsed = JSON.parse(rawMessage) as KalshiWSEvent;

      if (parsed.type === "orderbook_snapshot" || parsed.type === "orderbook_delta") {
        const instrumentId = buildInstrumentID("kalshi", "BINARY_OPTION", parsed.market_id);
        return [{
          type: "book",
          instrument: instrumentId,
          data: parsed,
          rawTimestamp: parsed.ts,
        }];
      }

      if (parsed.type === "trade") {
        const instrumentId = buildInstrumentID("kalshi", "BINARY_OPTION", parsed.market_id);
        return [{
          type: "trade",
          instrument: instrumentId,
          data: parsed,
          rawTimestamp: parsed.ts,
        }];
      }

      return [];
    } catch {
      return [];
    }
  }

  buildHeartbeatMessage(): string {
    return JSON.stringify({ type: "ping" });
  }

  extractAssetId(rawMessage: string): string | null {
    try {
      const parsed = JSON.parse(rawMessage);
      return parsed.market_id ?? null;
    } catch {
      return null;
    }
  }
}
```

### Step 4: Implement Metadata Provider

Create `metadata-provider.ts`:

```typescript
// src/adapters/kalshi/metadata-provider.ts

import type { IMetadataProvider, MarketMetadata, MetadataFilter } from "../base/metadata-provider";
import type { MarketSource } from "../../core/enums";
import type { KalshiMarket } from "./types";

export class KalshiMetadataProvider implements IMetadataProvider {
  readonly marketSource: MarketSource = "kalshi";

  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl: string, apiKey?: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  async fetchMarkets(filter?: MetadataFilter): Promise<MarketMetadata[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.apiUrl}/markets`, { headers });
    if (!response.ok) {
      throw new Error(`Kalshi API error: ${response.status}`);
    }

    const data = await response.json() as { markets: KalshiMarket[] };

    return data.markets
      .filter(m => !filter?.activeOnly || m.status === "open")
      .map(m => this.normalizeMetadata(m));
  }

  async fetchMarket(nativeId: string): Promise<MarketMetadata | null> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.apiUrl}/markets/${nativeId}`, { headers });
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Kalshi API error: ${response.status}`);
    }

    const market = await response.json() as KalshiMarket;
    return this.normalizeMetadata(market);
  }

  private normalizeMetadata(market: KalshiMarket): MarketMetadata {
    return {
      market_source: "kalshi",
      native_id: market.ticker,
      symbol: market.ticker,
      name: market.title,
      instrument_type: "BINARY_OPTION",
      status: market.status === "open" ? "ACTIVE" :
              market.status === "settled" ? "RESOLVED" : "INACTIVE",
      expiry_time: market.close_time ? new Date(market.close_time).getTime() : undefined,
      tick_size: 0.01,  // Kalshi uses 1 cent tick size
      extensions: {
        result: market.result,
      },
    };
  }

  supportsStreaming(): boolean {
    return false;  // Kalshi doesn't have streaming metadata
  }
}
```

### Step 5: Implement Sharding Strategy

Create `sharding-strategy.ts`:

```typescript
// src/adapters/kalshi/sharding-strategy.ts

import type { IShardingStrategy } from "../base/sharding-strategy";
import type { InstrumentID } from "../../core/instrument";
import { parseInstrumentID } from "../../core/instrument";

/**
 * Kalshi sharding strategy
 *
 * Kalshi markets are independent (no YES/NO pairs like Polymarket),
 * so we use simple hash-based sharding.
 */
export class KalshiShardingStrategy implements IShardingStrategy {
  readonly marketSource = "kalshi" as const;

  getShardId(instrument: InstrumentID, shardCount: number): string {
    const { nativeId } = parseInstrumentID(instrument);
    const hash = this.simpleHash(nativeId);
    const shardIndex = hash % shardCount;
    return `kalshi-shard-${shardIndex}`;
  }

  getRelatedInstruments(_instrument: InstrumentID): InstrumentID[] {
    // Kalshi markets are independent, no related instruments
    return [];
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;  // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
}
```

### Step 6: Create the Main Connector

Create `connector.ts`:

```typescript
// src/adapters/kalshi/connector.ts

import type { IMarketConnector, SubscriptionRequest, SubscriptionResult } from "../base/connector";
import type { IWebSocketHandler } from "../base/websocket-handler";
import type { IMetadataProvider } from "../base/metadata-provider";
import type { IShardingStrategy } from "../base/sharding-strategy";
import type { MarketSource, MarketType } from "../../core/enums";
import { KalshiWebSocketHandler } from "./websocket-handler";
import { KalshiMetadataProvider } from "./metadata-provider";
import { KalshiShardingStrategy } from "./sharding-strategy";

export interface KalshiConfig {
  apiUrl: string;
  wsUrl: string;
  apiKey?: string;
}

export class KalshiConnector implements IMarketConnector {
  readonly marketSource: MarketSource = "kalshi";
  readonly marketType: MarketType = "prediction";

  private config: KalshiConfig;
  private wsHandler: KalshiWebSocketHandler;
  private metadataProvider: KalshiMetadataProvider;
  private shardingStrategy: KalshiShardingStrategy;
  private initialized = false;

  constructor(config: KalshiConfig) {
    this.config = config;
    this.wsHandler = new KalshiWebSocketHandler();
    this.metadataProvider = new KalshiMetadataProvider(config.apiUrl, config.apiKey);
    this.shardingStrategy = new KalshiShardingStrategy();
  }

  async initialize(env: Record<string, unknown>): Promise<void> {
    // Perform any async initialization (auth, prefetch, etc.)
    this.initialized = true;
  }

  getWebSocketHandler(): IWebSocketHandler {
    return this.wsHandler;
  }

  getMetadataProvider(): IMetadataProvider {
    return this.metadataProvider;
  }

  getShardingStrategy(): IShardingStrategy {
    return this.shardingStrategy;
  }

  async subscribe(request: SubscriptionRequest): Promise<SubscriptionResult> {
    // Validate subscription request
    if (!this.initialized) {
      throw new Error("Connector not initialized");
    }

    return {
      success: true,
      subscribedInstruments: request.instruments,
      errors: [],
    };
  }

  async unsubscribe(instruments: string[]): Promise<void> {
    // Handle unsubscription
  }
}
```

### Step 7: Create Index File

Create `index.ts`:

```typescript
// src/adapters/kalshi/index.ts

export * from "./connector";
export * from "./websocket-handler";
export * from "./metadata-provider";
export * from "./sharding-strategy";
export * from "./types";
export * from "./normalizers";
```

### Step 8: Register the Adapter

Update the adapter registry in `src/adapters/registry.ts`:

```typescript
import { KalshiConnector } from "./kalshi";

// In initializeRegistry():
registry.register("kalshi", (config) => new KalshiConnector({
  apiUrl: config.metadata_api_url,
  wsUrl: config.ws_url,
  apiKey: env.KALSHI_API_KEY,
}));
```

### Step 9: Add Market Configuration

Update `wrangler.toml` to enable the market:

```toml
MARKETS_CONFIG = '''
[
  {
    "market_source": "kalshi",
    "market_type": "prediction",
    "enabled": true,
    "ws_url": "wss://trading-api.kalshi.com/v1/ws",
    "metadata_api_url": "https://api.kalshi.com/v1",
    "adapter_class": "KalshiConnector",
    "config": {
      "max_instruments_per_ws": 100,
      "requires_auth": true
    }
  }
]
'''
```

Add any required secrets:
```bash
wrangler secret put KALSHI_API_KEY
```

### Step 10: Update Core Enums

Add the new market source to `src/core/enums.ts`:

```typescript
export type MarketSource = "polymarket" | "kalshi" | "uniswap";
```

## Database Considerations

The database schema already includes `market_source` column. Data from the new market will automatically be partitioned correctly if you:

1. Include `market_source` in all emitted types (BBOSnapshot, TradeTick, etc.)
2. The normalizer functions set the correct `market_source` value

## Testing Checklist

- [ ] WebSocket handler correctly parses all message types
- [ ] Normalizers produce valid canonical types
- [ ] Metadata provider fetches and normalizes instruments
- [ ] Sharding strategy distributes instruments correctly
- [ ] Connector initializes and subscribes successfully
- [ ] Data flows to ClickHouse with correct `market_source`
- [ ] Triggers evaluate correctly for the new market
- [ ] Existing Polymarket functionality unaffected

## Trigger Considerations

If the market has specific trigger types (like Polymarket's ARBITRAGE_BUY/SELL):

1. Create a market-specific trigger evaluator in `/src/services/trigger-evaluator/`
2. Extend `BaseTriggerEvaluator` and add custom trigger types
3. Update the factory function in `prediction-evaluator.ts` to return the correct evaluator

## Common Patterns

### Binary Prediction Markets (Polymarket, Kalshi)
- YES/NO token pairs that sum to $1
- ARBITRAGE_BUY/SELL triggers for mispricing detection
- Use `PredictionMarketTriggerEvaluator`

### DEX/AMM (Uniswap, Curve)
- Liquidity pool based pricing
- Impermanent loss calculations
- Custom sharding for pool pairs

### Traditional Exchanges
- Order book based
- Multiple order types
- Position/margin tracking

## Reference Implementation

See `/src/adapters/polymarket/` for a complete reference implementation.
