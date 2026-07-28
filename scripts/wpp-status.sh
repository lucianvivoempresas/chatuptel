#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

token_response=$(curl --fail --silent --show-error \
  --request POST \
  "http://127.0.0.1:21465/api/${WPP_SESSION}/${WPP_SECRET_KEY}/generate-token")

WPP_TOKEN=$(TOKEN_RESPONSE="$token_response" python3 -c \
  'import json, os; print(json.loads(os.environ["TOKEN_RESPONSE"])["token"])')

curl --fail --silent --show-error \
  --request GET \
  "http://127.0.0.1:21465/api/${WPP_SESSION}/status-session" \
  --header "Authorization: Bearer ${WPP_TOKEN}"
printf '\n'

