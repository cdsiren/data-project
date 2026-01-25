# Trigger System Documentation

Low-latency event triggers for market making and trading strategies. Triggers are evaluated synchronously on every BBO update in the Durable Object, bypassing queues for sub-50ms latency.

## Table of Contents
- [Generic Triggers](#generic-triggers)
- [HFT / Market Making Triggers](#hft--market-making-triggers)
- [Prediction Market Triggers](#prediction-market-triggers)
- [Webhook Payload](#webhook-payload)
- [Registration API](#registration-api)
- [Cooldown Behavior](#cooldown-behavior)
- [Global Triggers (Always-On)](#global-triggers-always-on)
- [Authentication](#authentication)
- [Consuming Trigger Events](#consuming-trigger-events)
- [Third-Party Developer Guide](#third-party-developer-guide)

---

## Generic Triggers

Basic triggers that work across all market types.

### PRICE_ABOVE
**Purpose**: Fire when best bid or ask crosses above a price threshold.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Price level to watch |
| `side` | "BID" \| "ASK" | Yes | Which side to monitor |

### PRICE_BELOW
**Purpose**: Fire when best bid or ask drops below a price threshold.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Price level to watch |
| `side` | "BID" \| "ASK" | Yes | Which side to monitor |

### SPREAD_NARROW
**Purpose**: Fire when bid-ask spread narrows below threshold (in basis points).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Spread in bps |

### SPREAD_WIDE
**Purpose**: Fire when bid-ask spread widens above threshold (in basis points).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Spread in bps |

### IMBALANCE_BID
**Purpose**: Fire when book imbalance favors bids. Imbalance = (bid_size - ask_size) / (bid_size + ask_size).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Imbalance ratio (e.g., 0.3 = 30%) |

### IMBALANCE_ASK
**Purpose**: Fire when book imbalance favors asks (negative imbalance exceeds threshold).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Imbalance ratio (e.g., 0.3 fires when imbalance < -0.3) |

### SIZE_SPIKE
**Purpose**: Fire when large size appears at top of book.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Size threshold |
| `side` | "BID" \| "ASK" | Yes | Which side to monitor |

### PRICE_MOVE
**Purpose**: Fire when mid price moves X% within a time window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Percentage move (e.g., 5 = 5%) |
| `window_ms` | number | Yes | Rolling window in milliseconds (max 60000) |

### CROSSED_BOOK
**Purpose**: Fire when bid >= ask (rare arbitrage opportunity or data issue).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Ignored (use 0) |

### EMPTY_BOOK
**Purpose**: Fire when both sides of the book are empty (market halt, liquidity withdrawal).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Ignored (use 0) |

---

## HFT / Market Making Triggers

Advanced triggers optimized for Avellaneda-Stoikov market making and high-frequency strategies.

### VOLATILITY_SPIKE
**Purpose**: Detect realized volatility regime changes. Critical for AS model where spread = `2/γ + γσ²(T-t)`. When σ spikes, spreads should widen.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Volatility % (std dev of returns) |
| `window_ms` | number | Yes | Rolling window for calculation (max 60000) |

**Webhook extras**:
- `volatility`: Calculated volatility percentage

### MICROPRICE_DIVERGENCE
**Purpose**: Detect when microprice diverges from mid price. Microprice is a better short-term price predictor. Positive divergence = bullish, negative = bearish.

**Formula**: `microprice = (best_bid × ask_size + best_ask × bid_size) / (bid_size + ask_size)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Divergence in basis points |

**Webhook extras**:
- `microprice`: Calculated microprice
- `microprice_divergence_bps`: Divergence from mid in bps

### IMBALANCE_SHIFT
**Purpose**: Detect rapid changes in book imbalance. Signals shift in order flow preceding price movement.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Imbalance delta (e.g., 0.3 = 30% change) |
| `window_ms` | number | Yes | Comparison window |

**Webhook extras**:
- `imbalance_delta`: Change in imbalance
- `previous_imbalance`: Imbalance at window start
- `current_imbalance`: Current imbalance

### MID_PRICE_TREND
**Purpose**: Detect consecutive price moves in same direction. Crucial for AS inventory management.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Min consecutive moves to trigger |
| `side` | "BID" \| "ASK" | No | Optional filter: BID=down moves, ASK=up moves |

**Webhook extras**:
- `consecutive_moves`: Number of consecutive moves
- `trend_direction`: "UP" or "DOWN"

### QUOTE_VELOCITY
**Purpose**: Detect when BBO is updating frequently. Indicates competitive pressure or informed trading.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Updates per second |
| `window_ms` | number | Yes | Measurement window |

**Webhook extras**:
- `updates_per_second`: Calculated update rate

### STALE_QUOTE
**Purpose**: Fire when no BBO update received for threshold milliseconds. Indicates market halt or data issue. Evaluated in alarm handler, not on BBO update.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Staleness in milliseconds |

**Webhook extras**:
- `stale_ms`: Time since last update

### LARGE_FILL
**Purpose**: Detect when significant size is removed from the orderbook. Proxy for whale activity or large position opens.

**Formula**: `notional = |size_delta| × price`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Minimum notional value in USD |
| `side` | "BID" \| "ASK" | No | Optional filter for specific side |

**Webhook extras**:
- `fill_notional`: Notional value of removed size
- `fill_side`: "BID" or "ASK"
- `size_delta`: Size change (negative = removed)

---

## Prediction Market Triggers

Triggers specific to binary and multi-outcome prediction markets (Polymarket, Kalshi, etc.).

### ARBITRAGE_BUY
**Purpose**: Detect when YES_ask + NO_ask < threshold. Buying both guarantees profit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Sum threshold (e.g., 0.99 to account for fees) |
| `counterpart_asset_id` | string | Yes | Token ID of the other outcome |

**Webhook extras**:
- `counterpart_asset_id`: The other outcome's asset ID
- `counterpart_best_bid`, `counterpart_best_ask`: Counterpart prices
- `sum_of_asks`: YES_ask + NO_ask
- `potential_profit_bps`: Estimated profit in basis points

### ARBITRAGE_SELL
**Purpose**: Detect when YES_bid + NO_bid > threshold. Selling both guarantees profit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Sum threshold (e.g., 1.01 to account for fees) |
| `counterpart_asset_id` | string | Yes | Token ID of the other outcome |

**Webhook extras**:
- `counterpart_asset_id`: The other outcome's asset ID
- `counterpart_best_bid`, `counterpart_best_ask`: Counterpart prices
- `sum_of_bids`: YES_bid + NO_bid
- `potential_profit_bps`: Estimated profit in basis points

### MULTI_OUTCOME_ARBITRAGE
**Purpose**: Detect arbitrage in N-outcome prediction markets. Sum of all outcome asks < threshold = arbitrage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | number | Yes | Sum threshold (e.g., 0.99) |
| `outcome_asset_ids` | string[] | Yes | Array of all outcome token IDs |

**Webhook extras**:
- `outcome_ask_sum`: Sum of all outcome asks
- `outcome_count`: Number of outcomes
- `potential_profit_bps`: Estimated profit in basis points

---

## Webhook Payload

All triggers send a POST request with the following JSON payload:

```typescript
interface TriggerEvent {
  // Trigger metadata
  trigger_id: string;
  trigger_type: string;
  asset_id: string;
  condition_id: string;
  fired_at: number;           // Microsecond timestamp
  latency_us: number;         // Time from source to fire

  // Current market state
  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  mid_price: number | null;
  spread_bps: number | null;

  // Trigger evaluation
  threshold: number;
  actual_value: number;       // The value that triggered

  // Context
  book_hash: string;
  sequence_number: number;
  metadata?: Record<string, string>;

  // Trigger-specific fields (see individual triggers above)
  // ...
}
```

### Webhook Headers

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Trigger-ID` | Trigger ID |
| `X-Trigger-Type` | Trigger type (e.g., "VOLATILITY_SPIKE") |
| `X-Trigger-Signature` | HMAC-SHA256 signature (if `webhook_secret` configured) |

### Signature Verification

If `webhook_secret` is set, verify the signature:

```typescript
const crypto = require('crypto');

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');
  return signature === expected;
}
```

---

## Registration API

### Register Trigger

```
POST /triggers
```

```json
{
  "asset_id": "token_id_here",
  "condition": {
    "type": "VOLATILITY_SPIKE",
    "threshold": 5,
    "window_ms": 10000
  },
  "webhook_url": "https://your-server.com/webhook",
  "webhook_secret": "optional_hmac_secret",
  "cooldown_ms": 1000,
  "enabled": true,
  "metadata": {
    "strategy": "market_maker_v2"
  }
}
```

### List Triggers

```
GET /triggers
```

### Delete Trigger

```
POST /triggers/delete
```

```json
{
  "trigger_id": "trig_123456_abc"
}
```

---

## Performance Budget

| Trigger | Complexity | Memory/Asset |
|---------|------------|--------------|
| PRICE_ABOVE/BELOW | O(1) | None |
| SPREAD_NARROW/WIDE | O(1) | None |
| IMBALANCE_BID/ASK | O(1) | None |
| SIZE_SPIKE | O(1) | None |
| CROSSED_BOOK | O(1) | None |
| EMPTY_BOOK | O(1) | None |
| VOLATILITY_SPIKE | O(n), n~200 | Reuses priceHistory |
| MICROPRICE_DIVERGENCE | O(1) | None |
| IMBALANCE_SHIFT | O(n), n~100 | ~800 bytes max |
| MID_PRICE_TREND | O(1) | 24 bytes |
| QUOTE_VELOCITY | O(1) | 16 bytes |
| STALE_QUOTE | O(1) in alarm | 8 bytes |
| PRICE_MOVE | O(n), n~200 | Reuses priceHistory |
| LARGE_FILL | O(1) | 16 bytes |
| ARBITRAGE_BUY/SELL | O(1) | Reuses latestBBO |
| MULTI_OUTCOME_ARBITRAGE | O(k), k~5 | Reuses latestBBO |

**Target**: <1ms total evaluation per BBO update

---

## Cooldown Behavior

Cooldowns prevent triggers from firing repeatedly while a condition remains true. This avoids flooding your webhook or SSE stream with redundant events.

### Custom Triggers

Custom triggers have fully configurable cooldowns via the `cooldown_ms` field:

| `cooldown_ms` | Behavior |
|---------------|----------|
| `1000` (default) | Fire at most once per second while condition is true |
| `0` | No cooldown - fire on EVERY BBO update where condition is true |
| `5000` | Fire at most once per 5 seconds |

**Example scenarios** (spread stays wide for 10 seconds at 50 updates/sec):
- `cooldown_ms: 0` = 500 events
- `cooldown_ms: 1000` = 10 events
- `cooldown_ms: 5000` = 2 events

Use `cooldown_ms: 0` for high-frequency strategies that need to react to every tick.

### Global Triggers

Global triggers have a fixed 500ms cooldown per trigger type per asset. This provides a reasonable baseline for dashboard monitoring without overwhelming consumers.

If you need faster global trigger events, register an equivalent custom trigger with `cooldown_ms: 0`.

---

## Global Triggers (Always-On)

Built-in triggers that run on every BBO update without registration. These provide a baseline stream of market events for monitoring and dashboards.

| Trigger | Condition | Threshold | Description |
|---------|-----------|-----------|-------------|
| `SPREAD_WIDE` | spread > 200 bps | 2% spread | Liquidity withdrawal |
| `SPREAD_NARROW` | spread < 20 bps | 0.2% spread | Very tight market |
| `IMBALANCE_BID` | imbalance > 0.6 | 60% bid-heavy | Strong buy pressure |
| `IMBALANCE_ASK` | imbalance < -0.6 | 60% ask-heavy | Strong sell pressure |
| `CROSSED_BOOK` | bid >= ask | Critical | Arbitrage or data issue |
| `EMPTY_BOOK` | no liquidity | Critical | Market halt |
| `MICROPRICE_DIVERGENCE` | divergence > 50 bps | Short-term alpha | Price direction signal |
| `MID_PRICE_TREND` | 3+ consecutive moves | Momentum | Trending market |
| `LARGE_FILL` | > $1000 removed | Whale activity | Large position opens |
| `VOLATILITY_SPIKE` | volatility > 2% | Regime change | 10s rolling window |

**Key details:**
- Fixed 500ms cooldown per trigger type per asset
- SSE-only delivery (no webhook callbacks)
- Trigger ID format: `global_<type_lowercase>` (e.g., `global_spread_wide`)
- No registration required

---

## Authentication

All trigger endpoints require API key authentication.

### Admin API Key (`WEBHOOK_API_KEY`)

Used for trigger management operations.

| Header | Value |
|--------|-------|
| `X-API-Key` | Your `WEBHOOK_API_KEY` |

**Required for:**
- `POST /triggers` - Register new trigger
- `POST /triggers/delete` - Delete trigger
- `GET /triggers` - List all triggers

### Event Stream API Key (`VITE_DASHBOARD_API_KEY`)

Used for read-only event consumption via SSE.

| Parameter | Value |
|-----------|-------|
| `?key=` | Your `VITE_DASHBOARD_API_KEY` |

**Required for:**
- `GET /api/v1/triggers/events/sse` - SSE event stream
- `GET /api/v1/triggers/events/status` - Buffer status

API key is passed as a query parameter because the EventSource API doesn't support custom headers.

**Important:** In production, `VITE_DASHBOARD_API_KEY` must be configured. All consumers (including the app itself) must authenticate.

---

## Consuming Trigger Events

Trigger events can be consumed via SSE stream or webhook callbacks.

### SSE Stream

Real-time event stream for dashboards, monitoring, and applications.

**Endpoint:** `GET /api/v1/triggers/events/sse?key=<VITE_DASHBOARD_API_KEY>`

**Features:**
- Ring buffer of 100 events for reconnection replay
- 30-second heartbeat to keep connections alive
- CORS enabled for browser clients
- Receives both global and custom trigger events

**JavaScript/TypeScript Example:**

```typescript
const VITE_DASHBOARD_API_KEY = "your-api-key";
const eventSource = new EventSource(
  `https://your-worker.workers.dev/api/v1/triggers/events/sse?key=${VITE_DASHBOARD_API_KEY}`
);

eventSource.onmessage = (event) => {
  const triggerEvent = JSON.parse(event.data);
  console.log(`Trigger fired: ${triggerEvent.trigger_type} for ${triggerEvent.asset_id}`);

  // Filter by trigger type if needed
  if (triggerEvent.trigger_type === "SPREAD_WIDE") {
    handleWideSpread(triggerEvent);
  }
};

eventSource.onerror = (error) => {
  console.error("SSE connection error:", error);
  // EventSource will automatically reconnect
};

// Graceful cleanup
window.addEventListener("beforeunload", () => {
  eventSource.close();
});
```

**Node.js Example:**

```typescript
import EventSource from "eventsource";

const VITE_DASHBOARD_API_KEY = process.env.VITE_DASHBOARD_API_KEY;
const es = new EventSource(
  `https://your-worker.workers.dev/api/v1/triggers/events/sse?key=${VITE_DASHBOARD_API_KEY}`
);

es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Trigger:", data.trigger_type, data.asset_id);
};
```

### Webhook Delivery

For custom triggers, configure a `webhook_url` to receive POST requests when the trigger fires.

**Headers:**

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Trigger-ID` | Trigger ID (e.g., `trig_123456_abc`) |
| `X-Trigger-Type` | Trigger type (e.g., `VOLATILITY_SPIKE`) |
| `X-Trigger-Signature` | HMAC-SHA256 signature (if `webhook_secret` configured) |

**Signature Verification (Node.js):**

```typescript
import crypto from "crypto";

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Express middleware example
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["x-trigger-signature"] as string;
  const body = req.body.toString();

  if (!verifySignature(body, signature, process.env.WEBHOOK_SECRET!)) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(body);
  // Process event...
  res.status(200).send("OK");
});
```

**Signature Verification (Python):**

```python
import hmac
import hashlib
import base64

def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = base64.b64encode(
        hmac.new(
            secret.encode(),
            body,
            hashlib.sha256
        ).digest()
    ).decode()
    return hmac.compare_digest(signature, expected)

# Flask example
@app.route("/webhook", methods=["POST"])
def webhook():
    signature = request.headers.get("X-Trigger-Signature")
    if not verify_signature(request.data, signature, os.environ["WEBHOOK_SECRET"]):
        return "Invalid signature", 401

    event = request.get_json()
    # Process event...
    return "OK", 200
```

---

## Third-Party Developer Guide

Complete guide for integrating with the trigger system.

### Getting Started

1. **Obtain API keys from administrator:**
   - `WEBHOOK_API_KEY` - For trigger registration and management
   - `VITE_DASHBOARD_API_KEY` - For SSE event subscription (required)

2. **Choose integration pattern:**
   - **SSE-only**: Subscribe to global triggers via SSE stream
   - **Custom triggers**: Register your own triggers with custom conditions and webhooks
   - **Hybrid**: Use SSE for monitoring + custom triggers for specific conditions

### Subscribing to Global Triggers

Connect to the SSE stream to receive all trigger events:

```typescript
const es = new EventSource(
  `https://your-worker.workers.dev/api/v1/triggers/events/sse?key=${VITE_DASHBOARD_API_KEY}`
);

es.onmessage = (event) => {
  const data = JSON.parse(event.data);

  // Filter client-side by trigger type
  switch (data.trigger_type) {
    case "SPREAD_WIDE":
      console.log(`Wide spread on ${data.asset_id}: ${data.actual_value} bps`);
      break;
    case "LARGE_FILL":
      console.log(`Whale activity: $${data.fill_notional} ${data.fill_side}`);
      break;
  }
};
```

**Note:** Global triggers have a 500ms cooldown. For faster event delivery, register equivalent custom triggers with `cooldown_ms: 0`.

### Registering Custom Triggers

**Endpoint:** `POST /triggers`

**Required fields:**
- `asset_id` - Asset to monitor (or `"*"` for all assets)
- `condition` - Trigger condition with `type` and `threshold`

**Optional fields:**
- `webhook_url` - URL to POST when trigger fires
- `webhook_secret` - HMAC secret for signature verification
- `cooldown_ms` - Minimum time between fires (default: 1000, use 0 for max speed)
- `enabled` - Whether trigger is active (default: true)
- `metadata` - Custom key-value pairs passed through to events

**Example: High-Frequency Volatility Trigger**

```bash
curl -X POST https://your-worker.workers.dev/triggers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${WEBHOOK_API_KEY}" \
  -d '{
    "asset_id": "21742633143463906290569050155826241533067272736897614950488156847949938836455",
    "condition": {
      "type": "VOLATILITY_SPIKE",
      "threshold": 1.5,
      "window_ms": 5000
    },
    "webhook_url": "https://your-server.com/webhook",
    "webhook_secret": "your-secret-here",
    "cooldown_ms": 0,
    "metadata": {
      "strategy": "hft_vol_arb"
    }
  }'
```

**Example: Arbitrage Detection**

```bash
curl -X POST https://your-worker.workers.dev/triggers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${WEBHOOK_API_KEY}" \
  -d '{
    "asset_id": "YES_TOKEN_ID",
    "condition": {
      "type": "ARBITRAGE_BUY",
      "threshold": 0.995,
      "counterpart_asset_id": "NO_TOKEN_ID"
    },
    "webhook_url": "https://your-server.com/arb-webhook",
    "cooldown_ms": 100
  }'
```

**Example: Wildcard Trigger (All Assets)**

```bash
curl -X POST https://your-worker.workers.dev/triggers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${WEBHOOK_API_KEY}" \
  -d '{
    "asset_id": "*",
    "condition": {
      "type": "CROSSED_BOOK",
      "threshold": 0
    },
    "webhook_url": "https://your-server.com/alerts"
  }'
```

### Managing Triggers

**List all triggers:**

```bash
curl https://your-worker.workers.dev/triggers \
  -H "X-API-Key: ${WEBHOOK_API_KEY}"
```

**Delete a trigger:**

```bash
curl -X POST https://your-worker.workers.dev/triggers/delete \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${WEBHOOK_API_KEY}" \
  -d '{
    "trigger_id": "trig_123456_abc"
  }'
```

### Limits and Quotas

| Resource | Limit |
|----------|-------|
| Triggers per asset | 50 |
| Minimum cooldown | None (can use 0) |
| Webhook timeout | 5 seconds |
| SSE event buffer | 100 events |
| SSE heartbeat | 30 seconds |

### Best Practices

1. **Always use webhook secrets in production** - Verify HMAC signatures to ensure events are authentic

2. **Design idempotent webhook handlers** - Events may be delivered more than once during reconnections

3. **Handle SSE reconnection gracefully** - EventSource auto-reconnects; use `Last-Event-ID` header for replay

4. **Use `cooldown_ms: 0` carefully** - Only if your system can handle high event volumes (hundreds per second)

5. **Filter events client-side** - SSE stream contains all events; filter by `trigger_type` or `asset_id` as needed

6. **Monitor webhook failures** - Failed webhooks are logged but not retried; implement your own retry logic if needed

### Troubleshooting

| Issue | Solution |
|-------|----------|
| 401 on SSE | Check `VITE_DASHBOARD_API_KEY` in query param `?key=...` |
| 401 on trigger API | Check `X-API-Key` header matches `WEBHOOK_API_KEY` |
| No events received | Verify triggers are `enabled: true` and conditions match market state |
| Too many events | Increase `cooldown_ms` or filter client-side |
| Missing webhook calls | Verify `webhook_url` is accessible and returns 200 within 5s |
| Invalid signature | Verify `webhook_secret` matches and body is raw JSON string |
