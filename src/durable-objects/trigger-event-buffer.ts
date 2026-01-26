// src/durable-objects/trigger-event-buffer.ts
// Durable Object for SSE broadcasting of trigger events to dashboard clients

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { TriggerEvent } from "../core/triggers";

interface BufferedEvent {
  event: TriggerEvent;
  timestamp: number;
}

interface SSEConnection {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  createdAt: number;
}

/**
 * TriggerEventBuffer - SSE broadcasting for dashboard clients
 *
 * Features:
 * - Maintains SSE connections from dashboard clients
 * - Stores a ring buffer of recent trigger events (last 100)
 * - Broadcasts new events to all connected clients in real-time
 * - Handles client reconnection with event replay
 */
export class TriggerEventBuffer extends DurableObject<Env> {
  private connections: Map<string, SSEConnection> = new Map();
  private eventBuffer: BufferedEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 100;
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 second heartbeat
  private readonly FLUSH_DEBOUNCE_MS = 1000; // Debounce storage writes to 1/second
  private encoder = new TextEncoder();
  private nextAlarmTime: number | null = null;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null; // Guard against race conditions
  private bufferDirty = false; // Track if buffer needs flushing
  private flushScheduled = false; // Prevent multiple flush schedules

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Load event buffer from storage on first access
   * Uses promise caching to prevent double-init race condition
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializationPromise) {
      this.initializationPromise = this.doInitialize();
    }
    await this.initializationPromise;
  }

  private async doInitialize(): Promise<void> {
    const stored = await this.ctx.storage.get<BufferedEvent[]>("eventBuffer");
    if (stored) {
      this.eventBuffer = stored;
      console.log(`[SSE] Restored ${this.eventBuffer.length} buffered events from storage`);
    }
    this.initialized = true;
  }

  /**
   * Persist event buffer to storage
   */
  private async persistBuffer(): Promise<void> {
    await this.ctx.storage.put("eventBuffer", this.eventBuffer);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    const url = new URL(request.url);

    switch (url.pathname) {
      case "/sse":
        return this.handleSSE();
      case "/publish":
        return this.handlePublish(request);
      case "/publish-batch":
        return this.handlePublishBatch(request);
      case "/status":
        return this.handleStatus();
      case "/events":
        return this.handleGetEvents(url);
      case "/clear":
        return this.handleClear();
      default:
        return new Response("not found", { status: 404 });
    }
  }

  /**
   * Handle SSE connection from dashboard client
   */
  private handleSSE(): Response {
    const connectionId = crypto.randomUUID();

    // Create a transform stream for SSE
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Store the connection
    this.connections.set(connectionId, {
      writer,
      createdAt: Date.now(),
    });

    // Send initial connection message and recent events
    this.ctx.waitUntil(this.initializeConnection(connectionId, writer));

    // Schedule heartbeat if not already scheduled
    this.ctx.waitUntil(this.scheduleHeartbeat());

    console.log(`[SSE] Client ${connectionId.slice(0, 8)} connected, ${this.connections.size} total connections`);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  /**
   * Initialize connection with recent events
   */
  private async initializeConnection(
    connectionId: string,
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): Promise<void> {
    try {
      // Send connection established comment
      await this.sendToWriter(writer, ": connected\n\n");

      // Send recent events (oldest first for proper ordering)
      for (const buffered of this.eventBuffer) {
        await this.sendToWriter(
          writer,
          `data: ${JSON.stringify(buffered.event)}\n\n`
        );
      }

      console.log(
        `[SSE] Client ${connectionId.slice(0, 8)} initialized, ` +
        `sent ${this.eventBuffer.length} buffered events`
      );
    } catch (error) {
      console.error(`[SSE] Failed to initialize connection ${connectionId}:`, error);
      this.connections.delete(connectionId);
    }
  }

  /**
   * Handle event publish from OrderbookManager
   * Uses debounced storage writes to avoid performance bottleneck at high event rates
   */
  private async handlePublish(request: Request): Promise<Response> {
    try {
      const event = await request.json() as TriggerEvent;

      // Add to ring buffer
      this.eventBuffer.push({
        event,
        timestamp: Date.now(),
      });

      // Trim buffer to max size - single splice is O(1) vs O(n) for shift loop
      if (this.eventBuffer.length > this.MAX_BUFFER_SIZE) {
        this.eventBuffer.splice(0, this.eventBuffer.length - this.MAX_BUFFER_SIZE);
      }

      // Mark buffer as dirty (needs persistence)
      this.bufferDirty = true;

      // Schedule debounced flush (non-blocking)
      this.scheduleDebouncedFlush();

      // Broadcast to all connected clients (fire-and-forget)
      this.broadcast(event);

      return Response.json({
        status: "published",
        connections: this.connections.size,
        buffer_size: this.eventBuffer.length,
      });
    } catch (error) {
      return Response.json(
        { status: "error", message: String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle batch event publish from OrderbookManager
   * Reduces DO hop overhead when multiple triggers fire in one evaluation
   */
  private async handlePublishBatch(request: Request): Promise<Response> {
    try {
      const events = await request.json() as TriggerEvent[];

      if (!Array.isArray(events) || events.length === 0) {
        return Response.json({ status: "ok", count: 0, connections: this.connections.size });
      }

      const now = Date.now();

      // Add all events to ring buffer
      for (const event of events) {
        this.eventBuffer.push({ event, timestamp: now });
      }

      // Trim buffer to max size - single splice
      if (this.eventBuffer.length > this.MAX_BUFFER_SIZE) {
        this.eventBuffer.splice(0, this.eventBuffer.length - this.MAX_BUFFER_SIZE);
      }

      // Mark buffer as dirty (needs persistence)
      this.bufferDirty = true;

      // Schedule debounced flush (non-blocking)
      this.scheduleDebouncedFlush();

      // Broadcast all events in a single write per connection
      this.broadcastBatch(events);

      return Response.json({
        status: "published",
        count: events.length,
        connections: this.connections.size,
        buffer_size: this.eventBuffer.length,
      });
    } catch (error) {
      return Response.json(
        { status: "error", message: String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Schedule a debounced flush to storage
   * Batches multiple events into a single write (max 1 write per FLUSH_DEBOUNCE_MS)
   */
  private scheduleDebouncedFlush(): void {
    if (this.flushScheduled) return;

    this.flushScheduled = true;
    this.ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, this.FLUSH_DEBOUNCE_MS));
        if (this.bufferDirty) {
          await this.persistBuffer();
          this.bufferDirty = false;
        }
        this.flushScheduled = false;
      })()
    );
  }

  /**
   * Broadcast event to all connected clients (fire-and-forget, non-blocking)
   * Serializes once and reuses bytes for all connections
   */
  private broadcast(event: TriggerEvent): void {
    if (this.connections.size === 0) return;

    // Serialize once, reuse for all connections
    const messageBytes = this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

    // Fire-and-forget to each connection
    for (const [id, conn] of this.connections) {
      conn.writer.write(messageBytes).catch((error) => {
        console.error(`[SSE] Connection ${id.slice(0, 8)} write failed:`, error);
        this.connections.delete(id);
      });
    }
  }

  /**
   * Broadcast multiple events to all connected clients (batched)
   * Reduces write overhead when multiple triggers fire in one evaluation
   */
  private broadcastBatch(events: TriggerEvent[]): void {
    if (this.connections.size === 0 || events.length === 0) return;

    // Serialize all events once, concatenate into single message
    const message = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
    const messageBytes = this.encoder.encode(message);

    // Fire-and-forget to each connection
    for (const [id, conn] of this.connections) {
      conn.writer.write(messageBytes).catch((error) => {
        console.error(`[SSE] Connection ${id.slice(0, 8)} batch write failed:`, error);
        this.connections.delete(id);
      });
    }
  }

  /**
   * Send data to a writer (for initialization and heartbeat)
   */
  private async sendToWriter(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    data: string
  ): Promise<void> {
    await writer.write(this.encoder.encode(data));
  }

  /**
   * Handle status request
   */
  private handleStatus(): Response {
    return Response.json({
      connections: this.connections.size,
      buffer_size: this.eventBuffer.length,
      oldest_event: this.eventBuffer[0]?.timestamp,
      newest_event: this.eventBuffer[this.eventBuffer.length - 1]?.timestamp,
    });
  }

  /**
   * Clear event buffer - removes all buffered events
   */
  private async handleClear(): Promise<Response> {
    const clearedCount = this.eventBuffer.length;
    this.eventBuffer = [];
    await this.persistBuffer();
    return Response.json({ status: "cleared", events_removed: clearedCount });
  }

  /**
   * Handle get events request - returns buffered events for debugging/validation
   */
  private handleGetEvents(url: URL): Response {
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const typeFilter = url.searchParams.get("type")?.toUpperCase();

    let events = this.eventBuffer.slice(-limit);

    if (typeFilter) {
      events = events.filter((e) => e.event.trigger_type === typeFilter);
    }

    // Group by trigger type for summary
    const typeCounts: Record<string, number> = {};
    for (const buffered of this.eventBuffer) {
      const type = buffered.event.trigger_type;
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    return Response.json({
      total_buffered: this.eventBuffer.length,
      returned: events.length,
      type_filter: typeFilter || null,
      types_summary: typeCounts,
      events: events.map((e) => ({
        trigger_type: e.event.trigger_type,
        trigger_id: e.event.trigger_id,
        asset_id: e.event.asset_id?.slice(0, 20) + "...",
        fired_at: new Date(e.event.fired_at / 1000).toISOString(),
        threshold: e.event.threshold,
        actual_value: e.event.actual_value,
        best_bid: e.event.best_bid,
        best_ask: e.event.best_ask,
        buffered_at: new Date(e.timestamp).toISOString(),
      })),
    });
  }

  /**
   * Schedule heartbeat alarm
   */
  private async scheduleHeartbeat(): Promise<void> {
    const targetTime = Date.now() + this.HEARTBEAT_INTERVAL_MS;
    if (this.nextAlarmTime === null || targetTime < this.nextAlarmTime) {
      await this.ctx.storage.setAlarm(targetTime);
      this.nextAlarmTime = targetTime;
    }
  }

  /**
   * Alarm handler for heartbeat and buffer flush
   */
  async alarm(): Promise<void> {
    this.nextAlarmTime = null;

    // Always flush dirty buffer on alarm (ensures persistence before hibernation)
    if (this.bufferDirty) {
      await this.persistBuffer();
      this.bufferDirty = false;
    }

    if (this.connections.size === 0) {
      // No connections, don't schedule another heartbeat
      return;
    }

    // Send heartbeat comment to all connections
    const deadConnections: string[] = [];

    for (const [id, conn] of this.connections) {
      try {
        await this.sendToWriter(conn.writer, ": heartbeat\n\n");
      } catch {
        deadConnections.push(id);
      }
    }

    // Clean up dead connections
    for (const id of deadConnections) {
      this.connections.delete(id);
    }

    if (deadConnections.length > 0) {
      console.log(`[SSE] Heartbeat cleaned up ${deadConnections.length} dead connections`);
    }

    // Schedule next heartbeat if we still have connections
    if (this.connections.size > 0) {
      await this.scheduleHeartbeat();
    }
  }
}
