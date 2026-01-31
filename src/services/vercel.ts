import axios from 'axios';
import crypto from 'crypto';

const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN;

export interface DeployResult {
  url: string;
  deploymentId: string;
}

export async function deployToVercel(
  appName: string,
  files: { path: string; content: string }[]
): Promise<DeployResult> {
  // Unique project name per deployment so each app gets its own URL
  const suffix = crypto.randomBytes(3).toString('hex');
  const projectName = `${appName}-${suffix}`;

  console.log(`🚀 Deploying ${projectName} to Vercel...`);

  const deployment = await axios.post(
    `${VERCEL_API}/v13/deployments`,
    {
      name: projectName,
      files: files.map((file) => ({
        file: file.path,
        data: file.content,
      })),
      projectSettings: {
        framework: 'vite',
      },
      target: 'production',
    },
    {
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  // Use the clean project URL (accessible without Vercel auth)
  const deploymentUrl = `https://${projectName}.vercel.app`;
  const deploymentId = deployment.data.id;

  console.log(`✅ Deployed to Vercel: ${deploymentUrl} (id: ${deploymentId})`);

  return { url: deploymentUrl, deploymentId };
}

export async function waitForDeployment(
  deploymentId: string,
  timeoutMs: number = 5 * 60 * 1000,
  intervalMs: number = 10_000
): Promise<void> {
  console.log(`⏳ Waiting for deployment ${deploymentId} to be ready...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await axios.get(
      `${VERCEL_API}/v13/deployments/${deploymentId}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
    );
    const state = res.data.readyState;
    console.log(`  Deployment state: ${state}`);

    if (state === 'READY') {
      console.log(`✅ Deployment is ready`);
      return;
    }
    if (state === 'ERROR' || state === 'CANCELED') {
      throw new Error(`Deployment failed with state: ${state}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Deployment timed out after 5 minutes');
}
