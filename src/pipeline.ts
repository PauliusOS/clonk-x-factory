import { generateApp, generateConvexApp, generateThreeJsApp } from './services/claude';
import { deployToVercel, waitForDeployment } from './services/vercel';
import { createGitHubRepo } from './services/github';
import { replyToTweet, uploadMedia } from './services/xClient';
import { takeScreenshot } from './services/screenshot';
import { injectVibedBadge } from './services/badge';
import { createConvexProject, configureConvexAuthKeys, deployConvexBackend } from './services/convex';

export interface PipelineInput {
  idea: string;
  tweetId: string;
  userId: string;
  username: string;
  imageUrls?: string[];
  parentContext?: { text: string; imageUrls: string[] };
  backend?: 'convex';
  template?: 'threejs';
}

export async function processTweetToApp(input: PipelineInput): Promise<void> {
  console.log(`\n🚀 Starting pipeline for: "${input.idea}"${input.template ? ` (template: ${input.template})` : ''}${input.backend ? ` (backend: ${input.backend})` : ''}\n`);

  try {
    let generatedApp: Awaited<ReturnType<typeof generateApp>> | undefined;

    if (input.backend === 'convex') {
      // Convex flow: create project -> generate app -> deploy backend -> deploy frontend
      console.log('1️⃣ Creating Convex project...');
      // Sanitize project name: lowercase, hyphens, no special chars
      const sanitizedName = input.idea
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 40);

      try {
        const convex = await createConvexProject(sanitizedName);

        console.log('\n2️⃣ Generating Convex app code...');
        generatedApp = await generateConvexApp(
          input.idea,
          convex.deploymentUrl,
          input.imageUrls,
          input.parentContext,
          input.username,
        );

        const buildDir = generatedApp.buildDir!;
        console.log('\n3️⃣ Configuring auth + deploying Convex backend...');
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
      generatedApp = await generateThreeJsApp(input.idea, input.imageUrls, input.parentContext, input.username);
    }

    if (!input.backend && !generatedApp) {
      // Standard flow: generate static React app
      console.log('1️⃣ Generating app code...');
      generatedApp = await generateApp(input.idea, input.imageUrls, input.parentContext, input.username);
    }

    // Inject the "keep building on vibed.inc" badge into the app
    injectVibedBadge(generatedApp!.files);

    // Deploy to Vercel
    const stepNum = input.backend === 'convex' ? '4️⃣' : '2️⃣';
    console.log(`\n${stepNum} Deploying to Vercel...`);
    const { url: vercelUrl, deploymentId } = await deployToVercel(
      generatedApp!.appName,
      generatedApp!.files
    );

    // GitHub repo + wait for deploy in parallel
    const stepNum2 = input.backend === 'convex' ? '5️⃣' : '3️⃣';
    console.log(`\n${stepNum2} Creating GitHub repo + waiting for deploy...`);
    const [githubUrl] = await Promise.all([
      createGitHubRepo(
        generatedApp!.appName,
        generatedApp!.description,
        generatedApp!.files
      ),
      waitForDeployment(deploymentId),
    ]);

    // Screenshot (non-fatal — don't block the reply if this fails)
    let mediaIds: string[] | undefined;
    try {
      const screenshot = await takeScreenshot(vercelUrl);
      const mediaId = await uploadMedia(screenshot);
      mediaIds = [mediaId];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`⚠️ Screenshot failed (non-fatal): ${msg}`);
    }

    // Reply with links + optional screenshot
    const stepNum3 = input.backend === 'convex' ? '6️⃣' : '4️⃣';
    console.log(`\n${stepNum3} Replying to tweet...`);
    const backendNote = input.backend === 'convex' ? '\n⚡ Powered by Convex (real-time backend)' : '';
    const replyText = `✅ App live: ${vercelUrl}${backendNote}\n- Continue this in the @getkomand Mac app\n📝 Contribute: ${githubUrl}\n\nFork it, improve it, ship it together 🚀`;

    await replyToTweet(input.tweetId, replyText, mediaIds);

    console.log(`\n✅ Pipeline completed successfully!\n`);
  } catch (error: unknown) {
    // Log safely — never dump full axios errors (they contain auth headers)
    const err = error as Record<string, any>;
    const safeMessage = err.response
      ? `${err.response.status} ${err.response.statusText || ''} - ${err.config?.url || 'unknown URL'}`
      : err.message || 'Unknown error';
    console.error(`❌ Pipeline failed: ${safeMessage}`);

    // Try to reply with error message
    try {
      await replyToTweet(
        input.tweetId,
        `Sorry, I couldn't build that app right now. Please try again later! 🔧`
      );
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
