#!/usr/bin/env bash
# Starts the multi-user production server for the M8 browser tests: built web app served by the server itself,
# "Sign in with Google" pointed at the local mock provider. Synthetic accounts only.
set -euo pipefail
PORT="$1"
MOCK="$2"
DIR=.e2e-tmp3
rm -rf "$DIR" && mkdir -p "$DIR"
cat > "$DIR/config.json" <<JSON
{
  "admins": ["alice@example.com"],
  "maxUsers": 5,
  "oidc": {
    "issuer": "http://127.0.0.1:$MOCK",
    "clientId": "noortasks-test-client",
    "clientSecret": "test-secret",
    "redirectUri": "http://127.0.0.1:$PORT/api/auth/oidc/callback",
    "label": "Google",
    "allowInsecure": true
  }
}
JSON
exec env HOST=127.0.0.1 PORT="$PORT" NOORTASKS_DB="$DIR/db.sqlite" NOORTASKS_DATA_DIR="$DIR/files" NOORTASKS_CONFIG="$DIR/config.json" NOORTASKS_STATIC_DIR=dist ../server/node_modules/.bin/tsx ../server/src/main.ts
