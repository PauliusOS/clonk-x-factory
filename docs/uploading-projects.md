# Uploading Projects to clonk.ai Gallery

After every successful app deployment, the bot publishes the app's metadata and screenshot to the clonk.ai gallery. Each app gets a page at `https://clonk.ai/app/{slug}`.

---

## How It Works

The publish step runs in `src/pipeline.ts` **after** the screenshot is taken but **before** the X reply is posted. If publishing succeeds, the clonk.ai page URL is included in the reply tweet.

### Pipeline Position

```
1. Generate app code (Claude)
2. Deploy to Vercel
3. Create GitHub repo + wait for deployment
4. Take screenshot + upload to X
5. ** Publish to clonk.ai **    <-- this step
6. Reply to tweet (includes clonk.ai link if publish succeeded)
```

### Non-Fatal

The publish step is wrapped in a try/catch. If it fails for any reason (network error, Convex down, bad response), the bot logs a warning and continues -- the X reply still goes out, just without the clonk.ai link. Same pattern as the screenshot step.

---

## src/services/clonkSite.ts -- Gallery Publisher

**File**: `/Users/paulius/clonk/clonk-x-factory/src/services/clonkSite.ts`

Publishes deployed app entries to the clonk.ai Convex backend via an HTTP action.

### Interface

```typescript
interface AppEntry {
  appName: string;           // kebab-case app name, e.g. "meme-dashboard"
  description: string;       // One-line description from Claude
  vercelUrl: string;         // Deployed app URL, e.g. "https://meme-dashboard-a3f1b2.vercel.app"
  githubUrl: string;         // Source repo URL, e.g. "https://github.com/clonkbot/meme-dashboard-a3f1b2"
  username: string;          // X handle of the person who requested the app (no @)
  template: 'react' | 'convex' | 'threejs';
  screenshot?: Buffer;       // PNG buffer (same one uploaded to X), ~200KB typical
}
```

### API Request

```
POST {CLONK_SITE_API_URL}/api/publish?appName=...&description=...&vercelUrl=...&githubUrl=...&username=...&template=react
Authorization: Bearer {CLONK_SITE_API_KEY}
Content-Type: image/png
Body: <raw PNG screenshot bytes>
```

- **Metadata** is sent as URL query parameters
- **Screenshot** is sent as the raw binary request body with `Content-Type: image/png`
- If no screenshot is available (screenshot step failed), the body is empty and `Content-Type` is omitted
- **Authentication** uses a shared secret via `Authorization: Bearer` header

This approach avoids multipart form complexity and works directly with Convex HTTP actions, which accept `request.blob()`.

### Response

```json
{ "slug": "meme-dashboard", "pageUrl": "https://clonk.ai/app/meme-dashboard" }
```

The function returns `pageUrl` on success, or `null` if env vars are missing.

### Skip Behavior

If `CLONK_SITE_API_URL` or `CLONK_SITE_API_KEY` are not set, the function immediately returns `null` and logs which variable is missing:

```
⏭️ Skipping clonk.ai publish (CLONK_SITE_API_URL=missing, CLONK_SITE_API_KEY=set)
```

---

## Environment Variables

| Variable | Value | Where to set |
|---|---|---|
| `CLONK_SITE_API_URL` | `https://tacit-capybara-732.convex.site` | Railway service variables |
| `CLONK_SITE_API_KEY` | `clk_sk_...` (shared secret) | Railway service variables |

Both are **optional** -- if either is missing, the publish step is silently skipped and the bot works exactly as before.

The same API key must also be set as `CLONK_API_KEY` in the Convex dashboard for the clonk.ai project.

---

## What Happens on the clonk.ai Side

The clonk.ai website is a separate Next.js + Convex project. The bot doesn't need to know the details, but for reference:

### Convex Backend

1. **HTTP action** at `POST /api/publish` receives the request
2. Verifies the API key against the `CLONK_API_KEY` Convex environment variable
3. Stores the screenshot in **Convex file storage** (`ctx.storage.store(blob)`) -- same system used for logo uploads
4. Generates a unique **slug** from the app name (e.g. `crab-hotel`), with a suffix if the slug already exists
5. Inserts a row into the **`apps` table** via an internal mutation
6. Returns `{ slug, pageUrl }`

### Convex Schema (apps table)

```typescript
apps: defineTable({
  slug: v.string(),
  appName: v.string(),
  description: v.string(),
  vercelUrl: v.string(),
  githubUrl: v.string(),
  username: v.string(),
  template: v.string(),
  screenshotId: v.optional(v.id("_storage")),
  createdAt: v.number(),
})
  .index("by_slug", ["slug"])
  .index("by_createdAt", ["createdAt"])
  .index("by_username", ["username"])
```

### Frontend

- **Gallery page** uses `useQuery(api.apps.list)` -- real-time, auto-updates when new apps are published
- **App detail page** at `/app/[slug]` shows the live app in an iframe, screenshot, @username linked to X, and links to Vercel + GitHub
- **OG meta tags** use `ConvexHttpClient` server-side for rich link previews when shared on X/Discord

---

## Reply Tweet Format

When the publish succeeds, the reply includes the clonk.ai link:

```
✅ App live: https://crab-hotel-6591c4.vercel.app
🌐 https://clonk.ai/app/crab-hotel
📝 Contribute: https://github.com/clonkbot/crab-hotel-6eebee
```

When the publish fails or env vars aren't set, the reply is the same as before (no clonk.ai link):

```
✅ App live: https://crab-hotel-6591c4.vercel.app
📝 Contribute: https://github.com/clonkbot/crab-hotel-6eebee
```

---

## Log Messages

| Log | Meaning |
|---|---|
| `📡 Publishing to clonk.ai: https://...` | Env vars are set, making the API call |
| `🌐 Published to clonk.ai: https://clonk.ai/app/...` | Success -- app entry created |
| `⏭️ Skipping clonk.ai publish (...)` | One or both env vars missing |
| `⚠️ Clonk site publish failed (non-fatal): ...` | API call failed (network error, 401, 500, etc.) |

---

## Troubleshooting

### "Skipping clonk.ai publish" even though env vars are set on Railway

Railway env vars are injected at container start time. If you add or change them, you must **redeploy** the service for the running container to pick them up. Also check for:
- Trailing spaces or quotes in the variable value
- The variable name being slightly different (copy-paste issues with hidden characters)

If in doubt, delete the variable and re-add it by typing the name manually.

### 401 Unauthorized from Convex

The `CLONK_SITE_API_KEY` value on Railway must exactly match the `CLONK_API_KEY` value set in the Convex dashboard for the clonk.ai project.

### Screenshot missing on clonk.ai but present in tweet

The screenshot step and the publish step are independent. If the screenshot succeeds, the same `Buffer` is reused for both the X upload and the clonk.ai publish. But if the screenshot fails, `screenshotBuffer` is `undefined` and the publish sends no body -- the app entry is still created, just without a screenshot.
