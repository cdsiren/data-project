import { useState, useEffect, useCallback, useRef } from "react";
import type { TriggerEvent } from "@/types";
import { getTriggerSSEUrl, authenticate, resetAuth } from "@/lib/api";
import { logger } from "@/lib/logger";
import { SSE_CONFIG } from "@/lib/constants";

interface UseTriggerStreamResult {
  events: TriggerEvent[];
  connected: boolean;
  error: string | null;
  reconnect: () => void;
}

/**
 * Hook to subscribe to SSE trigger events stream
 * Authenticates first, then connects with session cookie
 */
export function useTriggerStream(): UseTriggerStreamResult {
  const [events, setEvents] = useState<TriggerEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const isMountedRef = useRef(true);

  // Stable cleanup function
  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(
    (connectFn: () => void) => {
      if (reconnectAttempts.current < SSE_CONFIG.MAX_RECONNECT_ATTEMPTS) {
        const delay =
          SSE_CONFIG.RECONNECT_BASE_DELAY_MS *
          Math.pow(
            SSE_CONFIG.RECONNECT_BACKOFF_FACTOR,
            reconnectAttempts.current
          );
        setError(
          `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`
        );

        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            reconnectAttempts.current++;
            connectFn();
          }
        }, delay);
      } else {
        setError("Max reconnect attempts reached. Click to retry.");
      }
    },
    []
  );

  // Single connect function used by both mount and manual reconnect
  const connect = useCallback(async () => {
    cleanup();

    const authenticated = await authenticate();
    if (!authenticated) {
      if (isMountedRef.current) {
        setError("Authentication failed - check VITE_DASHBOARD_API_KEY");
      }
      return;
    }

    const url = getTriggerSSEUrl();
    const eventSource = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      if (!isMountedRef.current) return;
      setConnected(true);
      setError(null);
      reconnectAttempts.current = 0;
    };

    eventSource.onmessage = (event) => {
      if (!isMountedRef.current) return;

      try {
        const triggerEvent = JSON.parse(event.data) as TriggerEvent;
        setEvents((prev) =>
          [triggerEvent, ...prev].slice(0, SSE_CONFIG.MAX_EVENTS)
        );
      } catch (e) {
        logger.error("SSE", "Failed to parse trigger event:", e);
      }
    };

    eventSource.onerror = () => {
      if (!isMountedRef.current) return;

      setConnected(false);
      eventSource.close();
      resetAuth();
      scheduleReconnect(connect);
    };
  }, [cleanup, scheduleReconnect]);

  useEffect(() => {
    isMountedRef.current = true;
    connect();

    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup]);

  // Manual reconnect resets attempts and connects
  const reconnect = useCallback(() => {
    reconnectAttempts.current = 0;
    connect();
  }, [connect]);

  return { events, connected, error, reconnect };
}
