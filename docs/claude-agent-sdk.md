# Claude Agent SDK Integration

How clonk-x-factory uses the Claude Agent SDK to generate apps with the `/frontend-design` skill.

## Architecture

```
Tweet mention
  -> src/index.ts (polls X API every 120s)
  -> src/pipeline.ts (processTweetToApp)
  -> src/services/claude.ts (generateApp)
     -> @anthropic-ai/claude-agent-sdk query()
        -> spawns Claude Code CLI subprocess
        -> Claude loads /frontend-design skill via Skill tool
        -> returns structured JSON (GeneratedApp)
  -> deploy to Vercel + create GitHub repo + reply to tweet
```

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a wrapper around the **Claude Code CLI**. It spawns the CLI as a subprocess, which runs the agent loop (tool use, skill loading, structured output). This is why the CLI must be installed globally in the Docker image.

## Key File: `src/services/claude.ts`

### How `generateApp()` works

1. **Builds a prompt** from the tweet idea, parent context, and username
2. **Handles images** — if the tweet has images, uses an async generator to pass multimodal content blocks (text + image URLs). Otherwise passes a plain string prompt.
3. **Calls `query()`** with these options:
   - `model: 'claude-opus-4-5-20251101'` — the model to use
   - `systemPrompt` — technical requirements (React/Vite/TS/Tailwind, config rules)
   - `outputFormat` — JSON schema for structured output (`GeneratedApp` type)
   - `tools: ['Skill']` — only the Skill tool is available (no file writes, no bash)
   - `allowedTools: ['Skill']` — auto-approve the Skill tool without permission prompts
   - `settingSources: ['project']` — loads skills from `.claude/skills/` in the project
   - `permissionMode: 'bypassPermissions'` — headless server, no interactive prompts
   - `persistSession: false` — one-off generations, no session history
   - `maxTurns: 5` — limits the agent loop
   - `stderr` callback — logs Claude Code subprocess errors
4. **Reads `structured_output`** from the result message — no manual JSON parsing needed
5. **Returns `GeneratedApp`** — `{ appName, description, files[] }`

### Prompt structure

The user prompt tells Claude to `"Use /frontend-design to make it visually stunning and distinctive."` — Claude then invokes the Skill tool to load the design guidelines from `.claude/skills/frontend-design/SKILL.md` before generating the app.

### Image handling

Two prompt modes:
- **No images** — `prompt` is a plain string
- **Has images** — `prompt` is an async generator that yields a single `SDKUserMessage` with content blocks (image URLs + text)

```typescript
// Async generator for multimodal input
async function* generateMessages() {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
  };
}
prompt = generateMessages();
```

## Skill: `/frontend-design`

**Location:** `.claude/skills/frontend-design/SKILL.md`

The skill is loaded dynamically by the Agent SDK when Claude invokes the `Skill` tool. It contains design guidelines that push Claude to create visually distinctive UIs (bold typography, cohesive color palettes, animations, unexpected layouts) and avoid generic AI aesthetics.

The skill is triggered by the prompt line: `"Use /frontend-design to make it visually stunning and distinctive."`

To add new skills, create a new directory under `.claude/skills/<skill-name>/SKILL.md`.

## Docker & Railway Setup

### Why Docker is required

The Agent SDK spawns the Claude Code CLI as a child process. Railway needs:
1. Claude Code CLI installed globally (`npm install -g @anthropic-ai/claude-code`)
2. A non-root user (Claude Code **refuses** `--dangerously-skip-permissions` as root)
3. A `~/.claude/settings.json` initialized before the app starts

### Dockerfile key parts

```dockerfile
# Install CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Non-root user — required for bypassPermissions mode
RUN useradd -m -s /bin/bash appuser

# After building, switch to non-root
RUN chown -R appuser:appuser /app
USER appuser
ENV HOME=/home/appuser

# Use entrypoint to init .claude config before starting
CMD ["/app/entrypoint.sh"]
```

### `entrypoint.sh`

Creates `~/.claude/settings.json` with permission rules before starting the app:

```bash
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" << 'SETTINGS'
{
  "permissions": {
    "allow": ["Skill"],
    "deny": []
  }
}
SETTINGS
exec node dist/index.js
```

### `railway.toml`

Tells Railway to use the Dockerfile (not nixpacks) and configures health checks:

```toml
[build]
builder = "dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 60
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

## Environment Variables

Required on Railway:
- `ANTHROPIC_API_KEY` — passed to the Claude Code subprocess via `env: process.env`

The SDK inherits env vars from the parent process. No special config needed beyond setting the key in Railway's service variables.

## Gotchas & Lessons Learned

1. **Agent SDK requires Claude Code CLI** — it's not a standalone API client. It spawns `claude` as a subprocess.
2. **Cannot run as root** — Claude Code has a security check that blocks `--dangerously-skip-permissions` when `uid === 0`. Must use a non-root user.
3. **`npm ci` runs postinstall** — our `postinstall: tsc` fails during Docker build because source isn't copied yet. Fix: `npm ci --ignore-scripts`.
4. **`railway.toml` with `builder = "dockerfile"`** — without this, Railway may ignore the Dockerfile and use nixpacks.
5. **`settingSources: ['project']`** — required for the SDK to discover skills in `.claude/skills/`.
6. **Structured output eliminates JSON parsing** — `outputFormat` with `json_schema` means `result.structured_output` is already parsed. No more brace-counting.
7. **`tools: ['Skill']`** — restricts Claude to only the Skill tool. It can't write files to disk or run bash. It loads skill instructions, then returns structured JSON.

## Dependencies

```
@anthropic-ai/claude-agent-sdk  — Agent SDK (npm package, talks to CLI)
@anthropic-ai/claude-code       — Claude Code CLI (global install in Docker)
```

The raw API SDK (`@anthropic-ai/sdk`) is still in package.json but no longer used by `claude.ts`. It may be used elsewhere or can be removed.
