# Contributing guidelines

When changing service ports, reverse-proxy settings, or CI expectations please:

- Keep `docker-compose.yaml`, `.github/workflows/ci.yaml`, and `docs/reverse-proxy.md` in sync.
- If you change MCP or API ports update all three places (compose defaults, CI, and nginx docs).
- Run the config consistency check locally before opening a PR:

```bash
# from repo root
grep "${MCP_PORT:-24787}" docker-compose.yaml && grep "${SCORCHCRAWL_PORT:-24786}" docker-compose.yaml
```

- Run unit and integration tests as documented in `README.md` and the `server` package.

- When cutting a new release, bump the `version` fields in `engine/package.json` and
  `server/package.json`, tag `vX.Y.Z`, push the git tag, build/push the Docker image, and
  update documentation (README, reverse-proxy, architecture) with the new tag or "latest"
  instructions.
Thanks for keeping the infra consistent — small mismatches cause confusing runtime errors behind reverse proxies.

Note: ScorchCrawl's MCP server uses the GitHub Copilot/Copilot-Agent integration (via `GITHUB_TOKEN`/agent settings) by default.
The `OPENAI_*` environment variables are optional and only used when configuring OpenAI-compatible providers; do not assume an OpenAI base URL is required.