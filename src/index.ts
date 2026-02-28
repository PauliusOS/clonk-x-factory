import express from 'express';
import dotenv from 'dotenv';
import { processMentionToApp, PipelineInput } from './pipeline';
import { pollXMentions } from './channels/x';
import { createTelegramBot, startTelegramBot } from './channels/telegram';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Only process messages created after this timestamp (server start time)
const startupTime = new Date();

// Set of message keys currently being processed to prevent double-processing
// Key format: "x:{tweetId}" or "telegram:{messageId}"
const processingMessages = new Set<string>();

/** Shared handler for mentions from any channel */
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

// --- X/Twitter polling ---
let lastSeenTweetId = '';
const POLL_INTERVAL_MS = 2 * 60 * 1000;

async function pollX() {
  try {
    lastSeenTweetId = await pollXMentions(
      lastSeenTweetId,
      processingMessages,
      startupTime,
      handleMention,
    );
  } catch (error: any) {
    if (error.response?.status === 429) {
      console.log('⏳ Rate limited, will retry next poll');
    } else {
      console.error('❌ Error polling mentions:', error.message || error);
    }
  }
}

setInterval(pollX, POLL_INTERVAL_MS);

// --- Telegram bot ---
// Uses webhooks when WEBHOOK_URL is set (production), long-polling otherwise (local dev).
if (process.env.TELEGRAM_BOT_TOKEN) {
  createTelegramBot(handleMention).then((telegramBot) => {
    startTelegramBot(telegramBot, app).catch((err) => {
      console.error('❌ Failed to start Telegram bot:', err.message || err);
    });

    // Graceful shutdown (only needed for long-polling mode, harmless otherwise)
    const stopBot = () => telegramBot.stop();
    process.once('SIGTERM', stopBot);
    process.once('SIGINT', stopBot);
  }).catch((err) => {
    console.error('❌ Failed to create Telegram bot:', err.message || err);
  });
} else {
  console.log('📱 Telegram channel disabled (no TELEGRAM_BOT_TOKEN)');
}

app.listen(PORT, () => {
  console.log(`🚀 Clonk bot server running on port ${PORT}`);
  console.log(`🔄 Polling X for mentions every ${POLL_INTERVAL_MS / 1000}s`);
});
