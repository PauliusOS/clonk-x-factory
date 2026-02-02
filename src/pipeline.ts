import { generateApp, generateConvexApp } from './services/claude';
import { deployToVercel, waitForDeployment } from './services/vercel';
import { createGitHubRepo } from './services/github';
import { replyToTweet, uploadMedia } from './services/xClient';
import { takeScreenshot } from './services/screenshot';
import { injectVibedBadge } from './services/badge';
import { createConvexProject, deployConvexBackend } from './services/convex';

export interface PipelineInput {
  idea: string;
  tweetId: string;
  userId: string;
  username: string;
  imageUrls?: string[];
  parentContext?: { text: string; imageUrls: string[] };
  backend?: 'convex';
}

export async function processTweetToApp(input: PipelineInput): Promise<void> {
  console.log(`\n🚀 Starting pipeline for: "${input.idea}"${input.backend ? ` (backend: ${input.backend})` : ''}\n`);

  try {
    let generatedApp;

    if (input.backend === 'convex') {
      // Convex flow: create project -> generate app -> deploy backend -> deploy frontend
      console.log('1️⃣ Creating Convex project...');
      const convex = await createConvexProject(input.idea.replace(/\s+/g, '-').toLowerCase().slice(0, 40));

      console.log('\n2️⃣ Generating Convex app code...');
      generatedApp = await generateConvexApp(
        input.idea,
        convex.deploymentUrl,
        input.imageUrls,
        input.parentContext,
        input.username,
      );

      console.log('\n3️⃣ Deploying Convex backend functions...');
      await deployConvexBackend('/tmp/app-build', convex.deployKey);
    } else {
      // Standard flow: generate static React app
      console.log('1️⃣ Generating app code...');
      generatedApp = await generateApp(input.idea, input.imageUrls, input.parentContext, input.username);
    }

    // Inject the "keep building on vibed.inc" badge into the app
    injectVibedBadge(generatedApp.files);

    // Deploy to Vercel
    const stepNum = input.backend === 'convex' ? '4️⃣' : '2️⃣';
    console.log(`\n${stepNum} Deploying to Vercel...`);
    const { url: vercelUrl, deploymentId } = await deployToVercel(
      generatedApp.appName,
      generatedApp.files
    );

    // GitHub repo + screenshot in parallel
    const stepNum2 = input.backend === 'convex' ? '5️⃣' : '3️⃣';
    console.log(`\n${stepNum2} Creating GitHub repo + waiting for deploy & taking screenshot...`);
    const [githubUrl, mediaIds] = await Promise.all([
      createGitHubRepo(
        generatedApp.appName,
        generatedApp.description,
        generatedApp.files
      ),
      (async (): Promise<string[] | undefined> => {
        try {
          await waitForDeployment(deploymentId);
          const screenshot = await takeScreenshot(vercelUrl);
          const mediaId = await uploadMedia(screenshot);
          return [mediaId];
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.warn(`⚠️ Screenshot failed (non-fatal): ${msg}`);
          return undefined;
        }
      })(),
    ]);

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
