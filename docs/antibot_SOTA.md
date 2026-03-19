# Anti-Bot Detection & Bypass — State of the Art (March 2026)

## Table of Contents
- [Executive Summary](#executive-summary)
- [How Anti-Bot Systems Work](#how-anti-bot-systems-work)
- [Cloudflare Browser Rendering API](#cloudflare-browser-rendering-api)
- [SOTA Bypass Tools](#sota-bypass-tools)
- [Commercial Anti-Bot Services](#commercial-anti-bot-services)
- [Open-Source Bypass Projects](#open-source-bypass-projects)
- [Detection vs Evasion Matrix](#detection-vs-evasion-matrix)
- [Integration Strategy for Scorchcrawl](#integration-strategy-for-scorchcrawl)
- [Lessons Learned](#lessons-learned)

---

## Executive Summary

The anti-bot landscape as of March 2026 is an escalating arms race. Cloudflare, DataDome, PerimeterX (HUMAN), and Akamai deploy increasingly sophisticated multi-signal detection combining TLS fingerprinting, JavaScript environment analysis, behavioral profiling, and AI-powered anomaly detection. The most significant recent development is **Cloudflare's Browser Rendering API** — a first-party service that runs a real browser on Cloudflare's edge, inherently bypassing Cloudflare's own bot protection. On the open-source side, **CloakBrowser** represents a generational leap: C++ source-level Chromium patches that pass 30+ detection sites including reCAPTCHA v3 (0.9 score) and Cloudflare Turnstile.

**Key Takeaway**: JS-level stealth patches (puppeteer-stealth, playwright-stealth) are increasingly ineffective. The future is either (a) source-level binary patching, (b) using the anti-bot provider's own infrastructure, or (c) premium proxy/browser APIs.

---

## How Anti-Bot Systems Work

### Layer 1: Network-Level Fingerprinting

| Signal | What's Detected | Difficulty to Spoof |
|--------|----------------|---------------------|
| **TLS/JA3/JA4 fingerprint** | TLS handshake parameters identify the HTTP client library. Node.js `fetch` has a completely different JA3 than Chrome. | Hard — requires matching the exact TLS stack of a real browser |
| **HTTP/2 fingerprint** | Frame ordering, SETTINGS values, window sizes differ between browsers and bot libraries | Hard — most HTTP libraries have unique H2 fingerprints |
| **IP reputation / ASN** | Datacenter IPs (AWS, GCP, DigitalOcean) are flagged vs residential/mobile IPs | Easy — use residential proxies |
| **TCP/IP fingerprint** | OS-level TCP stack parameters (TTL, window size, MSS) | Medium — OS-dependent |

### Layer 2: JavaScript Environment Fingerprinting

| Signal | What's Detected | Difficulty to Spoof |
|--------|----------------|---------------------|
| **`navigator.webdriver`** | Set to `true` by WebDriver/CDP automation | Easy (flag) — but antibot double-checks |
| **Canvas fingerprint** | Deterministic pixel rendering differences per GPU/driver | Hard — must match real hardware |
| **WebGL renderer/vendor** | `UNMASKED_RENDERER_WEBGL` and `UNMASKED_VENDOR_WEBGL` reveal GPU | Medium — can override but must be coherent |
| **Audio fingerprint** | AudioContext oscillator output is hardware-specific | Hard — requires binary-level noise injection |
| **Font enumeration** | Installed fonts differ between OS/environments | Medium — list must match claimed OS |
| **Plugin list** | `navigator.plugins.length === 0` in headless | Easy to inject but must be consistent |
| **CDP detection** | Chrome DevTools Protocol artifacts (Runtime.evaluate, extra JS contexts) | Hard — Puppeteer/Playwright leak CDP signals |
| **`window.chrome`** | Missing in headless Chromium | Easy flag, but deeper checks exist |
| **Screen/hardware** | `screen.width`, `deviceMemory`, `hardwareConcurrency` | Medium — must be coherent with other signals |

### Layer 3: Behavioral Analysis

| Signal | What's Detected | Difficulty to Spoof |
|--------|----------------|---------------------|
| **Mouse movement** | Bots teleport; humans move in curves with micro-corrections | Medium — requires Bézier curve simulation |
| **Keyboard timing** | Instant `fill()` vs human per-character typing with variance | Medium — need per-character delays |
| **Scroll patterns** | Bots jump; humans accelerate/decelerate | Medium |
| **Session behavior** | Time on page, navigation patterns, interaction depth | Hard — requires realistic session simulation |
| **reCAPTCHA v3 scoring** | Aggregates all behavioral signals into a 0.0-1.0 score | Hard — 0.9 requires near-human behavior |

### Layer 4: AI-Powered Anomaly Detection (NEW — 2025/2026)

Cloudflare's latest evolution introduces **per-customer behavioral anomaly models**:

- **Baseline learning**: CF monitors normal traffic patterns per customer site for 7+ days
- **Anomaly scoring**: AI scores each request against the learned baseline
- **Signals used**: Request timing, endpoint access patterns, geographic distribution, session depth, JavaScript execution patterns
- **Adaptive challenges**: Challenge difficulty escalates based on anomaly score
- **Cross-site intelligence**: Cloudflare aggregates detection across all 30M+ sites on its network

This means even perfect browser fingerprinting can be defeated by behavioral anomalies at the session/traffic-pattern level.

---

## Cloudflare Browser Rendering API

### What It Is

Cloudflare launched a **Browser Rendering** service that runs headless Chromium on Cloudflare's edge network. Since the browser runs *inside* Cloudflare's infrastructure, it inherently passes Cloudflare's own bot detection — the requests originate from Cloudflare's trusted IP space with a genuine browser TLS fingerprint.

### REST API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/content` | POST | Returns full HTML after JS rendering |
| `/pdf` | POST | Returns a PDF of the page |
| `/scrape` | POST | AI-powered structured data extraction with schema |
| `/json` | POST | Extract structured JSON with a prompt |
| `/markdown` | POST | Convert page to clean Markdown |
| `/crawl` | POST | Multi-page crawl with link following |
| `/links` | POST | Extract all links from a page |

### Key Features

- **AI extraction**: The `/scrape` endpoint accepts a `model` and `prompt` to extract structured data using Workers AI models (e.g., `@cf/meta/llama-4-scout-17b-16e-instruct`)
- **Schema validation**: Pass a JSON schema and get validated structured output
- **JavaScript execution**: Full browser environment — handles SPAs, dynamic content, infinite scroll
- **Markdown conversion**: Built-in HTML-to-Markdown with `removeSelectors` for cleaning
- **Multi-page crawl**: `/crawl` endpoint follows links with configurable depth and page limits

### Pricing (Workers Paid Plan)

| Resource | Included | Overage |
|----------|----------|---------|
| Browser hours | 10 hrs/month | $0.09/hr |
| Concurrent browsers | 10 (monthly avg) | $2.00/browser |
| REST API rate limit | 600 req/min (10/sec) | — |

**Free tier**: 10 min/day, 6 req/min, 3 concurrent browsers, 5 crawl jobs/day (100 pages max).

### Example Usage

```bash
# Get rendered HTML content
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/content" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# AI-powered structured extraction
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/scrape" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/products",
    "model": "@cf/meta/llama-4-scout-17b-16e-instruct",
    "prompt": "Extract all products with name, price, and description",
    "schema": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {"type": "string"},
          "price": {"type": "number"},
          "description": {"type": "string"}
        }
      }
    }
  }'

# Convert to Markdown
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/markdown" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "removeSelectors": ["nav", "footer", ".ads"]}'
```

### Implications for Scorchcrawl

**Pros**:
- Inherently bypasses Cloudflare challenges (same network / trusted origin)
- No browser infrastructure to manage
- AI extraction built in
- Extremely low cost ($0.09/hr)
- 600 req/min on paid plan

**Cons**:
- Only bypasses **Cloudflare** — does not help with DataDome, Akamai, PerimeterX
- Requires a Cloudflare account and API token
- 60-second browser timeout (extendable to 10 min with keep_alive)
- Rate limited (free tier is very restrictive)
- No proxy support — always originates from Cloudflare IPs
- Cannot customize browser behavior (no humanize, no custom fingerprints)

---

## SOTA Bypass Tools

### Tier 1: Source-Level Binary Patching

#### CloakBrowser (March 2026) — **Recommended**

**What**: A patched Chromium binary with 32 C++ source-level modifications. Drop-in replacement for Playwright/Puppeteer.

**Key capabilities**:
- 0.9 reCAPTCHA v3 score (server-verified, human-level)
- Passes Cloudflare Turnstile (both non-interactive and managed)
- Passes FingerprintJS, BrowserScan, deviceandbrowserinfo (30+ sites)
- TLS fingerprint matches real Chrome (JA3/JA4/Akamai)
- CDP detection evasion (`isAutomatedWithCDP: false`)
- `humanize=True` flag for human-like mouse/keyboard/scroll
- Persistent profiles for session/cookie continuity
- Auto-updating binary, cross-platform (Linux, macOS, Windows)

**Architecture**:
- C++ patches at the Chromium source level — not JavaScript injection
- Canvas, WebGL, audio, fonts, GPU, screen, automation signals, CDP input all patched
- Random fingerprint seed auto-generated per launch (or fixed with `--fingerprint=seed`)
- Platform spoofing (Linux binary reports as Windows by default)

**Integration**:
```python
# Python
from cloakbrowser import launch
browser = launch(humanize=True, proxy="http://user:pass@proxy:8080")
page = browser.new_page()
page.goto("https://protected-site.com")
```

```javascript
// JavaScript
import { launch } from 'cloakbrowser';
const browser = await launch({ humanize: true, proxy: 'http://user:pass@proxy:8080' });
const page = await browser.newPage();
await page.goto('https://protected-site.com');
```

**Docker**: `docker run --rm cloakhq/cloakbrowser cloaktest`

**Comparison to alternatives**:

| Feature | Playwright | playwright-stealth | undetected-chromedriver | Camoufox | CloakBrowser |
|---------|-----------|-------------------|------------------------|----------|-------------|
| reCAPTCHA v3 | 0.1 | 0.3-0.5 | 0.3-0.7 | 0.7-0.9 | **0.9** |
| Cloudflare Turnstile | Fail | Sometimes | Sometimes | Pass | **Pass** |
| Patch level | None | JS injection | Config patches | C++ (Firefox) | **C++ (Chromium)** |
| Survives Chrome updates | N/A | Breaks often | Breaks often | Yes | **Yes** |
| Maintenance | Active | Stale | Stale | Unstable | **Active** |
| Browser engine | Chromium | Chromium | Chrome | Firefox | **Chromium** |
| Playwright API | Native | Native | No (Selenium) | No | **Native** |

#### Camoufox

**What**: C++ patched Firefox with fingerprint spoofing. Python wrapper.

**Status**: Returned from hiatus in early 2026 but labeled as "unstable beta". Good reCAPTCHA scores (0.7-0.9) but lacks the consistency and active maintenance of CloakBrowser.

**Drawback**: Firefox engine means different TLS fingerprint from Chrome, smaller ecosystem, and no native Playwright API support.

### Tier 2: Protocol-Level Patching

#### Patchright

**What**: Fork of Playwright that suppresses CDP automation signals at the protocol layer.

**How**: Modifies Playwright's internal CDP communication to avoid leaking automation markers that reCAPTCHA Enterprise detects.

**Limitation**: Only addresses CDP signals — does not fix canvas, WebGL, audio, or TLS fingerprinting. Breaks proxy auth and `add_init_script`. Use as a supplement, not standalone.

### Tier 3: Request-Level Bypass

#### CloudflareBypassForScraping (sarperavci)

**What**: A proxy server that generates Cloudflare clearance cookies using a headless browser, then mirrors subsequent requests with those cookies.

**Approach**: "Request mirroring" — change your API base URL to point to the local proxy, add `x-hostname` header. Initial request generates and caches `cf_clearance` cookies; subsequent requests reuse them.

**Docker**: `docker run -p 8000:8000 ghcr.io/sarperavci/cloudflarebypassforscraping:latest`

**Use case**: Lightweight Cloudflare bypass for simple scraping. Does not solve full browser fingerprinting.

### Tier 4: JS-Level Patching (DEPRECATED for SOTA)

#### puppeteer-extra-plugin-stealth / playwright-stealth

**Status**: Increasingly ineffective as of 2025-2026. Anti-bot systems now detect the patches themselves (e.g., inconsistencies between injected values and true browser behavior).

#### undetected-chromedriver

**Status**: Stale maintenance, breaks with every Chrome update. Config-level patches are detectable.

---

## Commercial Anti-Bot Services

| Service | Approach | Cloudflare Bypass | Pricing |
|---------|----------|-------------------|---------|
| **Bright Data** | Premium proxy network + Scraping Browser (real browser in cloud) | Yes | $$$$ (enterprise) |
| **Scrape.do** | Proxy API with automatic anti-bot handling | Yes | ~$29/mo+ |
| **ScrapingBee** | Headless browser API with stealth | Yes | ~$49/mo+ |
| **ZenRows** | Anti-bot bypass API | Yes | ~$49/mo+ |
| **Oxylabs** | Residential proxy + Web Scraper API | Yes | $$$$ (enterprise) |
| **Apify** | Actor-based scraping platform with anti-bot | Partial | Usage-based |

**When to use commercial services**: When you need guaranteed bypass rates at scale and can justify the cost. Best for production workloads where failure rate matters more than per-request cost.

---

## Detection vs Evasion Matrix

| Detection Layer | Plain HTTP | Playwright | +Stealth Plugin | CloakBrowser | CF Browser API |
|----------------|------------|-----------|-----------------|-------------|---------------|
| TLS/JA3 fingerprint | DETECTED | Pass | Pass | **Pass** | **Pass** |
| navigator.webdriver | N/A | DETECTED | Pass | **Pass** | **Pass** |
| Canvas fingerprint | N/A | DETECTED | Partial | **Pass** | **Pass** |
| WebGL fingerprint | N/A | DETECTED | Partial | **Pass** | **Pass** |
| Audio fingerprint | N/A | DETECTED | Fail | **Pass** | **Pass** |
| CDP detection | N/A | DETECTED | DETECTED | **Pass** | **Pass** |
| Plugin/chrome object | N/A | DETECTED | Pass | **Pass** | **Pass** |
| Behavioral analysis | N/A | DETECTED | DETECTED | **Pass** (humanize) | N/A |
| IP reputation | Depends | Depends | Depends | Depends (proxy) | **Pass** (CF IPs) |
| Per-customer anomaly | DETECTED | DETECTED | DETECTED | Partial | **Pass** |
| reCAPTCHA v3 score | 0.1 | 0.1 | 0.3-0.5 | **0.9** | N/A |
| Cloudflare Turnstile | Fail | Fail | Sometimes | **Pass** | **Pass** |

---

## Integration Strategy for Scorchcrawl

### Recommended Tiered Fallback Architecture

```
Request
  │
  ▼
┌─────────────────────────────┐
│ Tier 0: Direct HTTP Fetch   │  ← fastest, cheapest, works for unprotected sites
│ (node-fetch / undici)       │
└─────────────┬───────────────┘
              │ 403/challenge detected
              ▼
┌─────────────────────────────┐
│ Tier 1: Playwright          │  ← handles JS-rendered SPAs, basic bot checks
│ (standard, no stealth)      │
└─────────────┬───────────────┘
              │ still blocked
              ▼
┌─────────────────────────────┐
│ Tier 2: CloakBrowser        │  ← passes Cloudflare Turnstile, reCAPTCHA, etc.
│ (humanize=true + proxy)     │
└─────────────┬───────────────┘
              │ still blocked (aggressive per-customer rules)
              ▼
┌─────────────────────────────┐
│ Tier 3: CF Browser API      │  ← nuclear option for Cloudflare-protected sites
│ (Cloudflare's own browser)  │
└─────────────────────────────┘
```

### Implementation Notes

1. **Challenge detection**: Check for HTTP 403, Cloudflare challenge pages (`<title>Just a moment...</title>`), Turnstile iframes, and empty body responses.

2. **Domain-specific overrides**: Maintain a mapping of domains to preferred engines (already implemented in `urlSpecificParams.ts` for ScienceDirect).

3. **Cookie persistence**: For sites with Cloudflare challenges, solve once and cache `cf_clearance` cookies for subsequent requests. Cookies typically last 30 minutes to 24 hours.

4. **Proxy rotation**: Use residential proxies for Tier 2+ requests. Datacenter IPs are heavily flagged by IP reputation systems regardless of browser fingerprint.

5. **Rate limiting**: Respect per-domain rate limits. Aggressive scraping triggers behavioral anomaly detection even with perfect fingerprints.

6. **CloakBrowser integration**: Available as `npm install cloakbrowser` or Docker `cloakhq/cloakbrowser`. CDP server mode allows connecting remotely:
   ```
   docker run -d -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve
   ```
   Then connect via Playwright's `connect_over_cdp("http://localhost:9222")`.

7. **Cloudflare Browser Rendering API integration**: Add as an optional backend when a Cloudflare API token is configured. Route Cloudflare-protected domains to this API when lower tiers fail.

---

## Lessons Learned

### 1. JS-level stealth is dead for SOTA anti-bot
JavaScript injection (puppeteer-stealth, playwright-stealth) creates detectable inconsistencies. Anti-bot systems now check that reported values match at multiple layers: the JS API, the rendering pipeline, and the TLS handshake. Source-level binary patching (CloakBrowser) or using the provider's own infrastructure (CF Browser API) are the only reliable approaches.

### 2. TLS fingerprinting is the first gate
If your TLS fingerprint doesn't match a real browser, you're blocked before any JavaScript runs. Node.js `fetch`, Python `requests`, and curl all have distinctive JA3/JA4 fingerprints. You must use an actual browser binary or a TLS-mimicking library (like `curl-impersonate`).

### 3. IP reputation matters more than fingerprint quality
Even a perfect browser fingerprint gets blocked on datacenter IPs. Cloudflare, DataDome, and others maintain IP reputation databases. Residential proxies are essential for high-value targets. Mobile proxies have the best reputation scores.

### 4. Behavioral analysis is the new frontier
Cloudflare's per-customer anomaly detection means that even with perfect fingerprints and residential IPs, your traffic patterns must look natural. This includes:
- Time on page (spend 5-15 seconds minimum)
- Navigation depth (don't just hit one API endpoint repeatedly)
- Session continuity (use persistent cookies/profiles)
- Human-like interaction timing (CloakBrowser's `humanize=True`)

### 5. Don't fight the provider — use their infrastructure
Cloudflare's Browser Rendering API is the ultimate "bypass" for Cloudflare-protected sites because you're using Cloudflare's own browser. Similarly, for sites behind other CDNs, using the CDN's own rendering service (if available) avoids the arms race entirely.

### 6. Cookie caching is high-ROI
Solving a Cloudflare challenge once and caching `cf_clearance` cookies avoids repeated challenge solving. Most clearance cookies last 30 min to 24 hours. CloudflareBypassForScraping's "request mirroring" pattern (solve once, cache, reuse) is an efficient pattern for batch scraping.

### 7. CDP protocol leaks are subtle
Even with a patched browser binary, Playwright/Puppeteer send CDP (Chrome DevTools Protocol) commands that sophisticated systems detect:
- `page.waitForTimeout()` sends CDP commands — use `setTimeout` instead
- `page.evaluate()` creates extra JS contexts that reCAPTCHA detects
- `page.fill()` bypasses keyboard events — use `page.type()` with delay
- Minimize CDP traffic before critical checks (reCAPTCHA, Turnstile)

### 8. Headless vs headed still matters
Some aggressive detections (DataDome) catch headless mode even with C++ patches. Running headed with Xvfb (virtual framebuffer) passes these checks. Docker + Xvfb is the production pattern:
```bash
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
# then launch with headless=False
```

### 9. Persistent profiles prevent re-challenges
Sites that challenge first-time visitors with empty cookie jars pass returning visitors with established profiles. Use `launch_persistent_context()` to maintain cookies, localStorage, and cache across sessions. This avoids incognito detection (BrowserScan) and cold-start challenges.

### 10. The arms race never ends
Every bypass technique has a shelf life. Source-level patches (CloakBrowser) are harder to detect than JS injection, but not impossible. The sustainable strategy is a tiered architecture that can swap components as the landscape evolves, combined with rate limiting and respectful scraping practices.

### 11. ScienceDirect-specific findings
Academic publishers (ScienceDirect, Springer, Wiley) use aggressive anti-bot beyond standard Cloudflare:
- Custom bot detection scripts that check for automation markers
- IP-based rate limiting (even on residential IPs)
- CAPTCHA challenges on sequential page loads
- **Workaround**: Use the publisher's API when available (CrossRef, Unpaywall). Fall back to browser scraping with long delays (30+ seconds between requests) and persistent profiles.

### 12. Monitor and adapt
- Track bypass success rates per domain
- A/B test different approaches (Playwright vs CloakBrowser vs CF API)
- Log challenge types encountered for debugging
- Keep browser binaries updated (CloakBrowser auto-updates, but verify)
- Watch for new detection techniques on sites like `bot.incolumitas.com` and `browserscan.net`
