# Multi-Market Graph System

## Overview

The graph system connects Polymarket prediction markets through weighted edges, enabling:

1. **Related Market Discovery** - Find markets that move together or inversely
2. **Arbitrage Detection** - Identify cross-market opportunities using BFS and Bellman-Ford
3. **Compound Triggers** - Fire triggers when conditions across multiple markets are met
4. **Network Effect** - User behavior implicitly builds and strengthens the graph

The graph is **user-driven**: every analysis, trigger, and successful prediction strengthens relationships between markets, creating a self-improving recommendation system.

---

## Architecture: Hybrid Three-Tier Cache

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: GraphManager Durable Object (Single Global Instance)  │
│  ─────────────────────────────────────────────────────────────  │
│  • Authoritative graph state rebuilt every 15 min from CH      │
│  • Serves complex queries: BFS, Bellman-Ford, N-hop            │
│  • Runs negative cycle detection for arbitrage alerts          │
│  • Memory: ~50MB for 10K markets, 100K edges                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Syncs adjacency lists
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2: KV Cache (Global, 15-min TTL)                          │
│  ─────────────────────────────────────────────────────────────  │
│  • Key: graph:neighbors:{market_id}                            │
│  • Value: JSON array of GraphNeighbor objects                  │
│  • TTL: 15 minutes (matches rebuild cycle)                     │
│  • Serves API requests with < 50ms latency                     │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Lazy-loaded on first access
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3: OrderbookManager DO Cache (Per Shard)                  │
│  ─────────────────────────────────────────────────────────────  │
│  • Local Map<string, GraphNeighbor[]>                          │
│  • Only 1-hop neighbors for hot path                           │
│  • Used for compound trigger evaluation                         │
│  • Provides < 5ms lookups                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Why this architecture:**
- Keeps OrderbookManager latency < 50ms (critical for triggers)
- GraphManager handles expensive operations off the hot path
- KV provides global fallback preventing cold-start spikes

---

## Data Model

### Edge Types

| Type | Weight | Description |
|------|--------|-------------|
| `correlation` | +0 to +1 | Markets that move together (positive correlation) |
| `hedge` | -1 to -0 | Markets that move inversely (stored negative for Bellman-Ford) |
| `causal` | +0 to +1 | Markets linked by shared tags/topics |
| `arbitrage` | log(1-spread) | Detected price discrepancies (negative when profitable) |

### Signal Sources

Signals are events that strengthen or weaken edges:

| Source | Strength | Description |
|--------|----------|-------------|
| `trigger_fire` | +1.0 × 2.0 | Compound trigger fired successfully (strongest signal) |
| `user_trigger` | +1.5 × 1.5 | User created compound trigger |
| `user_analysis` | +1.0 × 1.0 | User created analysis linking markets |
| `cron_correlation` | varies × 1.0 | Daily correlation seeding job |
| `metadata_tag` | +0.5 × 0.8 | Shared tags between markets |
| `trigger_miss` | -0.1 × 0.5 | Compound trigger didn't fire (gentle decay) |

### Weight Aggregation Formula

The GraphManager rebuilds edge weights every 15 minutes using:

```sql
log(1 + sum(
  strength *
  CASE signal_source
    WHEN 'trigger_fire' THEN 2.0
    WHEN 'user_trigger' THEN 1.5
    WHEN 'user_analysis' THEN 1.0
    WHEN 'trigger_miss' THEN 0.5
    WHEN 'cron_correlation' THEN 1.0
    WHEN 'metadata_tag' THEN 0.8
    ELSE 1.0
  END *
  exp(-dateDiff('day', created_at, now()) * 0.693147 / 30)  -- 30-day half-life (ln(2)/30)
)) AS weight
```

- **Logarithmic scaling**: Prevents any single user from dominating
- **Source weighting**: Fires > triggers > analyses
- **Exponential decay**: Recent signals matter more (30-day half-life)
- **Threshold**: Edges with weight < 0.1 are pruned

---

## Network Effect: User-Driven Graph Building

The graph builds itself through user behavior. Every action involving multiple markets creates edge signals:

```
┌──────────────────────────────────────────────────────────────────────┐
│                     USER ACTIONS BUILD THE GRAPH                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. User creates ANALYSIS linking markets A, B, C                      │
│     └─→ Edge signals: (A,B), (A,C), (B,C) with strength +1.0           │
│                                                                        │
│  2. User creates COMPOUND TRIGGER on markets A, B                      │
│     └─→ Edge signal: (A,B) with strength +1.5                          │
│                                                                        │
│  3. Trigger FIRES successfully                                         │
│     └─→ Edge signal: (A,B) with strength +1.0 × 2.0 multiplier         │
│         (User's hypothesis was CORRECT - strongest reinforcement)      │
│                                                                        │
│  4. Trigger evaluated 100 times without firing                         │
│     └─→ Edge signal: (A,B) with strength -0.1                          │
│         (User's hypothesis may be WRONG - gentle decay)                │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         FLYWHEEL EFFECT                               │
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Graph edges strengthen → Better suggestions shown to OTHER users      │
│           ↓                                                            │
│  Other users discover related markets → Create their own triggers      │
│           ↓                                                            │
│  More edge signals → Richer graph → More accurate arbitrage detection  │
│           ↓                                                            │
│  Triggers fire successfully → Strongest reinforcement signal           │
│           ↓                                                            │
│  Repeat (exponential growth in graph density)                          │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Compound Triggers

Compound triggers fire when conditions across **multiple markets** are met simultaneously.

### Registration

```bash
POST /triggers
{
  "asset_id": "primary_market_id",
  "webhook_url": "https://...",
  "compound_mode": "ALL_OF",        # ALL_OF | ANY_OF | N_OF_M
  "compound_threshold": 2,          # For N_OF_M mode
  "conditions": [
    {
      "market_id": "market_a",
      "asset_id": "token_a",
      "type": "PRICE_ABOVE",
      "threshold": 0.6,
      "side": "BID"
    },
    {
      "market_id": "market_b",
      "asset_id": "token_b",
      "type": "SPREAD_NARROW",
      "threshold": 50
    }
  ]
}
```

### Evaluation Modes

| Mode | Behavior |
|------|----------|
| `ALL_OF` | All conditions must be true |
| `ANY_OF` | At least one condition must be true |
| `N_OF_M` | At least N of M conditions must be true |

### Condition Types

Standard trigger conditions apply to each condition in a compound trigger:

- `PRICE_ABOVE`, `PRICE_BELOW`
- `SPREAD_NARROW`, `SPREAD_WIDE`
- `IMBALANCE_BID`, `IMBALANCE_ASK`
- `SIZE_SPIKE`
- `CROSSED_BOOK`, `EMPTY_BOOK`

### Cross-Shard Coordination

When a compound trigger spans markets on different shards:

1. Each shard evaluates its conditions and publishes state to KV
2. Coordinator shard aggregates cross-shard results
3. Fire decision is made based on aggregated state
4. TTL of 60 seconds prevents stale coordination data

### Gradual Decay for Wrong Hypotheses

When a trigger doesn't fire after 100 consecutive evaluations, a gentle decay signal is emitted:

```
Trigger created → +2.25 signal (user_trigger: 1.5 × 1.5)
       ↓
100 misses → -0.05 decay signal (-0.1 × 0.5)
       ↓
200 misses → another -0.05 decay
       ↓
Trigger fires → Reset counter + +2.0 reinforcement
```

**Balance**: One successful fire offsets ~40 decay signals (4,000 consecutive misses).

---

## Graph Algorithms

### 1. BFS for Arbitrage Path Finding

**Purpose**: Find multi-hop paths with arbitrage opportunities
**Complexity**: O(V + E)
**Latency**: < 50ms for 2-hop paths

```typescript
findArbitragePaths(startMarket, adjacencyList, {
  maxDepth: 2,     // Maximum hops
  minWeight: 0.5,  // Minimum edge weight
  limit: 10        // Max results
});
```

Returns paths sorted by `opportunity_bps` (basis points of profit).

### 2. Bellman-Ford for Negative Cycle Detection

**Purpose**: Find arbitrage loops through hedge relationships
**Complexity**: O(V × E)
**Run**: Every 15 minutes via cron (too slow for hot path)

Hedge edges have **negative weights**. A negative cycle means:
- Going around the cycle produces net profit
- Example: Market A hedges B, B hedges C, C hedges A

```typescript
detectNegativeCycles(adjacencyList);
// Returns: [{ markets: ['A', 'B', 'C'], total_weight: -0.3, opportunity_type: 'hedge_loop' }]
```

### 3. Dijkstra's Shortest Path

**Purpose**: Find shortest path between any two markets
**Complexity**: O((V + E) log V)

```typescript
findShortestPath(from, to, adjacencyList, {
  minWeight: 0.3,
  edgeTypes: ['correlation', 'causal']
});
```

### 4. N-Hop Neighbor Discovery

**Purpose**: Find all markets within N hops
**Use case**: "Show me markets related to X within 2 degrees"

```typescript
getNHopNeighbors(startMarket, adjacencyList, hops: 2);
```

---

## API Endpoints

All endpoints require `X-API-Key` header.

### Discovery

| Endpoint | Description |
|----------|-------------|
| `GET /api/graph/neighbors/:marketId` | 1-hop neighbors with weights |
| `GET /api/graph/nhop/:marketId/:hops` | N-hop neighbors (1-3 hops) |
| `GET /api/graph/suggestions/:marketId` | Related markets for UI (includes reasons) |
| `GET /api/graph/paths/:from/:to` | Shortest path between markets |

### Arbitrage

| Endpoint | Description |
|----------|-------------|
| `GET /api/graph/arbitrage/:marketId` | Arbitrage paths from a market |
| `GET /api/graph/cycles` | Detected negative cycles |
| `POST /api/graph/detect-cycles` | Manually trigger cycle detection |

### Analytics

| Endpoint | Description |
|----------|-------------|
| `GET /api/graph/top-edges` | Strongest edges globally |
| `GET /api/graph/stats` | Graph statistics |
| `GET /api/graph/health` | Health check |

### Admin

| Endpoint | Description |
|----------|-------------|
| `POST /api/graph/rebuild` | Force graph rebuild |
| `POST /api/graph/seed-correlation` | Run correlation seeding |

### Query Parameters

Most endpoints support:
- `min_weight`: Minimum edge weight (0-1)
- `limit`: Maximum results
- `edge_types`: Comma-separated filter (correlation,hedge,causal,arbitrage)

---

## ClickHouse Schema

### graph_edge_signals (Append-Only Log)

```sql
CREATE TABLE trading_data.graph_edge_signals (
    market_a String,
    market_b String,
    edge_type LowCardinality(String),
    signal_source LowCardinality(String),
    user_id String DEFAULT '',
    strength Float32 DEFAULT 1.0,
    metadata String DEFAULT '',
    created_at DateTime64(6),
    created_date Date
) ENGINE = MergeTree()
PARTITION BY created_date
ORDER BY (edge_type, market_a, market_b, created_at)
TTL created_at + INTERVAL 90 DAY;
```

### graph_edges (Aggregated Snapshot)

```sql
CREATE TABLE trading_data.graph_edges (
    market_a String,
    market_b String,
    edge_type LowCardinality(String),
    weight Float32,
    user_count UInt32,
    signal_count UInt32,
    last_signal_at DateTime64(6),
    updated_at DateTime64(6)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (market_a, market_b, edge_type);
```

### graph_negative_cycles (Detected Opportunities)

```sql
CREATE TABLE trading_data.graph_negative_cycles (
    cycle_id String,
    markets Array(String),
    total_weight Float32,
    opportunity_type LowCardinality(String),
    detected_at DateTime64(6),
    resolved_at DateTime64(6)
) ENGINE = MergeTree()
ORDER BY (detected_at, cycle_id)
TTL detected_at + INTERVAL 30 DAY;
```

---

## Wrangler Configuration

```toml
# KV Namespaces
[[kv_namespaces]]
binding = "GRAPH_CACHE"
id = "72261b1c3d1f41a3b357506f6178ee5a"

[[kv_namespaces]]
binding = "CROSS_SHARD_KV"
id = "3fc6ff2fddb04b9c889fb59ee04102fc"

# Queue
[[queues.producers]]
queue = "graph-edge-signal-queue"
binding = "GRAPH_QUEUE"

# Durable Object
[durable_objects]
bindings = [
  { name = "GRAPH_MANAGER", class_name = "GraphManager" }
]

# Cron (graph rebuild at 7,22,37,52 minutes each hour)
[triggers]
crons = ["7,22,37,52 * * * *"]
```

---

## File Structure

```
src/
├── durable-objects/
│   ├── graph-manager.ts          # Tier 1: Authoritative graph state
│   └── orderbook-manager.ts      # Tier 3: Local cache + compound triggers
├── services/
│   ├── graph/
│   │   ├── types.ts              # Type definitions
│   │   ├── graph-algorithms.ts   # BFS, Bellman-Ford, Dijkstra
│   │   ├── graph-cache.ts        # KV cache wrapper + helpers
│   │   └── index.ts              # Barrel export
│   └── trigger-evaluator/
│       └── compound-evaluator.ts # Compound trigger logic + decay
├── consumers/
│   └── edge-signal-consumer.ts   # Queue → ClickHouse
├── routes/
│   └── graph.ts                  # API endpoints
└── migrations/
    └── 004_graph_tables.sql      # ClickHouse schema
```

---

## Example: Building a Related Markets Widget

```typescript
// Fetch suggestions for a market
const response = await fetch('/api/graph/suggestions/0x123...', {
  headers: { 'X-API-Key': API_KEY }
});

const data = await response.json();
// {
//   market_id: "0x123...",
//   suggestions: [
//     {
//       market_id: "0x456...",
//       edge_type: "correlation",
//       weight: 0.85,
//       user_count: 12,
//       reason: "12 users created triggers linking these markets (correlation: 85%)",
//       market: { title: "Will ETH hit $5000?", ... }
//     },
//     ...
//   ],
//   community_signal: "Built from 47 user analyses"
// }
```

---

## Example: Creating a Compound Trigger

```typescript
// Create trigger that fires when BOTH markets show bullish signals
const response = await fetch('/orderbook-manager/triggers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    asset_id: "token_a",
    webhook_url: "https://my-webhook.com/alert",
    compound_mode: "ALL_OF",
    conditions: [
      {
        market_id: "0x123...",
        asset_id: "token_a",
        type: "PRICE_ABOVE",
        threshold: 0.7,
        side: "BID"
      },
      {
        market_id: "0x456...",
        asset_id: "token_b",
        type: "PRICE_ABOVE",
        threshold: 0.6,
        side: "BID"
      }
    ]
  })
});

// This automatically:
// 1. Creates edge signals between the markets (+1.5 strength)
// 2. Tracks evaluations for gradual decay
// 3. Emits reinforcement signals when trigger fires (+2.0 strength)
```

---

## Latency Budget

```
BBO Update arrives:              0ms
├─ Deserialize + normalize:      2ms
├─ Identify affected triggers:   1ms  (index lookup)
├─ Load graph neighbors:         5ms  (L3 cache hit)
├─ Evaluate conditions:         10ms  (up to 50 triggers)
├─ Cross-shard coordination:    15ms  (async KV, if needed)
├─ Fire webhook/SSE:            10ms  (async)
└─ Total:                       28ms  ✓ Under 50ms target
```

---

## Summary

The graph system transforms user behavior into a self-improving market intelligence layer:

1. **Users create relationships** → Edge signals recorded
2. **Graph edges strengthen** → Better suggestions emerge
3. **More users discover connections** → More signals created
4. **Triggers fire successfully** → Strongest reinforcement
5. **Bad hypotheses decay** → Graph self-corrects

The result is a **network effect flywheel** where the more users interact with the system, the smarter it becomes at finding related markets and arbitrage opportunities.
