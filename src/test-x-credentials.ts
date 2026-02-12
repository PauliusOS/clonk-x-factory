import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import crypto from 'crypto';

function generateOAuthHeader(method: string, url: string): string {
  const accessToken = process.env.X_ACCESS_TOKEN!;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET!;
  const apiKey = process.env.X_API_KEY!;
  const apiSecret = process.env.X_API_SECRET!;

  const oauth: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_token: accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(32).toString('base64').replace(/\W/g, ''),
    oauth_version: '1.0',
  };

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

async function testCredentials() {
  console.log('🔑 Testing X API credentials...\n');

  // Check env vars are set
  const required = ['X_API_KEY', 'X_API_SECRET', 'X_BEARER_TOKEN', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('✅ All required env vars are set\n');

  // Test 1: Bearer token (read access)
  console.log('--- Test 1: Bearer Token (read access) ---');
  try {
    const res = await axios.get('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    });
    console.log(`✅ Bearer token works! Logged in as: @${res.data.data.username} (ID: ${res.data.data.id})\n`);
  } catch (err: any) {
    console.log(`❌ Bearer token failed: ${err.response?.status} ${err.response?.statusText}`);
    console.log(`   Response: ${JSON.stringify(err.response?.data)}\n`);
  }

  // Test 2: OAuth 1.0a (read access via user context)
  console.log('--- Test 2: OAuth 1.0a (read access) ---');
  try {
    const url = 'https://api.x.com/2/users/me';
    const authHeader = generateOAuthHeader('GET', url);
    const res = await axios.get(url, {
      headers: { Authorization: authHeader },
    });
    console.log(`✅ OAuth 1.0a works! Logged in as: @${res.data.data.username} (ID: ${res.data.data.id})\n`);
  } catch (err: any) {
    console.log(`❌ OAuth 1.0a failed: ${err.response?.status} ${err.response?.statusText}`);
    console.log(`   Response: ${JSON.stringify(err.response?.data)}\n`);
  }

  // Test 3: OAuth 1.0a (write access - post and delete a test tweet)
  console.log('--- Test 3: OAuth 1.0a (write access) ---');
  try {
    const url = 'https://api.x.com/2/tweets';
    const authHeader = generateOAuthHeader('POST', url);
    const res = await axios.post(
      url,
      { text: '🔧 credential test - deleting shortly' },
      { headers: { Authorization: authHeader, 'Content-Type': 'application/json' } }
    );
    const tweetId = res.data.data.id;
    console.log(`✅ Write access works! Posted test tweet: ${tweetId}`);

    // Delete the test tweet
    const deleteUrl = `https://api.x.com/2/tweets/${tweetId}`;
    const deleteAuth = generateOAuthHeader('DELETE', deleteUrl);
    await axios.delete(deleteUrl, {
      headers: { Authorization: deleteAuth },
    });
    console.log(`✅ Deleted test tweet: ${tweetId}\n`);
  } catch (err: any) {
    console.log(`❌ Write access failed: ${err.response?.status} ${err.response?.statusText}`);
    console.log(`   Response: ${JSON.stringify(err.response?.data)}`);
    if (err.response?.status === 401) {
      console.log('   → Credentials are invalid or tokens were generated before write permissions were enabled.');
      console.log('   → Fix: Enable Read+Write in Developer Portal, then regenerate Access Token & Secret.');
    } else if (err.response?.status === 403) {
      console.log('   → App does not have write permissions or account is restricted.');
      console.log('   → Fix: Check app permissions and account status in Developer Portal.');
    }
    console.log('');
  }

  console.log('Done!');
}

testCredentials();
