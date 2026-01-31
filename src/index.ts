import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { processTweetToApp } from './pipeline';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Only process tweets created after this timestamp (server start time)
const startupTime = new Date();

// Store last seen tweet ID to avoid duplicates
let lastSeenTweetId = '';

// Set of tweet IDs currently being processed to prevent double-processing
const processingTweets = new Set<string>();

// Polling interval: 2 minutes (free tier allows ~1 req/15 min for mentions)
const POLL_INTERVAL_MS = 2 * 60 * 1000;

async function pollMentions() {
  try {
    const bearerToken = process.env.X_BEARER_TOKEN;
    const botUserId = process.env.X_BOT_USER_ID;

    if (!bearerToken || !botUserId) {
      console.error('Missing X_BEARER_TOKEN or X_BOT_USER_ID');
      return;
    }

    const params: Record<string, string> = {
      max_results: '10',
      'tweet.fields': 'author_id,created_at,attachments',
      'media.fields': 'url,preview_image_url,type',
      'user.fields': 'username',
      expansions: 'author_id,attachments.media_keys',
    };

    if (lastSeenTweetId) {
      params.since_id = lastSeenTweetId;
    }

    const response = await axios.get(
      `https://api.x.com/2/users/${botUserId}/mentions`,
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
        params,
      }
    );

    const tweets = response.data.data || [];
    const users = response.data.includes?.users || [];
    const media = response.data.includes?.media || [];

    if (tweets.length === 0) {
      return;
    }

    // Update last seen ID (first tweet is most recent)
    lastSeenTweetId = tweets[0].id;

    console.log(`\n📨 Found ${tweets.length} new mention(s)`);

    for (const tweet of tweets) {
      // Skip bot's own tweets
      if (tweet.author_id === botUserId) {
        continue;
      }

      // Skip tweets created before this server instance started
      if (tweet.created_at && new Date(tweet.created_at) < startupTime) {
        continue;
      }

      // Skip already-processing tweets
      if (processingTweets.has(tweet.id)) {
        continue;
      }

      const user = users.find((u: { id: string }) => u.id === tweet.author_id);
      const username = user?.username || 'unknown';
      const tweetLower = tweet.text.toLowerCase();

      console.log(`\n📝 Tweet from @${username}: ${tweet.text}`);

      // Only process tweets that contain "build" — ignore random mentions/spam
      if (!tweetLower.includes('build')) {
        console.log('No "build" keyword found, skipping');
        continue;
      }

      // Extract idea (remove @mentions and the "build" keyword)
      const idea = tweet.text
        .replace(/@\w+/g, '')
        .replace(/build/gi, '')
        .trim();

      if (!idea || idea.length < 3) {
        console.log('Idea too short, skipping');
        continue;
      }

      // Extract image URLs from tweet attachments
      const imageUrls: string[] = [];
      const mediaKeys = tweet.attachments?.media_keys || [];
      for (const key of mediaKeys) {
        const mediaItem = media.find((m: { media_key: string }) => m.media_key === key);
        if (mediaItem && mediaItem.type === 'photo' && mediaItem.url) {
          imageUrls.push(mediaItem.url);
        }
      }

      console.log(`💡 App idea: ${idea}${imageUrls.length ? ` (with ${imageUrls.length} image(s))` : ''}`);

      // Mark as processing
      processingTweets.add(tweet.id);

      // Process in background
      processTweetToApp({
        idea,
        tweetId: tweet.id,
        userId: tweet.author_id,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      })
        .catch((error: any) => {
          console.error('Pipeline error:', error.message || error);
        })
        .finally(() => {
          processingTweets.delete(tweet.id);
        });
    }
  } catch (error: any) {
    if (error.response?.status === 429) {
      console.log('⏳ Rate limited, will retry next poll');
    } else {
      console.error('❌ Error polling mentions:', error.message || error);
    }
  }
}

// Start polling
setInterval(pollMentions, POLL_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`🚀 Clonk bot server running on port ${PORT}`);
  console.log(`🔄 Polling for mentions every ${POLL_INTERVAL_MS / 1000}s`);
});
