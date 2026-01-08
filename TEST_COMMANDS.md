# Test Commands for Goldsky Webhook

Replace `YOUR_API_KEY` with your actual API key in all commands below.

## Test 1: Single Event

```bash
curl -X POST https://polymarket-enrichment.cd-durbin14.workers.dev/webhook/goldsky \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
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
```

**Expected Response:**
```json
{
  "status": "ok",
  "events_received": 1,
  "jobs_queued": 1,
  "cached": 0
}
```

## Test 2: Batch of Events (What Goldsky Actually Sends)

```bash
curl -X POST https://polymarket-enrichment.cd-durbin14.workers.dev/webhook/goldsky \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '[
    {
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
    },
    {
      "id": "46268263",
      "transaction_hash": "0x111111eae9b9fbc15b35e567f3ee3390d75400a0930b7775fcd6b671ec7db702",
      "timestamp": "1748971147",
      "order_hash": "0",
      "maker": "0xaaaaaaa890123456789012345678901234567890",
      "taker": "0xbbbbbbb321098765432109876543210987654321",
      "maker_asset_id": "0",
      "taker_asset_id": "70948999046678954944326787736190890890568173143213485913437360277446343508580",
      "maker_amount_filled": "100000000",
      "taker_amount_filled": "200000000",
      "fee": "0",
      "chain_id": 137,
      "_gs_chain": "matic",
      "_gs_gid": "a11b22c3344d5566e77f8899aa0bb1cc",
      "is_deleted": 0
    },
    {
      "id": "46268264",
      "transaction_hash": "0x222222eae9b9fbc15b35e567f3ee3390d75400a0930b7775fcd6b671ec7db703",
      "timestamp": "1748971148",
      "order_hash": "0",
      "maker": "0xcccccccc90123456789012345678901234567890",
      "taker": "0xdddddddd21098765432109876543210987654321",
      "maker_asset_id": "108455658871593933281610100985335550824316005504750317167886921837210241495309",
      "taker_asset_id": "0",
      "maker_amount_filled": "50000000",
      "taker_amount_filled": "75000000",
      "fee": "0",
      "chain_id": 137,
      "_gs_chain": "matic",
      "_gs_gid": "c22d33e4455f6677g88h9900ii1jj2kk",
      "is_deleted": 0
    }
  ]'
```

**Expected Response:**
```json
{
  "status": "ok",
  "events_received": 3,
  "jobs_queued": 3,
  "cached": 0
}
```

(Note: On subsequent runs with same data, `jobs_queued` will be 0 and `cached` will be 3)

## Test 3: Verify API Key Protection

This should fail with 401 Unauthorized:

```bash
curl -X POST https://polymarket-enrichment.cd-durbin14.workers.dev/webhook/goldsky \
  -H "Content-Type: application/json" \
  -d '{"id":"test"}'
```

**Expected Response:**
```json
{
  "error": "Unauthorized"
}
```

## Test 4: Health Check

```bash
curl https://polymarket-enrichment.cd-durbin14.workers.dev/health
```

**Expected Response:**
```json
{
  "status": "ok"
}
```

## Monitor Logs

Watch logs in real-time to see processing:

```bash
npx wrangler tail
```

Then run one of the test commands above and you should see:
- `Received X events from Goldsky`
- Queue processing logs
- Polymarket API calls
- ClickHouse inserts

## Using the Shell Script

You can also use the test script:

```bash
# Make it executable
chmod +x test-webhook.sh

# Edit to add your API key
nano test-webhook.sh

# Run all tests
./test-webhook.sh
```

## Real Token IDs Used in Tests

These are real Polymarket token IDs from the sample data:

1. `9022242446965460992675148513465279956952237358463225683411818753752794850571` - Israel/Hamas ceasefire market
2. `70948999046678954944326787736190890890568173143213485913437360277446343508580` - Kamala Harris inauguration market
3. `108455658871593933281610100985335550824316005504750317167886921837210241495309` - Atletico Madrid Champions League market

If ClickHouse is configured, these will fetch real metadata from Polymarket's API!
