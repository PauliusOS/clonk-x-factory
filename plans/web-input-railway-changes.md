# Railway Bot Changes for Web Chat Input

These changes go in the **clonk-x-factory** Railway app to support the website's `/new` build page. The website submits build requests via HTTP and polls for status — these endpoints power that flow.

**Prerequisite:** The website plan is in `plans/web-input.md`.

---

## R.1 Add In-Memory Job Store

Create a new file `src/channels/web.ts`:

```typescript
interface Job {
  id: string;
  status: 'queued' | 'classifying' | 'generating' | 'deploying' | 'screenshot' | 'publishing' | 'done' | 'error';
  stage: string;
  idea: string;
  username: string;
  hasImage: boolean;
  result?: {
    vercelUrl: string;
    githubUrl: string;
    clonkPageUrl?: string;
  };
  error?: string;
  createdAt: number;
}

// In-memory store — jobs auto-expire after 1 hour
const jobs = new Map<string, Job>();

setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < oneHourAgo) jobs.delete(id);
  }
}, 5 * 60 * 1000);
```

---

## R.2 Add Two Express Endpoints in `src/index.ts`

**POST `/api/build`** — submit a new build request
- Accept `multipart/form-data` (use `multer` or similar for file upload parsing)
- Fields: `idea` (string, required), `image` (file, optional), `username` (string, optional, default `"web-user"`)
- Auth: `Authorization: Bearer {CLONK_WEB_API_KEY}`
- Creates a job, calls `handleMention()` with `source: 'web'`
- Returns: `{ jobId: string }` with status `202`

**GET `/api/build/:jobId`** — poll job status
- Auth: same Bearer token
- Returns the full `Job` object
- 404 if job not found

---

## R.3 Wire `reply` and `onProgress` to Job Updates

When creating the `PipelineInput` for a web request:

```typescript
const job = createJob(idea);

const pipelineInput: PipelineInput = {
  idea,
  messageId: job.id,
  userId: 'web',
  username: username || 'web-user',
  source: 'web',
  imageBuffers: image ? [{ data: imageBuffer, mediaType }] : undefined,
  reply: async (text, screenshotBuffer) => {
    // Parse URLs from reply text
    const vercelMatch = text.match(/https:\/\/[^\s]*\.vercel\.app[^\s]*/);
    const githubMatch = text.match(/https:\/\/github\.com\/[^\s]+/);
    const clonkMatch = text.match(/https:\/\/clonk\.ai\/[^\s]+/);

    job.status = 'done';
    job.stage = 'Done!';
    job.result = {
      vercelUrl: vercelMatch?.[0] || '',
      githubUrl: githubMatch?.[0] || '',
      clonkPageUrl: clonkMatch?.[0],
    };
  },
  onProgress: (stage) => {
    // Map stage text to status
    if (stage.includes('classif')) job.status = 'classifying';
    else if (stage.includes('generat')) job.status = 'generating';
    else if (stage.includes('deploy') || stage.includes('Vercel')) job.status = 'deploying';
    else if (stage.includes('screenshot')) job.status = 'screenshot';
    else if (stage.includes('publish') || stage.includes('clonk')) job.status = 'publishing';
    job.stage = stage;
  },
};
```

---

## R.4 Update `PipelineInput` Source Type

In `src/pipeline.ts`, add `'web'` to the source union:

```typescript
source: 'x' | 'telegram' | 'web';
```

---

## R.5 CORS

Add CORS headers to the `/api/build` endpoints so the website can call them:

```typescript
import cors from 'cors';

// Allow the website origin
app.use('/api/build', cors({
  origin: ['https://clonk.ai', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
}));
```

---

## R.6 Rate Limiting (Recommended)

Add basic rate limiting to prevent abuse since the API key is exposed client-side:

```typescript
// Simple: max 3 builds per IP per 10 minutes
import rateLimit from 'express-rate-limit';

const buildLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: 'Too many build requests. Please try again in a few minutes.' },
});

app.post('/api/build', buildLimiter, ...);
```

---

## R.7 New Environment Variable

Add to Railway:

```env
CLONK_WEB_API_KEY=<same-value-as-NEXT_PUBLIC_BOT_API_KEY>
```

---

## R.8 New Dependencies

```bash
npm install multer cors express-rate-limit
npm install -D @types/multer @types/cors
```

---

## Checklist

- [ ] Create `src/channels/web.ts` (job store + request handler)
- [ ] Add `POST /api/build` + `GET /api/build/:jobId` to `src/index.ts`
- [ ] Add `'web'` to `PipelineInput.source` union in `src/pipeline.ts`
- [ ] Add CORS middleware for website origin
- [ ] Add rate limiting on build endpoint
- [ ] Install `multer`, `cors`, `express-rate-limit`
- [ ] Add `CLONK_WEB_API_KEY` env var to Railway
- [ ] Deploy and test

---

## Files Changed

| File | Action | Description |
|---|---|---|
| `src/channels/web.ts` | **New** | Job store + web request handler |
| `src/index.ts` | **Modify** | Mount `/api/build` POST + GET endpoints, add CORS + rate limit |
| `src/pipeline.ts` | **Modify** | Add `'web'` to `PipelineInput.source` union type (1 line) |
| `package.json` | **Modify** | Add `multer`, `cors`, `express-rate-limit` |
