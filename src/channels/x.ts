import { fetchMentions, replyToTweet, uploadMedia } from '../services/xClient';
import { classifyTweet, moderateContent } from '../services/classify';
import type { PipelineInput } from '../pipeline';

/** Build a reply function that sends a tweet reply with optional screenshot */
export function makeXReply(tweetId: string): PipelineInput['reply'] {
  return async (text: string, screenshotBuffer?: Buffer) => {
    let mediaIds: string[] | undefined;
    if (screenshotBuffer) {
      const mediaId = await uploadMedia(screenshotBuffer);
      mediaIds = [mediaId];
    }
    await replyToTweet(tweetId, text, mediaIds);
  };
}

/**
 * Poll X for new mentions and call onMention() for each valid build request.
 * Returns the updated lastSeenTweetId.
 */
export async function pollXMentions(
  lastSeenTweetId: string,
  processingMessages: Set<string>,
  startupTime: Date,
  onMention: (input: PipelineInput) => void,
): Promise<string> {
  const botUserId = process.env.X_BOT_USER_ID;
  if (!botUserId) {
    console.error('Missing X_BOT_USER_ID');
    return lastSeenTweetId;
  }

  const data = await fetchMentions(botUserId, lastSeenTweetId || undefined);

  const tweets = data.data || [];
  const users = data.includes?.users || [];
  const media = data.includes?.media || [];
  const includedTweets = data.includes?.tweets || [];

  if (tweets.length === 0) {
    return lastSeenTweetId;
  }

  // Update last seen ID (first tweet is most recent)
  const newLastSeenId = tweets[0].id;

  console.log(`\n📨 Found ${tweets.length} new mention(s)`);

  for (const tweet of tweets) {
    // Skip bot's own tweets
    if (tweet.author_id === botUserId) continue;

    // Skip tweets created before this server instance started
    if (tweet.created_at && new Date(tweet.created_at) < startupTime) continue;

    // Skip already-processing messages
    const key = `x:${tweet.id}`;
    if (processingMessages.has(key)) continue;

    const user = users.find((u: { id: string }) => u.id === tweet.author_id);
    const username = user?.username || 'unknown';
    const tweetLower = tweet.text.toLowerCase();

    console.log(`\n📝 Tweet from @${username}: ${tweet.text}`);

    // Only process tweets that contain a trigger keyword
    const TRIGGER_KEYWORDS = ['build', 'make', 'create'];
    const hasKeyword = TRIGGER_KEYWORDS.some((kw: string) => tweetLower.includes(kw));
    if (!hasKeyword) {
      console.log('No trigger keyword (build/make/create) found, skipping');
      continue;
    }

    // Detect template type
    const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'three js', 'webgl', 'webgpu', '3d game'];
    const wantsThreeJs = THREEJS_KEYWORDS.some((kw: string) => tweetLower.includes(kw));

    const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
    const wantsConvex = BACKEND_KEYWORDS.some((kw: string) => tweetLower.includes(kw));

    // Extract idea
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
    for (const mKey of mediaKeys) {
      const mediaItem = media.find((m: { media_key: string }) => m.media_key === mKey);
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
        for (const mKey of parentMediaKeys) {
          const mediaItem = media.find((m: { media_key: string }) => m.media_key === mKey);
          if (mediaItem && mediaItem.type === 'photo' && mediaItem.url) {
            parentImageUrls.push(mediaItem.url);
          }
        }
        parentContext = { text: parentTweet.text, imageUrls: parentImageUrls };
        console.log(`🔗 Parent tweet: ${parentTweet.text.substring(0, 80)}...${parentImageUrls.length ? ` (${parentImageUrls.length} image(s))` : ''}`);
      }
    }

    // Use AI to classify whether this is a genuine build request
    const hasImages = imageUrls.length > 0 || (parentContext?.imageUrls.length ?? 0) > 0;
    const isAppRequest = await classifyTweet(tweet.text, parentContext?.text, hasImages);
    if (!isAppRequest) {
      console.log('🤖 AI classification: NOT a build request, skipping');
      continue;
    }
    console.log('🤖 AI classification: confirmed build request, proceeding');

    // Content moderation
    const isSafe = await moderateContent(idea, parentContext?.text, hasImages);
    if (!isSafe) {
      console.log('🛡️ Content moderation: UNSAFE content detected, skipping');
      continue;
    }
    console.log('🛡️ Content moderation: content is safe, proceeding');

    console.log(`💡 App idea: ${idea}${imageUrls.length ? ` (with ${imageUrls.length} image(s))` : ''}${wantsThreeJs ? ' (Three.js 3D)' : ''}${wantsConvex ? ' (Convex backend)' : ''}`);

    onMention({
      idea,
      messageId: tweet.id,
      userId: tweet.author_id,
      username,
      source: 'x',
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      parentContext,
      backend: wantsConvex ? 'convex' : undefined,
      template: wantsThreeJs ? 'threejs' : undefined,
      reply: makeXReply(tweet.id),
    });
  }

  return newLastSeenId;
}
