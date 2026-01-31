import Anthropic from '@anthropic-ai/sdk';

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

export async function generateApp(idea: string): Promise<GeneratedApp> {
  console.log(`🤖 Generating app for idea: ${idea}`);

  const prompt = `You are an expert full-stack developer. Generate a complete, production-ready web application for: "${idea}"

Requirements:
- Frontend: React 18 + TypeScript + Vite
- Styling: Tailwind CSS (via CDN)
- Must be a single-page application (SPA)
- No backend/API required (client-side only)
- No external APIs or paid services
- Clean, modern UI design
- Must work immediately when deployed to Vercel
- Include responsive design

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
- Use Tailwind via CDN in index.html
- Keep it simple but polished
- All code must be valid and working`;

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 16384,
    messages: [
      {
        role: 'user',
        content: prompt,
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
