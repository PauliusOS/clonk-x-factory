# Plan: Add Telegram as a Second Channel for Clonkbot

## Overview

Enable clonkbot to receive build requests via **Telegram** in addition to X/Twitter. A Telegram user mentions or messages the bot, the same pipeline that generates, deploys, and screenshots apps fires, and the bot replies in the same Telegram conversation with the live link, GitHub repo, and screenshot.

The key design goal: **Telegram messages are treated identically to tweets**. A mention in a Telegram group is like an @mention on X. A reply to a message is like a quote-tweet / reply-tweet. The entire generation pipeline (`processTweetToApp`) stays unchanged — only the input/output edges differ.

---

## Architecture

```
                  ┌─────────────────────────────────────┐
                  │         index.ts (entrypoint)        │
                  │                                      │
                  │  ┌──────────┐   ┌────────────────┐  │
                  │  │ X Poller │   │ Telegram Client │  │
                  │  │(existing)│   │   (new, grammY) │  │
                  │  └────┬─────┘   └───────┬────────┘  │
                  │       │                 │            │
                  │       ▼                 ▼            │
                  │  ┌──────────────────────────────┐   │
                  │  │     pipeline.ts               │   │
                  │  │  processMentionToApp()        │   │
                  │  │  (refactored from             │   │
                  │  │   processTweetToApp)          │   │
                  │  └──────────┬───────────────────┘   │
                  │             │                        │
                  │    ┌────────┴────────┐              │
                  │    ▼                 ▼              │
                  │  claude.ts        vercel.ts         │
                  │  github.ts        screenshot.ts     │
                  │  classify.ts      badge.ts          │
                  │  convex.ts        clonkSite.ts      │
                  └─────────────────────────────────────┘
                              │
               Reply goes back via the originating channel:
               - X → replyToTweet()
               - Telegram → replyToTelegram()
```

---

## Why grammY (Library Choice)

| Criteria | grammY | Telegraf | node-telegram-bot-api |
|---|---|---|---|
| TypeScript-first | Yes | Yes | No (has @types) |
| Active maintenance (2025+) | Very active | Active | Slower |
| Webhook + long-polling | Both built-in | Both built-in | Both |
| Middleware system | Express-like | Express-like | Manual |
| Bundle size | Small | Medium | Small |
| Docs quality | Excellent | Good | OK |

**grammY** is the best fit: TypeScript-native, excellent docs, lightweight, supports both webhook and long-polling, and has a clean middleware API. The project already uses Express, so grammY's `webhookCallback("express")` integrates cleanly.

However, for Railway deployment (where there's no stable public URL for webhooks), **long-polling** is simpler and more reliable. grammY supports both — start with long-polling, optionally add webhook later.

---

## Step-by-Step Implementation

### Step 1: Make the Pipeline Channel-Agnostic

Currently `pipeline.ts` is coupled to X/Twitter — it imports `replyToTweet` and `uploadMedia` directly. Refactor it so the pipeline doesn't know which channel originated the request. Instead, the caller passes a **reply callback**.

**File: `src/pipeline.ts`**

```typescript
// Before:
export interface PipelineInput {
  idea: string;
  tweetId: string;
  userId: string;
  username: string;
  imageUrls?: string[];
  parentContext?: { text: string; imageUrls: string[] };
  backend?: 'convex';
  template?: 'threejs';
}

// After:
export interface PipelineInput {
  idea: string;
  messageId: string;           // was tweetId — generic identifier
  userId: string;
  username: string;
  source: 'x' | 'telegram';   // which channel originated this
  imageUrls?: string[];
  parentContext?: { text: string; imageUrls: string[] };
  backend?: 'convex';
  template?: 'threejs';

  // Channel-specific reply functions — injected by the caller
  reply: (text: string, imageBuffer?: Buffer) => Promise<void>;
}
```

The pipeline calls `input.reply(text, screenshot)` instead of `replyToTweet()` + `uploadMedia()` directly. Each channel adapter wraps its own reply logic:

- **X adapter**: uploads media via `uploadMedia()`, then calls `replyToTweet(tweetId, text, mediaIds)`
- **Telegram adapter**: calls `ctx.replyWithPhoto()` or `ctx.reply()`

This is the single most important refactor — it decouples the pipeline from any specific channel.

**Changes to pipeline.ts:**
- Remove the direct import of `replyToTweet` and `uploadMedia`
- Replace all `replyToTweet(input.tweetId, ...)` calls with `input.reply(...)`
- The success reply and error reply both go through `input.reply()`

### Step 2: Create X Channel Adapter

Extract the current X-specific polling + reply logic into its own module.

**New file: `src/channels/x.ts`**

```typescript
import { fetchMentions, replyToTweet, uploadMedia } from '../services/xClient';
import { PipelineInput } from '../pipeline';

/** Build a reply function that sends a tweet reply with optional screenshot */
export function makeXReply(tweetId: string): PipelineInput['reply'] {
  return async (text: string, imageBuffer?: Buffer) => {
    let mediaIds: string[] | undefined;
    if (imageBuffer) {
      const mediaId = await uploadMedia(imageBuffer);
      mediaIds = [mediaId];
    }
    await replyToTweet(tweetId, text, mediaIds);
  };
}

// Move the pollMentions() logic here (extracted from index.ts)
// The function builds PipelineInput objects with source: 'x' and reply: makeXReply(tweetId)
export async function pollMentions(
  lastSeenTweetId: string,
  processingSet: Set<string>,
  startupTime: Date,
  onMention: (input: PipelineInput) => void,
): Promise<string> {
  // ... existing polling logic from index.ts, returns updated lastSeenTweetId
}
```

### Step 3: Create Telegram Channel Adapter

**New file: `src/channels/telegram.ts`**

```typescript
import { Bot, Context, InputFile } from 'grammy';
import { classifyTweet, moderateContent } from '../services/classify';
import { PipelineInput } from '../pipeline';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'clonkbot';

export function createTelegramBot(
  onMention: (input: PipelineInput) => void,
): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(token);

  // Handle messages that mention the bot or are sent in DM
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'
    const username = ctx.from?.username || ctx.from?.first_name || 'unknown';
    const userId = String(ctx.from?.id || 'unknown');

    // In groups: only respond if bot is @mentioned
    // In DMs (private): always respond
    const isMentioned = chatType === 'private' ||
      text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);

    if (!isMentioned) return;

    // Extract the "idea" — remove @botname mentions
    const idea = text
      .replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '')
      .replace(/\b(build|make|create)\b/gi, '')
      .trim();

    // Trigger keyword check (same as X)
    const tweetLower = text.toLowerCase();
    const TRIGGER_KEYWORDS = ['build', 'make', 'create'];
    const hasKeyword = TRIGGER_KEYWORDS.some(kw => tweetLower.includes(kw));
    if (!hasKeyword) return;

    if (!idea || idea.length < 3) return;

    // Template detection (same logic as X)
    const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl'];
    const wantsThreeJs = THREEJS_KEYWORDS.some(kw => tweetLower.includes(kw));

    const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time',
      'login', 'auth', 'users', 'accounts'];
    const wantsConvex = BACKEND_KEYWORDS.some(kw => tweetLower.includes(kw));

    // AI classification + moderation (reuse existing services)
    const isAppRequest = await classifyTweet(text);
    if (!isAppRequest) return;

    const isSafe = await moderateContent(idea);
    if (!isSafe) return;

    // Extract parent context if this is a reply to another message
    let parentContext: { text: string; imageUrls: string[] } | undefined;
    if (ctx.message.reply_to_message?.text) {
      parentContext = {
        text: ctx.message.reply_to_message.text,
        imageUrls: [], // TODO: extract photos from parent message
      };
    }

    // Extract attached photos
    const imageUrls = await extractTelegramPhotos(ctx);

    // Build reply function
    const reply: PipelineInput['reply'] = async (replyText, imageBuffer?) => {
      if (imageBuffer) {
        await ctx.replyWithPhoto(new InputFile(imageBuffer, 'screenshot.png'), {
          caption: replyText,
          reply_parameters: { message_id: ctx.message!.message_id },
        });
      } else {
        await ctx.reply(replyText, {
          reply_parameters: { message_id: ctx.message!.message_id },
        });
      }
    };

    const input: PipelineInput = {
      idea,
      messageId: String(ctx.message.message_id),
      userId,
      username,
      source: 'telegram',
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      parentContext,
      backend: wantsConvex ? 'convex' : undefined,
      template: wantsThreeJs ? 'threejs' : undefined,
      reply,
    };

    onMention(input);
  });

  return bot;
}

/** Download photo attachments from a Telegram message and return temporary file URLs */
async function extractTelegramPhotos(ctx: Context): Promise<string[]> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return [];

  // Telegram sends multiple sizes — take the largest
  const largest = photos[photos.length - 1];
  try {
    const file = await ctx.api.getFile(largest.file_id);
    if (file.file_path) {
      const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
      return [url];
    }
  } catch (err) {
    console.warn('Failed to extract Telegram photo:', err);
  }
  return [];
}
```

### Step 4: Update the Entrypoint

**File: `src/index.ts`**

```typescript
import express from 'express';
import dotenv from 'dotenv';
import { processMentionToApp } from './pipeline';       // renamed
import { classifyTweet, moderateContent } from './services/classify';
import { pollMentions, makeXReply } from './channels/x';
import { createTelegramBot } from './channels/telegram';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Shared state ---
const startupTime = new Date();
const processingMessages = new Set<string>();

function handleMention(input: PipelineInput) {
  const key = `${input.source}:${input.messageId}`;
  if (processingMessages.has(key)) return;
  processingMessages.add(key);

  processMentionToApp(input)
    .catch((error: any) => {
      console.error(`Pipeline error (${input.source}):`, error.message || error);
    })
    .finally(() => {
      processingMessages.delete(key);
    });
}

// --- X/Twitter polling (existing) ---
let lastSeenTweetId = '';
const POLL_INTERVAL_MS = 2 * 60 * 1000;

async function pollX() {
  // ... existing pollMentions logic, calling handleMention() with source: 'x'
}

setInterval(pollX, POLL_INTERVAL_MS);

// --- Telegram bot (new) ---
if (process.env.TELEGRAM_BOT_TOKEN) {
  const telegramBot = createTelegramBot(handleMention);
  telegramBot.start({
    onStart: (botInfo) => {
      console.log(`🤖 Telegram bot started: @${botInfo.username}`);
    },
  });
  console.log('📱 Telegram channel enabled');
} else {
  console.log('📱 Telegram channel disabled (no TELEGRAM_BOT_TOKEN)');
}

app.listen(PORT, () => {
  console.log(`🚀 Clonk bot server running on port ${PORT}`);
});
```

### Step 5: Handle Telegram-Specific Reply Formatting

Telegram has different constraints than X:
- **No character limit** (vs 280 chars on X) — we can be more verbose
- **Markdown support** — Telegram supports MarkdownV2 formatting
- **Photo captions** have a 1024-char limit — if the reply is longer, send photo first then text
- **Inline keyboards** — we can add clickable buttons (Live App, GitHub, Clonk Gallery)

```typescript
// In the Telegram reply function, format the message with buttons:
import { InlineKeyboard } from 'grammy';

const reply: PipelineInput['reply'] = async (replyText, imageBuffer?) => {
  const keyboard = new InlineKeyboard();

  // Parse URLs from reply text to create buttons
  const urlMatch = replyText.match(/https?:\/\/[^\s]+/g);
  if (urlMatch) {
    for (const url of urlMatch) {
      if (url.includes('vercel.app')) keyboard.url('Open App', url);
      else if (url.includes('github.com')) keyboard.url('GitHub', url);
      else if (url.includes('clonk.ai')) keyboard.url('Gallery', url);
    }
  }

  // Clean the reply text (remove raw URLs, Telegram has buttons for those)
  const cleanText = replyText
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (imageBuffer) {
    await ctx.replyWithPhoto(new InputFile(imageBuffer, 'screenshot.png'), {
      caption: cleanText || 'App built!',
      reply_parameters: { message_id: ctx.message!.message_id },
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(cleanText, {
      reply_parameters: { message_id: ctx.message!.message_id },
      reply_markup: keyboard,
    });
  }
};
```

### Step 6: Update Pipeline to Use Reply Callback

**File: `src/pipeline.ts`** — key changes:

```typescript
// Remove these imports:
// import { replyToTweet, uploadMedia } from './services/xClient';

export async function processMentionToApp(input: PipelineInput): Promise<void> {
  // ... all the generation + deploy logic stays the same ...

  // Screenshot: keep the buffer for both the reply and clonk.ai publish
  let screenshotBuffer: Buffer | undefined;
  try {
    screenshotBuffer = await takeScreenshot(vercelUrl);
  } catch (err) {
    console.warn(`Screenshot failed (non-fatal): ${err}`);
  }

  // Publish to clonk.ai (unchanged)
  // ...

  // Reply via the injected channel-specific reply function
  const backendNote = input.backend === 'convex' ? '\n⚡ Powered by Convex' : '';
  const clonkLink = clonkPageUrl ? `\n🌐 ${clonkPageUrl}` : '';
  const replyText = `✅ App live: ${vercelUrl}${backendNote}${clonkLink}\n📝 Contribute: ${githubUrl}`;

  await input.reply(replyText, screenshotBuffer);

  // Error handling: also uses input.reply()
  // ...
}
```

### Step 7: Update clonkSite Publish for Source Tracking

Optionally extend the gallery publish to track which channel the build request came from:

```typescript
// In clonkSite.ts — add source to params
const params = new URLSearchParams({
  appName: entry.appName,
  description: entry.description,
  vercelUrl: entry.vercelUrl,
  githubUrl: entry.githubUrl,
  username: entry.username,
  template: entry.template,
  source: entry.source,  // 'x' | 'telegram' — for the gallery to show the origin
});
```

### Step 8: Classify Adapt for Telegram Context

The `classifyTweet` function name and prompts reference "tweets". Make it channel-agnostic:

- Rename to `classifyMessage` (keep `classifyTweet` as alias for backward compat)
- Update the system prompt to say "message" instead of "tweet" — or keep it as-is (it works fine for classification regardless of the word used)
- Same for `moderateContent` — no changes needed (it takes raw text)

**Minimal change**: Just keep the existing functions as-is. They work on raw text and the tweet-specific wording in prompts doesn't affect classification accuracy.

---

## Environment Variables

Add these to `.env.example`:

```env
# Telegram Bot
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_from_botfather
TELEGRAM_BOT_USERNAME=clonkbot
```

**How to get the token:**
1. Open Telegram, search for `@BotFather`
2. Send `/newbot`
3. Choose a name (e.g., "Clonk Builder Bot")
4. Choose a username (e.g., `clonkbot_builder`)
5. Copy the token

---

## New Dependency

```bash
npm install grammy
```

grammY has zero transitive dependencies beyond the Telegram Bot API types. It's lightweight and TypeScript-native.

---

## File Changes Summary

| File | Action | Description |
|---|---|---|
| `src/pipeline.ts` | **Modify** | Add `source`, `reply` to `PipelineInput`; remove direct X imports; use `input.reply()` |
| `src/index.ts` | **Modify** | Extract X polling to channel adapter; add Telegram bot startup; shared `handleMention()` |
| `src/channels/x.ts` | **New** | X-specific polling + reply adapter |
| `src/channels/telegram.ts` | **New** | Telegram bot setup, message handling, photo extraction, reply formatting |
| `src/services/xClient.ts` | No change | Still exports `fetchMentions`, `replyToTweet`, `uploadMedia` |
| `src/services/classify.ts` | No change | Works on raw text, channel-agnostic already |
| `.env.example` | **Modify** | Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` |
| `package.json` | **Modify** | Add `grammy` dependency |
| `Dockerfile` | No change | grammY uses long-polling, no extra system deps needed |

---

## Telegram-Specific Behaviors

### Group Chats vs DMs
- **DMs (private chat)**: Every message is treated as a build request (still subject to keyword + AI classification)
- **Groups/Supergroups**: Only respond when `@botusername` is mentioned in the message text
- **Channels**: Not supported (channels are broadcast-only)

### Reply Threading
- Telegram has native reply threading — bot replies are linked to the original message via `reply_parameters`
- If a user replies to an existing message with `@clonkbot build this`, the replied-to message becomes `parentContext` (same as replied_to tweet)

### Photo Handling
- Telegram photos are accessed via `getFile()` API → temporary URL (valid ~1 hour)
- Download the photo immediately and pass the URL to the pipeline
- The pipeline already supports `imageUrls` for visual reference

### Rate Limits
- Telegram Bot API: 30 messages/second to different chats, 1 message/second per chat
- No polling rate limits (unlike X's 15 req/15 min)
- Long-polling is free and instant — no need for intervals

### Message Length
- Telegram message limit: 4096 chars (vs 280 on X)
- Photo caption limit: 1024 chars
- If the reply exceeds 1024 chars and has a screenshot, send the photo first with a short caption, then send the full text separately

---

## Deployment Considerations

### Long Polling vs Webhook

**Start with long-polling** (recommended for Railway):
- No public URL needed
- Works behind NATs/firewalls
- grammY handles reconnection automatically
- `bot.start()` runs in the background alongside Express

**Optional: Webhook mode** (for production scale):
- Requires a stable public URL (Railway provides this)
- More efficient — no open connection
- Integrate with Express:
  ```typescript
  import { webhookCallback } from 'grammy';
  app.use('/telegram-webhook', webhookCallback(bot, 'express'));
  ```
- Set webhook URL via `bot.api.setWebhook('https://your-app.railway.app/telegram-webhook')`

### Graceful Shutdown

```typescript
// In index.ts, handle SIGTERM/SIGINT
process.on('SIGTERM', () => {
  telegramBot.stop();
  // ... other cleanup
});
```

---

## Testing Plan

1. **Unit test**: Verify `PipelineInput` accepts both `source: 'x'` and `source: 'telegram'`
2. **Integration test**: Send a test message to the Telegram bot in DM, verify pipeline fires
3. **Group test**: Add bot to a test group, verify it only responds to @mentions
4. **Reply test**: Reply to an existing message with a build request, verify `parentContext` is extracted
5. **Photo test**: Send a message with an attached photo, verify the image URL is passed to the pipeline
6. **Error test**: Verify error replies go back to the correct Telegram chat

---

## Implementation Order

1. `npm install grammy` and add env vars to `.env.example`
2. Refactor `PipelineInput` to add `source`, `messageId`, `reply` callback
3. Update `pipeline.ts` to use `input.reply()` instead of direct X calls
4. Extract X logic into `src/channels/x.ts`
5. Create `src/channels/telegram.ts`
6. Update `src/index.ts` to wire both channels
7. Test locally with BotFather test bot
8. Deploy to Railway
