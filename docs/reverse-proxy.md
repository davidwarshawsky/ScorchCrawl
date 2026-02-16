# Reverse Proxy Setup

This guide shows how to expose ScorchCrawl behind nginx with HTTPS and API key authentication.

## Prerequisites

- A domain name pointing to your server
- nginx installed
- An SSL certificate (e.g., from Let's Encrypt)

## 1. Generate API Keys

```bash
# Generate a random 256-bit API key
openssl rand -hex 32
```

## 2. Create the API Key Map

Create `/etc/nginx/scorchcrawl-api-keys.list`:

```nginx
# Format: "key" value;
"your_api_key_here" 1;
```

## 3. nginx Configuration

Add to your nginx server block:

```nginx
# API key validation map
map $api_key $scorch_key_valid {
    default 0;
    include /etc/nginx/scorchcrawl-api-keys.list;
}

# Rate limiting
limit_req_zone $binary_remote_addr zone=scorch_api:10m rate=10r/s;

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # MCP endpoint with API key in URL path
    location ~ ^/mcp-api/scorchcrawl/([^/]+)/(.*)$ {
        set $api_key $1;
        set $path $2;
        limit_req zone=scorch_api burst=20 nodelay;

        if ($scorch_key_valid = 0) {
            return 401 '{"error": "Invalid API key"}';
        }

        proxy_pass http://127.0.0.1:24787/$path$is_args$args;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Reject invalid paths
    location /mcp-api/ {
        return 404 '{"error": "Invalid service or missing API key"}';
    }
}
```

## 4. Update `.env`

```env
ENABLE_REVERSE_PROXY=true
MCP_HOST=127.0.0.1
```

## 5. Client Configuration

In VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "scorchcrawl": {
        "type": "http",
        "url": "https://your-domain.com/mcp-api/scorchcrawl/YOUR_API_KEY/mcp"
      }
    }
  }
}
```

## 6. Reload nginx

```bash
sudo nginx -t && sudo systemctl reload nginx
```
