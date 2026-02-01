import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';

export interface GeneratedApp {
  files: {
    path: string;
    content: string;
  }[];
  appName: string;
  description: string;
}

// Raw output from Claude — only creative files + metadata
interface RawGeneratedApp {
  appName: string;
  description: string;
  title: string;
  fonts: string[];
  extraDependencies?: Record<string, string>;
  files: {
    path: string;
    content: string;
  }[];
}

const TEMPLATE_DIR = path.join(process.cwd(), 'templates', 'react-vite');
const BUILD_DIR = '/tmp/app-build';

const SYSTEM_PROMPT = `You are an expert frontend developer. Generate ONLY the creative source files for a web application based on the user's request.

Infrastructure files (package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx) are pre-staged at /tmp/app-build/ — do NOT recreate them.

The stack is React 18 + TypeScript + Vite + Tailwind CSS (via CDN). You control the visual identity through:
- Font choices (specify Google Font stylesheet URLs in the "fonts" array)
- src/App.tsx — the main application component (REQUIRED)
- src/components/* — any additional components you need
- Any .css files if needed beyond Tailwind

If you need npm packages beyond react/react-dom (e.g. framer-motion, three, recharts, lucide-react), list them in "extraDependencies" as { "package-name": "^version" }. You MUST also install them into /tmp/app-build/ before building (e.g. cd /tmp/app-build && npm install framer-motion).

Requirements:
- Client-side only SPA, no backend/API calls, no external paid services
- Responsive design
- All TypeScript must compile cleanly — no unused variables, no type errors
- Make it fully functional and polished

BUILD VERIFICATION — you MUST do this before returning your final answer:
1. Write your creative source files to /tmp/app-build/src/ using Bash (the template files are already there).
2. Run: cd /tmp/app-build && npm install 2>&1 && npm run build 2>&1
3. If the build fails, fix the errors and retry (max 2 retries).
4. Only return your final structured output AFTER the build succeeds.
5. Clean up: rm -rf /tmp/app-build
Be efficient — combine file writes into single Bash commands using heredocs.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    appName: { type: 'string', description: 'Short kebab-case name for the app' },
    description: { type: 'string', description: 'One sentence description' },
    title: { type: 'string', description: 'Human-readable page title for the browser tab' },
    fonts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Google Fonts stylesheet URLs to load, e.g. "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap"',
    },
    extraDependencies: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Additional npm dependencies beyond react/react-dom, e.g. { "framer-motion": "^11.0.0" }. Only include if actually needed.',
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root (e.g. src/App.tsx, src/components/Header.tsx)' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
      description: 'ONLY creative source files: src/App.tsx (required), src/components/*, src/*.css. Do NOT include package.json, tsconfig.json, vite.config.ts, index.html, or src/main.tsx.',
    },
  },
  required: ['appName', 'description', 'title', 'fonts', 'files'],
};

// ---------------------------------------------------------------------------
// Template staging & merge
// ---------------------------------------------------------------------------

function readTemplateFiles(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  function walk(dir: string, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else {
        files.push({ path: relativePath, content: fs.readFileSync(fullPath, 'utf-8') });
      }
    }
  }

  walk(TEMPLATE_DIR);
  return files;
}

/**
 * Pre-stage template files to /tmp/app-build/ so Claude only needs to write creative files.
 * index.html is staged without fonts (fonts don't affect build, they're runtime-only).
 */
function stageTemplateToBuildDir(): void {
  // Clean up any previous build
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  const templateFiles = readTemplateFiles();
  for (const file of templateFiles) {
    let targetPath: string;
    let content = file.content;

    if (file.path === 'index.html.template') {
      // Stage as index.html with placeholder fonts stripped (build doesn't need them)
      targetPath = path.join(BUILD_DIR, 'index.html');
      content = content.replace('{{TITLE}}', 'App').replace('{{FONTS}}', '');
    } else {
      targetPath = path.join(BUILD_DIR, file.path);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }
}

/**
 * Merge template files with Claude's creative output for deployment.
 * Processes index.html template with fonts/title, merges extra deps into package.json.
 */
function mergeWithTemplate(raw: RawGeneratedApp): GeneratedApp {
  const templateFiles = readTemplateFiles();
  const mergedFiles: { path: string; content: string }[] = [];

  for (const tmpl of templateFiles) {
    if (tmpl.path === 'index.html.template') {
      const fontLinks = (raw.fonts || [])
        .map((url) => `    <link rel="stylesheet" href="${url}">`)
        .join('\n');
      const content = tmpl.content
        .replace('{{TITLE}}', raw.title || raw.appName)
        .replace('{{FONTS}}', fontLinks);
      mergedFiles.push({ path: 'index.html', content });
    } else if (tmpl.path === 'package.json' && raw.extraDependencies && Object.keys(raw.extraDependencies).length > 0) {
      const pkg = JSON.parse(tmpl.content);
      pkg.dependencies = { ...pkg.dependencies, ...raw.extraDependencies };
      mergedFiles.push({ path: 'package.json', content: JSON.stringify(pkg, null, 2) });
    } else {
      mergedFiles.push(tmpl);
    }
  }

  // Dedup: skip creative files that collide with template paths
  const templatePaths = new Set(mergedFiles.map((f) => f.path));
  for (const file of raw.files) {
    if (!templatePaths.has(file.path)) {
      mergedFiles.push(file);
    }
  }

  return {
    appName: raw.appName,
    description: raw.description,
    files: mergedFiles,
  };
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

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

  // Pre-stage template files so Claude only writes creative src/ files
  console.log('📋 Staging template files to /tmp/app-build/...');
  stageTemplateToBuildDir();

  // Generate creative files with Claude (Bash for build verification)
  let result: SDKResultSuccess | null = null;
  let lastError: string | null = null;

  for await (const message of query({
    prompt,
    options: {
      model: 'claude-opus-4-5-20251101',
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      settingSources: ['project'],
      tools: ['Skill', 'Bash'],
      allowedTools: ['Skill', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      maxTurns: 20,
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

  const rawApp = result.structured_output as RawGeneratedApp;
  console.log(`🎨 Claude generated ${rawApp.files.length} creative files for "${rawApp.appName}"`);

  // Merge with template (adds fonts to index.html, extra deps to package.json)
  const mergedApp = mergeWithTemplate(rawApp);
  console.log(`📦 Merged to ${mergedApp.files.length} total files (template + creative)`);

  return mergedApp;
}
