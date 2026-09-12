#!/usr/bin/env bash
# Deploy Cairn to Azure Container Apps (ADR-018). Step by step guide:
# docs/DEPLOY-AZURE.md.
#
#   deploy/azure/deploy.sh
#
# Run it once to create storage and the environment and learn Cairn's
# address. Create the OAuth app with that address, then run it again with the
# OAuth settings to create the app. Safe to run again at any time: it updates
# what is there.
#
# Settings, from the environment:
#   CAIRN_RG                   resource group (default: cairn)
#   CAIRN_LOCATION             Azure region (default: westeurope)
#   CAIRN_NAME                 app name, part of the address (default: cairn)
#   CAIRN_IMAGE                image (default: ghcr.io/vespassassina/cairn:latest)
#   CAIRN_AUTH_PROVIDER        github (default) or oidc
#   CAIRN_OIDC_ISSUER          for oidc only
#   CAIRN_OAUTH_CLIENT_ID      from your OAuth app; empty for the first pass
#   CAIRN_OAUTH_CLIENT_SECRET  from your OAuth app
#   CAIRN_ALLOWED_USERS        who may sign in, such as github:yourlogin
#   CAIRN_SERVICE_TOKEN        optional, for scripts that cannot sign in
#   CAIRN_AUTH_SECRET_PREVIOUS the old signing secret, during a rotation
#
# The signing secret is generated on the first run and kept, with the other
# secrets you give it, in deploy/azure/.cairn-deploy.env: readable only by
# you, and ignored by git. Keep that file; losing it signs everyone out.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secrets_file="$here/.cairn-deploy.env"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v az >/dev/null || fail "the Azure CLI is not installed. See https://learn.microsoft.com/cli/azure/install-azure-cli"
az account show >/dev/null 2>&1 || fail "not signed in to Azure. Run: az login"

# Settings from earlier runs fill in whatever this run does not set: a value
# given in the environment always wins over a saved one.
if [ -f "$secrets_file" ]; then
  while IFS= read -r line; do
    case "$line" in
      CAIRN_*=*)
        key="${line%%=*}"
        value="${line#*=}"
        value="${value#\'}"
        value="${value%\'}"
        if [ -z "${!key:-}" ]; then printf -v "$key" '%s' "$value"; fi
        ;;
    esac
  done < "$secrets_file"
fi
: "${CAIRN_RG:=cairn}"
: "${CAIRN_LOCATION:=westeurope}"
: "${CAIRN_NAME:=cairn}"
: "${CAIRN_IMAGE:=ghcr.io/vespassassina/cairn:latest}"
: "${CAIRN_AUTH_PROVIDER:=github}"
: "${CAIRN_OIDC_ISSUER:=}"
: "${CAIRN_OAUTH_CLIENT_ID:=}"
: "${CAIRN_OAUTH_CLIENT_SECRET:=}"
: "${CAIRN_ALLOWED_USERS:=}"
: "${CAIRN_SERVICE_TOKEN:=}"
: "${CAIRN_AUTH_SECRET_PREVIOUS:=}"
if [ -z "${CAIRN_AUTH_SECRET:-}" ]; then
  CAIRN_AUTH_SECRET="$(openssl rand -hex 32)"
  say "generated a signing secret, kept in $secrets_file"
fi

# Save everything needed to run this again, readable only by this user.
umask 077
cat > "$secrets_file" <<SAVED
# Written by deploy/azure/deploy.sh. Secrets: never commit or share this file.
CAIRN_RG='$CAIRN_RG'
CAIRN_LOCATION='$CAIRN_LOCATION'
CAIRN_NAME='$CAIRN_NAME'
CAIRN_AUTH_PROVIDER='$CAIRN_AUTH_PROVIDER'
CAIRN_OIDC_ISSUER='$CAIRN_OIDC_ISSUER'
CAIRN_OAUTH_CLIENT_ID='$CAIRN_OAUTH_CLIENT_ID'
CAIRN_OAUTH_CLIENT_SECRET='$CAIRN_OAUTH_CLIENT_SECRET'
CAIRN_ALLOWED_USERS='$CAIRN_ALLOWED_USERS'
CAIRN_AUTH_SECRET='$CAIRN_AUTH_SECRET'
CAIRN_SERVICE_TOKEN='$CAIRN_SERVICE_TOKEN'
CAIRN_AUTH_SECRET_PREVIOUS='$CAIRN_AUTH_SECRET_PREVIOUS'
SAVED

if [ -n "$CAIRN_OAUTH_CLIENT_ID" ]; then
  [ -n "$CAIRN_OAUTH_CLIENT_SECRET" ] || fail "CAIRN_OAUTH_CLIENT_SECRET is required with CAIRN_OAUTH_CLIENT_ID"
  [ -n "$CAIRN_ALLOWED_USERS" ] || fail "CAIRN_ALLOWED_USERS is required, such as github:yourlogin"
  if [ "$CAIRN_AUTH_PROVIDER" = "oidc" ] && [ -z "$CAIRN_OIDC_ISSUER" ]; then
    fail "CAIRN_OIDC_ISSUER is required for the oidc provider"
  fi
fi

say "registering the Azure services Cairn uses (only slow the first time)"
az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.Storage --wait >/dev/null

say "resource group $CAIRN_RG in $CAIRN_LOCATION"
az group create --name "$CAIRN_RG" --location "$CAIRN_LOCATION" --output none

# Secrets go in a parameters file only this user can read, never on the
# command line, where other processes could see them.
json_string() {
  local text="${1//\\/\\\\}"
  text="${text//\"/\\\"}"
  printf '"%s"' "$text"
}
params="$(mktemp)"
trap 'rm -f "$params"' EXIT
{
  printf '{"$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",'
  printf '"contentVersion":"1.0.0.0","parameters":{'
  printf '"name":{"value":%s},' "$(json_string "$CAIRN_NAME")"
  printf '"location":{"value":%s},' "$(json_string "$CAIRN_LOCATION")"
  printf '"image":{"value":%s},' "$(json_string "$CAIRN_IMAGE")"
  printf '"authProvider":{"value":%s},' "$(json_string "$CAIRN_AUTH_PROVIDER")"
  printf '"oidcIssuer":{"value":%s},' "$(json_string "$CAIRN_OIDC_ISSUER")"
  printf '"oauthClientId":{"value":%s},' "$(json_string "$CAIRN_OAUTH_CLIENT_ID")"
  printf '"oauthClientSecret":{"value":%s},' "$(json_string "$CAIRN_OAUTH_CLIENT_SECRET")"
  printf '"authSecret":{"value":%s},' "$(json_string "$CAIRN_AUTH_SECRET")"
  printf '"allowedUsers":{"value":%s},' "$(json_string "$CAIRN_ALLOWED_USERS")"
  printf '"serviceToken":{"value":%s},' "$(json_string "$CAIRN_SERVICE_TOKEN")"
  printf '"authSecretPrevious":{"value":%s}' "$(json_string "$CAIRN_AUTH_SECRET_PREVIOUS")"
  printf '}}'
} > "$params"

# Git Bash on Windows: az is a Windows program and needs Windows paths.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

say "deploying (a few minutes)"
az deployment group create \
  --resource-group "$CAIRN_RG" \
  --name cairn \
  --template-file "$(native "$here/main.bicep")" \
  --parameters "@$(native "$params")" \
  --output none

output() {
  az deployment group show --resource-group "$CAIRN_RG" --name cairn \
    --query "properties.outputs.$1.value" --output tsv | tr -d '\r'
}
url="$(output url)"
callback="$(output callbackUrl)"
deployed="$(output appDeployed)"

if [ "$deployed" != "true" ] && [ "$deployed" != "True" ]; then
  say ""
  say "First pass done. Cairn will live at:"
  say "  $url"
  say ""
  say "Next: create an OAuth app with this callback URL:"
  say "  $callback"
  say "For GitHub: https://github.com/settings/applications/new"
  say "Then run this again with CAIRN_OAUTH_CLIENT_ID, CAIRN_OAUTH_CLIENT_SECRET and CAIRN_ALLOWED_USERS set."
  exit 0
fi

say "waiting for Cairn to answer (the first start can take a minute)"
for _ in $(seq 1 40); do
  if curl -fsS "$url/health" >/dev/null 2>&1; then
    say ""
    say "Cairn is running at $url"
    say "  console      $url/  (sign in with $CAIRN_AUTH_PROVIDER)"
    say "  MCP          $url/mcp"
    say "  Claude Code  claude mcp add --transport http --scope user cairn $url/mcp"
    say "  CLI          CAIRN_URL=$url cairn login"
    exit 0
  fi
  sleep 6
done
fail "Cairn did not answer at $url/health. Look at its logs: az containerapp logs show -g $CAIRN_RG -n $CAIRN_NAME --follow"
