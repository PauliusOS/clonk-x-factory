import axios from 'axios';
import crypto from 'crypto';

const X_API_BASE = 'https://api.x.com/2';
const X_UPLOAD_BASE = 'https://upload.twitter.com/1.1';

interface TweetResponse {
  data: {
    id: string;
    text: string;
  };
}

function getCredentials() {
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;

  if (!accessToken || !accessTokenSecret || !apiKey || !apiSecret) {
    throw new Error('Missing X API credentials');
  }

  return { accessToken, accessTokenSecret, apiKey, apiSecret };
}

function generateOAuthHeader(method: string, url: string): string {
  const { accessToken, accessTokenSecret, apiKey, apiSecret } = getCredentials();

  const oauth: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_token: accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(32).toString('base64').replace(/\W/g, ''),
    oauth_version: '1.0',
  };

  // Create signature base string (only OAuth params, no body params for JSON/multipart)
  const paramString = Object.keys(oauth)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(oauth[key])}`)
    .join('&');

  const signatureBase = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessTokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  oauth['oauth_signature'] = signature;

  return (
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((key) => `${key}="${encodeURIComponent(oauth[key])}"`)
      .join(', ')
  );
}

export async function uploadMedia(imageBuffer: Buffer): Promise<string> {
  console.log(`📤 Uploading media to X (${imageBuffer.length} bytes)...`);

  const url = `${X_UPLOAD_BASE}/media/upload.json`;
  const authHeader = generateOAuthHeader('POST', url);

  // Build multipart form data
  const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;
  const parts: Buffer[] = [];

  // media_data field (base64-encoded image)
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media_data"\r\n\r\n` +
    imageBuffer.toString('base64') +
    `\r\n`
  ));

  // media_category field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media_category"\r\n\r\n` +
    `tweet_image\r\n`
  ));

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const response = await axios.post(url, body, {
    headers: {
      Authorization: authHeader,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length.toString(),
    },
    maxBodyLength: Infinity,
  });

  const mediaId = response.data.media_id_string;
  console.log(`✅ Media uploaded: ${mediaId}`);
  return mediaId;
}

export async function replyToTweet(
  tweetId: string,
  replyText: string,
  mediaIds?: string[]
): Promise<void> {
  console.log(`💬 Replying to tweet ${tweetId}...`);

  const url = `${X_API_BASE}/tweets`;
  const authHeader = generateOAuthHeader('POST', url);

  const requestBody: Record<string, unknown> = {
    text: replyText,
    reply: {
      in_reply_to_tweet_id: tweetId,
    },
  };

  if (mediaIds && mediaIds.length > 0) {
    requestBody.media = { media_ids: mediaIds };
  }

  const response = await axios.post<TweetResponse>(
    url,
    requestBody,
    {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    }
  );

  console.log(`✅ Replied to tweet: ${response.data.data.id}`);
}
