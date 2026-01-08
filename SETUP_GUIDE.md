# Quick Setup Guide

## Step 1: Generate and Set API Key

Generate a secure API key:
```bash
openssl rand -hex 32
```

Copy the output and set it as a secret:
```bash
wrangler secret put WEBHOOK_API_KEY
# Paste the generated key when prompted
```

## Step 2: Set ClickHouse Secrets

```bash
wrangler secret put CLICKHOUSE_URL
# Enter your ClickHouse URL (e.g., https://your-instance.clickhouse.cloud:8443)

wrangler secret put CLICKHOUSE_TOKEN
# Enter your ClickHouse access token
```

## Step 3: Deploy

```bash
wrangler deploy
```

## Step 4: Configure Goldsky

Provide Goldsky with these details:

**Webhook URL:**
```
https://cd-durbin14.workers.dev/webhook/goldsky
```

**Headers:**
```
X-API-Key: <your-generated-api-key>
Content-Type: application/json
```

## Step 5: Test

Test the endpoint manually:

```bash
# This should fail (no API key)
curl -X POST https://cd-durbin14.workers.dev/webhook/goldsky \
  -H "Content-Type: application/json" \
  -d '{"id":"test"}'

# Expected: {"error":"Unauthorized"}

# This should succeed (with API key)
curl -X POST https://cd-durbin14.workers.dev/webhook/goldsky \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-api-key" \
  -d '{
    "id": "46268262",
    "transaction_hash": "0x000000eae9b9fbc15b35e567f3ee3390d75400a0930b7775fcd6b671ec7db701",
    "timestamp": "1748971146",
    "order_hash": "0",
    "maker": "0x1234567890123456789012345678901234567890",
    "taker": "0x0987654321098765432109876543210987654321",
    "maker_asset_id": "9022242446965460992675148513465279956952237358463225683411818753752794850571",
    "taker_asset_id": "0",
    "maker_amount_filled": "98235000",
    "taker_amount_filled": "555000000",
    "fee": "0",
    "chain_id": 137,
    "_gs_chain": "matic",
    "_gs_gid": "d67f1e4524969bcaa6e732e50d7c2d27",
    "is_deleted": 0
  }'

# Expected: {"status":"ok","asset_id":"9022242446965460992675148513465279956952237358463225683411818753752794850571"}
```

## Step 6: Monitor

Watch the logs to see your webhook in action:
```bash
wrangler tail
```

## Security Notes

- **Never commit the API key to git**
- Store it securely (password manager, secrets manager, etc.)
- Rotate the key periodically
- Only share with Goldsky via secure channels
- The key is stored as a Cloudflare Worker secret (encrypted at rest)

## Troubleshooting

### "Unauthorized" error
- Check that the `X-API-Key` header is included
- Verify the key matches what you set with `wrangler secret put WEBHOOK_API_KEY`
- Check for extra whitespace in the key

### No data in ClickHouse
- Check the worker logs: `wrangler tail`
- Verify ClickHouse credentials are set correctly
- Test the health endpoint: `curl https://cd-durbin14.workers.dev/health`

### View current secrets (names only, not values)
```bash
wrangler secret list
```
