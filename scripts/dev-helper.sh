#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENGINE_ROOT_DIR="$ROOT_DIR/ScorchCrawl"
ENGINE_DIR="$ENGINE_ROOT_DIR/engine"
MCP_SERVER_DIR="$ROOT_DIR/scorchcrawl-mcp/server"
MCP_CLIENT_DIR="$ROOT_DIR/scorchcrawl-mcp/client"
DEFAULT_CA_PATH="/mnt/c/Users/320295634/MCP Configuration/combined-certs.pem"

SCORCHCRAWL_LOCAL_PROXY="${SCORCHCRAWL_LOCAL_PROXY:-true}"
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$DEFAULT_CA_PATH}"
export SCORCHCRAWL_LOCAL_PROXY NODE_EXTRA_CA_CERTS

usage() {
  cat <<'EOF'
Usage: dev-helper.sh <command>

Commands:
  env         ensure .env files exist and show the recommended WSL environment
  test-mcp    run the scorchcrawl-mcp client + server tests (node_modules required)
  test-engine run the engine unit tests (pnpm/npm + node_modules required)
  test-all    run both test suites sequentially
  help        show this message
EOF
  exit 1
}

ensure_env_file() {
  local dir="$1"
  local label="$2"

  if [ -f "$dir/.env" ]; then
    return 0
  fi

  if [ -f "$dir/.env.example" ]; then
    cp "$dir/.env.example" "$dir/.env"
    echo "Created $label/.env from example (please fill secrets before committing)."
  else
    echo "Warning: $label/.env and .env.example are both missing. Create one manually."
  fi
}

ensure_env_files() {
  ensure_env_file "$ENGINE_ROOT_DIR" "ScorchCrawl"
  ensure_env_file "$ROOT_DIR/scorchcrawl-mcp" "scorchcrawl-mcp"
}

print_env_summary() {
  cat <<EOF
WSL helper
  SCORCHCRAWL_LOCAL_PROXY=$SCORCHCRAWL_LOCAL_PROXY
  NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS
  SCORCHCRAWL_API_URL=${SCORCHCRAWL_API_URL:-http://localhost:24786}
EOF

  if command -v free >/dev/null 2>&1; then
    echo "Available host memory (free -h):"
    free -h
  else
    echo "Available host memory (fallback):"
    awk '/MemAvailable/ {print $2 " kB available"}' /proc/meminfo || true
  fi

  echo "Docker Compose defaults cap scorchcrawl-api @ 8G, playwright @ 4G, browserless @ 4G; lower mem_limit if you have < 16G."
}

check_node_modules() {
  local dir="$1"
  if [ -d "$dir/node_modules" ]; then
    return 0
  fi
  echo "node_modules is missing in $dir. Run pnpm install (or npm install) before testing."
  return 1
}

run_mcp_tests() {
  echo "Running scorchcrawl-mcp client tests..."
  if ! check_node_modules "$MCP_CLIENT_DIR"; then
    return 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not on PATH; install Node 18+ to run tests."
    return 1
  fi

  (cd "$MCP_CLIENT_DIR" && npm test)

  echo "Running scorchcrawl-mcp server tests..."
  if ! check_node_modules "$MCP_SERVER_DIR"; then
    return 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not on PATH; install Node 18+ to run tests."
    return 1
  fi

  (cd "$MCP_SERVER_DIR" && npm test)
}

run_engine_tests() {
  echo "Running scorchcrawl engine unit tests..."
  if ! check_node_modules "$ENGINE_DIR"; then
    return 1
  fi

  local manager=""
  if command -v pnpm >/dev/null 2>&1; then
    manager="pnpm"
  elif command -v npm >/dev/null 2>&1; then
    manager="npm"
  else
    echo "Neither pnpm nor npm is available on PATH; install one to run engine tests."
    return 1
  fi

  (cd "$ENGINE_DIR" && "$manager" test)
}

if [ $# -gt 1 ]; then
  usage
fi

action="${1:-env}"

if [ "$action" = "help" ]; then
  usage
fi

ensure_env_files
print_env_summary

case "$action" in
  env)
    exit 0
    ;;
  test-mcp)
    run_mcp_tests
    ;;
  test-engine)
    run_engine_tests
    ;;
  test-all)
    run_mcp_tests && run_engine_tests
    ;;
  *)
    usage
    ;;
esac
