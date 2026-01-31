# Service Reference

Detailed documentation for each source file in the Clonk X Factory codebase.

---

## src/index.ts -- Entry Point and Polling Loop

**File**: `/Users/paulius/clonk/clonk-x-factory/src/index.ts`

This is the main entry point. It starts an Express server and runs a polling loop that checks for new mentions of the bot on X.

### Express Server

A minimal Express app with a single endpoint:

- `GET /health` -- Returns `{ status: "ok", timestamp: "..." }`. Used by Railway for health checks.

The server listens on `process.env.PORT` (default: `8080`).

### Polling Mechanism

The `pollMentions()` function runs every 2 minutes via `setInterval`. It calls the X API v2 endpoint:

```
GET /2/users/{X_BOT_USER_ID}/mentions
```

**Request parameters:**

| Parameter | Value | Purpose |
|---|---|---|
| `max_results` | `10` | Fetch up to 10 mentions per poll |
| `tweet.fields` | `author_id,created_at` | Include author and timestamp in response |
| `user.fields` | `username` | Include username via user expansion |
| `expansions` | `author_id` | Expand author data |
| `since_id` | `lastSeenTweetId` (if set) | Only return tweets newer than this ID |

### Deduplication and Filtering

Each tweet goes through several checks before being processed:

1. **Self-tweet filter**: Skips tweets where `author_id` matches `X_BOT_USER_ID` (the bot's own replies).
2. **Startup time filter**: Skips tweets with `created_at` before the server's `startupTime`. This prevents reprocessing old tweets after a redeploy.
3. **Processing guard**: Skips tweets whose ID is in the `processingTweets` Set (already being processed).
4. **"build" keyword filter**: The tweet text (lowercased) must contain "build". This prevents random mentions from triggering the pipeline.
5. **Minimum idea length**: After stripping `@mentions` and the word "build", the remaining text must be at least 3 characters.

### Idea Extraction

The app idea is extracted from the tweet text by:

1. Removing all `@mentions` (regex: `/@\w+/g`)
2. Removing all occurrences of "build" (case-insensitive, regex: `/build/gi`)
3. Trimming whitespace

Example: `"@clonkbot build a pomodoro timer"` becomes `"a pomodoro timer"`.

### Background Processing

The pipeline is invoked without `await`:

```typescript
processTweetToApp({ idea, tweetId: tweet.id, userId: tweet.author_id })
  .catch((error) => { /* log */ })
  .finally(() => { processingTweets.delete(tweet.id); });
```

This ensures the polling loop is not blocked by long-running pipeline executions. The `processingTweets` Set entry is cleaned up in the `finally` block regardless of success or failure.

### Rate Limit Handling

If the X API returns HTTP 429, the error is caught and logged as a silent "Rate limited, will retry next poll" message. No backoff is applied; the next regular poll at the 2-minute interval serves as an implicit retry.

---

## src/pipeline.ts -- Pipeline Orchestrator

**File**: `/Users/paulius/clonk/clonk-x-factory/src/pipeline.ts`

Coordinates the four-step process of turning a tweet into a deployed app.

### Interface

```typescript
interface PipelineInput {
  idea: string;     // The extracted app idea text
  tweetId: string;  // The tweet ID to reply to
  userId: string;   // The tweet author's user ID
}
```

### Execution Flow

```typescript
async function processTweetToApp(input: PipelineInput): Promise<void>
```

Steps execute sequentially. Each step depends on the output of the previous one:

1. **`generateApp(idea)`** -- Returns `{ files, appName, description }`
2. **`deployToVercel(appName, files)`** -- Returns `vercelUrl`
3. **`createGitHubRepo(appName, description, files)`** -- Returns `githubUrl`
4. **`replyToTweet(tweetId, replyText)`** -- Posts the reply

### Reply Format

On success:

```
App live: https://<deployment>.vercel.app
Contribute: https://github.com/clonkbot/<app-name>

Fork it, improve it, ship it together
```

### Error Handling

If any step throws, the pipeline:

1. **Logs a redacted error message.** If the error has an `error.response` (axios HTTP error), only the status code and URL are logged. The full error object is never logged because axios errors contain the `Authorization` header in `error.config.headers`.

2. **Attempts to reply with an error message** to the original tweet: "Sorry, I couldn't build that app right now. Please try again later!"

3. **Re-throws** a sanitized error so the caller in `index.ts` can log it.

If the error reply itself fails, that failure is also logged in redacted form.

---

## src/services/claude.ts -- AI Code Generation

**File**: `/Users/paulius/clonk/clonk-x-factory/src/services/claude.ts`

Uses the Anthropic SDK to generate a complete web application from a text description.

### Configuration

| Setting | Value | Reason |
|---|---|---|
| Model | `claude-sonnet-4-20250514` | Good balance of speed, cost, and code quality |
| `max_tokens` | `16384` | Multi-file apps with full source code require high token limits |

### Generated App Interface

```typescript
interface GeneratedApp {
  files: { path: string; content: string }[];
  appName: string;
  description: string;
}
```

### Prompt Design

The prompt instructs Claude to generate a production-ready application with these constraints:

- **Stack**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS via CDN (loaded in `index.html`, not as an npm dependency)
- **Architecture**: Client-side only SPA, no backend or external API dependencies
- **Build command**: `tsc && vite build`

**Critical constraints** (learned from production failures):

- `tsconfig.json` must be completely self-contained. It must not use `references` or `extends` pointing to files like `tsconfig.node.json`. Standard `vite init` templates include these references, and when the referenced file is missing, the Vercel build fails.
- `vite.config.ts` must use a minimal setup with only the React plugin.
- `package.json` must list all dependencies explicitly.

### Output Format

Claude is asked to return a JSON object. The response typically includes surrounding text (explanations, markdown code fences), so the JSON must be extracted.

### JSON Extraction (Brace-Counting Algorithm)

Instead of using regex (which fails on nested braces and multi-line content), the service uses a brace-depth counter:

```typescript
const startIdx = text.indexOf('{');
let depth = 0;
let endIdx = -1;
for (let i = startIdx; i < text.length; i++) {
  if (text[i] === '{') depth++;
  else if (text[i] === '}') depth--;
  if (depth === 0) {
    endIdx = i;
    break;
  }
}
```

This finds the first top-level `{...}` block in the response, which is the JSON object. The extracted string is then parsed with `JSON.parse`.

**Limitation**: This algorithm does not account for braces inside JSON string values (e.g., a file containing `{` in its content). In practice, this has not been an issue because the outermost braces are matched first, and inner braces within string values are balanced or escaped.

### Error Cases

- Claude returns a non-text response type: throws "Unexpected response type from Claude"
- No `{` found in response: throws "Failed to extract JSON from Claude response"
- Unbalanced braces: throws "Failed to extract complete JSON from Claude response"
- Malformed JSON: `JSON.parse` throws a SyntaxError

---

## src/services/vercel.ts -- Vercel Deployment

**File**: `/Users/paulius/clonk/clonk-x-factory/src/services/vercel.ts`

Deploys generated applications to Vercel using their REST API.

### API Endpoint

```
POST https://api.vercel.com/v13/deployments
```

### Request Body

```json
{
  "name": "<appName>",
  "files": [
    { "file": "<path>", "data": "<content>" }
  ],
  "projectSettings": {
    "framework": "vite"
  },
  "target": "production"
}
```

Files are sent as **plain text** in the `data` field (not base64). The `framework: 'vite'` setting tells Vercel to use its Vite build pipeline, which runs `npm install` and then the `build` script from `package.json`.

### Authentication

Uses a Bearer token via the `Authorization` header:

```
Authorization: Bearer <VERCEL_API_TOKEN>
```

### Return Value

Returns the deployment URL in the format `https://<deployment-id>.vercel.app`.

**Important**: The URL is returned as soon as Vercel accepts the deployment request. The build may still be in progress or may ultimately fail. The bot does not poll for build completion.

### Error Cases

- Invalid token: Vercel returns 401/403
- Invalid project name: Vercel returns 400
- Network errors: axios throws with connection details

---

## src/services/github.ts -- GitHub Repository Creation

**File**: `/Users/paulius/clonk/clonk-x-factory/src/services/github.ts`

Creates a public GitHub repository and uploads all generated files.

### Step 1: Create Repository

```
POST https://api.github.com/user/repos
```

Request body:

```json
{
  "name": "<appName>",
  "description": "<description>",
  "public": true,
  "auto_init": false
}
```

The `auto_init: false` setting means no initial commit (no README, no .gitignore). This avoids merge conflicts when uploading files.

Authentication uses the `token` scheme:

```
Authorization: token <GITHUB_TOKEN>
```

The repo is created under whatever account the `GITHUB_TOKEN` belongs to. In production, this is the `clonkbot` account.

### Step 2: Upload Files

Each file is uploaded individually via the GitHub Contents API:

```
PUT https://api.github.com/repos/<owner>/<repo>/contents/<path>
```

Request body:

```json
{
  "message": "Add <path>",
  "content": "<base64-encoded content>"
}
```

Files are uploaded **sequentially** in a `for` loop, one at a time. Each upload creates a separate commit. This means a repo with 6 files will have 6 commits.

**Why sequential?** The GitHub Contents API requires the latest commit SHA for subsequent updates to the same branch. Parallel uploads would race and fail. An alternative would be the Git Trees/Blobs API (which can create a single commit with all files), but the Contents API is simpler.

### Error Handling

Individual file upload failures are caught and logged but do not abort the remaining uploads. The function still returns the repo URL even if some files failed to upload.

Error logging is redacted: only the HTTP status and status text are logged, never the full error object.

### Error Cases

- Duplicate repo name: GitHub returns 422 Unprocessable Entity. There is no retry or name-suffix logic.
- Invalid token or insufficient permissions: GitHub returns 401/403.
- File path issues: Paths with special characters may cause 422 errors.

---

## src/services/xClient.ts -- X (Twitter) Reply Client

**File**: `/Users/paulius/clonk/clonk-x-factory/src/services/xClient.ts`

Posts reply tweets using the X API v2 with OAuth 1.0a authentication, implemented from scratch without any OAuth library.

### API Endpoint

```
POST https://api.x.com/2/tweets
```

Request body:

```json
{
  "text": "<reply text>",
  "reply": {
    "in_reply_to_tweet_id": "<original tweet ID>"
  }
}
```

### OAuth 1.0a Implementation

The module implements the full OAuth 1.0a signing process manually using Node.js `crypto`:

**1. Assemble OAuth parameters:**

```typescript
{
  oauth_consumer_key: X_API_KEY,
  oauth_token: X_ACCESS_TOKEN,
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: <current unix timestamp>,
  oauth_nonce: <32 random bytes, base64, non-word chars stripped>,
  oauth_version: '1.0'
}
```

**2. Create the signature base string:**

```
POST&<percent-encoded URL>&<percent-encoded sorted parameter string>
```

The parameter string is all OAuth params (excluding `oauth_signature`) sorted alphabetically, with each key=value pair percent-encoded and joined by `&`.

**3. Create the signing key:**

```
<percent-encoded API secret>&<percent-encoded access token secret>
```

**4. Generate the HMAC-SHA1 signature:**

```typescript
crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64')
```

**5. Build the Authorization header:**

```
OAuth oauth_consumer_key="...", oauth_nonce="...", oauth_signature="...", ...
```

All values are percent-encoded. Parameters are sorted alphabetically.

### Why No OAuth Library?

The implementation avoids third-party OAuth libraries to minimize dependencies. The signing process is straightforward for a single endpoint (POST /tweets), and implementing it directly gives full control over the request construction.

### Required X App Permissions

The X app must have **Read and Write** permissions. Read-only permissions will result in a 403 error when attempting to post tweets. If permissions are changed after token generation, the access token and secret must be regenerated.

### Error Cases

- Missing credentials: throws "Missing X API credentials" before making any API call
- Invalid signature: X returns 401 Unauthorized (usually means credentials are wrong or permissions changed)
- Rate limited: X returns 429 (unlikely for posting, more common for reading)
- Duplicate tweet: X returns 403 if the exact same text is posted twice in quick succession
