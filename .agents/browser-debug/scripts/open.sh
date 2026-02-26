#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:-main}"
bun "$HOME/.agents/skills/browser-debug-orchestrator/scripts/run.ts" open "$TARGET" "${@:2}"
