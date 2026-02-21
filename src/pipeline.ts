import { generateApp, generateConvexApp, generateThreeJsApp } from './services/claude';
import { deployToVercel, waitForDeployment } from './services/vercel';
import { createGitHubRepo } from './services/github';
import { takeScreenshot } from './services/screenshot';
import { injectVibedBadge } from './services/badge';
import { createConvexProject, configureConvexAuthKeys, deployConvexBackend } from './services/convex';
import { publishToClonkSite } from './services/clonkSite';

export interface PipelineInput {
  idea: string;
  messageId: string;
  userId: string;
  username: string;
  source: 'x' | 'telegram';
  imageUrls?: string[];
  /** Pre-downloaded image buffers (e.g. from Telegram where URLs are blocked by robots.txt) */
  imageBuffers?: { data: Buffer; mediaType: string }[];
  parentContext?: { text: string; imageUrls: string[] };
  backend?: 'convex';
  template?: 'threejs';
  /** Channel-specific reply function — injected by the caller */
  reply: (text: string, screenshotBuffer?: Buffer) => Promise<void>;
  /** Optional progress callback — called at each pipeline stage (e.g. for Telegram live updates) */
  onProgress?: (stage: string) => void;
}

export async function processMentionToApp(input: PipelineInput): Promise<void> {
  console.log(`\n🚀 Starting pipeline for: "${input.idea}"${input.template ? ` (template: ${input.template})` : ''}${input.backend ? ` (backend: ${input.backend})` : ''}\n`);

  const progress = input.onProgress || (() => {});

  try {
    let generatedApp: Awaited<ReturnType<typeof generateApp>> | undefined;

    if (input.backend === 'convex') {
      // Convex flow: create project -> generate app -> deploy backend -> deploy frontend
      console.log('1️⃣ Creating Convex project...');
      progress('🔧 setting up Convex backend...');
      // Sanitize project name: lowercase, hyphens, no special chars
      const sanitizedName = input.idea
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 40);

      try {
        const convex = await createConvexProject(sanitizedName);

        console.log('\n2️⃣ Generating Convex app code...');
        progress('🧠 generating code with Claude...');
        generatedApp = await generateConvexApp(
          input.idea,
          convex.deploymentUrl,
          input.imageUrls,
          input.parentContext,
          input.username,
          input.template === 'threejs', // Pass 3D flag so Claude adds Three.js
          input.imageBuffers,
        );

        const buildDir = generatedApp.buildDir!;
        console.log('\n3️⃣ Configuring auth + deploying Convex backend...');
        progress('⚡ deploying Convex backend...');
        await configureConvexAuthKeys(convex.deploymentUrl, convex.deployKey);
        await deployConvexBackend(buildDir, convex.deployKey);
      } catch (convexError: unknown) {
        const msg = convexError instanceof Error ? convexError.message : String(convexError);
        const isQuota = msg.includes('ProjectQuotaReached') || msg.includes('project quota');
        if (isQuota) {
          console.warn('⚠️ Convex project quota reached — falling back to static build');
          input.backend = undefined;
        } else {
          throw convexError;
        }
      }
    }

    if (!generatedApp && input.template === 'threejs') {
      // Three.js flow: generate 3D React app (static, no backend)
      console.log('1️⃣ Generating Three.js 3D app code...');
      progress('🧠 generating 3D app with Claude...');
      generatedApp = await generateThreeJsApp(input.idea, input.imageUrls, input.parentContext, input.username, input.imageBuffers);
    }

    if (!input.backend && !generatedApp) {
      // Standard flow: generate static React app
      console.log('1️⃣ Generating app code...');
      progress('🧠 generating code with Claude...');
      generatedApp = await generateApp(input.idea, input.imageUrls, input.parentContext, input.username, input.imageBuffers);
    }

    // Inject the "keep building on vibed.inc" badge into the app
    injectVibedBadge(generatedApp!.files);

    // Deploy to Vercel
    const stepNum = input.backend === 'convex' ? '4️⃣' : '2️⃣';
    console.log(`\n${stepNum} Deploying to Vercel...`);
    progress('🚀 deploying to Vercel...');
    const { url: vercelUrl, deploymentId } = await deployToVercel(
      generatedApp!.appName,
      generatedApp!.files
    );

    // GitHub repo + wait for deploy in parallel
    const stepNum2 = input.backend === 'convex' ? '5️⃣' : '3️⃣';
    console.log(`\n${stepNum2} Creating GitHub repo + waiting for deploy...`);
    progress('📦 creating GitHub repo + waiting for deploy...');
    const [githubUrl] = await Promise.all([
      createGitHubRepo(
        generatedApp!.appName,
        generatedApp!.description,
        generatedApp!.files
      ),
      waitForDeployment(deploymentId),
    ]);

    // Screenshot (non-fatal — don't block the reply if this fails)
    progress('📸 taking a screenshot...');
    let screenshotBuffer: Buffer | undefined;
    try {
      screenshotBuffer = await takeScreenshot(vercelUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`⚠️ Screenshot failed (non-fatal): ${msg}`);
    }

    // Publish to clonk.ai gallery (non-fatal)
    progress('🌐 publishing to clonk.ai...');
    let clonkPageUrl: string | null = null;
    try {
      clonkPageUrl = await publishToClonkSite({
        appName: generatedApp!.appName,
        description: generatedApp!.description,
        vercelUrl,
        githubUrl,
        username: input.username,
        template: input.template === 'threejs' ? 'threejs' : (input.backend === 'convex' ? 'convex' : 'react'),
        screenshot: screenshotBuffer,
      });
      if (clonkPageUrl) {
        console.log(`🌐 Published to clonk.ai: ${clonkPageUrl}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`⚠️ Clonk site publish failed (non-fatal): ${msg}`);
    }

    // Reply with links + optional screenshot (via channel-specific reply function)
    const stepNum3 = input.backend === 'convex' ? '6️⃣' : '4️⃣';
    console.log(`\n${stepNum3} Replying (${input.source})...`);
    progress('✅ almost done! sending your app...');
    const backendNote = input.backend === 'convex' ? '\n⚡ Powered by Convex (real-time backend)' : '';
    const clonkLink = clonkPageUrl ? `\n🌐 ${clonkPageUrl}` : '';

    const replyText = `✅ App live: ${vercelUrl}${backendNote}${clonkLink}\n📝 Contribute: ${githubUrl}`;

    await input.reply(replyText, screenshotBuffer);

    console.log(`\n✅ Pipeline completed successfully!\n`);
  } catch (error: unknown) {
    // Log safely — never dump full axios errors (they contain auth headers)
    const err = error as Record<string, any>;
    const safeMessage = err.response
      ? `${err.response.status} ${err.response.statusText || ''} - ${err.config?.url || 'unknown URL'}`
      : err.message || 'Unknown error';
    console.error(`❌ Pipeline failed: ${safeMessage}`);

    // Try to reply with error message via the channel-specific reply function
    try {
      await input.reply(`Sorry, I couldn't build that app right now. Please try again later! 🔧`);
    } catch (replyError: unknown) {
      const rErr = replyError as Record<string, any>;
      const safeReplyMsg = rErr.response
        ? `${rErr.response.status} - ${rErr.config?.url || ''}`
        : rErr.message || 'Unknown error';
      console.error(`Failed to send error reply: ${safeReplyMsg}`);
    }

    throw new Error(safeMessage);
  }
}
