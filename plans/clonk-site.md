# Plan: Clonk.ai App Gallery — Showcase Every Bot Creation

## Overview

After the bot deploys an app, it should **POST the app entry to clonk.ai** so every creation appears in a public gallery at `clonk.ai/app/{app-name}`. Each entry contains:

- App name & description
- The creator's X handle (hyperlinked to their profile)
- The screenshot (same one posted in the X reply)
- The live app embedded in an iframe
- Links to the Vercel deployment and GitHub repo
- Template type (React / Convex / Three.js) and timestamp

The gallery homepage at `clonk.ai` shows all entries as cards. Individual app pages live at `clonk.ai/app/{app-name}`.

---

## Architecture

```
┌──────────────────┐    HTTP Action POST     ┌──────────────────────────────┐
│                  │ ──────────────────────>  │         clonk.ai             │
│  clonk-x-factory │  body: screenshot PNG   │  Next.js frontend (Vercel)   │
│  (bot on Railway)│  params: metadata       │         +                    │
│                  │ <──────────────────────  │  Convex backend (EXISTING)   │
└──────────────────┘    { slug, pageUrl }     │  - users, blueprints, etc.   │
                                              │  - NEW: apps table           │
                                              └──────────────────────────────┘
```

**Two codebases, one integration:**
1. **clonk-x-factory** (this repo) — gains a new `clonkSite.ts` service that POSTs app data after deployment
2. **clonk.ai** (separate Next.js + Convex repo) — **already has Convex set up** with HTTP routes, file storage, Clerk auth, etc. Just needs a new `apps` table + one new HTTP route + new pages

---

## Existing clonk.ai Infrastructure (Already Done)

Your site already has:
- Convex backend with schema (users, blueprints, skills, commands, etc.)
- HTTP router in `convex/http.ts` with routes (uploadLogo, getLogo, clerk webhook, stripe webhook, etc.)
- File storage working (logo upload/retrieval)
- Clerk authentication
- `ConvexProvider` in the Next.js layout
- Deployed to Vercel + Convex Cloud

**What needs to be added:**
- `apps` table in the existing schema
- `convex/apps.ts` — internal mutation + public queries
- New `POST /api/publish` route in the existing `convex/http.ts`
- Gallery page + app detail page in Next.js
- 1 new Convex env var (`CLONK_API_KEY`)

---

## Part 1: Changes to clonk-x-factory (This Repo)

### 1.1 New Service: `src/services/clonkSite.ts`

A lightweight HTTP client that POSTs app metadata + screenshot to the Convex HTTP action.

```typescript
// src/services/clonkSite.ts

interface AppEntry {
  appName: string;           // e.g. "meme-dashboard"
  description: string;       // One-line description
  vercelUrl: string;         // e.g. "https://meme-dashboard-a3f1b2.vercel.app"
  githubUrl: string;         // e.g. "https://github.com/clonkbot/meme-dashboard-a3f1b2"
  username: string;          // X handle of the creator (no @)
  template: 'react' | 'convex' | 'threejs';
  screenshot?: Buffer;       // PNG buffer (same one uploaded to X)
}

export async function publishToClonkSite(entry: AppEntry): Promise<string | null> {
  const apiUrl = process.env.CLONK_SITE_API_URL;
  const apiKey = process.env.CLONK_SITE_API_KEY;
  if (!apiUrl || !apiKey) return null; // silently skip if not configured

  // Send screenshot as binary body, metadata as query params
  // (Convex HTTP actions have a 20MB body limit — screenshots are ~200KB)
  const params = new URLSearchParams({
    appName: entry.appName,
    description: entry.description,
    vercelUrl: entry.vercelUrl,
    githubUrl: entry.githubUrl,
    username: entry.username,
    template: entry.template,
  });

  const res = await fetch(`${apiUrl}/api/publish?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'image/png',
    },
    body: entry.screenshot ?? null,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Clonk site API returned ${res.status}: ${text}`);
  }

  const { pageUrl } = await res.json();
  return pageUrl ?? null;
}
```

**Key design choice:** Send the screenshot as the raw binary body with metadata in query params. This avoids multipart form complexity and works perfectly with Convex HTTP actions which accept `request.blob()` directly. Convex HTTP actions have a 20MB body limit — our screenshots are ~200KB PNGs.

### 1.2 Pipeline Integration: `src/pipeline.ts`

Add the publish step **after** screenshot capture but **before** the X reply, so we can include the clonk.ai link in the reply too.

```typescript
// After screenshot is captured, before replying:
let clonkPageUrl: string | null = null;
try {
  clonkPageUrl = await publishToClonkSite({
    appName: generatedApp.appName,
    description: generatedApp.description,
    vercelUrl,
    githubUrl,
    username: input.username,
    template: input.template === 'threejs' ? 'threejs' : (input.backend === 'convex' ? 'convex' : 'react'),
    screenshot: screenshotBuffer, // reuse the same buffer
  });
} catch (err) {
  console.warn(`⚠️ Clonk site publish failed (non-fatal): ${err.message}`);
}
```

**Reply text update:**

```typescript
const clonkLink = clonkPageUrl ? `\n🌐 ${clonkPageUrl}` : '';
const replyText = `✅ App live: ${vercelUrl}${backendNote}${clonkLink}\n📝 Contribute: ${githubUrl}`;
```

### 1.3 Screenshot Buffer Refactor

Currently the screenshot buffer is only used inside a try/catch and immediately uploaded to X. We need to **extract it** so it can be reused for the clonk.ai publish:

```typescript
// Before (current):
let mediaIds: string[] | undefined;
try {
  const screenshot = await takeScreenshot(vercelUrl);
  const mediaId = await uploadMedia(screenshot);
  mediaIds = [mediaId];
} catch { ... }

// After:
let mediaIds: string[] | undefined;
let screenshotBuffer: Buffer | undefined;
try {
  screenshotBuffer = await takeScreenshot(vercelUrl);
  const mediaId = await uploadMedia(screenshotBuffer);
  mediaIds = [mediaId];
} catch { ... }
```

### 1.4 New Environment Variables

| Variable | Example | Description |
|----------|---------|-------------|
| `CLONK_SITE_API_URL` | `https://your-site.convex.site` | Convex HTTP actions base URL (from Convex dashboard) |
| `CLONK_SITE_API_KEY` | `clk_sk_...` | Shared secret for authenticating POST requests |

Both optional — if not set, the publish step is silently skipped.

### 1.5 Files Changed in This Repo

| File | Change | Lines |
|------|--------|-------|
| `src/services/clonkSite.ts` | **New file** — API client | ~40 |
| `src/pipeline.ts` | Add publish step + refactor screenshot buffer | ~20 |
| `.env.example` | Add `CLONK_SITE_API_URL` and `CLONK_SITE_API_KEY` | 2 |

---

## Part 2: Changes to clonk.ai (Existing Next.js + Convex Site)

These are additions to your existing codebase — no need to reinitialize anything.

### 2.1 Add `apps` Table to Existing Schema: `convex/schema.ts`

Add this table alongside your existing `users`, `blueprints`, `skills`, etc:

```typescript
// Add to your existing defineSchema({ ... })
apps: defineTable({
  slug: v.string(),               // URL-safe identifier (e.g. "meme-dashboard")
  appName: v.string(),            // Display name
  description: v.string(),        // One-liner
  vercelUrl: v.string(),          // Live app URL
  githubUrl: v.string(),          // Source code URL
  username: v.string(),           // X handle (no @)
  template: v.string(),           // "react" | "convex" | "threejs"
  screenshotId: v.optional(v.id("_storage")),  // Convex file storage ref (same system as logos)
  createdAt: v.number(),          // Date.now() timestamp
})
  .index("by_slug", ["slug"])
  .index("by_createdAt", ["createdAt"])
  .index("by_username", ["username"]),
```

Uses the same `_storage` system you already have for logo uploads.

### 2.2 New File: `convex/apps.ts`

Internal mutation (called by HTTP action) + public queries (called by frontend).

```typescript
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export const create = internalMutation({
  args: {
    appName: v.string(),
    description: v.string(),
    vercelUrl: v.string(),
    githubUrl: v.string(),
    username: v.string(),
    template: v.string(),
    screenshotId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    let slug = toSlug(args.appName);
    const existing = await ctx.db
      .query("apps")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (existing) {
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    }

    await ctx.db.insert("apps", {
      slug,
      appName: args.appName,
      description: args.description,
      vercelUrl: args.vercelUrl,
      githubUrl: args.githubUrl,
      username: args.username,
      template: args.template,
      screenshotId: args.screenshotId,
      createdAt: Date.now(),
    });

    const siteUrl = process.env.SITE_URL ?? "https://clonk.ai";
    return { slug, pageUrl: `${siteUrl}/app/${slug}` };
  },
});

// List all apps (newest first) — reactive, real-time
export const list = query({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_createdAt")
      .order("desc")
      .collect();

    return Promise.all(
      apps.map(async (app) => ({
        ...app,
        screenshotUrl: app.screenshotId
          ? await ctx.storage.getUrl(app.screenshotId)
          : null,
      }))
    );
  },
});

// Get single app by slug
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const app = await ctx.db
      .query("apps")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!app) return null;
    return {
      ...app,
      screenshotUrl: app.screenshotId
        ? await ctx.storage.getUrl(app.screenshotId)
        : null,
    };
  },
});
```

### 2.3 Add Route to Existing `convex/http.ts`

Add this route to your **existing** HTTP router (alongside uploadLogo, clerk webhook, etc.):

```typescript
// Add to your existing http router:
http.route({
  path: "/api/publish",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // 1. Verify API key
    const auth = request.headers.get("Authorization");
    const apiKey = auth?.replace("Bearer ", "");
    if (apiKey !== process.env.CLONK_API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Parse metadata from query params
    const url = new URL(request.url);
    const appName = url.searchParams.get("appName");
    const description = url.searchParams.get("description");
    const vercelUrl = url.searchParams.get("vercelUrl");
    const githubUrl = url.searchParams.get("githubUrl");
    const username = url.searchParams.get("username");
    const template = url.searchParams.get("template") ?? "react";

    if (!appName || !description || !vercelUrl || !githubUrl || !username) {
      return new Response("Missing required fields", { status: 400 });
    }

    // 3. Store screenshot in Convex file storage (same system as logos)
    let screenshotId;
    const contentType = request.headers.get("Content-Type");
    if (contentType === "image/png") {
      const blob = await request.blob();
      if (blob.size > 0) {
        screenshotId = await ctx.storage.store(blob);
      }
    }

    // 4. Insert into database via internal mutation
    const { slug, pageUrl } = await ctx.runMutation(internal.apps.create, {
      appName,
      description,
      vercelUrl,
      githubUrl,
      username,
      template,
      screenshotId,
    });

    return new Response(JSON.stringify({ slug, pageUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});
```

Make sure to add `import { internal } from "./_generated/api";` at the top if not already there.

### 2.4 Gallery Page + App Detail Page (Next.js)

**Gallery page** — grid of app cards using `useQuery(api.apps.list)` (real-time):

```
┌─────────────────────────────────────────────────────────┐
│  clonk.ai — apps built by AI, triggered by a tweet      │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │screenshot│  │screenshot│  │screenshot│              │
│  │          │  │          │  │          │              │
│  │App Name  │  │App Name  │  │App Name  │              │
│  │@user     │  │@user     │  │@user     │              │
│  │react     │  │convex    │  │threejs   │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

**App detail page** at `/app/[slug]` — iframe embed + metadata:

```
┌─────────────────────────────────────────────────────────┐
│  ← Back to gallery                                      │
│                                                         │
│  App Name                                     react     │
│  Built by @username                        2 hours ago  │
│  "One-line description of what this app does"           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │           LIVE APP IFRAME (vercel_url)           │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  [Open App]  [View Source]                              │
└─────────────────────────────────────────────────────────┘
```

**OG meta tags** — use `ConvexHttpClient` in `generateMetadata` (server-side) so link previews work on X/Discord:

```typescript
import { ConvexHttpClient } from "convex/browser";
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function generateMetadata({ params }) {
  const app = await convex.query(api.apps.getBySlug, { slug: params.slug });
  if (!app) return { title: "Not Found" };
  return {
    title: `${app.appName} — clonk.ai`,
    description: app.description,
    openGraph: {
      title: app.appName,
      description: `Built by @${app.username} via clonk.ai`,
      images: app.screenshotUrl ? [app.screenshotUrl] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: app.appName,
      description: `Built by @${app.username} via clonk.ai`,
      images: app.screenshotUrl ? [app.screenshotUrl] : [],
    },
  };
}
```

### 2.5 Iframe Security

```html
<iframe
  src="{vercelUrl}"
  sandbox="allow-scripts allow-same-origin allow-popups"
  loading="lazy"
/>
```

Cross-origin by default (`*.vercel.app` vs `clonk.ai`) — no risk.

---

## Part 3: Security

### 3.1 API Authentication

Shared secret checked in the HTTP action:

```
Authorization: Bearer clk_sk_<random-32-bytes-hex>
```

Set as:
- `CLONK_SITE_API_KEY` in clonk-x-factory (Railway env)
- `CLONK_API_KEY` in Convex (via dashboard env vars)

### 3.2 Internal Mutations

`apps.create` is `internalMutation` — only callable from Convex functions (the HTTP action), never from the browser client.

### 3.3 Queries Are Public (By Design)

`apps.list` and `apps.getBySlug` are public queries — the gallery is a public showcase, no auth needed to view.

---

## Part 4: Implementation Order

### Phase 1: clonk.ai Website (Do First)

Since Convex is already set up, this is just adding to what exists:

1. **Add `apps` table to existing `convex/schema.ts`** — section 2.1
2. **Create `convex/apps.ts`** — create (internal mutation), list, getBySlug queries — section 2.2
3. **Add `/api/publish` route to existing `convex/http.ts`** — section 2.3
4. **Set 1 new Convex env var** (via `npx convex dashboard`):
   - `CLONK_API_KEY` — generate with `openssl rand -hex 32`
   - `SITE_URL` — `https://clonk.ai` (if not already set)
5. **Deploy Convex** — `npx convex deploy`
6. **Build gallery page** — wherever makes sense in your existing Next.js routing
7. **Build app detail page** — `/app/[slug]` with iframe + OG meta
8. **Deploy Next.js** — push to Vercel
9. **Test with curl:**
   ```bash
   CONVEX_SITE_URL="https://your-site.convex.site"

   curl -X POST "$CONVEX_SITE_URL/api/publish?appName=test-app&description=A+test+app&vercelUrl=https://example.vercel.app&githubUrl=https://github.com/test/test&username=testuser&template=react" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: image/png" \
     --data-binary @screenshot.png
   ```

### Phase 2: clonk-x-factory Bot (Do Second)

Once the site is ready:

10. **Create `src/services/clonkSite.ts`** — API client (~40 lines)
11. **Update `src/pipeline.ts`** — add publish step + refactor screenshot buffer (~20 lines)
12. **Update `.env.example`** — add new env vars
13. **Set env vars on Railway** — `CLONK_SITE_API_URL` + `CLONK_SITE_API_KEY`
14. **Test end-to-end** — trigger a build, verify it appears on clonk.ai in real-time

### Phase 3: Polish (Optional)

15. **Backfill existing apps** — one-time Convex mutation to seed past deployments
16. **Add search/filter** — by template type, username
17. **Pagination** — Convex cursor-based pagination for large galleries

---

## Checklist for clonk.ai Site

- [ ] Add `apps` table to `convex/schema.ts` (alongside existing tables)
- [ ] Create `convex/apps.ts` (create, list, getBySlug)
- [ ] Add `POST /api/publish` to existing `convex/http.ts` (import `internal`)
- [ ] Set `CLONK_API_KEY` env var in Convex dashboard
- [ ] `npx convex deploy`
- [ ] Build gallery page (new route in Next.js)
- [ ] Build `/app/[slug]` detail page with iframe + OG meta
- [ ] Deploy Next.js to Vercel
- [ ] Curl test the HTTP action

---

## Summary

| Component | What Changes | Effort |
|-----------|-------------|--------|
| **clonk-x-factory** | New `clonkSite.ts` + pipeline update | ~60 lines, 2 files |
| **clonk.ai Convex** | Add `apps` table + `apps.ts` + 1 HTTP route | ~100 lines, 3 files |
| **clonk.ai Next.js** | Gallery page + detail page | 2 new pages |
| **Infrastructure** | 2 env vars on Railway + 1 on Convex | Minimal |

The integration is **non-fatal** — if clonk.ai is down or the publish fails, the bot continues working exactly as today. The gallery is additive, not a dependency.
