#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# ScorchCrawl — First-time setup script
# =============================================================================

echo "🔥 ScorchCrawl Setup"
echo "===================="
echo ""

# Check for .env
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "✓ Created .env from .env.example"
  else
    echo "✗ No .env.example found"
    exit 1
  fi
fi

# Check for GitHub token
if grep -q "ghp_your_token_here" .env 2>/dev/null; then
  echo ""
  echo "⚠ You need to set GITHUB_TOKEN in .env"
  echo ""
  echo "  Get a token at: https://github.com/settings/tokens"
  echo "  Required scope: copilot"
  echo ""
  read -p "Enter your GitHub token (or press Enter to skip): " token
  if [ -n "$token" ]; then
    sed -i "s|ghp_your_token_here|$token|" .env
    echo "✓ Token saved to .env"
  else
    echo "⚠ Skipped — you'll need to edit .env manually before using the agent"
  fi
fi

# Check for Docker
if ! command -v docker &>/dev/null; then
  echo "✗ Docker is not installed. Please install Docker first."
  echo "  https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  echo "✗ Docker Compose v2 is not installed."
  exit 1
fi

echo ""
echo "✓ Prerequisites met"
echo ""

# Check for engine directory
if [ ! -f engine/Dockerfile ] && [ ! -d engine/apps ]; then
  echo "⚠ The engine directory appears incomplete."
  echo "  The engine/ directory should contain the scraping engine source."
  echo "  See the README for setup instructions."
  echo ""
fi

echo "Ready to deploy! Run:"
echo ""
echo "  docker compose up -d"
echo ""
echo "Then configure your MCP client to connect to:"
echo "  http://localhost:24787/mcp"
echo ""
