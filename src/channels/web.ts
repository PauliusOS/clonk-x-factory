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

const jobs = new Map<string, Job>();

// Clean up jobs older than 1 hour every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000);

function createJob(): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    status: 'queued',
    stage: '',
    result: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
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

  // AI classification — is this actually a build request?
  const isAppRequest = await classifyTweet(`build ${idea}`, undefined, images);
  if (!isAppRequest) {
    return { error: 'Not recognized as a build request' };
  }

  // Content moderation
  const isSafe = await moderateContent(idea, undefined, images);
  if (!isSafe) {
    return { error: 'Content did not pass moderation' };
  }

  const job = createJob();
  job.status = 'processing';

  // Template detection
  const ideaLower = idea.toLowerCase();
  const THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game'];
  const wantsThreeJs = THREEJS_KEYWORDS.some(kw => ideaLower.includes(kw));

  const BACKEND_KEYWORDS = ['convex', 'backend', 'database', 'real-time', 'realtime', 'login', 'sign in', 'signup', 'sign up', 'auth', 'users', 'accounts'];
  const wantsConvex = BACKEND_KEYWORDS.some(kw => ideaLower.includes(kw));

  const input: PipelineInput = {
    idea,
    messageId: job.id,
    userId: `web:${username}`,
    username,
    source: 'web',
    imageBuffers: images,
    backend: wantsConvex ? 'convex' : undefined,
    template: wantsThreeJs ? 'threejs' : undefined,
    reply: async (text: string) => {
      job.result = text;
      job.status = 'done';
      job.stage = 'done';
    },
    onProgress: (stage: string) => {
      job.stage = stage;
    },
  };

  // Fire and forget — the job tracks progress
  processMentionToApp(input).catch((err) => {
    job.status = 'error';
    job.result = err.message || 'Pipeline failed';
  });

  return { jobId: job.id };
}
