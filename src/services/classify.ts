import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const CLASSIFICATION_MODEL = 'claude-haiku-4-5-20250929';

const SYSTEM_PROMPT = `You are a tweet intent classifier for a bot that builds web apps on request.

Your job: determine if the user is REQUESTING that an app, website, or tool be built — or if they are just praising, commenting, asking a question, or talking about the bot in general.

Respond with ONLY "YES" or "NO".

YES = the tweet (and/or its parent tweet) contains a genuine request to build/make/create an app, website, tool, or project.
NO = the tweet is praise, commentary, a question about the bot, or anything that is NOT a build request.

Examples:
- "@clonkbot build me a pomodoro timer" → YES
- "@clonkbot create a weather app with dark mode" → YES
- "@clonkbot make a todo list" → YES
- "@clonkbot you guys build amazing stuff!" → NO
- "@clonkbot just saw you build that app, wow" → NO
- "@clonkbot can you really build apps?" → NO
- "@clonkbot this is so cool, great build!" → NO
- "@clonkbot make sure to check this out" → NO`;

export async function classifyTweet(
  tweetText: string,
  parentText?: string,
): Promise<boolean> {
  const contextParts: string[] = [];

  if (parentText) {
    contextParts.push(`Parent tweet: "${parentText}"`);
  }
  contextParts.push(`Tweet: "${tweetText}"`);
  contextParts.push(
    '\nIs this a genuine request to build an app/website/tool? Answer YES or NO.',
  );

  const userMessage = contextParts.join('\n');

  console.log(
    `🤖 Classifying tweet: "${tweetText}"${parentText ? ` (parent: "${parentText.substring(0, 60)}...")` : ''}`,
  );

  try {
    const response = await client.messages.create({
      model: CLASSIFICATION_MODEL,
      max_tokens: 16,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const answer =
      response.content[0].type === 'text'
        ? response.content[0].text.trim().toUpperCase()
        : '';

    const isBuildRequest = answer.startsWith('YES');

    console.log(
      `🤖 Classification result: ${answer} (model: ${CLASSIFICATION_MODEL})`,
    );

    return isBuildRequest;
  } catch (error: any) {
    console.error(
      `❌ Classification failed: ${error.message || error}. Defaulting to YES to avoid missing real requests.`,
    );
    return true;
  }
}
