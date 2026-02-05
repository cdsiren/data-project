#!/bin/bash
# Script to check R2 to ClickHouse data reconciliation
# Run this before deleting any data from ClickHouse to verify row counts match

set -e

WORKER_URL="${WORKER_URL:-https://polymarket-enrichment.cd-durbin14.workers.dev}"
API_KEY="${VITE_DASHBOARD_API_KEY:-$API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY or VITE_DASHBOARD_API_KEY environment variable required"
  echo "Usage: VITE_DASHBOARD_API_KEY=your-key ./scripts/check-r2-clickhouse-reconciliation.sh"
  exit 1
fi

echo "=== R2 to ClickHouse Data Reconciliation ==="
echo "Worker URL: $WORKER_URL"
echo ""

# Fetch reconciliation data
echo "Fetching reconciliation data..."
RESULT=$(curl -s "$WORKER_URL/admin/reconciliation" \
  -H "X-API-Key: $API_KEY" \
  -H "Accept: application/json")

# Check for errors
if echo "$RESULT" | grep -q '"error"'; then
  echo "Error fetching reconciliation data:"
  echo "$RESULT" | jq .
  exit 1
fi

# Display summary
echo ""
echo "=== Summary ==="
echo "$RESULT" | jq '.summary'

echo ""
echo "=== Table Details ==="
echo "$RESULT" | jq -r '.tables[] | "\(.status | if . == "ok" then "✓" else "✗" end) \(.database).\(.table): R2=\(.manifestRows | tostring | . as $n | if length > 3 then ($n[:-3] + "," + $n[-3:]) else $n end) CH=\(.clickhouseRows | tostring | . as $n | if length > 3 then ($n[:-3] + "," + $n[-3:]) else $n end) diff=\(.percentDiff | . * 100 | round / 100)%"'

echo ""

# Check overall status
OVERALL_STATUS=$(echo "$RESULT" | jq -r '.summary.overallStatus')
if [ "$OVERALL_STATUS" = "ok" ]; then
  echo "✓ All tables reconciled successfully. Safe to proceed with deletion."
  exit 0
else
  echo "✗ Some tables have mismatched row counts. DO NOT delete data until resolved."
  exit 1
fi
