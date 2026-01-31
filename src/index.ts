import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { processTweetToApp } from './pipeline';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// X Webhook CRC verification
app.get('/webhooks/x', (req, res) => {
  const crc_token = req.query.crc_token as string;

  if (crc_token) {
    const hash = crypto
      .createHmac('sha256', process.env.X_API_SECRET || '')
      .update(crc_token)
      .digest('base64');

    res.status(200).json({
      response_token: `sha256=${hash}`,
    });
  } else {
    res.status(400).send('Missing crc_token');
  }
});

// X Webhook event handler
app.post('/webhooks/x', async (req, res) => {
  console.log('\n📨 Webhook received');

  // Respond immediately (X requires <10s response)
  res.status(200).json({ status: 'received' });

  try {
    // Check if it's a tweet_create event
    const events = req.body.tweet_create_events;
    if (!events || events.length === 0) {
      console.log('No tweet events found');
      return;
    }

    const tweet = events[0];
    const tweetText = tweet.text;
    const tweetId = tweet.id_str;
    const userId = tweet.user.id_str;
    const username = tweet.user.screen_name;

    // Ignore the bot's own tweets to prevent infinite loops
    const botUserId = process.env.X_BOT_USER_ID;
    if (botUserId && userId === botUserId) {
      console.log('Ignoring own tweet');
      return;
    }

    console.log(`📝 Tweet from @${username}: ${tweetText}`);

    // Check if this is a mention of our bot
    if (!tweetText.toLowerCase().includes('@clonkbot')) {
      console.log('Not a mention of @clonkbot');
      return;
    }

    // Extract the app idea
    const idea = tweetText
      .replace(/@clonkbot/gi, '')
      .replace(/build/gi, '')
      .trim();

    if (!idea || idea.length < 3) {
      console.log('Idea too short, skipping');
      return;
    }

    console.log(`💡 App idea: ${idea}`);

    // Process in background (don't await)
    processTweetToApp({ idea, tweetId, userId }).catch((error) => {
      console.error('Pipeline error:', error);
    });
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Clonk bot server running on port ${PORT}`);
  console.log(`📍 Webhook endpoint: /webhooks/x`);
});
