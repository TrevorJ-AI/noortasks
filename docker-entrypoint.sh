#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${NOORTASKS_DB:-/data/noortasks.sqlite}"
DATA_DIR="${NOORTASKS_DATA_DIR:-/data/files}"
CONFIG_PATH="${NOORTASKS_CONFIG:-/data/config.json}"
CLI_BIN="/app/apps/server/node_modules/.bin/tsx"
CLI_SCRIPT="/app/apps/server/src/cli.ts"

mkdir -p "$(dirname "$DB_PATH")" "$DATA_DIR"

EXTRA_ARGS=()

if [ "${NOORTASKS_NO_AUTH:-false}" = "true" ] || [ "${NOORTASKS_NO_AUTH:-0}" = "1" ]; then
  EXTRA_ARGS+=("--no-auth")
elif [ ! -f "$CONFIG_PATH" ]; then
  PASSPHRASE_VALUE=""
  if [ -n "${NOORTASKS_PASSPHRASE_FILE:-}" ] && [ -r "${NOORTASKS_PASSPHRASE_FILE}" ]; then
    PASSPHRASE_VALUE="$(tr -d '\r\n' < "${NOORTASKS_PASSPHRASE_FILE}")"
  elif [ -n "${NOORTASKS_PASSPHRASE:-}" ]; then
    PASSPHRASE_VALUE="${NOORTASKS_PASSPHRASE}"
  fi

  if [ -n "$PASSPHRASE_VALUE" ]; then
    mkdir -p "$(dirname "$CONFIG_PATH")"
    printf '%s\n' "$PASSPHRASE_VALUE" | "$CLI_BIN" "$CLI_SCRIPT" hash-passphrase "$CONFIG_PATH"
    unset PASSPHRASE_VALUE
  else
    echo "No config found at $CONFIG_PATH; starting in browser first-run setup mode." >&2
  fi
fi

# Prevent child Node processes from inheriting plaintext passphrase env vars
unset NOORTASKS_PASSPHRASE

if [ "${NOORTASKS_AUTO_VAPID:-false}" = "true" ] && [ -n "${NOORTASKS_VAPID_FILE:-}" ] && [ ! -f "${NOORTASKS_VAPID_FILE}" ]; then
  mkdir -p "$(dirname "${NOORTASKS_VAPID_FILE}")"
  VAPID_SUBJECT_ARG=()
  if [ -n "${NOORTASKS_VAPID_SUBJECT:-}" ]; then
    VAPID_SUBJECT_ARG=("--subject" "${NOORTASKS_VAPID_SUBJECT}")
  fi
  "$CLI_BIN" "$CLI_SCRIPT" generate-vapid "${NOORTASKS_VAPID_FILE}" "${VAPID_SUBJECT_ARG[@]}"
fi

exec "$@" "${EXTRA_ARGS[@]}"
