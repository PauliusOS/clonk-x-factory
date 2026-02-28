# Plan: Web Chat Input — Build Apps from the Website

## Overview

Add a chat-style input to the website in /new so users can submit build requests (text + optional image) directly from the browser — the same experience as Telegram, but on the web. The user sees real-time build progress, and when done, the deployed app is shown embedded in an iframe alongside links to the live app, source code, and gallery page.

---

## Architecture

```
┌───────────────────────────────┐         ┌──────────────────────────────────┐
│        clonk.ai Website       │         │     clonk-x-factory (Railway)    │
│     (Next.js + Convex)        │         │     Express server               │
│                               │         │                                  │
│  [Chat Input UI]              │         │  POST /api/build                 │
│    ↓ submit                   │  HTTP   │    → classify + moderate         │
│  [POST /api/build] ──────────────────→  │    → generate code (Claude)      │
│    ↓ returns jobId            │         │    → deploy (Vercel + GitHub)    │
│  [Poll GET /api/build/:id] ──────────→  │    → screenshot + gallery       │
│    ↓ status updates           │         │    → update job status           │
│  [Progress UI]                │         │                                  │
│    ↓ done                     │         │  GET /api/build/:jobId           │
│  [Result: iframe + links]     │         │    → returns job state           │
└───────────────────────────────┘         └──────────────────────────────────┘
```

**Two sets of changes:**
1. **clonk.ai website** (this document) — chat UI, polling, result display
2. **clonk-x-factory on Railway** — new HTTP endpoints + job tracking (see `plans/web-input-railway-changes.md`)

---

## Part 1: Website — Chat Input Component

### 1.1 Create a Build Page / Section

Add a new page or section (e.g. `/new` or a prominent section on the homepage) with a chat-style input. This is the primary entry point for web users.

**Component: `BuildInput`**

- **Text area** — auto-expanding, placeholder: `"Describe the app you want to build..."`
- **Image upload** — button + drag-and-drop zone. When an image is attached, show a thumbnail preview with a remove button
- **Submit button** — disabled when text is empty. Label: "Build" or "Build it"
- **Max image size**: 5MB client-side validation (the bot handles larger but this prevents accidental huge uploads)
- **Keyboard shortcut**: Cmd/Ctrl+Enter to submit

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Describe the app you want to build...              │
│                                                     │
│                                                     │
│  ┌──────────┐                                       │
│  │ 📷 thumb │ ✕                          [ Build ]  │
│  └──────────┘                                       │
└─────────────────────────────────────────────────────┘
```

### 1.2 Submitting a Build Request

On submit, POST to the Railway bot server:

```typescript
async function submitBuild(idea: string, image?: File): Promise<string> {
  const form = new FormData();
  form.append('idea', idea);
  if (image) form.append('image', image);

  const res = await fetch(`${process.env.NEXT_PUBLIC_BOT_API_URL}/api/build`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.NEXT_PUBLIC_BOT_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Build submission failed (${res.status})`);
  }

  const { jobId } = await res.json();
  return jobId;
}
```

After getting the `jobId`, transition the UI from the input to the progress view.

---

## Part 2: Website — Progress Display

### 2.1 Poll for Job Status

Once you have a `jobId`, poll `GET /api/build/:jobId` every 2-3 seconds:

```typescript
async function getJobStatus(jobId: string): Promise<Job> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_BOT_API_URL}/api/build/${jobId}`,
    { headers: { 'Authorization': `Bearer ${process.env.NEXT_PUBLIC_BOT_API_KEY}` } },
  );
  return res.json();
}
```

**Job shape returned by the API:**

```typescript
interface Job {
  id: string;
  status: 'queued' | 'classifying' | 'generating' | 'deploying' | 'screenshot' | 'publishing' | 'done' | 'error';
  stage: string;          // Human-readable, e.g. "generating code with Claude..."
  idea: string;
  createdAt: number;
  result?: {
    vercelUrl: string;
    githubUrl: string;
    clonkPageUrl?: string;
  };
  error?: string;
}
```

### 2.2 Progress UI Component

Show a step-by-step progress indicator that updates in real-time as the job advances:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Building: "a pomodoro timer with sound effects"    │
│                                                     │
│  ✅  Classifying request                            │
│  ✅  Generating code with Claude                    │
│  ⏳  Deploying to Vercel...                         │
│  ○   Taking screenshot                              │
│  ○   Publishing to gallery                          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Stage mapping** — map `status` values to display steps:

| `status` value | Display | State |
|---|---|---|
| `queued` | Queued... | spinner |
| `classifying` | Classifying request | spinner |
| `generating` | Generating code with Claude | spinner |
| `deploying` | Deploying to Vercel | spinner |
| `screenshot` | Taking screenshot | spinner |
| `publishing` | Publishing to gallery | spinner |
| `done` | Done! | all checkmarks |
| `error` | Error | error state |

Each step shows:
- **Checkmark** for completed steps (all steps before current)
- **Spinner** for the current step
- **Empty circle** for future steps
- Use the `stage` string as the label for the currently active step (it's human-readable and matches what Telegram users see)

### 2.3 Error State

If `status === 'error'`:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ❌ Something went wrong                            │
│                                                     │
│  {job.error || "Couldn't build that app right now"} │
│                                                     │
│                        [ Try Again ]                │
│                                                     │
└─────────────────────────────────────────────────────┘
```

"Try Again" resets to the input view with the previous idea pre-filled.

---

## Part 3: Website — Result Display

### 3.1 Success State

When `status === 'done'`, transform the progress view into a result card:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ✅ Your app is ready!                              │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │                                             │    │
│  │          LIVE APP IFRAME                    │    │
│  │          (job.result.vercelUrl)             │    │
│  │                                             │    │
│  │                                             │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  [ ▶️ Open App ]  [ 📝 View Source ]  [ 🌐 Gallery ] │
│                                                     │
│                  [ Build Another ]                   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 3.2 Iframe Embed

```html
<iframe
  src="{vercelUrl}"
  style="width: 100%; height: 600px; border-radius: 12px; border: 1px solid #e5e7eb;"
  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
  loading="lazy"
  title="Live app preview"
/>
```

The iframe is cross-origin safe since the app is on `*.vercel.app` and the site is on `clonk.ai`.

### 3.3 Action Buttons

- **Open App** — `window.open(job.result.vercelUrl, '_blank')` — opens full-screen in new tab
- **View Source** — `window.open(job.result.githubUrl, '_blank')` — GitHub repo
- **Gallery** — only shown if `job.result.clonkPageUrl` exists — links to `clonk.ai/app/{slug}`
- **Build Another** — resets the entire flow back to the chat input

---

## Part 4: Website Environment Variables

Add these to your website's env (Vercel dashboard or `.env.local`):

```env
# Bot server URL (Railway deployment)
NEXT_PUBLIC_BOT_API_URL=https://clonk-x-factory-production.up.railway.app

# Shared secret for bot API auth
NEXT_PUBLIC_BOT_API_KEY=<generate-with-openssl-rand-hex-32>
```

**Note on client-side exposure:** These `NEXT_PUBLIC_` vars are visible in the browser bundle. The API key is a basic abuse-prevention measure, not true authentication. For hardening, the bot server should add rate limiting per IP (see Railway changes section).

---

## Part 5: UX Flow Summary

```
1. User visits /build (or homepage section)
2. Types "a pomodoro timer with sound effects"
3. Optionally drags/drops a reference screenshot
4. Clicks "Build" (or Cmd+Enter)
5. Input disables, progress card appears
6. Progress updates every 2-3s via polling:
   - "Classifying your request..."
   - "Generating code with Claude..."
   - "Deploying to Vercel..."
   - "Taking screenshot..."
   - "Publishing to gallery..."
7. Build completes (~2-3 minutes) → result card appears:
   - Embedded iframe showing the live app
   - "Open App" button → vercelUrl in new tab
   - "View Source" → githubUrl
   - "Gallery" → clonkPageUrl (if available)
   - "Build Another" → reset to step 1
```

---

## Part 6: Component Structure

Suggested file structure for the website:

```
app/
  build/
    page.tsx              # The /build route
components/
  build/
    BuildInput.tsx        # Text area + image upload + submit button
    BuildProgress.tsx     # Step-by-step progress indicator
    BuildResult.tsx       # Iframe embed + action buttons
    BuildFlow.tsx         # State machine that orchestrates Input → Progress → Result
lib/
  bot-api.ts              # submitBuild() + getJobStatus() API client functions
```

### State Machine (BuildFlow.tsx)

```typescript
type BuildState =
  | { phase: 'input' }
  | { phase: 'building'; jobId: string }
  | { phase: 'done'; job: Job }
  | { phase: 'error'; job: Job; previousIdea: string };
```

- `input` → user submits → `building`
- `building` → poll returns `done` → `done`
- `building` → poll returns `error` → `error`
- `done` → "Build Another" click → `input`
- `error` → "Try Again" click → `input` (pre-fill idea)

---

## Part 7: Optional Enhancements

These are nice-to-haves, not required for v1:

1. **Persist job ID in URL** — e.g. `/build?job=abc123` so the user can share/refresh the progress page
2. **Recent builds list** — show the user's recent builds (store jobIds in localStorage)
3. **Template selector** — let users pick "3D Game", "With Backend", or "Standard" before submitting (maps to the same template keywords the bot uses)
4. **Sound/notification** — play a sound or browser notification when the build completes (builds take 2-3 min, user might tab away)

---

## Checklist

- [ ] Create `/new` page route
- [ ] Build `BuildInput` component (text area + image upload + submit)
- [ ] Build `BuildProgress` component (step indicator + polling)
- [ ] Build `BuildResult` component (iframe embed + action buttons)
- [ ] Build `BuildFlow` orchestrator (state machine: input → building → done/error)
- [ ] Create `lib/bot-api.ts` (submitBuild + getJobStatus client functions)
- [ ] Add env vars: `NEXT_PUBLIC_BOT_API_URL`, `NEXT_PUBLIC_BOT_API_KEY`
- [ ] Test end-to-end with Railway bot

---

## Summary

| Where | What | Effort |
|---|---|---|
| **Website** | `BuildInput` + `BuildProgress` + `BuildResult` + `BuildFlow` + API client | ~4-5 components, ~300-400 lines |
| **Website** | `/new` page route | 1 page |
| **Website** | 2 env vars | Config |

The website changes are purely frontend — a form, a poller, and a result display. The Railway bot changes are in `plans/web-input-railway-changes.md`. The pipeline itself (`processMentionToApp`) needs zero changes — it already supports `onProgress` and `reply` callbacks.
