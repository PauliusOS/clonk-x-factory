# Claude Agent SDK Integration

How clonk-x-factory uses the Claude Agent SDK to generate apps.

## Architecture

```
Tweet mention
  -> src/index.ts (polls X API every 120s)
  -> src/pipeline.ts (processTweetToApp)
  -> src/services/claude.ts (generateApp)
     1. Pre-stage template files to /tmp/app-build/
     2. Call @anthropic-ai/claude-agent-sdk query()
        -> spawns Claude Code CLI subprocess
        -> Claude writes creative src/ files via Write tool
        -> Claude runs build verification via Bash tool
        -> returns structured JSON (RawGeneratedApp)
     3. Merge template + creative files (fonts, extra deps)
     4. Return GeneratedApp
  -> deploy to Vercel + create GitHub repo + reply to tweet
```

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a wrapper around the **Claude Code CLI**. It spawns the CLI as a subprocess, which runs the agent loop (tool use, skill loading, structured output). This is why the CLI must be installed globally in the Docker image.

## Key File: `src/services/claude.ts`

### Template System

Infrastructure files that never change are stored in `templates/react-vite/`:

```
templates/react-vite/
├── package.json          # Fixed deps: react, react-dom, typescript, vite
├── tsconfig.json         # Self-contained config, noUnusedLocals: false
├── vite.config.ts        # Simple react plugin setup
├── src/main.tsx          # Standard ReactDOM.createRoot entry
└── index.html.template   # Skeleton with {{TITLE}} and {{FONTS}} slots
```

Claude only generates creative files (`src/App.tsx`, components, CSS). The pipeline merges template + creative output for deployment. This saves ~3000 tokens per generation and eliminates config-based build failures.

### How `generateApp()` works

1. **Builds a prompt** from the tweet idea, parent context, and username
2. **Handles images** — if the tweet has images, uses an async generator to pass multimodal content blocks (text + image URLs). Otherwise passes a plain string prompt.
3. **Pre-stages template files** to `/tmp/app-build/` so Claude only writes creative files there
4. **Calls `query()`** with these options:
   - `model: 'claude-opus-4-5-20251101'`
   - `systemPrompt` — technical requirements + design guidelines (loaded from skills)
   - `outputFormat` — JSON schema for structured output (`RawGeneratedApp` type)
   - `settingSources: ['project']` — loads skills from `.claude/skills/`
   - `tools / allowedTools: ['Skill', 'Bash', 'Write', 'Read', 'Edit']`
   - `permissionMode: 'bypassPermissions'` — headless server, no interactive prompts
   - `persistSession: false` — one-off generations, no session history
   - `maxTurns: 20` — enough room for skill loading + file writes + build verification + retries
   - `stderr` callback — logs Claude Code subprocess errors
5. **Reads `structured_output`** — contains only creative files + metadata (fonts, title, extra deps)
6. **Merges with template** — injects fonts into index.html, merges extra deps into package.json
7. **Returns `GeneratedApp`** — `{ appName, description, files[] }` with all files ready for deployment

### Structured Output

Claude returns a `RawGeneratedApp`:

```typescript
interface RawGeneratedApp {
  appName: string;           // kebab-case
  description: string;       // one sentence
  title: string;             // browser tab title
  fonts: string[];           // Google Font stylesheet URLs
  extraDependencies?: Record<string, string>;  // e.g. { "framer-motion": "^11.0.0" }
  files: { path: string; content: string }[];  // ONLY src/ files
}
```

The exported `GeneratedApp` (consumed by pipeline, Vercel, GitHub) has the same shape but `files` includes everything (template + creative):

```typescript
interface GeneratedApp {
  appName: string;
  description: string;
  files: { path: string; content: string }[];  // ALL files
}
```

### Build Verification

Claude verifies its own code compiles before returning:

1. Template files are pre-staged at `/tmp/app-build/` by the pipeline
2. Claude writes creative files to `/tmp/app-build/src/` using the **Write tool** (not Bash heredocs — JS code with brackets like `arr[i]` causes shell substitution errors)
3. If extra deps needed, Claude installs them: `cd /tmp/app-build && npm install <pkg>`
4. Claude runs `cd /tmp/app-build && npm install && npm run build`
5. If build fails, Claude reads the errors and fixes them (max 2 retries)
6. Claude cleans up: `rm -rf /tmp/app-build`

### Skill Loading (dual mechanism)

Skills are loaded two ways for resilience:

1. **Embedded in system prompt** — `loadSkills()` reads all `.claude/skills/*/SKILL.md` files at startup, strips YAML frontmatter, and appends them to the system prompt under `## Design Guidelines`. This always works regardless of SDK state.
2. **Native SDK Skill tool** — `settingSources: ['project']` + `Skill` in `allowedTools` lets Claude invoke skills via the `/skill-name` syntax. This is the standard SDK approach and supports future extensibility.

Both mechanisms read from `.claude/skills/` as the single source of truth. To add a new skill, just create `.claude/skills/<name>/SKILL.md`.

## Skill: `/frontend-design`

**Location:** `.claude/skills/frontend-design/SKILL.md`

Design guidelines that push Claude to create visually distinctive UIs (bold typography, cohesive color palettes, animations, unexpected layouts) and avoid generic AI aesthetics.

Triggered by the prompt line: `"Use /frontend-design and follow the Design Guidelines to make it visually stunning and distinctive."`

## Docker & Railway Setup

### Why Docker is required

The Agent SDK spawns the Claude Code CLI as a child process. Railway needs:
1. Claude Code CLI installed globally (`npm install -g @anthropic-ai/claude-code`)
2. A non-root user (Claude Code refuses `--dangerously-skip-permissions` as root)
3. `~/.claude/settings.json` and `~/.claude/remote-settings.json` initialized before the app starts

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

Creates required config files before starting the app:

```bash
mkdir -p "$HOME/.claude"

# Tool permissions for the CLI subprocess
cat > "$HOME/.claude/settings.json" << 'SETTINGS'
{
  "permissions": {
    "allow": ["Skill", "Bash", "Write", "Read", "Edit"],
    "deny": []
  }
}
SETTINGS

# Prevent SDK ENOENT crash on missing remote-settings.json
echo '{}' > "$HOME/.claude/remote-settings.json"

exec node dist/index.js
```

### Required files in `.claude/`

The project must have:

```
.claude/
├── settings.json                    # Tool permissions (REQUIRED — SDK crashes without it
│                                    #   when settingSources: ['project'] is used)
└── skills/
    └── frontend-design/
        └── SKILL.md                 # Design guidelines skill
```

**The `settings.json` is critical.** Without it, `settingSources: ['project']` causes `RangeError: Maximum call stack size exceeded` — the SDK enters a recursive hook execution loop when the expected settings file is missing. See "Gotchas" below.

## Environment Variables

Required on Railway:
- `ANTHROPIC_API_KEY` — passed to the Claude Code subprocess via `env: process.env`

The SDK inherits env vars from the parent process. No special config needed beyond setting the key in Railway's service variables.

## Gotchas & Lessons Learned

### Critical

1. **`.claude/settings.json` MUST exist when using `settingSources: ['project']`** — without it the SDK hits `RangeError: Maximum call stack size exceeded` (recursive hook execution). The file needs at minimum `{}`, but should include tool permissions. This is not documented in the SDK docs and may be a bug, but the workaround is trivial.

2. **`~/.claude/remote-settings.json` must exist** — the SDK tries to read this at startup. If missing: `ENOENT: no such file or directory`. Create it with `echo '{}' > ~/.claude/remote-settings.json` in the entrypoint.

3. **Never use Bash heredocs for writing source files** — JS/TS code containing array brackets (e.g. `arr[i]`, `monthNames[date.getMonth()]`) causes `Bad substitution` errors in bash. Always use the Write tool for source files, Bash only for running commands.

4. **Cannot run as root** — Claude Code has a security check that blocks `--dangerously-skip-permissions` when `uid === 0`. Must use a non-root user in Docker.

### Important

5. **Agent SDK requires Claude Code CLI** — it's not a standalone API client. It spawns `claude` as a subprocess. The CLI must be installed globally in the Docker image.

6. **`npm ci` runs postinstall** — if `postinstall: tsc` is set, it fails during Docker build because source isn't copied yet. Fix: `npm ci --ignore-scripts`.

7. **Structured output eliminates JSON parsing** — `outputFormat` with `json_schema` means `result.structured_output` is already parsed. No manual parsing needed.

8. **`Bun is not defined` errors are non-fatal** — the SDK tries to detect the Bun runtime and falls back to Node.js. These stderr messages can be ignored.

9. **Template files eliminate config build failures** — by pre-staging known-good package.json, tsconfig, and vite.config, Claude never generates broken configs. The only build failures come from TypeScript errors in creative code, which Claude can self-fix.

## Dependencies

```
@anthropic-ai/claude-agent-sdk  — Agent SDK (npm package, talks to CLI)
@anthropic-ai/claude-code       — Claude Code CLI (global install in Docker)
```
