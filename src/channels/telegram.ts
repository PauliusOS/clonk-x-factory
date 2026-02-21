import { Bot, InputFile, InlineKeyboard, Context, webhookCallback } from 'grammy';
import crypto from 'crypto';
import type { Express } from 'express';
import { classifyTweet, moderateContent } from '../services/classify';
import type { PipelineInput } from '../pipeline';

const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'clonkrbot';

/**
 * Extract the largest photo from a Telegram message as a downloadable URL.
 * Telegram sends multiple sizes — we take the biggest one.
 */
async function extractTelegramPhotos(ctx: Context): Promise<string[]> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return [];

  // Telegram sends multiple resolutions — last is largest
  const largest = photos[photos.length - 1];
  try {
    const file = await ctx.api.getFile(largest.file_id);
    if (file.file_path) {
      const token = process.env.TELEGRAM_BOT_TOKEN!;
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      return [url];
    }
  } catch (err) {
    console.warn('Failed to extract Telegram photo:', err);
  }
  return [];
}

/**
 * Build a Telegram-specific reply function that sends text + optional screenshot
 * with inline keyboard buttons for the app links.
 */
function makeTelegramReply(ctx: Context): PipelineInput['reply'] {
  return async (text: string, screenshotBuffer?: Buffer) => {
    // Build inline keyboard from URLs in the reply text
    const keyboard = new InlineKeyboard();
    const urlMatches = text.match(/https?:\/\/[^\s]+/g) || [];
    for (const url of urlMatches) {
      if (url.includes('vercel.app')) keyboard.url('Open App', url);
      else if (url.includes('github.com')) keyboard.url('GitHub', url);
      else if (url.includes('clonk.ai')) keyboard.url('Gallery', url);
    }

    // Clean text for Telegram (URLs are in buttons, keep the status lines)
    const cleanText = text
      .replace(/https?:\/\/[^\s]+/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();

    const replyParams = { message_id: ctx.message!.message_id };

    if (screenshotBuffer) {
      // Photo caption max is 1024 chars
      const caption = cleanText.length > 1024 ? cleanText.slice(0, 1021) + '...' : cleanText;
      await ctx.replyWithPhoto(new InputFile(screenshotBuffer, 'screenshot.png'), {
        caption: caption || 'App built!',
        reply_parameters: replyParams,
        reply_markup: urlMatches.length > 0 ? keyboard : undefined,
      });
    } else {
      await ctx.reply(cleanText || text, {
        reply_parameters: replyParams,
        reply_markup: urlMatches.length > 0 ? keyboard : undefined,
      });
    }
  };
}

/**
 * Create and configure the Telegram bot.
 * Calls onMention() for each valid build request.
 *
 * Use `startTelegramWebhook()` to mount it on Express with webhooks (recommended
 * for production on Railway/Heroku/etc where you have a stable public URL).
 * Falls back to long-polling via `bot.start()` if no WEBHOOK_URL is available.
 */
export function createTelegramBot(
  onMention: (input: PipelineInput) => void,
): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(token);

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const chatType = ctx.chat.type;
    const username = ctx.from?.username || ctx.from?.first_name || 'unknown';
    const userId = String(ctx.from?.id || 'unknown');

    // In groups: only respond if bot is @mentioned
    // In DMs (private): always respond
    const isMentioned = chatType === 'private' ||
      text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);

    if (!isMentioned) return;

    const textLower = text.toLowerCase();

    // Trigger keyword check (same as X)
    const TRIGGER_KEYWORDS = ['build', 'make', 'create'];
    const hasKeyword = TRIGGER_KEYWORDS.some(kw => textLower.includes(kw));
    if (!hasKeyword) return;

    // Extract the "idea" — remove @botname mentions and trigger keywords
    const idea = text
      .replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '')
      .replace(/\b(build|make|create)\b/gi, '')
      .trim();

    if (!idea || idea.length < 3) return;

    console.log(`\n📱 Telegram message from @${username}: ${text}`);

    // Template detection (same logic as X)
    const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game'];
    const wantsThreeJs = THREEJS_KEYWORDS.some(kw => textLower.includes(kw));

    const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
    const wantsConvex = BACKEND_KEYWORDS.some(kw => textLower.includes(kw));

    // AI classification + moderation (reuse existing services)
    const isAppRequest = await classifyTweet(text);
    if (!isAppRequest) {
      console.log('🤖 AI classification: NOT a build request, skipping');
      return;
    }
    console.log('🤖 AI classification: confirmed build request, proceeding');

    const isSafe = await moderateContent(idea);
    if (!isSafe) {
      console.log('🛡️ Content moderation: UNSAFE content detected, skipping');
      return;
    }
    console.log('🛡️ Content moderation: content is safe, proceeding');

    // Extract parent context if this is a reply to another message
    let parentContext: { text: string; imageUrls: string[] } | undefined;
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg) {
      const parentImageUrls: string[] = [];
      // Extract photos from the parent message
      if (replyMsg.photo && replyMsg.photo.length > 0) {
        const largest = replyMsg.photo[replyMsg.photo.length - 1];
        try {
          const file = await ctx.api.getFile(largest.file_id);
          if (file.file_path) {
            parentImageUrls.push(
              `https://api.telegram.org/file/bot${token}/${file.file_path}`
            );
          }
        } catch {
          // Non-fatal
        }
      }
      parentContext = {
        text: replyMsg.text || replyMsg.caption || '',
        imageUrls: parentImageUrls,
      };
      if (parentContext.text) {
        console.log(`🔗 Parent message: ${parentContext.text.substring(0, 80)}...`);
      }
    }

    // Extract attached photos from the current message
    const imageUrls = await extractTelegramPhotos(ctx);

    console.log(`💡 App idea: ${idea}${imageUrls.length ? ` (with ${imageUrls.length} image(s))` : ''}${wantsThreeJs ? ' (Three.js 3D)' : ''}${wantsConvex ? ' (Convex backend)' : ''}`);

    onMention({
      idea,
      messageId: String(ctx.message.message_id),
      userId,
      username,
      source: 'telegram',
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      parentContext,
      backend: wantsConvex ? 'convex' : undefined,
      template: wantsThreeJs ? 'threejs' : undefined,
      reply: makeTelegramReply(ctx),
    });
  });

  // Handle photo messages with captions (user sends a photo with "build X" as caption)
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption;
    if (!caption) return;

    const chatType = ctx.chat.type;
    const isMentioned = chatType === 'private' ||
      caption.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);
    if (!isMentioned) return;

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

    const isAppRequest = await classifyTweet(caption);
    if (!isAppRequest) return;

    const isSafe = await moderateContent(idea);
    if (!isSafe) return;

    const imageUrls = await extractTelegramPhotos(ctx);

    const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game'];
    const wantsThreeJs = THREEJS_KEYWORDS.some(kw => captionLower.includes(kw));

    const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
    const wantsConvex = BACKEND_KEYWORDS.some(kw => captionLower.includes(kw));

    onMention({
      idea,
      messageId: String(ctx.message.message_id),
      userId,
      username,
      source: 'telegram',
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      backend: wantsConvex ? 'convex' : undefined,
      template: wantsThreeJs ? 'threejs' : undefined,
      reply: makeTelegramReply(ctx),
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
    await bot.api.setWebhook(fullUrl, { secret_token: secretToken });
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
