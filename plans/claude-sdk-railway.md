# Fix Claude Agent SDK on Railway

## Problem
The Agent SDK spawns the Claude Code CLI as a subprocess, which exits with code 1. Our current setup is missing critical configuration that the working reference implementation (chrisboden/cloude-agent) has.

## Root Causes (comparing against working reference)

1. **No `railway.toml`** — Railway may not be using our Dockerfile at all (falling back to nixpacks). The reference uses `builder = "dockerfile"` explicitly.
2. **No `.claude` config directory in container** — Claude Code needs a `.claude/settings.json` with permission rules. The reference creates this via `entrypoint.sh`.
3. **No health check configured** — Railway may kill the container before it's ready.
4. **Missing `ALLOW_BYPASS_PERMISSIONS`** — The reference sets this env var to allow headless operation.

## Implementation Steps

### 1. Add `railway.toml`
Tell Railway to use the Dockerfile and configure health checks:
```toml
[build]
builder = "dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 60
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

### 2. Add health check endpoint
The app already has Express on port 8080. Add a `/health` endpoint in `src/index.ts`.

### 3. Create `entrypoint.sh`
Initialize the `.claude` directory and settings before starting the app:
```bash
#!/bin/bash
set -e

# Create .claude config directory
mkdir -p /home/node/.claude
mkdir -p /app/.claude/skills

# Create settings.json that allows bypass permissions
cat > /home/node/.claude/settings.json << 'SETTINGS'
{
  "permissions": {
    "allow": ["Skill"],
    "deny": []
  }
}
SETTINGS

exec node dist/index.js
```

### 4. Update Dockerfile
- Add an `entrypoint.sh` instead of raw `CMD`
- Ensure `.claude/skills/` directory is included in the image
- Set `HOME` env var so Claude Code finds its config

```dockerfile
FROM node:22-slim

# System deps for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation libgbm1 libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libnss3 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxrandr2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV HOME=/home/node

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# Make entrypoint executable
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
```

### 5. Pass env explicitly in `src/services/claude.ts`
Ensure `ANTHROPIC_API_KEY` reaches the subprocess. Already done in latest commit — just verify it works with the new setup.

## Files to Create/Modify
- **Create** `railway.toml` — build + deploy config
- **Create** `entrypoint.sh` — container initialization
- **Modify** `Dockerfile` — use entrypoint, set HOME
- **Modify** `src/index.ts` — add `/health` endpoint

## Env Vars Needed on Railway
- `ANTHROPIC_API_KEY` — must be set in Railway service variables
- All existing env vars (Twitter, Vercel, GitHub tokens)

## Verification
After deploy, Railway logs should show:
1. Health check passing at `/health`
2. `[claude-code stderr]` output (if any issues) instead of silent exit code 1
3. Successful app generation with `/frontend-design` skill invocation
