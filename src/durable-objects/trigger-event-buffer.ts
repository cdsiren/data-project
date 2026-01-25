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
  private encoder = new TextEncoder();
  private nextAlarmTime: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/sse":
        return this.handleSSE();
      case "/publish":
        return this.handlePublish(request);
      case "/status":
        return this.handleStatus();
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
   */
  private async handlePublish(request: Request): Promise<Response> {
    try {
      const event = await request.json() as TriggerEvent;

      // Add to ring buffer
      this.eventBuffer.push({
        event,
        timestamp: Date.now(),
      });

      // Trim buffer to max size
      while (this.eventBuffer.length > this.MAX_BUFFER_SIZE) {
        this.eventBuffer.shift();
      }

      // Broadcast to all connected clients
      await this.broadcast(event);

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
   * Broadcast event to all connected clients
   */
  private async broadcast(event: TriggerEvent): Promise<void> {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    const deadConnections: string[] = [];

    const sendPromises = Array.from(this.connections.entries()).map(
      async ([id, conn]) => {
        try {
          await this.sendToWriter(conn.writer, message);
        } catch {
          deadConnections.push(id);
        }
      }
    );

    await Promise.all(sendPromises);

    // Clean up dead connections
    for (const id of deadConnections) {
      this.connections.delete(id);
    }

    if (deadConnections.length > 0) {
      console.log(
        `[SSE] Cleaned up ${deadConnections.length} dead connections, ` +
        `${this.connections.size} remaining`
      );
    }
  }

  /**
   * Send data to a writer
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
   * Alarm handler for heartbeat
   */
  async alarm(): Promise<void> {
    this.nextAlarmTime = null;

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
