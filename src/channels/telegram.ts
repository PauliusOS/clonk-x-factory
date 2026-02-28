import { Bot, InputFile, InlineKeyboard, Context, webhookCallback } from 'grammy';
import crypto from 'crypto';
import axios from 'axios';
import type { Express } from 'express';
import { classifyTweet, moderateContent } from '../services/classify';
import type { PipelineInput } from '../pipeline';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'clonkrbot';

// Curated list of fun cooking/building/crafting GIFs for acknowledgement messages.
// Telegram fetches these directly — no external API key needed.
const ACK_GIFS = [
  'https://media.giphy.com/media/l0MYt5jPR6QX5APm0/giphy.gif',       // cooking fire
  'https://media.giphy.com/media/3oEjHGr1Fhz0kyv8Ig/giphy.gif',      // chef cooking
  'https://media.giphy.com/media/xT0xeMA62E1XIlqYb6/giphy.gif',      // building blocks
  'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif',           // cat typing
  'https://media.giphy.com/media/LmNwrBhejkK9EFP504/giphy.gif',      // coding
  'https://media.giphy.com/media/13HgwGsXF0aiGY/giphy.gif',          // hacker typing
  'https://media.giphy.com/media/du3J3cXyzhj75IOgvA/giphy.gif',      // lego building
  'https://media.giphy.com/media/3knKct3fGqxhK/giphy.gif',           // science cooking
  'https://media.giphy.com/media/snEeOh54kCFxe/giphy.gif',           // building machine
  'https://media.giphy.com/media/iDJQRjTCenF7A4BRyU/giphy.gif',      // robot working
];

const ACK_MESSAGES = [
  "🔨 clonk clonk clonk...",
  "⚡ clonking in progress...",
  "🚀 clonking your app into existence...",
  "🧑‍🍳 clonk clonk! cooking it up...",
  "🏗️ clonking away...",
  "🔧 clonk clonk clonk clonk...",
  "🧪 clonking the ingredients together...",
  "⏳ clonking... give me a sec...",
];

/** Pick from array without repeating until all items have been used */
function makeShuffledPicker<T>(arr: T[]): () => T {
  let remaining: T[] = [];
  return () => {
    if (remaining.length === 0) {
      remaining = [...arr].sort(() => Math.random() - 0.5);
    }
    return remaining.pop()!;
  };
}

const pickGif = makeShuffledPicker(ACK_GIFS);
const pickMessage = makeShuffledPicker(ACK_MESSAGES);

/** Send an acknowledgement GIF + message and return the ack message ID for later editing */
async function sendAcknowledgement(ctx: Context): Promise<number | undefined> {
  try {
    const msg = await ctx.replyWithAnimation(pickGif(), {
      caption: pickMessage(),
      reply_parameters: { message_id: ctx.message!.message_id },
    });
    return msg.message_id;
  } catch (err) {
    // Non-fatal — if the GIF fails, try a plain text ack
    try {
      const msg = await ctx.reply(pickMessage(), {
        reply_parameters: { message_id: ctx.message!.message_id },
      });
      return msg.message_id;
    } catch {
      // Truly non-fatal
    }
  }
  return undefined;
}

/** React to the user's message with a fire emoji */
async function reactToMessage(ctx: Context): Promise<void> {
  try {
    await ctx.react('🔥');
  } catch {
    // Non-fatal — reactions may not be available in all chats
  }
}

/** Update the reaction to a party emoji when the build is done */
async function reactDone(ctx: Context): Promise<void> {
  try {
    await ctx.react('🎉');
  } catch {
    // Non-fatal
  }
}

/**
 * Create a progress callback for Telegram that:
 * 1. Edits the ack message caption/text with the current stage
 * 2. Sends a "typing" chat action (visible for ~5s, re-sent each stage)
 */
function makeTelegramProgress(
  ctx: Context,
  ackMessageId: number | undefined,
): { onProgress: (stage: string) => void; stopTyping: () => void } {
  const chatId = ctx.chat!.id;

  // Keep a "typing" indicator running on a 4s interval
  let typingInterval: ReturnType<typeof setInterval> | undefined;

  const sendTyping = () => {
    ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
  };

  // Start typing immediately
  sendTyping();
  typingInterval = setInterval(sendTyping, 4000);

  const onProgress = (stage: string) => {
    // Re-trigger typing action on each stage change
    sendTyping();

    if (!ackMessageId) return;

    // Try editing caption (for GIF ack) first, fall back to text (for text ack)
    ctx.api.editMessageCaption(chatId, ackMessageId, { caption: stage }).catch(() => {
      ctx.api.editMessageText(chatId, ackMessageId, stage).catch(() => {});
    });
  };

  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  };

  return { onProgress, stopTyping };
}

interface DownloadedImage {
  data: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/** Normalize a content-type to one of Claude's allowed image types */
function normalizeMediaType(contentType: string, filePath?: string): DownloadedImage['mediaType'] {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === 'image/png') return 'image/png';
  if (ct === 'image/gif') return 'image/gif';
  if (ct === 'image/webp') return 'image/webp';
  if (ct === 'image/jpeg' || ct === 'image/jpg') return 'image/jpeg';

  // Fallback: guess from file extension
  if (filePath) {
    if (filePath.endsWith('.png')) return 'image/png';
    if (filePath.endsWith('.gif')) return 'image/gif';
    if (filePath.endsWith('.webp')) return 'image/webp';
  }
  return 'image/jpeg'; // safe default — Telegram photos are almost always JPEG
}

/**
 * Extract the largest photo from a Telegram message, download it, and return
 * both the raw buffer (for classify/moderate) and the image data.
 * Telegram's file API is blocked by robots.txt so Claude can't fetch URLs directly.
 */
async function downloadTelegramPhotos(ctx: Context): Promise<DownloadedImage[]> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return [];

  // Telegram sends multiple resolutions — last is largest
  const largest = photos[photos.length - 1];
  try {
    const file = await ctx.api.getFile(largest.file_id);
    if (file.file_path) {
      const token = process.env.TELEGRAM_BOT_TOKEN!;
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      const mediaType = normalizeMediaType(response.headers['content-type'] || '', file.file_path);
      return [{ data: Buffer.from(response.data), mediaType }];
    }
  } catch (err) {
    console.warn('Failed to download Telegram photo:', err instanceof Error ? err.message : err);
  }
  return [];
}

/**
 * Download photos from a parent (replied-to) message.
 */
async function downloadParentPhotos(ctx: Context): Promise<DownloadedImage[]> {
  const replyMsg = ctx.message?.reply_to_message;
  if (!replyMsg?.photo || replyMsg.photo.length === 0) return [];

  const largest = replyMsg.photo[replyMsg.photo.length - 1];
  try {
    const file = await ctx.api.getFile(largest.file_id);
    if (file.file_path) {
      const token = process.env.TELEGRAM_BOT_TOKEN!;
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      const mediaType = normalizeMediaType(response.headers['content-type'] || '', file.file_path);
      return [{ data: Buffer.from(response.data), mediaType }];
    }
  } catch (err) {
    console.warn('Failed to download parent photo:', err instanceof Error ? err.message : err);
  }
  return [];
}

/**
 * Build a Telegram-specific reply function that sends text + optional screenshot
 * with inline keyboard buttons for the app links.
 */
function makeTelegramReply(ctx: Context): PipelineInput['reply'] {
  return async (text: string, screenshotBuffer?: Buffer) => {
    // Extract URLs to build "Open" and "Remix" buttons
    const keyboard = new InlineKeyboard();
    const urlMatches = text.match(/https?:\/\/[^\s]+/g) || [];
    let hasButtons = false;
    for (const url of urlMatches) {
      if (url.includes('vercel.app')) { keyboard.url('▶️ Open', url); hasButtons = true; }
      else if (url.includes('clonk.ai')) { keyboard.url('🔀 Remix', url); hasButtons = true; }
    }

    const replyParams = { message_id: ctx.message!.message_id };
    const replyMarkup = hasButtons ? keyboard : undefined;
    const caption = '✅ Your app is ready!';

    if (screenshotBuffer) {
      await ctx.replyWithPhoto(new InputFile(screenshotBuffer, 'screenshot.png'), {
        caption,
        reply_parameters: replyParams,
        reply_markup: replyMarkup,
      });
    } else {
      await ctx.reply(caption, {
        reply_parameters: replyParams,
        reply_markup: replyMarkup,
      });
    }
  };
}

/**
 * Check whether a message is addressed to the bot.
 * Returns true if:
 * - Chat is private (DM)
 * - Text/caption contains @botname
 * - Message is a reply to one of the bot's own messages
 */
function isAddressedToBot(ctx: Context): boolean {
  if (ctx.chat?.type === 'private') return true;

  const text = (ctx.message?.text || ctx.message?.caption || '').toLowerCase();
  if (text.includes(`@${BOT_USERNAME.toLowerCase()}`)) return true;

  // Check if replying to one of the bot's own messages.
  // ctx.me requires bot.init() — guard with try/catch for webhook mode
  // where init may not have been called yet.
  try {
    if (ctx.message?.reply_to_message?.from?.id === ctx.me.id) return true;
  } catch {
    // ctx.me not available — fall through
  }

  return false;
}

/**
 * Create and configure the Telegram bot.
 * Calls onMention() for each valid build request.
 *
 * The bot works with Telegram's default privacy mode — in groups it only
 * receives @mentions, replies-to-bot, commands, and service messages.
 *
 * Use `startTelegramWebhook()` to mount it on Express with webhooks (recommended
 * for production on Railway/Heroku/etc where you have a stable public URL).
 * Falls back to long-polling via `bot.start()` if no WEBHOOK_URL is available.
 */
export async function createTelegramBot(
  onMention: (input: PipelineInput) => void,
): Promise<Bot> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(token);

  // Fetch bot info eagerly so ctx.me is available in all handlers
  // (required for reply-to-bot detection in webhook mode).
  await bot.init();
  console.log(`📱 Telegram bot initialized as @${bot.botInfo.username}`);

  // Log unhandled errors instead of crashing silently
  bot.catch((err) => {
    console.error('❌ Telegram bot error:', err.error || err);
  });

  // --- Shared build-request handler used by /build command and message:text ---
  async function handleBuildRequest(ctx: Context, rawText: string): Promise<void> {
    const username = ctx.from?.username || ctx.from?.first_name || 'unknown';
    const userId = String(ctx.from?.id || 'unknown');
    const textLower = rawText.toLowerCase();

    // Extract the "idea" — remove @botname mentions and trigger keywords
    const idea = rawText
      .replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '')
      .replace(/\b(build|make|create)\b/gi, '')
      .trim();

    if (!idea || idea.length < 3) {
      await ctx.reply(
        `💡 Please describe what you want to build, e.g. \`/build a pomodoro timer\``,
        { parse_mode: 'Markdown', reply_parameters: { message_id: ctx.message!.message_id } },
      );
      return;
    }

    console.log(`\n📱 Telegram message from @${username}: ${rawText}`);

    // Template detection (same logic as X)
    const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game'];
    const wantsThreeJs = THREEJS_KEYWORDS.some(kw => textLower.includes(kw));

    const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
    const wantsConvex = BACKEND_KEYWORDS.some(kw => textLower.includes(kw));

    // Download photos early — we need them for classification, moderation, AND the pipeline.
    const downloadedImages = await downloadTelegramPhotos(ctx);
    const parentImages = await downloadParentPhotos(ctx);
    const allImages = [...downloadedImages, ...parentImages];

    // Extract parent context
    let parentContext: { text: string; imageUrls: string[] } | undefined;
    const replyMsg = ctx.message!.reply_to_message;
    if (replyMsg) {
      parentContext = {
        text: replyMsg.text || replyMsg.caption || '',
        imageUrls: [], // images passed separately as buffers now
      };
      if (parentContext.text) {
        console.log(`🔗 Parent message: ${parentContext.text.substring(0, 80)}...`);
      }
    }

    // AI classification + moderation — Haiku sees the actual images
    const isAppRequest = await classifyTweet(rawText, parentContext?.text, allImages.length > 0 ? allImages : undefined);
    if (!isAppRequest) {
      console.log('🤖 AI classification: NOT a build request, skipping');
      return;
    }
    console.log('🤖 AI classification: confirmed build request, proceeding');

    const isSafe = await moderateContent(idea, parentContext?.text, allImages.length > 0 ? allImages : undefined);
    if (!isSafe) {
      console.log('🛡️ Content moderation: UNSAFE content detected, skipping');
      return;
    }
    console.log('🛡️ Content moderation: content is safe, proceeding');

    console.log(`💡 App idea: ${idea}${allImages.length ? ` (with ${allImages.length} image(s))` : ''}${wantsThreeJs ? ' (Three.js 3D)' : ''}${wantsConvex ? ' (Convex backend)' : ''}`);

    // React + acknowledge immediately so the user knows we're on it
    await reactToMessage(ctx);
    const ackMsgId = await sendAcknowledgement(ctx);
    const { onProgress, stopTyping } = makeTelegramProgress(ctx, ackMsgId);

    onMention({
      idea,
      messageId: String(ctx.message!.message_id),
      userId,
      username,
      source: 'telegram',
      imageBuffers: allImages.length > 0 ? allImages : undefined,
      parentContext,
      backend: wantsConvex ? 'convex' : undefined,
      template: wantsThreeJs ? 'threejs' : undefined,
      reply: async (text, screenshotBuffer) => {
        stopTyping();
        await reactDone(ctx);
        await makeTelegramReply(ctx)(text, screenshotBuffer);
      },
      onProgress,
    });
  }

  // --- /start and /help commands (registered first — order matters in grammY) ---
  bot.command(['start', 'help'], async (ctx) => {
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    await ctx.reply(
      `👋 I'm Clonk — I turn ideas into live web apps in seconds!\n\n` +
      `**How to use:**\n` +
      `• \`/build a pomodoro timer\`\n` +
      `• \`/build a quiz about space\`\n` +
      `• \`/build a pixel art editor\`\n` +
      `• Reply to a screenshot with \`/build this\`\n\n` +
      (isGroup ? `You can also @mention me: \`@${BOT_USERNAME} build a calculator\`\n\n` : '') +
      `**Templates:** say "3D game" for Three.js, or "with backend" for Convex`,
      { parse_mode: 'Markdown' },
    );
  });

  // --- /build command — the primary way to use the bot (always delivered, even with privacy mode) ---
  bot.command(['build', 'make', 'create'], async (ctx) => {
    // ctx.match contains everything after "/build " (grammY strips the command)
    const idea = ctx.match || '';
    await handleBuildRequest(ctx, `build ${idea}`);
  });

  // --- Welcome message when bot is added to a group ---
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;
    const chatType = update.chat.type;

    // Only fire when transitioning into a group/supergroup as member or admin
    if (
      (chatType === 'group' || chatType === 'supergroup') &&
      (oldStatus === 'left' || oldStatus === 'kicked') &&
      (newStatus === 'member' || newStatus === 'administrator')
    ) {
      await ctx.api.sendMessage(
        update.chat.id,
        `👋 Hey! I'm Clonk — I build web apps from a single message.\n\n` +
        `Try: \`/build a calculator\`\n\n` +
        `Type /help for more examples.`,
        { parse_mode: 'Markdown' },
      );
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const chatType = ctx.chat.type;

    if (!isAddressedToBot(ctx)) return;

    const textLower = text.toLowerCase();

    // Trigger keyword check (same as X)
    const TRIGGER_KEYWORDS = ['build', 'make', 'create'];
    const hasKeyword = TRIGGER_KEYWORDS.some(kw => textLower.includes(kw));
    if (!hasKeyword) {
      // In groups, reply with a usage hint so users know what to say
      if (chatType === 'group' || chatType === 'supergroup') {
        await ctx.reply(
          `💡 Try: \`/build <your idea>\`\nType /help for more examples.`,
          {
            parse_mode: 'Markdown',
            reply_parameters: { message_id: ctx.message.message_id },
          },
        );
      }
      return;
    }

    await handleBuildRequest(ctx, text);
  });

  // Handle photo messages with captions (user sends a photo with "build X" as caption)
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption;
    if (!caption) return;

    if (!isAddressedToBot(ctx)) return;

    const captionLower = caption.toLowerCase();
    const TRIGGER_KEYWORDS = ['build', 'make', 'create'];
    const hasKeyword = TRIGGER_KEYWORDS.some(kw => captionLower.includes(kw));
    if (!hasKeyword) return;

    const username = ctx.from?.username || ctx.from?.first_name || 'unknown';
    const userId = String(ctx.from?.id || 'unknown');

    const idea = caption
      .replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '')
      .replace(/\b(build|make|create)\b/gi, '')
      .trim();

    if (!idea || idea.length < 3) return;

    console.log(`\n📱 Telegram photo+caption from @${username}: ${caption}`);

    // Download the attached photo early
    const downloadedImages = await downloadTelegramPhotos(ctx);

    const isAppRequest = await classifyTweet(caption, undefined, downloadedImages.length > 0 ? downloadedImages : undefined);
    if (!isAppRequest) return;

    const isSafe = await moderateContent(idea, undefined, downloadedImages.length > 0 ? downloadedImages : undefined);
    if (!isSafe) return;

    const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game'];
    const wantsThreeJs = THREEJS_KEYWORDS.some(kw => captionLower.includes(kw));

    const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
    const wantsConvex = BACKEND_KEYWORDS.some(kw => captionLower.includes(kw));

    // React + acknowledge immediately
    await reactToMessage(ctx);
    const ackMsgId = await sendAcknowledgement(ctx);
    const { onProgress, stopTyping } = makeTelegramProgress(ctx, ackMsgId);

    onMention({
      idea,
      messageId: String(ctx.message.message_id),
      userId,
      username,
      source: 'telegram',
      imageBuffers: downloadedImages.length > 0 ? downloadedImages : undefined,
      backend: wantsConvex ? 'convex' : undefined,
      template: wantsThreeJs ? 'threejs' : undefined,
      reply: async (text, screenshotBuffer) => {
        stopTyping();
        await reactDone(ctx);
        await makeTelegramReply(ctx)(text, screenshotBuffer);
      },
      onProgress,
    });
  });

  return bot;
}

/**
 * Mount the Telegram bot on an Express app using webhooks.
 *
 * Security: uses Telegram's official `secret_token` parameter on `setWebhook`.
 * Telegram sends this back as an `X-Telegram-Bot-Api-Secret-Token` header on
 * every webhook request, and grammY's `webhookCallback` verifies it automatically.
 * This is the Telegram-recommended approach to prevent spoofed updates.
 *
 * If WEBHOOK_URL is set, registers the webhook with Telegram and uses
 * Express to receive updates. Otherwise falls back to long-polling.
 */
export async function startTelegramBot(
  bot: Bot,
  expressApp: Express,
): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  if (webhookUrl) {
    // Generate a secret token for webhook verification (1-256 chars, A-Za-z0-9_-)
    const secretToken = crypto.createHash('sha256').update(token).digest('hex');

    // Mount webhook handler on a simple path — security comes from the secret_token
    // header verification, not from an unguessable URL path
    expressApp.use(
      '/webhooks/telegram',
      webhookCallback(bot, 'express', { secretToken }),
    );

    // Trim any trailing whitespace/slash from the URL
    const baseUrl = webhookUrl.replace(/\/+$/, '').trim();
    const fullUrl = `${baseUrl}/webhooks/telegram`;
    console.log(`📱 Registering Telegram webhook at: ${fullUrl}`);
    await bot.api.setWebhook(fullUrl, {
      secret_token: secretToken,
      allowed_updates: ['message', 'my_chat_member'],
    });
    console.log(`📱 Telegram bot webhook registered successfully`);
  } else {
    // Fallback: long-polling (for local dev or when no public URL)
    // Delete any previously set webhook first
    await bot.api.deleteWebhook();
    bot.start({
      onStart: (botInfo) => {
        console.log(`📱 Telegram bot started (long-polling): @${botInfo.username}`);
      },
    });
  }
}
