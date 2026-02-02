import { execSync } from 'child_process';

const CONVEX_API = 'https://api.convex.dev/v1';
const CONVEX_TEAM_ID = process.env.CONVEX_TEAM_ID;
const CONVEX_ACCESS_TOKEN = process.env.CONVEX_ACCESS_TOKEN;
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID;
const WORKOS_API_KEY = process.env.WORKOS_API_KEY;

export interface ConvexProject {
  projectId: string;
  deploymentName: string;
  deploymentUrl: string;
  deployKey: string;
}

/**
 * Create a new Convex project via Management API, get a deploy key,
 * and configure WorkOS environment variables on the deployment.
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
 * Set WorkOS environment variables on a Convex deployment.
 * Must be run from a directory that has `convex` in package.json
 * (the Convex CLI requires it to be a project dependency).
 */
export function configureConvexAuthEnvVars(buildDir: string, deployKey: string): void {
  if (!WORKOS_CLIENT_ID || !WORKOS_API_KEY) {
    console.warn(`⚠️ WORKOS_CLIENT_ID or WORKOS_API_KEY not set — AuthKit will not work`);
    return;
  }

  console.log(`🔐 Configuring WorkOS AuthKit env vars...`);
  setConvexEnvVar(buildDir, deployKey, 'AUTH_WORKOS_CLIENT_ID', WORKOS_CLIENT_ID);
  setConvexEnvVar(buildDir, deployKey, 'AUTH_WORKOS_API_KEY', WORKOS_API_KEY);
  console.log(`✅ WorkOS env vars configured`);
}

/**
 * Set an environment variable on a Convex deployment via CLI.
 * Runs from buildDir which has convex as a package.json dependency.
 */
function setConvexEnvVar(buildDir: string, deployKey: string, name: string, value: string): void {
  execSync(`npx convex env set ${name} "${value}"`, {
    cwd: buildDir,
    env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey },
    stdio: 'pipe',
    timeout: 30_000,
  });
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
