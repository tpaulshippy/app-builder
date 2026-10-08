#!/usr/bin/env bash
# Deploy app-builder to Cloudflare Workers.
#
# Prerequisite, one-time and requires your browser session:
#   https://dash.cloudflare.com/42454937997b510315154707ff81475e/workers/onboarding
# Every Workers deploy needs a workers.dev subdomain registered, even when you
# attach a custom domain (API error 10063). No API token can create it — the
# endpoint returns 10405 "Method not allowed for this authentication scheme"
# for scoped tokens. Opening the Workers page in the dashboard creates one.

set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-42454937997b510315154707ff81475e}"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

# Pull the deploy-scoped token out of shared_config if it is not already set.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$HOME/shared_config" ]; then
  # shellcheck disable=SC1090
  CLOUDFLARE_API_TOKEN="$(grep -E '^export CLOUDFLARE_WORKER_API_TOKEN=' "$HOME/shared_config" \
    | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  export CLOUDFLARE_API_TOKEN
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: no CLOUDFLARE_API_TOKEN, and none found in ~/shared_config" >&2
  exit 1
fi

echo "account: $ACCOUNT_ID"
echo "token:   ${CLOUDFLARE_API_TOKEN:0:9}…"
echo

npx wrangler deploy "$@"

echo
echo "Done. If you also attached a custom domain, DNS and the certificate can"
echo "take a minute to settle. Otherwise use the *.workers.dev URL printed above."