import axios from 'axios';
import crypto from 'crypto';

const X_API_BASE = 'https://api.x.com/2';

interface TweetResponse {
  data: {
    id: string;
    text: string;
  };
}

export async function replyToTweet(
  tweetId: string,
  replyText: string
): Promise<void> {
  console.log(`💬 Replying to tweet ${tweetId}...`);

  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;

  if (!accessToken || !accessTokenSecret || !apiKey || !apiSecret) {
    throw new Error('Missing X API credentials');
  }

  // OAuth 1.0a signature generation
  const oauth: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_token: accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(32).toString('base64').replace(/\W/g, ''),
    oauth_version: '1.0',
  };

  const method = 'POST';
  const url = `${X_API_BASE}/tweets`;
  const params = { ...oauth };

  // Create signature base string
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');

  const signatureBase = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;

  // Create signing key
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessTokenSecret)}`;

  // Generate signature
  const signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  oauth['oauth_signature'] = signature;

  // Create Authorization header
  const authHeader =
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((key) => `${key}="${encodeURIComponent(oauth[key])}"`)
      .join(', ');

  // Post tweet
  const response = await axios.post<TweetResponse>(
    url,
    {
      text: replyText,
      reply: {
        in_reply_to_tweet_id: tweetId,
      },
    },
    {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log(`✅ Replied to tweet: ${response.data.data.id}`);
}
