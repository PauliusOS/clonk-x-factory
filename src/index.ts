import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { processTweetToApp } from './pipeline';
import { classifyTweet } from './services/classify';

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
      'tweet.fields': 'author_id,created_at,attachments,referenced_tweets',
      'media.fields': 'url,preview_image_url,type',
      'user.fields': 'username',
      expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.attachments.media_keys',
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
    const includedTweets = response.data.includes?.tweets || [];

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

      // Only process tweets that contain a trigger keyword — ignore random mentions/spam
      const TRIGGER_KEYWORDS = ['build', 'make', 'create'];
      const hasKeyword = TRIGGER_KEYWORDS.some(kw => tweetLower.includes(kw));
      if (!hasKeyword) {
        console.log('No trigger keyword (build/make/create) found, skipping');
        continue;
      }

      // Detect if the app needs a backend (Convex)
      // Triggers: mentions "convex", or describes needing a backend/database/auth/login/real-time
      const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
      const wantsConvex = BACKEND_KEYWORDS.some(kw => tweetLower.includes(kw));

      // Extract idea (remove @mentions, trigger keywords, and @convex tag)
      const idea = tweet.text
        .replace(/@\w+/g, '')
        .replace(/\b(build|make|create)\b/gi, '')
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

      // Extract parent tweet context if this mention is a reply
      let parentContext: { text: string; imageUrls: string[] } | undefined;
      const repliedToRef = tweet.referenced_tweets?.find(
        (ref: { type: string }) => ref.type === 'replied_to'
      );
      if (repliedToRef) {
        const parentTweet = includedTweets.find(
          (t: { id: string }) => t.id === repliedToRef.id
        );
        if (parentTweet) {
          const parentImageUrls: string[] = [];
          const parentMediaKeys = parentTweet.attachments?.media_keys || [];
          for (const key of parentMediaKeys) {
            const mediaItem = media.find((m: { media_key: string }) => m.media_key === key);
            if (mediaItem && mediaItem.type === 'photo' && mediaItem.url) {
              parentImageUrls.push(mediaItem.url);
            }
          }
          parentContext = { text: parentTweet.text, imageUrls: parentImageUrls };
          console.log(`🔗 Parent tweet: ${parentTweet.text.substring(0, 80)}...${parentImageUrls.length ? ` (${parentImageUrls.length} image(s))` : ''}`);
        }
      }

      // Use AI to classify whether this is a genuine build request
      const isAppRequest = await classifyTweet(tweet.text, parentContext?.text);
      if (!isAppRequest) {
        console.log('🤖 AI classification: NOT a build request, skipping');
        continue;
      }
      console.log('🤖 AI classification: confirmed build request, proceeding');

      console.log(`💡 App idea: ${idea}${imageUrls.length ? ` (with ${imageUrls.length} image(s))` : ''}${wantsConvex ? ' (Convex backend)' : ''}`);

      // Mark as processing
      processingTweets.add(tweet.id);

      // Process in background
      processTweetToApp({
        idea,
        tweetId: tweet.id,
        userId: tweet.author_id,
        username,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        parentContext,
        backend: wantsConvex ? 'convex' : undefined,
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
