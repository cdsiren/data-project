// src/adapters/lifecycle/index.ts
// Re-export lifecycle adapter components

export type {
  MarketLifecycleAdapter,
  MarketLifecycleEvent,
  MarketMetadata,
} from "./base-lifecycle-adapter";

export { PolymarketLifecycleAdapter } from "./polymarket-lifecycle-adapter";

export {
  getLifecycleAdapter,
  hasLifecycleAdapter,
  getSupportedLifecycleMarkets,
} from "./registry";
