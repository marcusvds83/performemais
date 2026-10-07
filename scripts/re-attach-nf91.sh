#!/bin/bash
# Script para re-anexar XML/PDF na NF 91
# Uso: MIDDLEWARE_API_KEY=sua-chave bash scripts/re-attach-nf91.sh [MOVE_ID]

MIDDLEWARE_URL="${MIDDLEWARE_URL:-https://performemais.vercel.app}"
MOVE_ID="${1:-91}"  # Default: move_id=91

if [ -z "$MIDDLEWARE_API_KEY" ]; then
  echo "ERRO: Defina MIDDLEWARE_API_KEY"
  echo "  MIDDLEWARE_API_KEY=sua-chave bash scripts/re-attach-nf91.sh 91"
  exit 1
fi

echo "=== Re-anexando XML/PDF para move_id=$MOVE_ID ==="
echo "URL: $MIDDLEWARE_URL/api/v1/nfse/re-attach"

curl -s -X POST "$MIDDLEWARE_URL/api/v1/nfse/re-attach" \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: $MIDDLEWARE_API_KEY" \
  -d "{\"move_id\": $MOVE_ID}" | python3 -m json.tool 2>/dev/null || \
  curl -s -X POST "$MIDDLEWARE_URL/api/v1/nfse/re-attach" \
  -H 'Content-Type: application/json' \
  -H "X-Api-Key: $MIDDLEWARE_API_KEY" \
  -d "{\"move_id\": $MOVE_ID}"
