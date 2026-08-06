#!/usr/bin/env bash
# CycloneDX SBOM generator (ROADMAP §19, M2-security).
# Produces artifacts/sbom.cyclonedx.json for the whole workspace.
# cdxgen is PINNED (supply-chain hygiene: no floating npx versions).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p artifacts

CDXGEN_VERSION="12.8.2"
npx --yes "@cyclonedx/cdxgen@${CDXGEN_VERSION}" \
  --type js \
  --output artifacts/sbom.cyclonedx.json \
  .

echo "SBOM written to artifacts/sbom.cyclonedx.json"
