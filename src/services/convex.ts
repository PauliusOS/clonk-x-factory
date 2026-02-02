import { execSync } from 'child_process';
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

const CONVEX_API = 'https://api.convex.dev/v1';
const CONVEX_TEAM_ID = process.env.CONVEX_TEAM_ID;
const CONVEX_ACCESS_TOKEN = process.env.CONVEX_ACCESS_TOKEN;


export interface ConvexProject {
  projectId: string;
  deploymentName: string;
  deploymentUrl: string;
  deployKey: string;
}

/**
 * Create a new Convex project via Management API and get a deploy key.
 */
export async function createConvexProject(appName: string): Promise<ConvexProject> {
  if (!CONVEX_TEAM_ID || !CONVEX_ACCESS_TOKEN) {
    throw new Error('Missing CONVEX_TEAM_ID or CONVEX_ACCESS_TOKEN environment variables');
  }

  const headers = {
    Authorization: `Bearer ${CONVEX_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // 1. Create the project (provisions a production deployment)
  console.log(`🔧 Creating Convex project: ${appName}...`);
  const createRes = await fetch(`${CONVEX_API}/teams/${CONVEX_TEAM_ID}/create_project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projectName: appName,
      deploymentType: 'prod',
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Failed to create Convex project: ${createRes.status} ${body}`);
  }

  const createData = await createRes.json() as { projectId: string; deploymentName: string; deploymentUrl: string };
  const { projectId, deploymentName, deploymentUrl } = createData;
  console.log(`✅ Convex project created: ${deploymentName} (${deploymentUrl})`);

  // 2. Create a deploy key for this deployment
  console.log(`🔑 Creating deploy key for ${deploymentName}...`);
  const keyRes = await fetch(`${CONVEX_API}/deployments/${deploymentName}/create_deploy_key`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `clonk-${appName}`,
    }),
  });

  if (!keyRes.ok) {
    const body = await keyRes.text();
    throw new Error(`Failed to create deploy key: ${keyRes.status} ${body}`);
  }

  const keyData = await keyRes.json() as { deployKey: string };
  const { deployKey } = keyData;
  console.log(`✅ Deploy key created`);

  return { projectId, deploymentName, deploymentUrl, deployKey };
}

/**
 * Generate an RSA256 key pair and set JWT_PRIVATE_KEY + JWKS env vars
 * on the Convex deployment. Required by @convex-dev/auth for session tokens.
 * Uses the Convex Deployment HTTP API (no CLI/shell needed).
 */
export async function configureConvexAuthKeys(deploymentUrl: string, deployKey: string): Promise<void> {
  console.log(`🔐 Generating JWT keys for Convex Auth...`);

  const keys = await generateKeyPair('RS256', { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey);
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = JSON.stringify({ keys: [{ use: 'sig', ...publicKey }] });

  // Private key: collapse newlines to spaces (Convex env vars are single-line)
  const privateKeyOneLine = privateKey.trimEnd().replace(/\n/g, ' ');

  const res = await fetch(`${deploymentUrl}/api/v1/update_environment_variables`, {
    method: 'POST',
    headers: {
      Authorization: `Convex ${deployKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      changes: [
        { name: 'JWT_PRIVATE_KEY', value: privateKeyOneLine },
        { name: 'JWKS', value: jwks },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to set JWT env vars: ${res.status} ${body}`);
  }

  console.log(`✅ JWT keys configured`);
}

/**
 * Deploy Convex functions from the build directory.
 * Pushes convex/ folder contents to the Convex cloud.
 */
export async function deployConvexBackend(buildDir: string, deployKey: string): Promise<void> {
  console.log(`📤 Deploying Convex functions from ${buildDir}...`);

  try {
    execSync(`npx convex deploy`, {
      cwd: buildDir,
      env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey },
      stdio: 'pipe',
      timeout: 120_000,
    });
    console.log(`✅ Convex functions deployed`);
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    throw new Error(`Convex deploy failed: ${stderr || stdout || err.message}`);
  }
}
