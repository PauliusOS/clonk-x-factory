import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface GeneratedApp {
  files: {
    path: string;
    content: string;
  }[];
  appName: string;
  description: string;
  buildDir?: string; // Unique build dir path (needed for Convex deploy step)
  tokenSymbol?: string; // Suggested token ticker symbol (when user requests a coin)
}

// Raw output from Claude — metadata only (files are read from disk)
interface RawGeneratedApp {
  appName: string;
  description: string;
  title: string;
  fonts: string[];
  extraDependencies?: Record<string, string>;
  tokenSymbol?: string;
}

export type TemplateName = 'react-vite' | 'convex-react-vite' | 'threejs-react-vite';

const TEMPLATES_ROOT = path.join(process.cwd(), 'templates');

/** Generate a unique build directory path to prevent concurrent pipeline collisions. */
function createBuildDir(): string {
  const id = crypto.randomBytes(4).toString('hex');
  return `/tmp/app-build-${id}`;
}

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

function makeSystemPrompt(buildDir: string): string {
  return `You are an expert frontend developer. Generate ONLY the creative source files for a web application based on the user's request.

Infrastructure files (package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx) are pre-staged at ${buildDir}/ — do NOT recreate them.

The stack is React 18 + TypeScript + Vite + Tailwind CSS (via CDN). You control the visual identity through:
- Font choices (specify Google Font stylesheet URLs in the "fonts" array)
- src/App.tsx — the main application component (REQUIRED)
- src/components/* — any additional components you need
- Any .css files if needed beyond Tailwind

If you need npm packages beyond react/react-dom (e.g. framer-motion, three, recharts, lucide-react), list them in "extraDependencies" as { "package-name": "^version" }. You MUST also install them into ${buildDir}/ before building (e.g. cd ${buildDir} && npm install framer-motion).

Requirements:
- Client-side only SPA, no backend/API calls, no external paid services
- Mobile-friendly responsive design — the app MUST look great on desktops AND be fully usable on phones (375px+) and tablets. Use Tailwind responsive prefixes to ensure layouts adapt properly across all screen sizes.
- All TypeScript must compile cleanly — no unused variables, no type errors
- Make it fully functional and polished

BUILD VERIFICATION — you MUST do this before returning your final answer:
1. Write your creative source files to ${buildDir}/src/ using the Write tool (the template files are already there). Do NOT use Bash heredocs — JS code with brackets causes shell substitution errors.
2. If you specified extraDependencies, install them: cd ${buildDir} && npm install <pkg1> <pkg2> 2>&1
3. Run: cd ${buildDir} && npm install 2>&1 && npm run build 2>&1
4. If the build fails, fix the errors and retry (max 2 retries).
5. Only return your final structured output AFTER the build succeeds.
6. Do NOT clean up ${buildDir} — the pipeline reads your files from disk.
7. Do NOT re-read files for the structured output. The pipeline reads them from disk automatically. Your structured output only needs metadata (appName, description, title, fonts, extraDependencies).

## Design Guidelines

${FRONTEND_SKILL}`;
}

function makeConvexSystemPrompt(buildDir: string, use3D?: boolean): string {
  const threeJsSection = use3D ? `

## Three.js / React Three Fiber (3D Apps)

This app requires 3D graphics. Install and use Three.js via React Three Fiber:

\`\`\`bash
cd ${buildDir} && npm install three @react-three/fiber @react-three/drei @types/three
\`\`\`

Use React Three Fiber (R3F) for all 3D rendering:
- \`import { Canvas } from '@react-three/fiber'\`
- \`import { OrbitControls, Environment } from '@react-three/drei'\`

Key patterns:
- Wrap 3D content in \`<Canvas>\` component
- Use \`OrbitControls\` for interactive camera
- Use \`Environment\` for lighting presets
- Use \`useFrame\` hook for animations
- Drei provides helpers: Text, Float, Stars, Sky, Html, useGLTF, etc.

Make the 3D canvas responsive and mobile-friendly with touch controls.

### 3D Model Assets from Poly.Pizza

When the scene involves recognizable real-world objects (cars, trees, buildings, characters,
animals, furniture, weapons, food, etc.), search poly.pizza for ready-made low-poly 3D models
instead of building them from scratch with primitive geometry.

**How to search (build-time only — use Bash tool):**
\`\`\`bash
curl -s -H "X-Auth-Token: $POLY_PIZZA_API_KEY" \\
  "https://api.poly.pizza/v1.1/search/car" | head -c 2000
\`\`\`

Response contains \`results[]\` with each model having:
- \`Download\` — direct GLB URL (use this with useGLTF)
- \`Title\` — model name
- \`Attribution\` — credit text (MUST include in app)
- \`Licence\` — "CC0" or "CC-BY" (attribution required)
- \`TriCount\` — triangle count (prefer under 50k)

**How to load in React Three Fiber:**
\`\`\`tsx
import { useGLTF } from '@react-three/drei'

function CarModel(props: JSX.IntrinsicElements['group']) {
  const { scene } = useGLTF('https://...the-download-url...')
  return <primitive object={scene.clone()} {...props} />
}
useGLTF.preload('https://...the-download-url...')
\`\`\`

**Rules:**
1. Search the API FIRST, then embed the Download URL directly in code — do NOT make API calls at runtime
2. Always wrap model components in \`<Suspense>\` with a fallback
3. Use \`scene.clone()\` when placing the same model multiple times
4. Adjust scale — poly.pizza models vary in size
5. For CC-BY models, include attribution in the app footer
6. Prefer models with lower TriCount for better performance
7. If $POLY_PIZZA_API_KEY is not set or search returns no results, fall back to procedural geometry
8. Search with simple keywords: "car", "tree", "house"
` : '';

  return `You are an expert full-stack developer. Generate the creative source files AND Convex backend functions for a web application based on the user's request.

Infrastructure files are pre-staged at ${buildDir}/ — do NOT recreate them. Specifically do NOT create:
- package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx
- convex/auth.ts, convex/auth.config.ts, convex/http.ts, convex/tsconfig.json

The stack is React 18 + TypeScript + Vite + Tailwind CSS (via CDN) + Convex (real-time backend) + Convex Auth (password + anonymous authentication).

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

If you need npm packages beyond what's in the template (e.g. framer-motion, lucide-react), list them in "extraDependencies" and install them: cd ${buildDir} && npm install <pkg>.

Requirements:
- Full-stack app with real-time Convex backend
- Include authentication (email/password sign-in/sign-up using Convex Auth)
- Mobile-friendly responsive design — the app MUST look great on desktops AND be fully usable on phones (375px+) and tablets. Use Tailwind responsive prefixes to ensure layouts adapt properly across all screen sizes.
- All TypeScript in src/ must compile cleanly (convex/ files are NOT compiled by tsc — they are compiled separately by the Convex CLI)
- Make it fully functional and polished

CRITICAL: Do NOT explore, read, or list files in ${buildDir}/. The template is already staged and you know exactly what's there. Do NOT read package.json, tsconfig.json, main.tsx, auth.ts, auth.config.ts, http.ts, or any _generated/ files. Do NOT modify any template files. Just write your creative files and build.

BUILD VERIFICATION — you MUST do this before returning your final answer:
1. Write ALL your files to ${buildDir}/src/ and ${buildDir}/convex/ using the Write tool in a single turn if possible. Do NOT use Bash heredocs.
2. If you specified extraDependencies, install them: cd ${buildDir} && npm install <pkg1> <pkg2> 2>&1
3. Run: cd ${buildDir} && npm install 2>&1 && npm run build 2>&1
4. The build only compiles src/ files (not convex/). If it fails, fix only src/ errors and retry (max 2 retries).
5. Only return your final structured output AFTER the build succeeds.
6. Do NOT clean up ${buildDir} — the pipeline needs it to deploy Convex functions.
7. Do NOT re-read files for the structured output. The pipeline reads them from disk automatically. Your structured output only needs metadata (appName, description, title, fonts, extraDependencies).

## Convex Backend Guidelines

${CONVEX_SKILL}
${threeJsSection}
## Design Guidelines

${FRONTEND_SKILL}`;
}

function makeThreeJsSystemPrompt(buildDir: string): string {
  return `You are an expert 3D web developer. Generate ONLY the creative source files for an interactive 3D web application based on the user's request.

Infrastructure files (package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx) are pre-staged at ${buildDir}/ — do NOT recreate them.

The stack is React 18 + TypeScript + Vite + Tailwind CSS (via CDN) + **Three.js via React Three Fiber (@react-three/fiber) + Drei (@react-three/drei)**.

These packages are already in the template's package.json — do NOT add them to extraDependencies:
- three
- @react-three/fiber
- @react-three/drei
- @types/three

## Three.js / React Three Fiber Guidelines

Use React Three Fiber (R3F) for all 3D rendering. Key patterns:

**Scene Setup:**
\`\`\`tsx
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Canvas camera={{ position: [0, 2, 5], fov: 60 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 5, 5]} intensity={1} />
        <OrbitControls enableDamping />
        <Environment preset="sunset" />
        {/* Your 3D objects here */}
      </Canvas>
    </div>
  )
}
\`\`\`

**Useful Drei helpers** (already installed, use freely):
- \`OrbitControls\` — interactive camera rotation/zoom
- \`Environment\` — HDR environment maps (presets: "sunset", "dawn", "night", "warehouse", "forest", "apartment", "studio", "city", "park", "lobby")
- \`Text\` / \`Text3D\` — 3D text rendering
- \`Float\` — makes objects float/bob
- \`MeshWobbleMaterial\`, \`MeshDistortMaterial\` — animated materials
- \`Stars\`, \`Sky\`, \`Cloud\` — atmospheric effects
- \`Html\` — embed HTML inside 3D scene
- \`useGLTF\` — load 3D models (GLTF/GLB)
- \`RoundedBox\`, \`Sphere\`, \`Torus\`, \`Plane\` — geometry primitives
- \`PerspectiveCamera\`, \`OrthographicCamera\` — camera components
- \`ContactShadows\`, \`AccumulativeShadows\`, \`SoftShadows\` — shadow systems
- \`Center\` — center group of objects

## 3D Model Assets from Poly.Pizza

When the user's request involves recognizable real-world objects (cars, trees, buildings,
characters, animals, furniture, weapons, food, etc.), search poly.pizza for ready-made
low-poly 3D models instead of building them from scratch with primitive geometry.

**When to use poly.pizza:**
- User asks for a game/scene with specific objects (racing game → search "car", "road")
- Scene needs environmental detail (trees, rocks, buildings, furniture)
- Characters or animals are needed

**When NOT to use poly.pizza (use procedural geometry instead):**
- Abstract/geometric art, particle effects, mathematical visualizations
- Simple shapes that are faster to code than to load (cubes, spheres)
- The API key is not available

**How to search (build-time only — use Bash tool):**
\`\`\`bash
curl -s -H "X-Auth-Token: $POLY_PIZZA_API_KEY" \\
  "https://api.poly.pizza/v1.1/search/car" | head -c 2000
\`\`\`

Response contains \`results[]\` with each model having:
- \`Download\` — direct GLB URL (use this with useGLTF)
- \`Title\` — model name
- \`Attribution\` — credit text (MUST include in app)
- \`Licence\` — "CC0" (no attribution needed) or "CC-BY" (attribution required)
- \`TriCount\` — triangle count (prefer lower for performance, under 50k)

**How to load in React Three Fiber:**
\`\`\`tsx
import { useGLTF } from '@react-three/drei'
import { Suspense } from 'react'

function CarModel(props: JSX.IntrinsicElements['group']) {
  const { scene } = useGLTF('https://...the-download-url...')
  return <primitive object={scene.clone()} {...props} />
}

// Preload for better UX
useGLTF.preload('https://...the-download-url...')

// Always wrap in Suspense
<Suspense fallback={null}>
  <CarModel position={[0, 0, 0]} scale={1} />
</Suspense>
\`\`\`

**Important rules:**
1. Search the API FIRST, then embed the Download URL directly in code — do NOT make API calls at runtime
2. Always wrap model components in \`<Suspense>\` with a fallback
3. Use \`scene.clone()\` when placing the same model multiple times
4. Adjust scale — poly.pizza models vary in size, you may need \`scale={0.5}\` or \`scale={2}\`
5. For CC-BY models, include attribution in the app footer (add to the existing footer text)
6. Prefer models with lower TriCount for better performance
7. If $POLY_PIZZA_API_KEY is not set or the search returns no results, fall back to procedural geometry
8. Search with simple, specific keywords: "car", "tree", "house" — not long phrases
9. You can search multiple times for different objects in the same scene

**Animation with useFrame:**
\`\`\`tsx
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'

function SpinningBox() {
  const ref = useRef<THREE.Mesh>(null!)
  useFrame((state, delta) => {
    ref.current.rotation.y += delta
  })
  return (
    <mesh ref={ref}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="hotpink" />
    </mesh>
  )
}
\`\`\`

**Interactive objects:**
\`\`\`tsx
<mesh
  onClick={(e) => { /* handle click */ }}
  onPointerOver={(e) => { /* hover in */ }}
  onPointerOut={(e) => { /* hover out */ }}
>
  <sphereGeometry args={[1, 32, 32]} />
  <meshStandardMaterial color="royalblue" />
</mesh>
\`\`\`

## Requirements
- The 3D canvas should be responsive and fill the viewport (or a large portion of it)
- Include interactive camera controls (OrbitControls at minimum)
- Add proper lighting (ambient + directional/point lights)
- Make objects interactive where it makes sense (hover effects, click handlers)
- Use Drei helpers to make the scene visually rich (environment maps, shadows, atmospheric effects)
- Client-side only SPA — the generated app must NOT call any backend APIs at runtime (loading static assets like GLB models from CDN URLs is fine)
- All TypeScript must compile cleanly
- You can add a Tailwind-styled UI overlay (HUD, controls panel, info cards) on top of the 3D canvas using absolute positioning or Drei's Html component
- Mobile-friendly: ensure touch controls work for orbit/zoom, and any UI overlays are usable on small screens

If you need additional npm packages beyond what's in the template (e.g. framer-motion, gsap, @react-three/rapier for physics, @react-three/postprocessing for effects), list them in "extraDependencies" and install them: cd ${buildDir} && npm install <pkg>.

BUILD VERIFICATION — you MUST do this before returning your final answer:
1. Write your creative source files to ${buildDir}/src/ using the Write tool. Do NOT use Bash heredocs.
2. If you specified extraDependencies, install them: cd ${buildDir} && npm install <pkg1> <pkg2> 2>&1
3. Run: cd ${buildDir} && npm install 2>&1 && npm run build 2>&1
4. If the build fails, fix the errors and retry (max 2 retries).
5. Only return your final structured output AFTER the build succeeds.
6. Do NOT clean up ${buildDir} — the pipeline reads your files from disk.
7. Do NOT re-read files for the structured output. The pipeline reads them from disk automatically. Your structured output only needs metadata (appName, description, title, fonts, extraDependencies).

## Design Guidelines

${FRONTEND_SKILL}`;
}

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
    tokenSymbol: {
      type: 'string',
      description: 'Suggested 3-5 character token ticker symbol (e.g. "MEMED", "POMO"). Only include if the user explicitly requested a coin, token, or memecoin alongside their app.',
    },
  },
  required: ['appName', 'description', 'title', 'fonts'],
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
 * Pre-stage template files to a unique build dir so Claude only needs to write creative files.
 * index.html is staged without fonts (fonts don't affect build, they're runtime-only).
 * For Convex templates, also writes .env.local with VITE_CONVEX_URL.
 */
function stageTemplateToBuildDir(template: TemplateName, buildDir: string, convexUrl?: string): void {
  // Clean up if this specific dir exists (shouldn't with unique IDs, but just in case)
  fs.rmSync(buildDir, { recursive: true, force: true });

  const templateFiles = readTemplateFiles(template);
  for (const file of templateFiles) {
    let targetPath: string;
    let content = file.content;

    if (file.path === 'index.html.template') {
      // Stage as index.html with placeholder fonts stripped (build doesn't need them)
      targetPath = path.join(buildDir, 'index.html');
      content = content.replace('{{TITLE}}', 'App').replace('{{FONTS}}', '');
    } else {
      targetPath = path.join(buildDir, file.path);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  // For Convex templates, write .env.local so the frontend build can resolve VITE_CONVEX_URL
  if (template === 'convex-react-vite' && convexUrl) {
    fs.writeFileSync(path.join(buildDir, '.env.local'), `VITE_CONVEX_URL=${convexUrl}\n`);
  }
}

/**
 * Merge template files with Claude's creative output for deployment.
 * Processes index.html template with fonts/title, merges extra deps into package.json.
 * For Convex templates, also injects VITE_CONVEX_URL into .env.local.
 */
function mergeWithTemplate(raw: RawGeneratedApp & { files: { path: string; content: string }[] }, template: TemplateName, convexUrl?: string): GeneratedApp {
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
    tokenSymbol: raw.tokenSymbol,
  };
}

// ---------------------------------------------------------------------------
// Read creative files from disk (replaces structured output files)
// ---------------------------------------------------------------------------

/** Read all creative files Claude wrote to the build dir (src/**, convex/**, *.css). */
function readCreativeFilesFromDisk(buildDir: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  // Directories that contain Claude-generated creative files
  const creativeDirs = ['src', 'convex'];

  for (const dir of creativeDirs) {
    const dirPath = path.join(buildDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    function walk(currentDir: string, prefix: string) {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          // Skip node_modules; _generated is kept (needed when Claude manually adds Convex to non-Convex templates)
          if (entry.name === 'node_modules') continue;
          walk(fullPath, relativePath);
        } else {
          files.push({ path: relativePath, content: fs.readFileSync(fullPath, 'utf-8') });
        }
      }
    }

    walk(dirPath, dir);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Shared query runner
// ---------------------------------------------------------------------------

async function runClaudeQuery(
  prompt: string | AsyncIterable<any>,
  systemPrompt: string,
  buildDir: string,
  maxTurns: number = 20,
): Promise<RawGeneratedApp & { files: { path: string; content: string }[] }> {
  // Hard timeout: 5 minutes. Protects against SDK getting stuck in retry loops
  // (e.g. when hitting repeated 500s from the API).
  const HARD_TIMEOUT_MS = 5 * 60 * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  let result: SDKResultSuccess | null = null;
  let lastError: string | null = null;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  let turnCount = 0;
  let consecutiveRefusals = 0;
  const MAX_CONSECUTIVE_REFUSALS = 3;

  try {
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
        // Filter out noisy "Bun is not defined" messages
        if (!data.includes('Bun is not defined')) {
          console.error(`[claude-code stderr] ${data}`);
        }
      },
    },
  })) {
    const msg = message as any;

    if (msg.type === 'assistant') {
      turnCount++;
      consecutiveErrors = 0; // Reset on successful turn
      // Log assistant text (truncated)
      const text = msg.message?.content
        ?.filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
        .slice(0, 200);
      if (text) {
        console.log(`  🤖 [turn ${turnCount}/${maxTurns}] ${text}${text.length >= 200 ? '...' : ''}`);
      }

      // Detect refusal patterns — if Claude is refusing to build, bail early
      const fullText = msg.message?.content
        ?.filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('') || '';
      const hasToolUse = msg.message?.content?.some((b: any) => b.type === 'tool_use');
      const REFUSAL_PATTERNS = [
        /\brefus(e|al|ing)\b/i,
        /\bwill not\b/i,
        /\bcannot\b/i,
        /\bi can'?t\b/i,
        /\bethical\b/i,
        /\binappropriate\b/i,
        /\bharmful\b/i,
        /\bunable to (create|build|generate|make)\b/i,
      ];
      const isRefusal = !hasToolUse && REFUSAL_PATTERNS.some(p => p.test(fullText));
      if (isRefusal) {
        consecutiveRefusals++;
        if (consecutiveRefusals >= MAX_CONSECUTIVE_REFUSALS) {
          throw new Error(`Content refused by Claude (${consecutiveRefusals} consecutive refusals). The request likely violates content policy.`);
        }
      } else {
        consecutiveRefusals = 0;
      }

      // Log tool use summaries
      const tools = msg.message?.content?.filter((b: any) => b.type === 'tool_use') || [];
      for (const tool of tools) {
        const input = tool.input || {};
        if (tool.name === 'Write') {
          console.log(`  📝 [turn ${turnCount}] Write: ${input.file_path || 'unknown'}`);
        } else if (tool.name === 'Bash') {
          const cmd = (input.command || '').slice(0, 120);
          console.log(`  💻 [turn ${turnCount}] Bash: ${cmd}`);
        } else if (tool.name === 'Read') {
          console.log(`  📖 [turn ${turnCount}] Read: ${input.file_path || 'unknown'}`);
        } else if (tool.name === 'Skill') {
          console.log(`  🎨 [turn ${turnCount}] Skill: ${input.skill || 'unknown'}`);
        } else {
          console.log(`  🔧 [turn ${turnCount}] ${tool.name}`);
        }
      }
    } else if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        result = msg as SDKResultSuccess;
        console.log(`  ✅ [turn ${turnCount}] Generation complete`);
      } else {
        consecutiveErrors++;
        lastError = msg.errors?.join(', ') || msg.subtype || 'unknown';
        console.error(`  ❌ [turn ${turnCount}] Agent SDK error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${lastError}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`Aborting: ${MAX_CONSECUTIVE_ERRORS} consecutive errors from Claude API: ${lastError}`);
        }
      }
    }
  }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Claude query timed out after ${HARD_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!result?.structured_output) {
    throw new Error(`Failed to get structured output from Claude: ${lastError || 'unknown error'}`);
  }

  const metadata = result.structured_output as RawGeneratedApp;
  const files = readCreativeFilesFromDisk(buildDir);
  console.log(`  📂 Read ${files.length} creative files from disk`);

  return { ...metadata, files };
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

  const buildDir = createBuildDir();
  console.log(`📋 Staging template files to ${buildDir}/...`);
  stageTemplateToBuildDir('react-vite', buildDir);

  const rawApp = await runClaudeQuery(prompt, makeSystemPrompt(buildDir), buildDir);
  console.log(`🎨 Claude generated ${rawApp.files.length} creative files for "${rawApp.appName}"`);

  const mergedApp = mergeWithTemplate(rawApp, 'react-vite');
  console.log(`📦 Merged to ${mergedApp.files.length} total files (template + creative)`);

  // Clean up build dir (static apps don't need it after merge)
  fs.rmSync(buildDir, { recursive: true, force: true });

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
  use3D?: boolean,
): Promise<GeneratedApp> {
  console.log(`🤖 Generating Convex app for idea: ${idea}${imageUrls?.length ? ` (with ${imageUrls.length} image(s))` : ''}${parentContext ? ' (with parent tweet context)' : ''}${use3D ? ' (with Three.js 3D)' : ''}`);

  const promptParts: string[] = [];
  if (parentContext) {
    promptParts.push(`The user replied to the following tweet with their build request. Use this original post as the primary context for what to build:\n\n"${parentContext.text}"`);
  }
  promptParts.push(`Build a full-stack web app with a Convex backend for: "${idea}"`);
  promptParts.push(`The app should have real-time data, authentication (email/password sign-in/sign-up), and a polished UI.`);
  const footer = `Requested by @${username || 'unknown'} · Built by @clonkbot`;
  promptParts.push(`Include a small footer at the bottom of the page that says "${footer}" — style it subtly (muted text, small font size).`);
  promptParts.push('Use /frontend-design and follow the Design Guidelines to make it visually stunning and distinctive.');

  // Nudge Claude to search for 3D assets when relevant (Convex + 3D apps)
  if (use3D && process.env.POLY_PIZZA_API_KEY) {
    promptParts.push(`If this scene would benefit from realistic 3D models (vehicles, characters, buildings, nature, etc.), search poly.pizza for suitable assets using the API instructions in your system prompt.`);
  }

  const prompt = buildPrompt(promptParts.join('\n\n'), imageUrls, parentContext);

  const buildDir = createBuildDir();
  console.log(`📋 Staging Convex template files to ${buildDir}/...`);
  stageTemplateToBuildDir('convex-react-vite', buildDir, convexDeploymentUrl);

  const rawApp = await runClaudeQuery(prompt, makeConvexSystemPrompt(buildDir, use3D), buildDir, 30);
  console.log(`🎨 Claude generated ${rawApp.files.length} creative files for "${rawApp.appName}"`);

  const mergedApp = mergeWithTemplate(rawApp, 'convex-react-vite', convexDeploymentUrl);
  mergedApp.buildDir = buildDir;
  console.log(`📦 Merged to ${mergedApp.files.length} total files (template + creative)`);

  return mergedApp;
}

/**
 * Generate a Three.js / 3D app. Uses React Three Fiber + Drei on top of
 * the standard Vite + React stack. Same deploy flow as generateApp (static).
 */
export async function generateThreeJsApp(
  idea: string,
  imageUrls?: string[],
  parentContext?: { text: string; imageUrls: string[] },
  username?: string,
): Promise<GeneratedApp> {
  console.log(`🤖 Generating Three.js app for idea: ${idea}${imageUrls?.length ? ` (with ${imageUrls.length} image(s))` : ''}${parentContext ? ' (with parent tweet context)' : ''}`);

  const promptParts: string[] = [];
  if (parentContext) {
    promptParts.push(`The user replied to the following tweet with their build request. Use this original post as the primary context for what to build:\n\n"${parentContext.text}"`);
  }
  promptParts.push(`Build an interactive 3D web app for: "${idea}"`);
  promptParts.push(`Use React Three Fiber (<Canvas>) for the 3D scene and Drei helpers for controls, lighting, and effects. Make it visually impressive and interactive.`);
  const footer = `Requested by @${username || 'unknown'} · Built by @clonkbot`;
  promptParts.push(`Include a small footer at the bottom of the page that says "${footer}" — style it subtly (muted text, small font size). Use absolute positioning or an overlay so it doesn't interfere with the 3D canvas.`);
  promptParts.push('Use /frontend-design and follow the Design Guidelines to make any UI chrome visually stunning and distinctive.');

  // Nudge Claude to search for 3D assets when relevant
  if (process.env.POLY_PIZZA_API_KEY) {
    promptParts.push(`If this scene would benefit from realistic 3D models (vehicles, characters, buildings, nature, etc.), search poly.pizza for suitable assets using the API instructions in your system prompt.`);
  }

  const prompt = buildPrompt(promptParts.join('\n\n'), imageUrls, parentContext);

  const buildDir = createBuildDir();
  console.log(`📋 Staging Three.js template files to ${buildDir}/...`);
  stageTemplateToBuildDir('threejs-react-vite', buildDir);

  const rawApp = await runClaudeQuery(prompt, makeThreeJsSystemPrompt(buildDir), buildDir);
  console.log(`🎨 Claude generated ${rawApp.files.length} creative files for "${rawApp.appName}"`);

  const mergedApp = mergeWithTemplate(rawApp, 'threejs-react-vite');
  console.log(`📦 Merged to ${mergedApp.files.length} total files (template + creative)`);

  // Clean up build dir (static apps don't need it after merge)
  fs.rmSync(buildDir, { recursive: true, force: true });

  return mergedApp;
}
