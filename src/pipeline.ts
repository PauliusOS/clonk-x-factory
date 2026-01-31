import { generateApp } from './services/claude';
import { deployToVercel } from './services/vercel';
import { createGitHubRepo } from './services/github';
import { replyToTweet } from './services/xClient';

export interface PipelineInput {
  idea: string;
  tweetId: string;
  userId: string;
}

export async function processTweetToApp(input: PipelineInput): Promise<void> {
  console.log(`\n🚀 Starting pipeline for: "${input.idea}"\n`);

  try {
    // Step 1: Generate app code with Claude
    console.log('1️⃣ Generating app code...');
    const generatedApp = await generateApp(input.idea);

    // Step 2: Deploy to Vercel
    console.log('\n2️⃣ Deploying to Vercel...');
    const vercelUrl = await deployToVercel(generatedApp.appName, generatedApp.files);

    // Step 3: Create GitHub repo
    console.log('\n3️⃣ Creating GitHub repo...');
    const githubUrl = await createGitHubRepo(
      generatedApp.appName,
      generatedApp.description,
      generatedApp.files
    );

    // Step 4: Reply with links
    console.log('\n4️⃣ Replying to tweet...');
    const replyText = `✅ App live: ${vercelUrl}\n📝 Contribute: ${githubUrl}\n\nFork it, improve it, ship it together 🚀`;

    await replyToTweet(input.tweetId, replyText);

    console.log(`\n✅ Pipeline completed successfully!\n`);
  } catch (error: any) {
    // Log safely — never dump full axios errors (they contain auth headers)
    const safeMessage = error.response
      ? `${error.response.status} ${error.response.statusText || ''} - ${error.config?.url || 'unknown URL'}`
      : error.message || 'Unknown error';
    console.error(`❌ Pipeline failed: ${safeMessage}`);

    // Try to reply with error message
    try {
      await replyToTweet(
        input.tweetId,
        `Sorry, I couldn't build that app right now. Please try again later! 🔧`
      );
    } catch (replyError: any) {
      const safeReplyMsg = replyError.response
        ? `${replyError.response.status} - ${replyError.config?.url || ''}`
        : replyError.message || 'Unknown error';
      console.error(`Failed to send error reply: ${safeReplyMsg}`);
    }

    throw new Error(safeMessage);
  }
}
