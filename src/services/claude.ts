import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';

export interface GeneratedApp {
  files: {
    path: string;
    content: string;
  }[];
  appName: string;
  description: string;
}

const SYSTEM_PROMPT = `You are an expert full-stack developer. Generate a complete, production-ready web application based on the user's request.

Requirements:
- Frontend: React 18 + TypeScript + Vite
- Styling: Tailwind CSS (via CDN in index.html)
- Must be a single-page application (SPA)
- No backend/API required (client-side only)
- No external APIs or paid services
- Must work immediately when deployed to Vercel with "npm run build"
- Include responsive design

CRITICAL rules for generated config files:
- tsconfig.json must NOT reference any other tsconfig files (no "references", no "extends" pointing to tsconfig.node.json)
- tsconfig.json should be a single self-contained config
- tsconfig.json MUST include "noUnusedLocals": false and "noUnusedParameters": false (otherwise builds fail)
- vite.config.ts should use a simple setup with just the react plugin
- package.json must include all dependencies needed (react, react-dom, @types/react, @types/react-dom, typescript, vite, @vitejs/plugin-react)
- package.json "build" script must be "tsc && vite build"
- All generated code must have zero TypeScript errors — do not declare variables you don't use

BUILD VERIFICATION — you MUST do this before returning your final answer:
1. Write all project files to /tmp/app-build/
2. Run: cd /tmp/app-build && npm install && npm run build
3. If the build fails, read the error output, fix the code, and retry until it passes
4. Only return your final structured output AFTER the build succeeds
5. Clean up: rm -rf /tmp/app-build

Important:
- Make the app fully functional
- All code must be valid and build successfully
- Keep it simple but polished`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    appName: { type: 'string', description: 'Short kebab-case name for the app' },
    description: { type: 'string', description: 'One sentence description' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
      description: 'All project files including index.html, package.json, src/main.tsx, src/App.tsx, tsconfig.json, vite.config.ts',
    },
  },
  required: ['appName', 'description', 'files'],
};

export async function generateApp(
  idea: string,
  imageUrls?: string[],
  parentContext?: { text: string; imageUrls: string[] },
  username?: string,
): Promise<GeneratedApp> {
  console.log(`🤖 Generating app for idea: ${idea}${imageUrls?.length ? ` (with ${imageUrls.length} image(s))` : ''}${parentContext ? ' (with parent tweet context)' : ''}`);

  // Build the user prompt parts
  const promptParts: string[] = [];

  if (parentContext) {
    promptParts.push(`The user replied to the following tweet with their build request. Use this original post as the primary context for what to build:\n\n"${parentContext.text}"`);
  }

  promptParts.push(`Build a web app for: "${idea}"`);

  const footer = `Requested by @${username || 'unknown'} · Built by @clonkbot`;
  promptParts.push(`Include a small footer at the bottom of the page that says "${footer}" — style it subtly (muted text, small font size).`);

  promptParts.push('Use /frontend-design to make it visually stunning and distinctive.');

  const textPrompt = promptParts.join('\n\n');

  // Build content blocks for images + text
  const hasImages = (imageUrls?.length ?? 0) > 0 || (parentContext?.imageUrls.length ?? 0) > 0;

  let prompt: string | AsyncIterable<any>;

  if (hasImages) {
    const contentBlocks: any[] = [];

    if (parentContext?.imageUrls.length) {
      for (const url of parentContext.imageUrls) {
        contentBlocks.push({ type: 'image', source: { type: 'url', url } });
      }
      contentBlocks.push({
        type: 'text',
        text: 'The above image(s) were attached to the original post. Use them as visual reference for the app design.',
      });
    }

    if (imageUrls?.length) {
      for (const url of imageUrls) {
        contentBlocks.push({ type: 'image', source: { type: 'url', url } });
      }
      contentBlocks.push({
        type: 'text',
        text: 'The above image(s) were attached to the tweet. Use them as visual reference — they may be wireframes, mockups, screenshots, or inspiration images. Try to match the layout, colors, and style shown.',
      });
    }

    contentBlocks.push({ type: 'text', text: textPrompt });

    async function* generateMessages() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: contentBlocks },
      };
    }
    prompt = generateMessages();
  } else {
    prompt = textPrompt;
  }

  let result: SDKResultSuccess | null = null;
  let lastError: string | null = null;

  for await (const message of query({
    prompt,
    options: {
      model: 'claude-opus-4-5-20251101',
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      settingSources: ['project'],
      tools: ['Skill', 'Bash', 'Write', 'Read', 'Edit'],
      allowedTools: ['Skill', 'Bash', 'Write', 'Read', 'Edit'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      maxTurns: 15,
      systemPrompt: SYSTEM_PROMPT,
      outputFormat: {
        type: 'json_schema',
        schema: OUTPUT_SCHEMA,
      },
      stderr: (data: string) => {
        console.error(`[claude-code stderr] ${data}`);
      },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        result = message as SDKResultSuccess;
      } else {
        const errMsg = message as any;
        lastError = errMsg.errors?.join(', ') || errMsg.subtype || 'unknown';
        console.error(`❌ Agent SDK result error: ${lastError}`);
      }
    }
  }

  if (!result?.structured_output) {
    throw new Error(`Failed to get structured output from Claude: ${lastError || 'unknown error'}`);
  }

  const generatedApp = result.structured_output as GeneratedApp;

  console.log(`✅ Generated ${generatedApp.files.length} files for ${generatedApp.appName}`);

  return generatedApp;
}
