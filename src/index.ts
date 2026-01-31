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

// Store last seen tweet ID to avoid duplicates
let lastSeenTweetId = '';

// Set of tweet IDs currently being processed to prevent double-processing
const processingTweets = new Set<string>();

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
      'tweet.fields': 'author_id,created_at',
      'user.fields': 'username',
      expansions: 'author_id',
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

      console.log(`💡 App idea: ${idea}`);

      // Mark as processing
      processingTweets.add(tweet.id);

      // Process in background
      processTweetToApp({
        idea,
        tweetId: tweet.id,
        userId: tweet.author_id,
      })
        .catch((error) => {
          console.error('Pipeline error:', error);
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

// Poll every 30 seconds
setInterval(pollMentions, 30000);

// Initial poll on startup
pollMentions();

app.listen(PORT, () => {
  console.log(`🚀 Clonk bot server running on port ${PORT}`);
  console.log(`🔄 Polling for mentions every 30 seconds`);
});
