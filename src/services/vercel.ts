import axios from 'axios';
import crypto from 'crypto';

const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN;

export async function deployToVercel(
  appName: string,
  files: { path: string; content: string }[]
): Promise<string> {
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

  // Use the project alias (clean URL) instead of the deployment-specific URL
  const aliases = deployment.data.alias;
  const deploymentUrl = aliases && aliases.length > 0
    ? `https://${aliases[0]}`
    : `https://${deployment.data.url}`;

  console.log(`✅ Deployed to Vercel: ${deploymentUrl}`);

  return deploymentUrl;
}
