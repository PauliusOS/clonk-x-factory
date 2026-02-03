# Convex Integration

How the pipeline generates, configures, and deploys full-stack Convex apps.

## Overview

When a tweet mentions `@convex` alongside a build trigger (`build`, `make`, `create`), the pipeline runs a **Convex flow** instead of the standard static React flow:

1. **Create Convex project** — provisions a production deployment via Management API
2. **Generate app code** — Claude generates frontend + backend files using the Convex template
3. **Configure auth keys** — generates RS256 JWT key pair, sets env vars on deployment via HTTP API
4. **Deploy backend** — pushes `convex/*.ts` functions to Convex cloud
5. **Deploy frontend** — uploads all files to Vercel
6. **Reply** — tweets the live URL + GitHub link

```
Tweet: "build a todo app with @convex"
  → createConvexProject()          # Convex Management API
  → generateConvexApp()            # Claude Agent SDK
  → configureConvexAuthKeys()      # Deployment HTTP API (JWT keys)
  → deployConvexBackend()          # npx convex deploy
  → deployToVercel()               # Vercel API
  → replyToTweet()                 # X API
```

## Trigger Detection

**File:** `src/index.ts`

```typescript
const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime',
  'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
const wantsConvex = BACKEND_KEYWORDS.some(kw => tweetLower.includes(kw));
// ...
backend: wantsConvex ? 'convex' : undefined,
```

The tweet must contain a trigger keyword (`build`, `make`, `create`) AND mention any backend-related keyword to activate the Convex flow. This includes:
- Explicitly mentioning "convex"
- Describing backend needs: "backend", "database", "real-time"
- Describing auth needs: "login", "sign in", "sign up", "auth", "users", "accounts"

If none of these keywords are present, the standard static React + Vite template is used instead.

## Pipeline

**File:** `src/pipeline.ts`

The Convex-specific branch:

```typescript
if (input.backend === 'convex') {
  const convex = await createConvexProject(appName);
  generatedApp = await generateConvexApp(idea, convex.deploymentUrl, ...);

  const buildDir = generatedApp.buildDir!;
  await configureConvexAuthKeys(convex.deploymentUrl, convex.deployKey);
  await deployConvexBackend(buildDir, convex.deployKey);
}
```

Key difference from standard flow: the `buildDir` is preserved (not cleaned up) because `npx convex deploy` needs it.

## Convex Service

**File:** `src/services/convex.ts`

### `createConvexProject(appName)`

Creates a new Convex project and deploy key via the [Management API](https://api.convex.dev/v1):

1. `POST /teams/{teamId}/create_project` — provisions a production deployment
2. `POST /deployments/{name}/create_deploy_key` — creates a deploy key for CI

**Auth:** `Bearer {CONVEX_ACCESS_TOKEN}` header.

**Returns:** `{ projectId, deploymentName, deploymentUrl, deployKey }`

**Required env vars:** `CONVEX_TEAM_ID`, `CONVEX_ACCESS_TOKEN`

### `configureConvexAuthKeys(deploymentUrl, deployKey)`

Generates JWT keys and sets them on the deployment via the [Deployment Platform API](https://docs.convex.dev/deployment-platform-api):

1. Generates RS256 key pair using `jose` (`generateKeyPair`)
2. Exports private key (PKCS8) and public key (JWK)
3. `POST {deploymentUrl}/api/v1/update_environment_variables` — sets both in one call

**Auth:** `Convex {deployKey}` header.

**Sets these env vars on the deployment:**
- `JWT_PRIVATE_KEY` — private key with newlines collapsed to spaces
- `JWKS` — JSON Web Key Set (`{ keys: [{ use: "sig", ...publicKey }] }`)

These are required by `@convex-dev/auth` to sign session tokens. There is no way to avoid them.

**Why HTTP API instead of CLI:** The Convex CLI (`npx convex env set`) passes values through shell argument parsing. The private key starts with `-----BEGIN` which gets interpreted as a CLI flag. The HTTP API avoids this entirely — just a `fetch()` call with JSON body.

### `deployConvexBackend(buildDir, deployKey)`

Deploys backend functions to Convex cloud:

```
npx convex deploy
```

Runs from `buildDir` with `CONVEX_DEPLOY_KEY` in the environment. This compiles `convex/*.ts` files and pushes them to the cloud. Timeout: 120 seconds.

## Code Generation

**File:** `src/services/claude.ts`

### Build Directory

Each pipeline run gets a unique build dir to prevent concurrent collisions:

```typescript
function createBuildDir(): string {
  const id = crypto.randomBytes(4).toString('hex');
  return `/tmp/app-build-${id}`;
}
```

### Template Staging

`stageTemplateToBuildDir('convex-react-vite', buildDir, convexUrl)`:

1. Copies all files from `templates/convex-react-vite/` to the build dir
2. Processes `index.html.template` → `index.html` (strips font placeholders)
3. Creates `.env.local` with `VITE_CONVEX_URL={convexDeploymentUrl}`

### System Prompt

`makeConvexSystemPrompt(buildDir)` tells Claude:

- Stack is React 18 + TypeScript + Vite + Tailwind + Convex + Convex Auth
- Generate frontend files (`src/App.tsx`, `src/components/*`) AND backend files (`convex/schema.ts`, `convex/*.ts`)
- Include email/password authentication
- Do NOT recreate infrastructure files (they're pre-staged)
- Do NOT read/explore the build dir — trust the template
- Build verification: `npm install && npm run build` (only compiles `src/`, not `convex/`)
- Do NOT clean up the build dir

**Skills embedded in prompt:**
- `convex-backend` — from `.claude/skills/convex-backend/SKILL.md`
- `frontend-design` — from `.claude/skills/frontend-design/SKILL.md`

### `generateConvexApp(idea, convexDeploymentUrl, ...)`

1. Builds multimodal prompt (text + images from tweet/parent)
2. Stages `convex-react-vite` template with Convex URL
3. Calls `runClaudeQuery()` with Convex system prompt, `maxTurns: 15`
4. Claude generates files, writes them to build dir, runs build
5. Merges Claude's output with template files
6. Returns `GeneratedApp` with `buildDir` property preserved

### Template Merging

`mergeWithTemplate()` combines Claude's creative files with the template:

- Processes `index.html.template` with title + Google Font URLs from Claude
- Merges `extraDependencies` into `package.json`
- Injects `.env.local` with `VITE_CONVEX_URL`
- Claude's files override template files on conflict
- Returns complete file list ready for Vercel

## Template Structure

**Location:** `templates/convex-react-vite/`

### Pre-staged Infrastructure (do NOT modify)

| File | Purpose |
|------|---------|
| `package.json` | Dependencies: convex, @convex-dev/auth, cookie, react, vite, etc. |
| `tsconfig.json` | TypeScript config — only compiles `src/`, NOT `convex/` |
| `vite.config.ts` | Vite + React plugin |
| `index.html.template` | HTML shell with `{{TITLE}}`, `{{FONTS}}` placeholders, Tailwind CDN |
| `src/main.tsx` | App entry: wraps `<App />` in `<ConvexAuthProvider>` |
| `src/vite-env.d.ts` | Vite client type reference |
| `convex/auth.ts` | `convexAuth({ providers: [Password, Anonymous] })` |
| `convex/auth.config.ts` | Provider config with `CONVEX_SITE_URL` |
| `convex/http.ts` | HTTP router with `auth.addHttpRoutes(http)` |
| `convex/tsconfig.json` | Separate tsconfig for `convex/` directory |
| `convex/_generated/api.ts` | Proxy stub — returns `"module:function"` strings |
| `convex/_generated/server.ts` | Stub function constructors (`query`, `mutation`, `action`) |
| `convex/_generated/dataModel.ts` | Type stubs (`Id`, `Doc`, `DataModel`) |

### Generated by Claude

| File | Required | Purpose |
|------|----------|---------|
| `convex/schema.ts` | Yes | Database schema with `...authTables` |
| `convex/*.ts` | Yes | Server functions (queries, mutations, actions) |
| `src/App.tsx` | Yes | Main React component |
| `src/components/*` | No | Additional React components |
| `*.css` | No | Custom styles beyond Tailwind |

### `_generated/` Stubs

The `convex/_generated/` stubs exist so `tsc` passes during the build step. They're NOT the real generated files:

- **`api.ts`** — Proxy that returns `"module:function"` strings (e.g., `api.tasks.list` → `"tasks:list"`). The colon separator is critical — Convex uses it to route function calls. A dot would be interpreted as a file extension.
- **`server.ts`** — Untyped function constructors (`query`, `mutation`, `action`) that pass through to allow compilation.
- **`dataModel.ts`** — Type stubs for `Id<T>`, `Doc<T>`, etc.

The real `_generated/` files are created by `npx convex deploy` during the pipeline's deploy step.

## Authentication

### How It Works

The template uses [Convex Auth](https://labs.convex.dev/auth) with two built-in providers:

- **Password** — email/password sign-in and sign-up
- **Anonymous** — guest access without credentials

No external OAuth providers, no redirect URIs, no external service configuration needed. Everything runs within Convex.

### Required Environment Variables (set on each deployment)

| Variable | Set By | Purpose |
|----------|--------|---------|
| `JWT_PRIVATE_KEY` | `configureConvexAuthKeys()` | Signs session tokens (RS256 PKCS8) |
| `JWKS` | `configureConvexAuthKeys()` | Public key set for token validation |
| `VITE_CONVEX_URL` | Template staging (`.env.local`) | Frontend connects to Convex backend |

### Why Not WorkOS / External OAuth?

Previously used WorkOS AuthKit, but it requires per-deployment OAuth redirect URIs. Since each app gets a unique Convex deployment URL, there's no way to pre-configure a single redirect URI. Password + Anonymous providers avoid this entirely.

### Client-Side Auth Pattern

```tsx
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";

// Password sign-in/sign-up
const { signIn } = useAuthActions();
await signIn("password", { email, password, flow: "signIn" }); // or "signUp"

// Anonymous guest access
await signIn("anonymous");

// Check auth state
const { isAuthenticated, isLoading } = useConvexAuth();

// Sign out
const { signOut } = useAuthActions();
await signOut();
```

### Server-Side Auth

```typescript
import { getAuthUserId } from "@convex-dev/auth/server";

export const myQuery = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return []; // or throw
    // ... use userId
  },
});
```

## Environment Variables

### Pipeline Runtime (on Railway)

| Variable | Purpose |
|----------|---------|
| `CONVEX_TEAM_ID` | Convex team/org for project creation |
| `CONVEX_ACCESS_TOKEN` | Management API auth (Bearer token) |

### Per-Deployment (set automatically)

| Variable | Where Set | How Set |
|----------|-----------|---------|
| `JWT_PRIVATE_KEY` | Convex deployment | HTTP API (`/api/v1/update_environment_variables`) |
| `JWKS` | Convex deployment | HTTP API (same call) |
| `VITE_CONVEX_URL` | `.env.local` in build dir | Template staging |
| `CONVEX_DEPLOY_KEY` | Process env during `npx convex deploy` | Passed via `execSync` env option |

## Dependencies

### Root Project (`package.json`)

- `jose` — RS256 key pair generation for JWT auth setup

### Template (`templates/convex-react-vite/package.json`)

- `convex: ^1.17.0` — Convex client + CLI
- `@convex-dev/auth: ^0.0.74` — Built-in auth (Password, Anonymous)
- `cookie: ^1.0.2` — Session cookie handling (required by @convex-dev/auth)
- `@types/node: ^22.0.0` — Required so `process.env` resolves in `convex/auth.config.ts`

Note: `@auth/core` was removed — it was only needed for WorkOS OAuth and caused peer dependency conflicts with `@convex-dev/auth@0.0.74` on Vercel.

## Common Issues & Fixes

### `Cannot read properties of undefined (reading 'map')` in `convexAuth()`
**Cause:** `convexAuth({})` called without `providers` array.
**Fix:** Pass `providers: [Password, Anonymous]` explicitly.

### `Cannot find name 'process'` in `auth.config.ts`
**Cause:** Convex CLI runs its own `tsc` on `convex/` directory, and `@types/node` wasn't installed.
**Fix:** Add `@types/node` to devDependencies.

### Vercel `npm install` fails with peer dependency conflict
**Cause:** `@auth/core@^0.37.0` conflicts with `@convex-dev/auth@0.0.74` (expects `^0.36.0`).
**Fix:** Remove `@auth/core` entirely (not needed for Password/Anonymous providers).

### `Module path has an extension that isn't 'js'`
**Cause:** `_generated/api.ts` stub returned `"module.function"` (dot separator). Convex interprets the dot as a file extension.
**Fix:** Use colon separator: `"module:function"`.

### `Missing environment variable JWT_PRIVATE_KEY`
**Cause:** `@convex-dev/auth` needs JWT keys for session tokens. They must be set on each deployment.
**Fix:** `configureConvexAuthKeys()` generates and sets them via the Deployment HTTP API.

### `error: unknown option '-----BEGIN PRIVATE KEY-----'`
**Cause:** CLI arg parser interprets `-----BEGIN` as a flag when using `npx convex env set`.
**Fix:** Use the HTTP API (`/api/v1/update_environment_variables`) instead of CLI.

### Concurrent builds clobber each other
**Cause:** All builds used the same `/tmp/app-build/` directory.
**Fix:** Each build gets a unique `/tmp/app-build-{randomHex}/` directory.
