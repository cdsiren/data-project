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

  // Queue size limit to prevent memory exhaustion on dense graphs
  // For a complete graph with branching factor B and depth D, queue can grow to O(B^D)
  const MAX_QUEUE_SIZE = 10000;
  const MAX_PATHS = limit * 2; // Collect extra for sorting

  const queue: BFSQueueEntry[] = [{
    market: startMarket,
    path: [startMarket],
    weights: [],
    edgeTypes: [],
    totalWeight: 1.0,
  }];
  const paths: ArbitragePath[] = [];
  let queueLimitReached = false;

  while (queue.length > 0 && paths.length < MAX_PATHS) {
    const entry = queue.shift()!;
    const { market, path, weights, edgeTypes, totalWeight } = entry;

    // Skip if path exceeds max depth
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

      // Continue BFS if not at max depth and queue not full
      if (newPath.length <= maxDepth) {
        if (queue.length >= MAX_QUEUE_SIZE) {
          if (!queueLimitReached) {
            console.warn(
              `[findArbitragePaths] Queue size limit reached (${MAX_QUEUE_SIZE}). ` +
              `Consider increasing minWeight or reducing maxDepth.`
            );
            queueLimitReached = true;
          }
          // Stop adding to queue but continue processing existing entries
          continue;
        }
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
 *
 * Weight formula in SQL: log(1 + Σ(strength × source_weight × decay))
 * To extract signal strength: exp(weight) - 1
 *
 * Arbitrage edges represent detected price discrepancies.
 * Correlation edges with high weights suggest cross-market opportunities.
 */
function calculateOpportunityBps(weights: number[], edgeTypes: EdgeType[]): number {
  let opportunityFactor = 0;

  for (let i = 0; i < weights.length; i++) {
    // Extract signal strength from log-scaled weight: exp(weight) - 1
    const strength = Math.exp(weights[i]) - 1;

    if (edgeTypes[i] === "arbitrage") {
      // Arbitrage edges store signal strength directly
      // Convert strength to basis points (0.01 = 1% = 100 bps)
      opportunityFactor += Math.max(0, strength) * 10000;
    } else if (edgeTypes[i] === "correlation" && strength > 0.8) {
      // High correlation suggests potential cross-market opportunity
      // Only count the portion above 0.8 threshold
      opportunityFactor += Math.max(0, strength - 0.8) * 1000;
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
 * Normalize a cycle for deduplication by rotating to start with lexicographically smallest element.
 * Cycles like A→B→C and B→C→A are the same cycle and should be deduplicated.
 */
function normalizeCycle(cycle: string[]): string[] {
  if (cycle.length === 0) return cycle;

  // Find index of lexicographically smallest element
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex]) {
      minIndex = i;
    }
  }

  // Rotate to start with smallest element
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}

/**
 * Detect negative cycles in the graph using Bellman-Ford algorithm.
 * Negative cycles represent arbitrage opportunities through hedge relationships.
 *
 * Uses a virtual source node to reduce complexity from O(V²E) to O(VE):
 * - Add virtual source with 0-weight edges to all vertices
 * - Run Bellman-Ford once from virtual source
 * - This finds all negative cycles including in disconnected components
 *
 * Edge weight convention:
 * - correlation: +weight (positive correlation)
 * - hedge: -weight (inverse correlation, stored as negative)
 * - arbitrage: log(1 - spread) (negative when profitable)
 *
 * @param adjacencyList - Map of market_id -> neighbors
 * @returns Array of detected negative cycles (deduplicated)
 */
export function detectNegativeCycles(
  adjacencyList: Map<string, GraphNeighbor[]>
): NegativeCycle[] {
  const markets = Array.from(adjacencyList.keys());
  if (markets.length === 0) return [];

  // Virtual source node for O(VE) complexity (instead of O(V²E) from per-vertex runs)
  const VIRTUAL_SOURCE = "__VIRTUAL_SOURCE__";

  // Build edge list with proper weight signs
  const edges: BFEdge[] = [];

  // Add 0-weight edges from virtual source to all vertices
  // This ensures all vertices are reachable, handling disconnected components
  for (const market of markets) {
    edges.push({
      source: VIRTUAL_SOURCE,
      target: market,
      weight: 0,
      edgeType: "correlation", // Placeholder, not used in cycle detection
    });
  }

  // Add real edges
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

  // Initialize distances (virtual source has distance 0, all others Infinity)
  const dist = new Map<string, number>();
  const pred = new Map<string, string | null>();

  dist.set(VIRTUAL_SOURCE, 0);
  pred.set(VIRTUAL_SOURCE, null);
  for (const m of markets) {
    dist.set(m, Infinity);
    pred.set(m, null);
  }

  // Relax edges V times (V = markets.length + 1 for virtual source)
  const numVertices = markets.length + 1;
  for (let i = 0; i < numVertices - 1; i++) {
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
  const allCycles: NegativeCycle[] = [];
  const processedInCycle = new Set<string>();
  // Track detected cycles by normalized form to deduplicate rotations (A→B→C vs B→C→A)
  const detectedCycleKeys = new Set<string>();

  for (const edge of edges) {
    // Skip virtual source edges (they can't be part of real cycles)
    if (edge.source === VIRTUAL_SOURCE) continue;

    const srcDist = dist.get(edge.source)!;
    if (srcDist === Infinity) continue;

    if (srcDist + edge.weight < dist.get(edge.target)!) {
      // Found negative cycle - trace back to find it
      const cycle = traceNegativeCycle(pred, edge.target, markets.length, VIRTUAL_SOURCE);

      // Filter out trivial 2-node cycles (caused by bidirectional hedge edges)
      // Real arbitrage opportunities require at least 3 markets to form a meaningful cycle
      if (cycle.length >= 3) {
        // Normalize cycle for deduplication (rotate to start with smallest element)
        const normalizedCycle = normalizeCycle(cycle);
        const cycleKey = normalizedCycle.join("->");

        // Skip if we've already detected this cycle (as a rotation)
        if (detectedCycleKeys.has(cycleKey)) continue;
        detectedCycleKeys.add(cycleKey);

        // Mark all markets in cycle as processed
        for (const m of normalizedCycle) {
          processedInCycle.add(m);
        }

        const totalWeight = calculateCycleWeight(adjacencyList, normalizedCycle);

        allCycles.push({
          cycle_id: `cycle_${Date.now()}_${allCycles.length}`,
          markets: normalizedCycle,
          total_weight: totalWeight,
          opportunity_type: determineOpportunityType(adjacencyList, normalizedCycle),
          detected_at: Date.now(), // Milliseconds (standard JS timestamp)
        });
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
  maxIterations: number,
  virtualSource?: string
): string[] {
  const visited = new Map<string, number>();
  let current: string | null = start;
  let iteration = 0;

  // Find a node in the cycle (stop if we hit virtual source)
  while (current && current !== virtualSource && !visited.has(current) && iteration < maxIterations) {
    visited.set(current, iteration);
    current = pred.get(current) ?? null;
    iteration++;
  }

  // If we hit virtual source, there's no real cycle from this path
  if (!current || current === virtualSource || !visited.has(current)) {
    return []; // No cycle found
  }

  // Trace the cycle
  const cycleStart = current;
  const cycle = [cycleStart];
  current = pred.get(cycleStart) ?? null;

  let safetyCounter = 0;
  while (current && current !== cycleStart && current !== virtualSource && safetyCounter < maxIterations) {
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
// Min-Heap Priority Queue for Dijkstra's Algorithm
// ============================================================

/**
 * Min-heap implementation for O(log N) priority queue operations.
 * Replaces O(N log N) array sort per iteration with O(log N) heap operations.
 */
class MinHeap<T> {
  private heap: Array<{ item: T; priority: number }> = [];

  get length(): number {
    return this.heap.length;
  }

  push(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): { item: T; priority: number } | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return min;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[parentIndex].priority <= this.heap[index].priority) break;
      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      let minIndex = index;
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;

      if (leftChild < this.heap.length && this.heap[leftChild].priority < this.heap[minIndex].priority) {
        minIndex = leftChild;
      }
      if (rightChild < this.heap.length && this.heap[rightChild].priority < this.heap[minIndex].priority) {
        minIndex = rightChild;
      }
      if (minIndex === index) break;

      [this.heap[index], this.heap[minIndex]] = [this.heap[minIndex], this.heap[index]];
      index = minIndex;
    }
  }
}

// ============================================================
// Dijkstra's Algorithm for Shortest Path
// ============================================================

/**
 * Find shortest path between two markets using Dijkstra's algorithm.
 * Note: Only works with non-negative weights. For graphs with negative
 * weights (hedge edges), use Bellman-Ford or transform weights.
 *
 * Time complexity: O((V + E) log V) using min-heap priority queue.
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

  // Transform weights: use 1 / (1 + |weight|) so higher weight = shorter path
  // This ensures non-negative distances for Dijkstra (required for correctness)
  // Range: (0, 1] - always positive regardless of input weight magnitude
  const transformWeight = (w: number) => 1 / (1 + Math.abs(w));

  const dist = new Map<string, number>();
  const prev = new Map<string, { market: string; edgeType: EdgeType } | null>();
  const visited = new Set<string>();

  // Min-heap priority queue for O(log N) extraction
  const pq = new MinHeap<string>();

  dist.set(from, 0);
  pq.push(from, 0);

  while (pq.length > 0) {
    // Get minimum distance node in O(log N)
    const entry = pq.pop()!;
    const current = entry.item;
    const currentDist = entry.priority;

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
        pq.push(neighbor.market_id, newDist);
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
