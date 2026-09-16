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
#   CAIRN_LOCATION             Azure region (default: swedencentral)
#   CAIRN_NAME                 app name, part of the address (default: cairn)
#   CAIRN_IMAGE                image (default: ghcr.io/vespassassina/cairn:latest,
#                              the newest release; use :edge for the newest
#                              commit on main). The tag is resolved to the
#                              digest it points at now, so a moved tag really
#                              deploys and an unmoved one says so.
#   CAIRN_AUTH_PROVIDER        github (default) or oidc
#   CAIRN_OIDC_ISSUER          for oidc only
#   CAIRN_OAUTH_CLIENT_ID      from your OAuth app; empty for the first pass
#   CAIRN_OAUTH_CLIENT_SECRET  from your OAuth app
#   CAIRN_ALLOWED_USERS        who may sign in, such as github:yourlogin
#   CAIRN_SERVICE_TOKEN        optional, for scripts that cannot sign in
#   CAIRN_AUTH_SECRET_PREVIOUS the old signing secret, during a rotation
#   CAIRN_EMBEDDINGS           local (default): search by meaning too, English
#                              only; off: keyword search only, less memory
#   CAIRN_IDLE_MINUTES         minutes without a request before Cairn stops
#                              (default 30); the next request starts it again
#   CAIRN_ALWAYS_ON            true: never stop, so no cold starts, for a small
#                              monthly cost beyond the free grant (default false)
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
: "${CAIRN_LOCATION:=swedencentral}"
: "${CAIRN_NAME:=cairn}"
: "${CAIRN_IMAGE:=ghcr.io/vespassassina/cairn:latest}"
: "${CAIRN_AUTH_PROVIDER:=github}"
: "${CAIRN_OIDC_ISSUER:=}"
: "${CAIRN_OAUTH_CLIENT_ID:=}"
: "${CAIRN_OAUTH_CLIENT_SECRET:=}"
: "${CAIRN_ALLOWED_USERS:=}"
: "${CAIRN_SERVICE_TOKEN:=}"
: "${CAIRN_AUTH_SECRET_PREVIOUS:=}"
: "${CAIRN_EMBEDDINGS:=local}"
: "${CAIRN_IDLE_MINUTES:=30}"
: "${CAIRN_ALWAYS_ON:=false}"
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
CAIRN_EMBEDDINGS='$CAIRN_EMBEDDINGS'
CAIRN_IDLE_MINUTES='$CAIRN_IDLE_MINUTES'
CAIRN_ALWAYS_ON='$CAIRN_ALWAYS_ON'
SAVED

case "$CAIRN_IDLE_MINUTES" in
  '' | *[!0-9]*) fail "CAIRN_IDLE_MINUTES must be a whole number of minutes, from 1 to 1440" ;;
esac
if [ "$CAIRN_IDLE_MINUTES" -lt 1 ] || [ "$CAIRN_IDLE_MINUTES" -gt 1440 ]; then
  fail "CAIRN_IDLE_MINUTES must be from 1 to 1440"
fi
case "$CAIRN_ALWAYS_ON" in
  true | false) ;;
  *) fail "CAIRN_ALWAYS_ON must be true or false" ;;
esac

if [ -n "$CAIRN_OAUTH_CLIENT_ID" ]; then
  [ -n "$CAIRN_OAUTH_CLIENT_SECRET" ] || fail "CAIRN_OAUTH_CLIENT_SECRET is required with CAIRN_OAUTH_CLIENT_ID"
  [ -n "$CAIRN_ALLOWED_USERS" ] || fail "CAIRN_ALLOWED_USERS is required, such as github:yourlogin"
  if [ "$CAIRN_AUTH_PROVIDER" = "oidc" ] && [ -z "$CAIRN_OIDC_ISSUER" ]; then
    fail "CAIRN_OIDC_ISSUER is required for the oidc provider"
  fi
fi

# Container Apps makes a new revision only when the template changes, and a
# tag such as :latest is the same string however often the image behind it
# moves. Left as a tag, a redeploy after a new build is a silent no-op: the
# template is identical, no revision is created, and the old image keeps
# running. So the tag is resolved to the digest it points at now, and the
# digest goes in the template (ADR-047).
#
# Only ghcr.io is resolved, with an anonymous pull token, because that is where
# Cairn publishes. Anything else is passed through untouched, with a warning
# that says what that costs.
resolve_digest() {
  local ref="$1" path tag token digest
  case "$ref" in
    *@sha256:*) printf '%s' "$ref"; return 0 ;;
    ghcr.io/*) ;;
    *) printf '%s' "$ref"; return 0 ;;
  esac
  path="${ref#ghcr.io/}"
  tag=latest
  case "$path" in *:*) tag="${path##*:}"; path="${path%:*}" ;; esac
  # No token means the registry could not be reached at all, which is a
  # network problem rather than a wrong tag: pass the ref through and let the
  # caller warn.
  token="$(curl -fsS "https://ghcr.io/token?scope=repository:${path}:pull" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || { printf '%s' "$ref"; return 0; }
  digest="$(curl -fsSI \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/${path}/manifests/${tag}" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p')"
  # The registry answered but has no such tag. Saying so here is worth more
  # than letting Azure fail to pull it in a few minutes' time.
  [ -n "$digest" ] || return 2
  printf 'ghcr.io/%s@%s' "$path" "$digest"
}

requested_image="$CAIRN_IMAGE"
if resolved="$(resolve_digest "$requested_image")"; then
  CAIRN_IMAGE="$resolved"
  if [ "$CAIRN_IMAGE" != "$requested_image" ]; then
    say "image $requested_image is ${CAIRN_IMAGE##*@}"
  else
    case "$requested_image" in
      *@sha256:*) ;;
      *) say "warning: could not reach the registry to look up the digest for $requested_image, so the tag goes in the template as it is. If that tag has moved since the last deploy, this run will not pick up the new image. To be certain, deploy by digest: CAIRN_IMAGE=$requested_image@sha256:<digest>" ;;
    esac
  fi
else
  fail "the registry has no image tagged $requested_image. Cairn publishes :latest for each release and :edge for the newest commit on main. Pick one of those, or give a digest: CAIRN_IMAGE=ghcr.io/vespassassina/cairn:edge $0"
fi

say "registering the Azure services Cairn uses (only slow the first time)"
az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.Storage --wait >/dev/null

# A group keeps the region it was created in, but may hold resources in any
# region, and the template places them in CAIRN_LOCATION. So an existing
# group is used as it is: after a region refused a first attempt, the next
# run in another region still works.
if [ "$(az group exists --name "$CAIRN_RG" | tr -d '\r')" = "true" ]; then
  say "resource group $CAIRN_RG exists; resources go in $CAIRN_LOCATION"
else
  say "resource group $CAIRN_RG in $CAIRN_LOCATION"
  az group create --name "$CAIRN_RG" --location "$CAIRN_LOCATION" --output none
fi

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
  # "$schema" is a literal JSON key, meant not to expand.
  # shellcheck disable=SC2016
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
  printf '"authSecretPrevious":{"value":%s},' "$(json_string "$CAIRN_AUTH_SECRET_PREVIOUS")"
  printf '"embeddings":{"value":%s},' "$(json_string "$CAIRN_EMBEDDINGS")"
  printf '"idleMinutes":{"value":%s},' "$CAIRN_IDLE_MINUTES"
  printf '"alwaysOn":{"value":%s}' "$CAIRN_ALWAYS_ON"
  printf '}}'
} > "$params"

# Git Bash on Windows: az is a Windows program and needs Windows paths.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# What was running before this run, so afterwards we can tell a real rollout
# from a template that did not change, and say which image is being replaced
# by which (ADR-047). Both empty on a first deploy, when there is no app yet.
revision_before="$(az containerapp show --resource-group "$CAIRN_RG" --name "$CAIRN_NAME" \
  --query "properties.latestRevisionName" --output tsv 2>/dev/null | tr -d '\r' || true)"
image_before="$(az containerapp show --resource-group "$CAIRN_RG" --name "$CAIRN_NAME" \
  --query "properties.template.containers[0].image" --output tsv 2>/dev/null | tr -d '\r' || true)"

if [ -n "$image_before" ]; then
  if [ "$image_before" = "$CAIRN_IMAGE" ]; then
    say "already running this exact image, so this run changes nothing about it"
  else
    say "replacing the running image"
    say "  from  $image_before"
    say "  to    $CAIRN_IMAGE"
  fi
  # A tag left in an earlier template is why a redeploy could silently keep an
  # old image: the string never changed, so no revision was ever made.
  case "$image_before" in
    *@sha256:*) ;;
    *) say "warning: the running revision was deployed by tag ($image_before) rather than by digest, so earlier redeploys could not tell a moved tag from an unchanged one. This run fixes that by deploying a digest." ;;
  esac
fi

case "$requested_image" in
  *:edge | *:edge@*) say "warning: :edge is the newest commit on main, not a release. It has passed CI but has not been through a release. Use :latest for the newest release." ;;
esac

if [ "$CAIRN_ALWAYS_ON" = "false" ]; then
  say "note: this Cairn stops after $CAIRN_IDLE_MINUTES idle minutes, so the first request after a pause waits for it to start"
fi

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

revision_after="$(az containerapp show --resource-group "$CAIRN_RG" --name "$CAIRN_NAME" \
  --query "properties.latestRevisionName" --output tsv 2>/dev/null | tr -d '\r' || true)"

# No new revision means the template was identical, so nothing rolled out.
# That is a normal outcome worth saying plainly: waiting for a version that
# was never created is how a redeploy comes to look like a hang (ADR-047).
if [ -n "$revision_before" ] && [ "$revision_before" = "$revision_after" ]; then
  say "no change to deploy: $revision_after already runs this image and these settings"
  say "  image  ${CAIRN_IMAGE##*/}"
  say "  If you expected a new version, the image you asked for is the one already running."
  say "  Deploy a different one with CAIRN_IMAGE, such as: CAIRN_IMAGE=ghcr.io/vespassassina/cairn:edge $0"
else
  # The old revision keeps answering while the new one starts, so wait for
  # the new one to be ready before asking Cairn if it is up.
  say "waiting for $revision_after to start (the first start can take a minute)"
  for _ in $(seq 1 60); do
    ready="$(az containerapp show --resource-group "$CAIRN_RG" --name "$CAIRN_NAME" \
      --query "properties.latestReadyRevisionName == properties.latestRevisionName" --output tsv 2>/dev/null | tr -d '\r' || true)"
    [ "$ready" = "true" ] && break
    sleep 5
  done
  [ "$ready" = "true" ] || fail "$revision_after was created but never became ready, after five minutes. The container is starting and failing, so the reason is in its own log rather than here: az containerapp logs show -g $CAIRN_RG -n $CAIRN_NAME --tail 50"
fi

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
say ""
say "warning: the revision started, but Cairn has not answered at $url/health after four minutes."
say "Azure reporting the revision as healthy is not the same as Cairn being able to serve: the"
say "container can be starting and failing in a loop while the platform still calls it running (ADR-046)."
say "Read the container's own log, which is where the reason is:"
say "  az containerapp logs show -g $CAIRN_RG -n $CAIRN_NAME --tail 50"
say "Cairn stops on purpose, rather than serve, when the database it restored cannot be vouched for."
say "If that is what happened, the log names the damaged transaction and what to do about it."
fail "Cairn did not answer at $url/health"
