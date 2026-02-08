// src/services/webhook-signer.ts
// Centralized HMAC signature generation for webhook authentication
// Eliminates duplicate signing logic across trigger webhooks and lifecycle webhooks

/**
 * Utility class for webhook HMAC signature generation.
 * Uses Web Crypto API (SubtleCrypto) for secure signing.
 *
 * Used by:
 * - Trigger webhook dispatch (orderbook-manager.ts)
 * - Market lifecycle webhook dispatch (market-lifecycle.ts)
 */
export class WebhookSigner {
  private static encoder = new TextEncoder();

  /**
   * Generate HMAC-SHA256 signature for a payload.
   *
   * @param payload - The string payload to sign (usually JSON)
   * @param secret - The HMAC secret key
   * @returns Base64-encoded signature
   */
  static async signPayload(payload: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      this.encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      this.encoder.encode(payload)
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  /**
   * Add X-Signature header to a headers object if secret is provided.
   * No-op if secret is undefined or empty.
   *
   * @param headers - Headers object to modify
   * @param payload - The payload that will be sent
   * @param secret - Optional HMAC secret
   */
  static async addSignatureHeader(
    headers: Record<string, string>,
    payload: string,
    secret?: string
  ): Promise<void> {
    if (secret) {
      headers["X-Signature"] = await this.signPayload(payload, secret);
    }
  }
}
