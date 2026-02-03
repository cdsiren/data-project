# Public API Roadmap

> Distilled implementation guide for Indication's public API, dashboard, and PLG monetization strategy.

## Overview

Build a tiered public API with dashboard for trigger registration, supporting both developers and traders through a PLG (product-led growth) conversion model.

**Target**: $5K MRR Day 1, $1.1M ARR Year 1

---

## Tier Structure

| Tier | Price | Latency | Key Features |
|------|-------|---------|--------------|
| Sandbox | Free | 1000ms | 5 basic triggers, 7d history, 1K export rows |
| Hobby | $29/mo | 750ms | 5 triggers, 14d history, 10K export rows |
| Builder | $99/mo | 500ms | 12 triggers + arbitrage, batch APIs, fee calcs |
| **Startup** | **$299/mo** | **Real-time** | All triggers + L2 sizing, multi-outcome arb |
| Scale | $999/mo | Real-time | Unlimited, private shards, priority support |
| Enterprise | $3K+/mo | Real-time | Custom retention, dedicated infrastructure |

**Key Insight**: Startup+ gets real-time (0ms delay). Lower tiers have artificial delays to create upgrade pressure.

---

## API Endpoints Summary

### Market Data (All Tiers)
```
GET /api/v1/markets
GET /api/v1/markets/{asset_id}
GET /api/v1/markets/{asset_id}/orderbook
GET /api/v1/markets/{asset_id}/ticker
GET /api/v1/markets/{asset_id}/trades
GET /api/v1/tickers?asset_ids=...
GET /api/v1/ohlc/{asset_id}
```

### Batch APIs (Builder+)
```
POST /api/v1/batch/markets
POST /api/v1/batch/orderbooks
POST /api/v1/batch/tickers
POST /api/v1/batch/arbitrage-scan
```

### Market Helpers (All Tiers)
```
GET /api/v1/markets/{asset_id}/counterparts    # Find YES/NO pairs
GET /api/v1/markets/{condition_id}/outcomes    # All outcomes for N-way markets
```

### Triggers
```
GET  /api/v1/triggers                          # User's triggers
POST /api/v1/triggers                          # Create trigger
GET  /api/v1/triggers/{id}                     # Trigger details
PUT  /api/v1/triggers/{id}                     # Update trigger
DELETE /api/v1/triggers/{id}                   # Delete trigger
POST /api/v1/triggers/{id}/test                # Dry-run (Builder+)
```

### System Triggers
```
GET  /api/v1/triggers/system                   # Pre-configured triggers
GET  /api/v1/triggers/system/{id}              # System trigger details
POST /api/v1/triggers/system/{id}/subscribe    # Subscribe to system trigger
GET  /api/v1/triggers/system/subscriptions     # User's subscriptions
```

### Real-Time (SSE)
```
GET /api/v1/triggers/events/sse               # Server-Sent Events stream
GET /api/v1/triggers/events                   # REST fallback (buffered)
GET /api/v1/triggers/missed-opportunities     # PLG conversion endpoint
```

### Leaderboards (Builder+)
```
GET /api/v1/leaderboard/makers
GET /api/v1/leaderboard/takers
GET /api/v1/leaderboard/traders
GET /api/v1/leaderboard/arbitrage
```

### Account
```
GET /api/v1/account
GET /api/v1/account/usage
GET /api/v1/account/features
GET /api/v1/tiers
```

---

## Trigger Types by Tier

### Sandbox/Hobby (5 Basic)
- PRICE_ABOVE, PRICE_BELOW
- SPREAD_NARROW, SPREAD_WIDE
- STALE_QUOTE

### Builder (12 Generic + Binary Arbitrage)
- All Basic +
- IMBALANCE_BID, IMBALANCE_ASK
- SIZE_SPIKE, LARGE_FILL, QUOTE_VELOCITY
- **ARBITRAGE_BUY** (with fee-adjusted sizing)
- **ARBITRAGE_SELL** (with fee-adjusted sizing)

### Startup+ (All 21)
- All Builder +
- PRICE_MOVE, CROSSED_BOOK, EMPTY_BOOK
- VOLATILITY_SPIKE, MICROPRICE_DIVERGENCE
- IMBALANCE_SHIFT, MID_PRICE_TREND
- **MULTI_OUTCOME_ARBITRAGE** (with L2-aware sizing)

---

## Arbitrage Trigger Response

### Builder Tier (Fee-Adjusted)
```json
{
  "trigger_type": "ARBITRAGE_BUY",
  "gross_profit_bps": 200,
  "recommended_size": 1500.00,
  "fees": {
    "maker_fee_bps": 0,
    "taker_fee_bps": 100,
    "estimated_fee": 30.00,
    "net_profit_bps": 100,
    "net_expected_profit": 15.30
  }
}
```

### Startup Tier (L2-Aware)
```json
{
  "l2_analysis": {
    "depth_levels_used": 5,
    "optimal_size": 1200.00,
    "slippage_at_optimal": 0.15,
    "vwap_price": 0.521
  },
  "execution": {
    "urgency": "HIGH",
    "time_to_stale_ms": 500,
    "recommended_order_type": "IOC"
  }
}
```

---

## Authentication & Dashboard

### Clerk Integration

**Why Clerk**: Better DX, built-in React components, native Stripe integration, free tier includes 10K MAU.

**Setup**:
```bash
pnpm add @clerk/clerk-react @clerk/backend
```

**Environment**:
```toml
# wrangler.toml
[vars]
CLERK_PUBLISHABLE_KEY = "pk_test_..."

[[secrets]]
name = "CLERK_SECRET_KEY"
```

### Dashboard Features
1. User signup/login (Clerk hosted UI)
2. API key management (create, revoke, view usage)
3. **Trigger registration UI** (visual builder)
4. Webhook configuration
5. Billing management (Stripe portal)
6. Usage analytics and quota display

### Billing Flow
1. User signs up via Clerk
2. User upgrades via Stripe checkout
3. Stripe webhook fires → update Clerk user metadata with new tier
4. API reads tier from Clerk JWT on each request

---

## Implementation Phases

### Phase 1: Core Tier Infrastructure
- [ ] Update `src/schemas/common.ts` with 6-tier UserTier enum
- [ ] Update `src/middleware/rate-limiter.ts` with tier limits
- [ ] Create `src/middleware/latency-tier.ts` (1000/750/500/0ms)
- [ ] Create `src/services/tier-gating.ts` for feature flags

### Phase 2: Clerk/Auth Integration
- [ ] Create `src/middleware/clerk-auth.ts` for JWT validation
- [ ] Create `app/src/lib/clerk.ts` for dashboard config
- [ ] Add ClerkProvider to `app/src/main.tsx`
- [ ] Set up Clerk → Stripe webhook

### Phase 3: Dashboard Core
- [ ] Create dashboard layout with navigation
- [ ] Implement API key management UI
- [ ] Create usage display component
- [ ] Implement billing page with Stripe

### Phase 4: Dashboard Trigger Registration
- [ ] Create TriggerBuilder component
- [ ] Create TriggerList component
- [ ] Create SystemTriggerList component
- [ ] Add tier-based trigger filtering

### Phase 5: Fee & L2 Services
- [ ] Create `src/services/fee-calculator.ts`
- [ ] Create `src/services/l2-analyzer.ts`
- [ ] Integrate into orderbook-manager

### Phase 6: Trigger Gating
- [ ] Update triggers.ts with tier requirements
- [ ] Create `/triggers/types` documentation endpoint
- [ ] Add upgrade previews to blocked triggers

### Phase 7: Batch APIs
- [ ] Create `src/routes/batch.ts`
- [ ] Implement batch/markets, batch/orderbooks, batch/tickers
- [ ] Implement batch/arbitrage-scan

### Phase 8: Market Helpers & System Triggers
- [ ] Add counterparts endpoint
- [ ] Add outcomes endpoint
- [ ] Create system triggers CRUD
- [ ] Seed initial system triggers

### Phase 9: Maker/Taker Pipeline
- [ ] Add maker/taker to TradeTick
- [ ] Run database migrations
- [ ] Create leaderboard endpoints

### Phase 10: PLG Features
- [ ] Create missed-opportunities endpoint
- [ ] Add latency headers ("Startup+ saw this Xms ago")
- [ ] Add feature upgrade CTAs

### Phase 11: Webhook Management
- [ ] Create webhook CRUD endpoints
- [ ] Add dashboard webhook UI
- [ ] Implement test webhook endpoint

---

## Database Changes

```sql
-- Add maker/taker to trade_ticks
ALTER TABLE trading_data.trade_ticks
ADD COLUMN IF NOT EXISTS maker String DEFAULT '',
ADD COLUMN IF NOT EXISTS taker String DEFAULT '';

-- Makers aggregation table
CREATE TABLE IF NOT EXISTS trading_data.makers (
  market_source LowCardinality(String),
  user String,
  token_id String,
  timestamp DateTime,
  trades_count UInt64,
  usdc_volume Float64
) ENGINE = SummingMergeTree()
ORDER BY (market_source, user, token_id, timestamp);

-- Takers aggregation table
CREATE TABLE IF NOT EXISTS trading_data.takers (
  market_source LowCardinality(String),
  user String,
  token_id String,
  timestamp DateTime,
  trades_count UInt64,
  usdc_volume Float64
) ENGINE = SummingMergeTree()
ORDER BY (market_source, user, token_id, timestamp);

-- Arbitrage events for missed-opportunities
CREATE TABLE IF NOT EXISTS trading_data.arbitrage_events (
  event_id UUID DEFAULT generateUUIDv4(),
  trigger_type LowCardinality(String),
  asset_id String,
  counterpart_asset_id String,
  condition_id String,
  fired_at DateTime64(6, 'UTC'),
  potential_profit_bps Float64,
  recommended_size Float64,
  expected_profit Float64
) ENGINE = MergeTree()
ORDER BY (condition_id, fired_at)
TTL toDateTime(fired_at) + INTERVAL 90 DAY;

-- System triggers
CREATE TABLE IF NOT EXISTS trading_data.system_triggers (
  id String,
  name String,
  trigger_type LowCardinality(String),
  threshold Float64,
  tier_required LowCardinality(String),
  enabled UInt8 DEFAULT 1
) ENGINE = ReplacingMergeTree()
ORDER BY id;

-- System trigger subscriptions
CREATE TABLE IF NOT EXISTS trading_data.system_trigger_subscriptions (
  subscription_id UUID DEFAULT generateUUIDv4(),
  user_id String,
  system_trigger_id String,
  webhook_url String,
  cooldown_ms UInt32 DEFAULT 1000,
  enabled UInt8 DEFAULT 1
) ENGINE = MergeTree()
ORDER BY (user_id, system_trigger_id);
```

---

## PLG Conversion Strategy

### Conversion Triggers
1. **Rate limit hit** → Upgrade modal
2. **Trigger type blocked** → Show upgrade preview with feature value
3. **Latency header** → "Startup+ users saw this 500ms ago"
4. **Missed opportunities** → "12 arbitrage signals today, 3 profitable after fees"

### Response Headers
```
X-Indication-Tier: builder
X-Indication-Delay-Ms: 500
X-Indication-Features-Used: ["arbitrage_triggers", "fee_adjusted"]
X-Indication-Features-Locked: ["l2_sizing", "real_time"]
X-Indication-Upgrade-Benefit: "Real-time signals + L2-aware sizing"
```

### Key Differentiators vs Free Polymarket API
1. **Trigger system** - They don't have one
2. **Fee-adjusted calculations** - Manual calculation otherwise
3. **L2 orderbook analysis** - Their API is BBO only
4. **Historical aggregations** - Makers/takers leaderboards
5. **Batch endpoints** - They don't have batch queries
6. **Dashboard** - Visual trigger management

---

## Files Reference

### New Files to Create
| File | Purpose |
|------|---------|
| `src/middleware/latency-tier.ts` | Artificial delay (1000/750/500/0ms) |
| `src/middleware/clerk-auth.ts` | JWT validation |
| `src/services/fee-calculator.ts` | Polymarket fee calculations |
| `src/services/l2-analyzer.ts` | L2 orderbook analysis |
| `src/services/tier-gating.ts` | Feature flags |
| `src/routes/batch.ts` | Batch endpoints |
| `src/routes/leaderboard.ts` | Leaderboard endpoints |
| `src/routes/account.ts` | Account/usage endpoints |
| `src/routes/system-triggers.ts` | System trigger CRUD |
| `app/src/components/triggers/TriggerBuilder.tsx` | Visual trigger UI |

### Files to Modify
| File | Changes |
|------|---------|
| `src/middleware/rate-limiter.ts` | Expand to 6 tiers |
| `src/schemas/common.ts` | Add UserTier enum |
| `src/routes/api-v1.ts` | Add new endpoints |
| `src/core/triggers.ts` | Add tier requirements |
| `src/core/orderbook.ts` | Add maker/taker fields |
| `src/durable-objects/orderbook-manager.ts` | Fee/L2 integration |
| `wrangler.toml` | Add Clerk secrets |
| `app/src/main.tsx` | Add ClerkProvider |

---

## Verification Checklist

### Latency
- [ ] Sandbox requests take ~1000ms
- [ ] Hobby requests take ~750ms
- [ ] Builder requests take ~500ms
- [ ] Startup+ requests are real-time (<100ms)

### Auth
- [ ] Clerk sign-up creates sandbox user
- [ ] Stripe webhook updates tier
- [ ] JWT validates in API

### Dashboard
- [ ] Can register triggers visually
- [ ] Can manage webhooks
- [ ] Can view usage
- [ ] Can upgrade tier

### Triggers
- [ ] Basic triggers work for all tiers
- [ ] Arbitrage blocked for Sandbox/Hobby
- [ ] Fee calculations included for Builder+
- [ ] L2 analysis included for Startup+

### PLG
- [ ] Latency headers show delay info
- [ ] Upgrade previews show on blocked features
- [ ] Missed opportunities endpoint works
