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

export type TemplateName = 'react-vite' | 'convex-react-vite';

const TEMPLATES_ROOT = path.join(process.cwd(), 'templates');
const BUILD_DIR = '/tmp/app-build';

// Load all skills from .claude/skills/ at startup and embed in system prompt.
// This serves as both the primary delivery mechanism and a fallback if the SDK's
// native Skill tool has issues. Skills stay in .claude/skills/ as source of truth.
function loadSkill(skillName: string): string {
  const skillFile = path.join(process.cwd(), '.claude', 'skills', skillName, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return '';
  return fs.readFileSync(skillFile, 'utf-8').replace(/^---[\s\S]*?---\n*/m, '').trim();
}

const FRONTEND_SKILL = loadSkill('frontend-design');
const CONVEX_SKILL = loadSkill('convex-backend');

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
1. Write your creative source files to /tmp/app-build/src/ using the Write tool (the template files are already there). Do NOT use Bash heredocs — JS code with brackets causes shell substitution errors.
2. If you specified extraDependencies, install them: cd /tmp/app-build && npm install <pkg1> <pkg2> 2>&1
3. Run: cd /tmp/app-build && npm install 2>&1 && npm run build 2>&1
4. If the build fails, fix the errors and retry (max 2 retries).
5. Only return your final structured output AFTER the build succeeds.
6. Clean up: rm -rf /tmp/app-build

## Design Guidelines

${FRONTEND_SKILL}`;

const CONVEX_SYSTEM_PROMPT = `You are an expert full-stack developer. Generate the creative source files AND Convex backend functions for a web application based on the user's request.

Infrastructure files are pre-staged at /tmp/app-build/ — do NOT recreate them. Specifically do NOT create:
- package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx
- convex/auth.ts, convex/auth.config.ts, convex/tsconfig.json

The stack is React 18 + TypeScript + Vite + Tailwind CSS (via CDN) + Convex (real-time backend) + WorkOS AuthKit (authentication).

You generate TWO categories of files:

**Frontend (src/):**
- src/App.tsx — the main application component (REQUIRED)
- src/components/* — additional React components
- Any .css files if needed beyond Tailwind

**Backend (convex/):**
- convex/schema.ts — database schema (REQUIRED)
- convex/*.ts — server functions (queries, mutations, actions)

The ConvexAuthProvider is already set up in src/main.tsx. Use these imports in your React components:
- \`import { useQuery, useMutation, useAction } from "convex/react"\`
- \`import { useConvexAuth } from "convex/react"\`
- \`import { useAuthActions } from "@convex-dev/auth/react"\`
- \`import { api } from "../convex/_generated/api"\`

If you need npm packages beyond what's in the template (e.g. framer-motion, lucide-react), list them in "extraDependencies" and install them: cd /tmp/app-build && npm install <pkg>.

Requirements:
- Full-stack app with real-time Convex backend
- Include authentication (sign in/out buttons using WorkOS AuthKit)
- Responsive design
- All TypeScript must compile cleanly
- Make it fully functional and polished

BUILD VERIFICATION — you MUST do this before returning your final answer:
1. Write your files to /tmp/app-build/src/ and /tmp/app-build/convex/ using the Write tool. Do NOT use Bash heredocs.
2. If you specified extraDependencies, install them: cd /tmp/app-build && npm install <pkg1> <pkg2> 2>&1
3. Run: cd /tmp/app-build && npm install 2>&1 && npm run build 2>&1
4. If the build fails, fix the errors and retry (max 2 retries).
5. Only return your final structured output AFTER the build succeeds.
6. Do NOT clean up /tmp/app-build — the pipeline needs it to deploy Convex functions.

## Convex Backend Guidelines

${CONVEX_SKILL}

## Design Guidelines

${FRONTEND_SKILL}`;

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
      description: 'Additional npm dependencies beyond what the template provides. Only include if actually needed.',
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root (e.g. src/App.tsx, src/components/Header.tsx, convex/schema.ts)' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
      description: 'ONLY creative source files. Do NOT include infrastructure files that are pre-staged in the template.',
    },
  },
  required: ['appName', 'description', 'title', 'fonts', 'files'],
};

// ---------------------------------------------------------------------------
// Template staging & merge
// ---------------------------------------------------------------------------

function getTemplateDir(template: TemplateName): string {
  return path.join(TEMPLATES_ROOT, template);
}

function readTemplateFiles(template: TemplateName): { path: string; content: string }[] {
  const templateDir = getTemplateDir(template);
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

  walk(templateDir);
  return files;
}

/**
 * Pre-stage template files to /tmp/app-build/ so Claude only needs to write creative files.
 * index.html is staged without fonts (fonts don't affect build, they're runtime-only).
 * For Convex templates, also writes .env.local with VITE_CONVEX_URL.
 */
function stageTemplateToBuildDir(template: TemplateName, convexUrl?: string): void {
  // Clean up any previous build
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  const templateFiles = readTemplateFiles(template);
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

  // For Convex templates, write .env.local so the frontend build can resolve VITE_CONVEX_URL
  if (template === 'convex-react-vite' && convexUrl) {
    fs.writeFileSync(path.join(BUILD_DIR, '.env.local'), `VITE_CONVEX_URL=${convexUrl}\n`);
  }
}

/**
 * Merge template files with Claude's creative output for deployment.
 * Processes index.html template with fonts/title, merges extra deps into package.json.
 * For Convex templates, also injects VITE_CONVEX_URL into .env.local.
 */
function mergeWithTemplate(raw: RawGeneratedApp, template: TemplateName, convexUrl?: string): GeneratedApp {
  const templateFiles = readTemplateFiles(template);
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

  // For Convex templates, add .env.local with the deployment URL
  if (template === 'convex-react-vite' && convexUrl) {
    mergedFiles.push({ path: '.env.local', content: `VITE_CONVEX_URL=${convexUrl}\n` });
  }

  // Dedup: if Claude rewrites a template file, keep Claude's version
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
// Shared query runner
// ---------------------------------------------------------------------------

async function runClaudeQuery(
  prompt: string | AsyncIterable<any>,
  systemPrompt: string,
  maxTurns: number = 20,
): Promise<RawGeneratedApp> {
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
      maxTurns,
      systemPrompt,
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

  return result.structured_output as RawGeneratedApp;
}

// ---------------------------------------------------------------------------
// Build multimodal prompt from images + text
// ---------------------------------------------------------------------------

function buildPrompt(
  textPrompt: string,
  imageUrls?: string[],
  parentContext?: { text: string; imageUrls: string[] },
): string | AsyncIterable<any> {
  const hasImages = (imageUrls?.length ?? 0) > 0 || (parentContext?.imageUrls.length ?? 0) > 0;

  if (!hasImages) return textPrompt;

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
  return generateMessages();
}

// ---------------------------------------------------------------------------
// Main generation functions
// ---------------------------------------------------------------------------

export async function generateApp(
  idea: string,
  imageUrls?: string[],
  parentContext?: { text: string; imageUrls: string[] },
  username?: string,
): Promise<GeneratedApp> {
  console.log(`🤖 Generating app for idea: ${idea}${imageUrls?.length ? ` (with ${imageUrls.length} image(s))` : ''}${parentContext ? ' (with parent tweet context)' : ''}`);

  const promptParts: string[] = [];
  if (parentContext) {
    promptParts.push(`The user replied to the following tweet with their build request. Use this original post as the primary context for what to build:\n\n"${parentContext.text}"`);
  }
  promptParts.push(`Build a web app for: "${idea}"`);
  const footer = `Requested by @${username || 'unknown'} · Built by @clonkbot`;
  promptParts.push(`Include a small footer at the bottom of the page that says "${footer}" — style it subtly (muted text, small font size).`);
  promptParts.push('Use /frontend-design and follow the Design Guidelines to make it visually stunning and distinctive.');

  const prompt = buildPrompt(promptParts.join('\n\n'), imageUrls, parentContext);

  console.log('📋 Staging template files to /tmp/app-build/...');
  stageTemplateToBuildDir('react-vite');

  const rawApp = await runClaudeQuery(prompt, SYSTEM_PROMPT);
  console.log(`🎨 Claude generated ${rawApp.files.length} creative files for "${rawApp.appName}"`);

  const mergedApp = mergeWithTemplate(rawApp, 'react-vite');
  console.log(`📦 Merged to ${mergedApp.files.length} total files (template + creative)`);

  return mergedApp;
}

/**
 * Generate a full-stack Convex app. Same flow as generateApp but uses the
 * Convex template and system prompt, and injects VITE_CONVEX_URL.
 */
export async function generateConvexApp(
  idea: string,
  convexDeploymentUrl: string,
  imageUrls?: string[],
  parentContext?: { text: string; imageUrls: string[] },
  username?: string,
): Promise<GeneratedApp> {
  console.log(`🤖 Generating Convex app for idea: ${idea}${imageUrls?.length ? ` (with ${imageUrls.length} image(s))` : ''}${parentContext ? ' (with parent tweet context)' : ''}`);

  const promptParts: string[] = [];
  if (parentContext) {
    promptParts.push(`The user replied to the following tweet with their build request. Use this original post as the primary context for what to build:\n\n"${parentContext.text}"`);
  }
  promptParts.push(`Build a full-stack web app with a Convex backend for: "${idea}"`);
  promptParts.push(`The app should have real-time data, authentication (WorkOS AuthKit sign-in/sign-out), and a polished UI.`);
  const footer = `Requested by @${username || 'unknown'} · Built by @clonkbot`;
  promptParts.push(`Include a small footer at the bottom of the page that says "${footer}" — style it subtly (muted text, small font size).`);
  promptParts.push('Use /frontend-design and follow the Design Guidelines to make it visually stunning and distinctive.');

  const prompt = buildPrompt(promptParts.join('\n\n'), imageUrls, parentContext);

  console.log('📋 Staging Convex template files to /tmp/app-build/...');
  stageTemplateToBuildDir('convex-react-vite', convexDeploymentUrl);

  const rawApp = await runClaudeQuery(prompt, CONVEX_SYSTEM_PROMPT, 35);
  console.log(`🎨 Claude generated ${rawApp.files.length} creative files for "${rawApp.appName}"`);

  const mergedApp = mergeWithTemplate(rawApp, 'convex-react-vite', convexDeploymentUrl);
  console.log(`📦 Merged to ${mergedApp.files.length} total files (template + creative)`);

  return mergedApp;
}
