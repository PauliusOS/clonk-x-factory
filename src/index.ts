import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { processMentionToApp, PipelineInput } from './pipeline';
import { pollXMentions } from './channels/x';
import { createTelegramBot, startTelegramBot } from './channels/telegram';
import { handleWebBuild, getJob } from './channels/web';

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

// --- Web API channel ---
const WEB_API_KEY = process.env.CLONK_WEB_API_KEY;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use('/api/build', cors({
  origin: ['https://clonk.ai', 'https://www.clonk.ai', 'http://localhost:3000', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
}));

function checkWebAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!WEB_API_KEY) { res.status(503).json({ error: 'Web API not configured' }); return; }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${WEB_API_KEY}`) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}

app.post('/api/build', checkWebAuth, upload.single('image'), async (req, res) => {
  const idea = req.body?.idea;
  const username = req.body?.username || 'web-user';
  if (!idea || typeof idea !== 'string' || idea.trim().length < 3) {
    res.status(400).json({ error: 'Missing or too short "idea" field' });
    return;
  }

  const imageBuffer = req.file?.buffer;
  const mediaType = req.file?.mimetype;

  const result = await handleWebBuild(idea.trim(), username, imageBuffer, mediaType);
  if ('error' in result) {
    res.status(422).json(result);
    return;
  }
  res.status(202).json(result);
});

app.get('/api/build/:jobId', checkWebAuth, (req, res) => {
  const jobId = req.params.jobId as string;
  const job = getJob(jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`🚀 Clonk bot server running on port ${PORT}`);
  console.log(`🔄 Polling X for mentions every ${POLL_INTERVAL_MS / 1000}s`);
});
