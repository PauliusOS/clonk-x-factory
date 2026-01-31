import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface GeneratedApp {
  files: {
    path: string;
    content: string;
  }[];
  appName: string;
  description: string;
}

export async function generateApp(
  idea: string,
  imageUrls?: string[],
  parentContext?: { text: string; imageUrls: string[] },
  username?: string,
): Promise<GeneratedApp> {
  console.log(`🤖 Generating app for idea: ${idea}${imageUrls?.length ? ` (with ${imageUrls.length} image(s))` : ''}${parentContext ? ' (with parent tweet context)' : ''}`);

  const prompt = `You are an expert full-stack developer. Generate a complete, production-ready web application for: "${idea}"

Requirements:
- Frontend: React 18 + TypeScript + Vite
- Styling: Tailwind CSS (via CDN in index.html)
- Must be a single-page application (SPA)
- No backend/API required (client-side only)
- No external APIs or paid services
- Clean, modern UI design
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

Return ONLY a JSON object with this exact structure:
{
  "appName": "short-kebab-case-name",
  "description": "One sentence description",
  "files": [
    {
      "path": "index.html",
      "content": "..."
    },
    {
      "path": "package.json",
      "content": "..."
    },
    {
      "path": "src/main.tsx",
      "content": "..."
    },
    {
      "path": "src/App.tsx",
      "content": "..."
    },
    {
      "path": "tsconfig.json",
      "content": "..."
    },
    {
      "path": "vite.config.ts",
      "content": "..."
    }
  ]
}

Important:
- Make the app fully functional
- All code must be valid and build successfully
- Keep it simple but polished
- Include a small footer at the bottom of the page that says "Requested by @${username || 'unknown'} · Built by @clonkbot" — style it subtly (muted text, small font size)`;

  // Build message content: parent context first, then reply images, then prompt
  const contentBlocks: ContentBlockParam[] = [];

  // Include parent tweet context if this mention was a reply
  if (parentContext) {
    contentBlocks.push({
      type: 'text',
      text: `The user replied to the following tweet with their build request. Use this original post as the primary context for what to build:\n\n"${parentContext.text}"`,
    });
    for (const url of parentContext.imageUrls) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'url', url },
      });
    }
    if (parentContext.imageUrls.length) {
      contentBlocks.push({
        type: 'text',
        text: 'The above image(s) were attached to the original post. Use them as visual reference for the app design.',
      });
    }
  }

  if (imageUrls?.length) {
    for (const url of imageUrls) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'url', url },
      });
    }
    // Add context about the images
    contentBlocks.push({
      type: 'text',
      text: 'The above image(s) were attached to the tweet. Use them as visual reference for the app design — they may be wireframes, mockups, screenshots, or inspiration images. Try to match the layout, colors, and style shown.',
    });
  }

  contentBlocks.push({ type: 'text', text: prompt });

  const response = await client.messages.create({
    model: 'claude-opus-4-5-20251101',
    max_tokens: 16384,
    messages: [
      {
        role: 'user',
        content: contentBlocks,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  // Extract JSON from response using brace-counting for accuracy
  const text = content.text;
  const startIdx = text.indexOf('{');
  if (startIdx === -1) {
    throw new Error('Failed to extract JSON from Claude response');
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    if (depth === 0) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    throw new Error('Failed to extract complete JSON from Claude response');
  }

  const generatedApp = JSON.parse(text.substring(startIdx, endIdx + 1)) as GeneratedApp;

  console.log(`✅ Generated ${generatedApp.files.length} files for ${generatedApp.appName}`);

  return generatedApp;
}
