import express from 'express';
import dotenv from 'dotenv';
import { processTweetToApp } from './pipeline';
import { classifyTweet, moderateContent } from './services/classify';
import { fetchMentions } from './services/xClient';

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
    const botUserId = process.env.X_BOT_USER_ID;

    if (!botUserId) {
      console.error('Missing X_BOT_USER_ID');
      return;
    }

    const data = await fetchMentions(botUserId, lastSeenTweetId || undefined);

    const tweets = data.data || [];
    const users = data.includes?.users || [];
    const media = data.includes?.media || [];
    const includedTweets = data.includes?.tweets || [];

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

      // Detect if the app is a 3D / game / Three.js request
      const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'three js', 'webgl', 'webgpu', '3d game'];
      const wantsThreeJs = THREEJS_KEYWORDS.some(kw => tweetLower.includes(kw));

      // Detect if the app needs a backend (Convex)
      // Triggers: mentions "convex", or describes needing a backend/database/auth/login/real-time
      // Note: Convex can be combined with ThreeJS - we prioritize Convex template and add Three.js packages
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

      // Content moderation — reject harmful/adversarial prompts before they hit the expensive pipeline
      const isSafe = await moderateContent(idea, parentContext?.text);
      if (!isSafe) {
        console.log('🛡️ Content moderation: UNSAFE content detected, skipping');
        continue;
      }
      console.log('🛡️ Content moderation: content is safe, proceeding');

      console.log(`💡 App idea: ${idea}${imageUrls.length ? ` (with ${imageUrls.length} image(s))` : ''}${wantsThreeJs ? ' (Three.js 3D)' : ''}${wantsConvex ? ' (Convex backend)' : ''}`);

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
        template: wantsThreeJs ? 'threejs' : undefined,
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
