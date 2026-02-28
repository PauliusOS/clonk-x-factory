# Plan: Persist Web Build Jobs via Convex (clonk-x-factory changes)

## Context

Web build jobs are stored in an in-memory `Map` — they're lost on server restart. Replace with HTTP calls to the clonk.ai Convex backend (`POST/GET /api/job`) so jobs survive restarts and users can revisit build URLs.

**Prerequisite:** The clonk.ai Convex backend must have the `/api/job` endpoints deployed first. See `plans/clonk-jobs-web.md`.

## Changes

### 1. `src/channels/web.ts` — Replace in-memory Map with Convex HTTP calls

Remove:
- `Map<string, Job>` store
- `createJob()` helper
- `getJob()` export
- `setInterval` cleanup

Add:
- `persistJob(job)` — `POST {CLONK_SITE_API_URL}/api/job` with JSON body, fire-and-forget
- `fetchJob(id)` — `GET {CLONK_SITE_API_URL}/api/job?id=xxx`, returns Job or null
- Export `fetchJob`

Update `handleWebBuild()`:
- Generate `jobId` with `crypto.randomUUID()` upfront
- `await persistJob(...)` on create (with `status: 'processing', stage: 'classifying'`, `idea`, `username`)
- `onProgress` callback: `persistJob({ jobId, status: 'processing', stage: normalizeStage(stage) })`
- `reply` callback: `persistJob({ jobId, status: 'done', stage: 'done', result: text })`
- Error catch: `persistJob({ jobId, status: 'error', stage: 'error', result: err.message })`

### 2. `src/index.ts:121-125` — Update GET endpoint to async

```typescript
// Before (sync):
const job = getJob(jobId);

// After (async):
const job = await fetchJob(jobId);
```

### 3. No new env vars needed

Reuses `CLONK_SITE_API_URL` and `CLONK_SITE_API_KEY` (already set for gallery publishing).

## Files to modify

| File | Action |
|---|---|
| `src/channels/web.ts` | Rewrite storage layer: Map → Convex HTTP calls |
| `src/index.ts:121-125` | Make GET handler async, use `fetchJob()` |

## Verification

1. `npm run build` compiles
2. Deploy to Railway
3. Submit a build from website → get jobId
4. Poll `GET /api/build/:jobId` → see stages updating in real time
5. Restart Railway service → poll same jobId → job data still returns from Convex
6. Refresh website mid-build → progress resumes from current stage
