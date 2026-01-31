import { generateApp } from './services/claude';
import { deployToVercel, waitForDeployment } from './services/vercel';
import { createGitHubRepo } from './services/github';
import { replyToTweet, uploadMedia } from './services/xClient';
import { takeScreenshot } from './services/screenshot';

export interface PipelineInput {
  idea: string;
  tweetId: string;
  userId: string;
  imageUrls?: string[];
  parentContext?: { text: string; imageUrls: string[] };
}

export async function processTweetToApp(input: PipelineInput): Promise<void> {
  console.log(`\n🚀 Starting pipeline for: "${input.idea}"\n`);

  try {
    // Step 1: Generate app code with Claude
    console.log('1️⃣ Generating app code...');
    const generatedApp = await generateApp(input.idea, input.imageUrls, input.parentContext);

    // Step 2: Deploy to Vercel
    console.log('\n2️⃣ Deploying to Vercel...');
    const { url: vercelUrl, deploymentId } = await deployToVercel(
      generatedApp.appName,
      generatedApp.files
    );

    // Step 3: GitHub repo + screenshot in parallel
    // GitHub doesn't need deployment to be ready, screenshot does
    console.log('\n3️⃣ Creating GitHub repo + waiting for deploy & taking screenshot...');
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

    // Step 4: Reply with links + optional screenshot
    console.log('\n4️⃣ Replying to tweet...');
    const replyText = `✅ App live: ${vercelUrl}\n📝 Contribute: ${githubUrl}\n\nFork it, improve it, ship it together 🚀`;

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
