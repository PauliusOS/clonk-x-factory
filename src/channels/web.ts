import crypto from 'crypto';
import { classifyTweet, moderateContent } from '../services/classify';
import { processMentionToApp, PipelineInput } from '../pipeline';

export interface Job {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  stage: string;
  result: string | null;
  createdAt: number;
}

interface PersistPayload {
  jobId: string;
  idea?: string;
  username?: string;
  status: string;
  stage: string;
  result?: string;
  createdAt?: number;
}

function persistJob(payload: PersistPayload): void {
  const apiUrl = process.env.CLONK_SITE_API_URL;
  const apiKey = process.env.CLONK_SITE_API_KEY;
  if (!apiUrl || !apiKey) return;

  fetch(`${apiUrl}/api/job`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('Failed to persist job:', err.message || err);
  });
}

export async function fetchJob(id: string): Promise<Job | null> {
  const apiUrl = process.env.CLONK_SITE_API_URL;
  const apiKey = process.env.CLONK_SITE_API_KEY;
  if (!apiUrl || !apiKey) return null;

  const res = await fetch(`${apiUrl}/api/job?id=${encodeURIComponent(id)}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;

  const doc = await res.json() as Record<string, any>;
  return {
    id: doc.jobId,
    status: doc.status,
    stage: doc.stage,
    result: doc.result ?? null,
    createdAt: doc.createdAt,
  };
}

/** Map pipeline emoji stages to clean names the website UI can match on */
function normalizeStage(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('convex') && s.includes('setting up')) return 'generating';
  if (s.includes('generating') || s.includes('claude')) return 'generating';
  if (s.includes('deploying') && s.includes('convex')) return 'generating';
  if (s.includes('deploying') || s.includes('vercel')) return 'deploying';
  if (s.includes('github') || s.includes('waiting')) return 'deploying';
  if (s.includes('screenshot')) return 'screenshot';
  if (s.includes('clonk.ai') || s.includes('publishing')) return 'publishing';
  if (s.includes('almost done') || s.includes('sending')) return 'publishing';
  return raw;
}

export async function handleWebBuild(
  idea: string,
  username: string,
  imageBuffer?: Buffer,
  mediaType?: string,
): Promise<{ jobId: string } | { error: string }> {
  const images = imageBuffer && mediaType
    ? [{ data: imageBuffer, mediaType }]
    : undefined;

  const jobId = crypto.randomUUID();

  // Persist initial state so the website can start polling immediately
  persistJob({ jobId, idea, username, status: 'processing', stage: 'classifying', createdAt: Date.now() });

  // AI classification — is this actually a build request?
  const isAppRequest = await classifyTweet(`build ${idea}`, undefined, images);
  if (!isAppRequest) {
    persistJob({ jobId, status: 'error', stage: 'classifying', result: 'Not recognized as a build request' });
    return { error: 'Not recognized as a build request' };
  }

  // Content moderation
  const isSafe = await moderateContent(idea, undefined, images);
  if (!isSafe) {
    persistJob({ jobId, status: 'error', stage: 'classifying', result: 'Content did not pass moderation' });
    return { error: 'Content did not pass moderation' };
  }

  // Template detection
  const ideaLower = idea.toLowerCase();
  const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game'];
  const wantsThreeJs = THREEJS_KEYWORDS.some(kw => ideaLower.includes(kw));

  const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
  const wantsConvex = BACKEND_KEYWORDS.some(kw => ideaLower.includes(kw));

  const input: PipelineInput = {
    idea,
    messageId: jobId,
    userId: `web:${username}`,
    username,
    source: 'web',
    imageBuffers: images,
    backend: wantsConvex ? 'convex' : undefined,
    template: wantsThreeJs ? 'threejs' : undefined,
    reply: async (text: string) => {
      persistJob({ jobId, status: 'done', stage: 'done', result: text });
    },
    onProgress: (stage: string) => {
      persistJob({ jobId, status: 'processing', stage: normalizeStage(stage) });
    },
  };

  // Fire and forget — the job tracks progress via Convex
  processMentionToApp(input).catch((err) => {
    persistJob({ jobId, status: 'error', stage: 'error', result: err.message || 'Pipeline failed' });
  });

  return { jobId };
}
