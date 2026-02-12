// src/services/graph/graph-algorithms.ts
// Graph traversal algorithms for multi-market arbitrage detection

import type {
  GraphNeighbor,
  GraphEdge,
  ArbitragePath,
  NegativeCycle,
  ShortestPath,
  EdgeType,
  GraphQueryOptions,
} from "./types";

// ============================================================
// Weighted BFS for Multi-Market Arbitrage Path Finding
// Target latency: < 50ms for up to 2-hop paths
// ============================================================

/**
 * BFS queue entry for weighted path finding.
 */
interface BFSQueueEntry {
  market: string;
  path: string[];
  weights: number[];
  edgeTypes: EdgeType[];
  totalWeight: number;
}

/**
 * Find arbitrage paths from a starting market using weighted BFS.
 * Returns paths sorted by opportunity (highest first).
 *
 * @param startMarket - Starting market ID
 * @param adjacencyList - Map of market_id -> neighbors
 * @param options - Query options (maxDepth, minWeight, limit)
 * @returns Array of arbitrage paths sorted by opportunity_bps
 */
export function findArbitragePaths(
  startMarket: string,
  adjacencyList: Map<string, GraphNeighbor[]>,
  options: GraphQueryOptions = {}
): ArbitragePath[] {
  const { maxDepth = 2, minWeight = 0.5, limit = 10 } = options;

  const visited = new Set<string>();
  const queue: BFSQueueEntry[] = [{
    market: startMarket,
    path: [startMarket],
    weights: [],
    edgeTypes: [],
    totalWeight: 1.0,
  }];
  const paths: ArbitragePath[] = [];

  while (queue.length > 0 && paths.length < limit * 2) { // Collect extra for sorting
    const entry = queue.shift()!;
    const { market, path, weights, edgeTypes, totalWeight } = entry;

    // Skip if we've visited this market in current path depth
    if (path.length > maxDepth + 1) continue;

    // Get neighbors from adjacency list
    const neighbors = adjacencyList.get(market) || [];

    for (const neighbor of neighbors) {
      // Skip weak edges
      if (Math.abs(neighbor.weight) < minWeight) continue;

      // Skip if already in current path (avoid cycles in BFS)
      if (path.includes(neighbor.market_id)) continue;

      // Only consider arbitrage and correlation edges for path finding
      if (!["arbitrage", "correlation"].includes(neighbor.edge_type)) continue;

      const newPath = [...path, neighbor.market_id];
      const newWeights = [...weights, neighbor.weight];
      const newEdgeTypes = [...edgeTypes, neighbor.edge_type];
      const newTotalWeight = totalWeight * Math.abs(neighbor.weight);

      // Calculate opportunity in basis points
      // For arbitrage edges, negative weight indicates profit opportunity
      const opportunityBps = calculateOpportunityBps(newWeights, newEdgeTypes);

      // Record path if it has positive opportunity
      if (opportunityBps > 0) {
        paths.push({
          markets: newPath,
          weights: newWeights,
          total_weight: newTotalWeight,
          opportunity_bps: opportunityBps,
          edge_types: newEdgeTypes,
        });
      }

      // Continue BFS if not at max depth
      if (newPath.length <= maxDepth) {
        queue.push({
          market: neighbor.market_id,
          path: newPath,
          weights: newWeights,
          edgeTypes: newEdgeTypes,
          totalWeight: newTotalWeight,
        });
      }
    }
  }

  // Sort by opportunity (highest first) and return top N
  return paths
    .sort((a, b) => b.opportunity_bps - a.opportunity_bps)
    .slice(0, limit);
}

/**
 * Calculate opportunity in basis points from path weights.
 * Arbitrage edges have negative weights when profitable.
 */
function calculateOpportunityBps(weights: number[], edgeTypes: EdgeType[]): number {
  let opportunityFactor = 0;

  for (let i = 0; i < weights.length; i++) {
    if (edgeTypes[i] === "arbitrage") {
      // Arbitrage weight is log(1 - spread), negative when profitable
      // Convert back: spread = 1 - exp(weight)
      // Opportunity = spread * 10000 bps
      opportunityFactor += (1 - Math.exp(weights[i])) * 10000;
    } else if (edgeTypes[i] === "correlation" && weights[i] > 0.8) {
      // High correlation suggests potential cross-market opportunity
      opportunityFactor += (weights[i] - 0.8) * 1000; // Small bonus for correlated markets
    }
  }

  return Math.round(opportunityFactor);
}

// ============================================================
// Bellman-Ford for Negative Cycle Detection
// Run as cron job (every 15 min) - O(V*E) too slow for hot path
// ============================================================

/**
 * Internal edge representation for Bellman-Ford.
 */
interface BFEdge {
  source: string;
  target: string;
  weight: number;
  edgeType: EdgeType;
}

/**
 * Detect negative cycles in the graph using Bellman-Ford algorithm.
 * Negative cycles represent arbitrage opportunities through hedge relationships.
 *
 * Edge weight convention:
 * - correlation: +weight (positive correlation)
 * - hedge: -weight (inverse correlation, stored as negative)
 * - arbitrage: log(1 - spread) (negative when profitable)
 *
 * @param adjacencyList - Map of market_id -> neighbors
 * @returns Array of detected negative cycles
 */
export function detectNegativeCycles(
  adjacencyList: Map<string, GraphNeighbor[]>
): NegativeCycle[] {
  const markets = Array.from(adjacencyList.keys());
  if (markets.length === 0) return [];

  // Build edge list with proper weight signs
  const edges: BFEdge[] = [];
  for (const [source, neighbors] of adjacencyList) {
    for (const neighbor of neighbors) {
      // Hedge edges are stored with positive weight but represent negative correlation
      // Convert to negative for Bellman-Ford cycle detection
      const weight = neighbor.edge_type === "hedge"
        ? -Math.abs(neighbor.weight)
        : neighbor.weight;

      edges.push({
        source,
        target: neighbor.market_id,
        weight,
        edgeType: neighbor.edge_type,
      });
    }
  }

  // Initialize distances
  const dist = new Map<string, number>();
  const pred = new Map<string, string | null>();

  for (const m of markets) {
    dist.set(m, Infinity);
    pred.set(m, null);
  }

  // Run from each vertex to find all cycles (markets may be disconnected)
  const allCycles: NegativeCycle[] = [];
  const processedInCycle = new Set<string>();

  for (const startVertex of markets) {
    if (processedInCycle.has(startVertex)) continue;

    // Reset distances for new starting point
    for (const m of markets) {
      dist.set(m, Infinity);
      pred.set(m, null);
    }
    dist.set(startVertex, 0);

    // Relax edges V-1 times
    for (let i = 0; i < markets.length - 1; i++) {
      let updated = false;
      for (const edge of edges) {
        const srcDist = dist.get(edge.source)!;
        if (srcDist === Infinity) continue;

        const newDist = srcDist + edge.weight;
        if (newDist < dist.get(edge.target)!) {
          dist.set(edge.target, newDist);
          pred.set(edge.target, edge.source);
          updated = true;
        }
      }
      // Early termination if no updates
      if (!updated) break;
    }

    // Detect negative cycles (V-th iteration finds improvements)
    for (const edge of edges) {
      const srcDist = dist.get(edge.source)!;
      if (srcDist === Infinity) continue;

      if (srcDist + edge.weight < dist.get(edge.target)!) {
        // Found negative cycle - trace back to find it
        const cycle = traceNegativeCycle(pred, edge.target, markets.length);

        if (cycle.length > 0) {
          // Mark all markets in cycle as processed
          for (const m of cycle) {
            processedInCycle.add(m);
          }

          const totalWeight = calculateCycleWeight(adjacencyList, cycle);

          allCycles.push({
            cycle_id: `cycle_${Date.now()}_${allCycles.length}`,
            markets: cycle,
            total_weight: totalWeight,
            opportunity_type: determineOpportunityType(adjacencyList, cycle),
            detected_at: Date.now() * 1000, // Convert to microseconds
          });
        }
      }
    }
  }

  return allCycles;
}

/**
 * Trace back from a node to find the negative cycle.
 */
function traceNegativeCycle(
  pred: Map<string, string | null>,
  start: string,
  maxIterations: number
): string[] {
  const visited = new Map<string, number>();
  let current: string | null = start;
  let iteration = 0;

  // Find a node in the cycle
  while (current && !visited.has(current) && iteration < maxIterations) {
    visited.set(current, iteration);
    current = pred.get(current) ?? null;
    iteration++;
  }

  if (!current || !visited.has(current)) {
    return []; // No cycle found
  }

  // Trace the cycle
  const cycleStart = current;
  const cycle = [cycleStart];
  current = pred.get(cycleStart) ?? null;

  let safetyCounter = 0;
  while (current && current !== cycleStart && safetyCounter < maxIterations) {
    cycle.push(current);
    current = pred.get(current) ?? null;
    safetyCounter++;
  }

  return cycle.reverse();
}

/**
 * Calculate total weight of a cycle.
 */
function calculateCycleWeight(
  adjacencyList: Map<string, GraphNeighbor[]>,
  cycle: string[]
): number {
  let totalWeight = 0;

  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i];
    const to = cycle[(i + 1) % cycle.length];

    const neighbors = adjacencyList.get(from) || [];
    const edge = neighbors.find(n => n.market_id === to);

    if (edge) {
      // Apply same weight transformation as in cycle detection
      const weight = edge.edge_type === "hedge"
        ? -Math.abs(edge.weight)
        : edge.weight;
      totalWeight += weight;
    }
  }

  return totalWeight;
}

/**
 * Determine the type of arbitrage opportunity in a cycle.
 */
function determineOpportunityType(
  adjacencyList: Map<string, GraphNeighbor[]>,
  cycle: string[]
): "hedge_loop" | "inverse_correlation" {
  let hedgeCount = 0;

  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i];
    const to = cycle[(i + 1) % cycle.length];

    const neighbors = adjacencyList.get(from) || [];
    const edge = neighbors.find(n => n.market_id === to);

    if (edge?.edge_type === "hedge") {
      hedgeCount++;
    }
  }

  // If majority of edges are hedge edges, it's a hedge loop
  return hedgeCount > cycle.length / 2 ? "hedge_loop" : "inverse_correlation";
}

// ============================================================
// Dijkstra's Algorithm for Shortest Path
// ============================================================

/**
 * Find shortest path between two markets using Dijkstra's algorithm.
 * Note: Only works with non-negative weights. For graphs with negative
 * weights (hedge edges), use Bellman-Ford or transform weights.
 *
 * @param from - Starting market ID
 * @param to - Target market ID
 * @param adjacencyList - Map of market_id -> neighbors
 * @param options - Query options
 * @returns Shortest path or null if no path exists
 */
export function findShortestPath(
  from: string,
  to: string,
  adjacencyList: Map<string, GraphNeighbor[]>,
  options: GraphQueryOptions = {}
): ShortestPath | null {
  const { minWeight = 0, edgeTypes } = options;

  // Transform weights: use 1 - |weight| so higher weight = shorter path
  // This makes sense because weight represents correlation strength
  const transformWeight = (w: number) => 1 - Math.abs(w);

  const dist = new Map<string, number>();
  const prev = new Map<string, { market: string; edgeType: EdgeType } | null>();
  const visited = new Set<string>();

  // Priority queue (simple array, sorted on insert)
  const pq: Array<{ market: string; distance: number }> = [];

  dist.set(from, 0);
  pq.push({ market: from, distance: 0 });

  while (pq.length > 0) {
    // Get minimum distance node
    pq.sort((a, b) => a.distance - b.distance);
    const { market: current, distance: currentDist } = pq.shift()!;

    if (visited.has(current)) continue;
    visited.add(current);

    // Found target
    if (current === to) {
      return reconstructPath(from, to, prev, dist);
    }

    const neighbors = adjacencyList.get(current) || [];

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.market_id)) continue;
      if (Math.abs(neighbor.weight) < minWeight) continue;
      if (edgeTypes && !edgeTypes.includes(neighbor.edge_type)) continue;

      const edgeWeight = transformWeight(neighbor.weight);
      const newDist = currentDist + edgeWeight;

      if (!dist.has(neighbor.market_id) || newDist < dist.get(neighbor.market_id)!) {
        dist.set(neighbor.market_id, newDist);
        prev.set(neighbor.market_id, { market: current, edgeType: neighbor.edge_type });
        pq.push({ market: neighbor.market_id, distance: newDist });
      }
    }
  }

  return null; // No path found
}

/**
 * Reconstruct path from predecessor map.
 */
function reconstructPath(
  from: string,
  to: string,
  prev: Map<string, { market: string; edgeType: EdgeType } | null>,
  dist: Map<string, number>
): ShortestPath {
  const path: string[] = [];
  const edgeTypes: EdgeType[] = [];
  let current: string | null = to;

  while (current) {
    path.unshift(current);
    const prevEntry = prev.get(current);
    if (prevEntry) {
      edgeTypes.unshift(prevEntry.edgeType);
      current = prevEntry.market;
    } else {
      current = null;
    }
  }

  return {
    from,
    to,
    path,
    total_weight: dist.get(to) ?? 0,
    edge_types: edgeTypes,
  };
}

// ============================================================
// Graph Statistics and Utilities
// ============================================================

/**
 * Calculate basic statistics about the graph.
 */
export interface GraphStats {
  marketCount: number;
  edgeCount: number;
  avgDegree: number;
  maxDegree: number;
  edgeTypeCounts: Record<EdgeType, number>;
  componentCount: number;
}

/**
 * Calculate statistics for the graph.
 */
export function calculateGraphStats(
  adjacencyList: Map<string, GraphNeighbor[]>
): GraphStats {
  let edgeCount = 0;
  let maxDegree = 0;
  const edgeTypeCounts: Record<EdgeType, number> = {
    correlation: 0,
    hedge: 0,
    causal: 0,
    arbitrage: 0,
  };

  for (const neighbors of adjacencyList.values()) {
    edgeCount += neighbors.length;
    maxDegree = Math.max(maxDegree, neighbors.length);

    for (const neighbor of neighbors) {
      edgeTypeCounts[neighbor.edge_type]++;
    }
  }

  const marketCount = adjacencyList.size;

  return {
    marketCount,
    edgeCount,
    avgDegree: marketCount > 0 ? edgeCount / marketCount : 0,
    maxDegree,
    edgeTypeCounts,
    componentCount: countConnectedComponents(adjacencyList),
  };
}

/**
 * Count connected components in the graph using BFS.
 */
function countConnectedComponents(
  adjacencyList: Map<string, GraphNeighbor[]>
): number {
  const visited = new Set<string>();
  let components = 0;

  for (const market of adjacencyList.keys()) {
    if (visited.has(market)) continue;

    // BFS from this market
    const queue = [market];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const neighbors = adjacencyList.get(current) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.market_id)) {
          queue.push(neighbor.market_id);
        }
      }
    }

    components++;
  }

  return components;
}

/**
 * Get N-hop neighbors from a market.
 */
export function getNHopNeighbors(
  startMarket: string,
  adjacencyList: Map<string, GraphNeighbor[]>,
  hops: number,
  options: GraphQueryOptions = {}
): Map<string, { distance: number; path: string[] }> {
  const { minWeight = 0 } = options;

  const result = new Map<string, { distance: number; path: string[] }>();
  const queue: Array<{ market: string; distance: number; path: string[] }> = [
    { market: startMarket, distance: 0, path: [startMarket] }
  ];
  const visited = new Set<string>([startMarket]);

  while (queue.length > 0) {
    const { market, distance, path } = queue.shift()!;

    if (distance > 0) {
      result.set(market, { distance, path });
    }

    if (distance >= hops) continue;

    const neighbors = adjacencyList.get(market) || [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.market_id)) continue;
      if (Math.abs(neighbor.weight) < minWeight) continue;

      visited.add(neighbor.market_id);
      queue.push({
        market: neighbor.market_id,
        distance: distance + 1,
        path: [...path, neighbor.market_id],
      });
    }
  }

  return result;
}
