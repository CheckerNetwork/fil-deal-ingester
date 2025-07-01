#!/usr/bin/env bash

set -e

DATABASE_URL="${DATABASE_URL?Missing required env var: DATABASE_URL}"
# defaults to ./target/release/fil-deal-ingester to support local ingestion and backwards compatibility
JSON_CONVERTER_BIN="${JSON_CONVERTER_BIN:-./target/release/fil-deal-ingester}"

mkdir -p generated

if [ $ENVIRONMENT = "docker" ]; then
  echo "Skipping JSON->NDJSON converter build in docker environment"
else
  echo "** Building the JSON->NDJSON converter **"
  cargo build --release
fi

echo "** Downloading the latest market deals state **"
curl --fail -o ./generated/StateMarketDeals.json.zst https://marketdeals.s3.amazonaws.com/StateMarketDeals.json.zst

echo "** Converting from .json.zst to .ndjson **"
$JSON_CONVERTER_BIN ./generated/StateMarketDeals.json.zst > generated/StateMarketDeals.ndjson

echo "** Parsing retrievable deals **"
node scripts/parse-retrievable-deals.js

echo "** Building the SQL query to update the SPARK DB **"
node scripts/build-spark-update-sql.js

echo "** UPDATING THE PRODUCTION DATABASE **"
psql "$DATABASE_URL" -f generated/update-spark-db.sql | tee generated/dbupdate.log

echo "** Updating client-allocator mappings **"
node scripts/update-allocator-clients.js | tee generated/allocator-update.log

# Parse number of deleted and added deals
DELETED=$(grep "^DELETE" < generated/dbupdate.log | awk '{s+=$2} END {print s}')
ADDED=$(grep "^INSERT" < generated/dbupdate.log | awk '{s+=$3} END {print s}')

# Parse number of updated allocator clients
ALLOCATOR_UPDATED_LOG=$(tail -1 generated/allocator-update.log)
ALLOCATOR_UPDATED=$(echo $ALLOCATOR_UPDATED_LOG | grep -o '[0-9]\+')

# Format message
MESSAGE="
**FINISHED INGESTION OF f05 DEALS**
Deleted: $DELETED
Added: $ADDED
$ALLOCATOR_UPDATED_LOG
"

echo -e $MESSAGE

if [ -n "$SLACK_WEBHOOK_URL" ]; then
  echo "** Sending message to slack **"
  curl -X POST -H 'Content-type: application/json' --data "{\"text\":\"$MESSAGE\"}" $SLACK_WEBHOOK_URL
fi

if [ -n "$INFLUXDB_TOKEN" ]; then
  curl --request POST \
  "https://eu-central-1-1.aws.cloud2.influxdata.com/api/v2/write?&bucket=deal-ingestion&precision=ms" \
  --header "Authorization: Token $INFLUXDB_TOKEN" \
  --header "Content-Type: text/plain; charset=utf-8" \
  --header "Accept: application/json" \
  --data-binary "deal_ingestion deleted=$DELETED,added=$ADDED,allocator_updated=$ALLOCATOR_UPDATED"
fi
