# Setup Guide

This document covers everything needed to run Clonk X Factory locally or deploy it to Railway.

## Prerequisites

- Node.js >= 22
- npm
- An X (Twitter) developer account with a project and app
- An Anthropic API key
- A Vercel account and API token
- A GitHub account (or organization) for generated repos, with a fine-grained personal access token

## Environment Variables

All variables are required unless noted otherwise. In production, these are set in the Railway dashboard.

### X (Twitter) Credentials

| Variable | Purpose | How to obtain |
|---|---|---|
| `X_API_KEY` | OAuth 1.0a consumer key | X Developer Portal > Your App > Keys and Tokens |
| `X_API_SECRET` | OAuth 1.0a consumer secret | Same location as above |
| `X_BEARER_TOKEN` | App-level Bearer token for reading mentions | X Developer Portal > Your App > Keys and Tokens > Bearer Token |
| `X_ACCESS_TOKEN` | User-level OAuth 1.0a access token (for posting tweets) | X Developer Portal > Your App > Keys and Tokens > Access Token and Secret |
| `X_ACCESS_TOKEN_SECRET` | User-level OAuth 1.0a access token secret | Same location as above |
| `X_BOT_USER_ID` | The bot account's numeric user ID | See "Finding your bot's user ID" below |

### Third-Party API Keys

| Variable | Purpose | How to obtain |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API access for code generation | [console.anthropic.com](https://console.anthropic.com/) > API Keys |
| `VERCEL_API_TOKEN` | Deploying generated apps to Vercel | [vercel.com/account/tokens](https://vercel.com/account/tokens) |
| `GITHUB_TOKEN` | Creating repos and uploading files | See "GitHub PAT Setup" below |

### Server Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port for the Express server | `8080` |

## X App Configuration

### 1. Create a developer account

Go to [developer.x.com](https://developer.x.com/) and sign up. The free tier is sufficient for this bot.

### 2. Create a project and app

In the Developer Portal, create a new Project and App. The app name does not matter.

### 3. Set app permissions to Read and Write

This is critical. The bot needs **Read and Write** permissions to post reply tweets. Navigate to:

```
Developer Portal > Your App > Settings > User authentication settings
```

Set "App permissions" to **Read and Write**. If you change permissions after generating tokens, you must regenerate the access token and secret.

### 4. Generate tokens

Under "Keys and Tokens", generate:

- **API Key and Secret** (consumer credentials) -- these go into `X_API_KEY` and `X_API_SECRET`
- **Bearer Token** -- this goes into `X_BEARER_TOKEN`
- **Access Token and Secret** -- these go into `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET`

The Access Token and Secret must belong to the bot's account (the account that will post replies). If you are logged into the developer portal as the bot account, the generated tokens will be for that account.

### 5. Finding your bot's user ID

The `X_BOT_USER_ID` is the numeric ID of the bot's X account. You can find it by calling:

```bash
curl -s "https://api.x.com/2/users/by/username/YOUR_BOT_USERNAME" \
  -H "Authorization: Bearer $X_BEARER_TOKEN" | jq '.data.id'
```

Or use a service like [tweeterid.com](https://tweeterid.com/).

## GitHub PAT Setup

The bot creates repositories and uploads files under a specific GitHub account (in production, the `clonkbot` account). You need a fine-grained personal access token (PAT) scoped to that account.

### 1. Go to token settings

Navigate to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) while logged in as the account that will own the generated repos.

### 2. Create a fine-grained token

- **Token name**: Something descriptive like "clonk-x-factory"
- **Expiration**: Set an appropriate expiration
- **Repository access**: "All repositories" (the bot creates new repos, so you cannot scope to specific ones)
- **Permissions**:
  - **Repository permissions**:
    - Contents: **Read and write** (to upload files)
    - Administration: **Read and write** (to create repositories)
  - No organization permissions needed unless the repos are under an org

### 3. Copy the token

The token starts with `github_pat_`. Set it as `GITHUB_TOKEN`.

## Vercel API Token

### 1. Create a token

Go to [vercel.com/account/tokens](https://vercel.com/account/tokens) while logged into the account where apps should be deployed.

### 2. Set scope

- **Scope**: "Full Account" (the bot creates new projects)
- **Expiration**: Set as needed

### 3. Copy the token

Set it as `VERCEL_API_TOKEN`.

## Local Development

### 1. Clone the repository

```bash
git clone https://github.com/PauliusOS/clonk-x-factory.git
cd clonk-x-factory
```

### 2. Install dependencies

```bash
npm install
```

This also runs `tsc` via the `postinstall` script.

### 3. Create a `.env` file

```bash
cp .env.example .env  # if an example exists, otherwise create manually
```

Populate all the environment variables listed above.

### 4. Run in development mode

```bash
npm run dev
```

This starts the server with `ts-node`, which compiles TypeScript on the fly. The server will begin polling for mentions immediately.

### 5. Build and run in production mode

```bash
npm run build
npm start
```

`npm run build` compiles TypeScript to the `dist/` directory. `npm start` runs the compiled JavaScript with `node dist/index.js`.

### 6. Health check

Verify the server is running:

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{"status":"ok","timestamp":"2026-01-31T12:00:00.000Z"}
```

## Railway Deployment

### 1. Connect the repository

In the Railway dashboard, create a new project and connect it to the `PauliusOS/clonk-x-factory` GitHub repository.

### 2. Set environment variables

In the Railway service settings, add all environment variables listed above.

### 3. Deploy

Railway auto-deploys on every push to `main`. The build process runs:

1. `npm install` (which triggers `postinstall` -> `tsc`)
2. `npm start` (which runs `node dist/index.js`)

### 4. Verify

Check the Railway logs for:

```
Clonk bot server running on port 8080
Polling for mentions every 120s
```

The health endpoint is available at whatever public URL Railway assigns.

## Troubleshooting

### Bot is not detecting mentions

- Verify `X_BEARER_TOKEN` and `X_BOT_USER_ID` are set correctly
- Check Railway logs for "Rate limited" messages (the free tier is very restrictive)
- Confirm the mention tweet contains the word "build"
- Check that the tweet was posted *after* the current deploy started (the `startupTime` filter skips older tweets)

### Bot detects mentions but does not reply

- Verify `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET` are set
- Confirm the X app has **Read and Write** permissions (read-only will fail on tweet posting)
- If you changed permissions after generating tokens, regenerate them

### Vercel deployment fails

- Check that `VERCEL_API_TOKEN` is valid and has full account scope
- Look for Claude generating a `tsconfig.json` with `references` or `extends` -- this causes build failures

### GitHub repo creation fails with 422

- The `appName` generated by Claude may conflict with an existing repo under the `clonkbot` account
- GitHub returns 422 Unprocessable Entity for duplicate repo names
- There is no automated handling for this; the repo name depends entirely on Claude's output

### "Missing X API credentials" in logs

- One or more of `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_API_KEY`, or `X_API_SECRET` is not set
- Double-check for trailing whitespace in environment variable values
