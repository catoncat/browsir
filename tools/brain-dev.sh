#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_TOKEN="${BRIDGE_TOKEN:-dev-token-change-me}"
BRIDGE_BASE="${BRIDGE_BASE:-http://127.0.0.1:8787}"
declare -a PIDS=()

if [[ "$BRIDGE_TOKEN" == "dev-token-change-me" ]]; then
  echo "[brain:dev] 使用默认 BRIDGE_TOKEN=dev-token-change-me（仅建议本地开发）"
else
  echo "[brain:dev] 使用自定义 BRIDGE_TOKEN"
fi

echo "[brain:dev] bridge:  $BRIDGE_BASE"
echo "[brain:dev] watcher: extension/**/*"
echo "[brain:dev] 提示: 扩展里 Bridge Token 需与当前 BRIDGE_TOKEN 一致"

cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT INT TERM

if curl -fsS "${BRIDGE_BASE}/health" >/dev/null 2>&1; then
  echo "[brain:dev] 检测到已有 bridge 在运行，复用现有进程"
  if curl -fsS --get --data-urlencode "token=${BRIDGE_TOKEN}" "${BRIDGE_BASE}/dev/version" >/dev/null 2>&1; then
    echo "[brain:dev] token 校验通过（可触发扩展自动 reload）"
  else
    echo "[brain:dev] 警告: 当前 BRIDGE_TOKEN 与已运行 bridge 不一致，watcher 可能 401"
    echo "[brain:dev] 建议: 使用与 bridge 相同的 BRIDGE_TOKEN 重新运行"
  fi
else
  (
    cd "$ROOT_DIR/bridge"
    BRIDGE_TOKEN="$BRIDGE_TOKEN" bun run start 2>&1 | sed 's/^/[bridge] /'
  ) &
  PIDS+=("$!")
fi

(
  cd "$ROOT_DIR"
  BRIDGE_TOKEN="$BRIDGE_TOKEN" BRIDGE_BASE="$BRIDGE_BASE" bun tools/brain-ext-watch.ts 2>&1 | sed 's/^/[watch]  /'
) &
PIDS+=("$!")

wait -n "${PIDS[@]}"
