import axios from 'axios';

const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN;

export async function deployToVercel(
  appName: string,
  files: { path: string; content: string }[]
): Promise<string> {
  console.log(`🚀 Deploying ${appName} to Vercel...`);

  // Create deployment
  const deployment = await axios.post(
    `${VERCEL_API}/v13/deployments`,
    {
      name: appName,
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

  const deploymentUrl = `https://${deployment.data.url}`;
  console.log(`✅ Deployed to Vercel: ${deploymentUrl}`);

  return deploymentUrl;
}
