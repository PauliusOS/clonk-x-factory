# Template-First Generation Strategy

## Problem

Every app generation burns tokens on identical boilerplate:
- `package.json` (~500 tokens) — same deps every time
- `tsconfig.json` (~200 tokens) — same config every time
- `vite.config.ts` (~100 tokens) — same config every time
- `index.html` (~200 tokens) — same skeleton every time
- `src/main.tsx` (~100 tokens) — same entry point every time
- Config rules in system prompt (~400 tokens) — explaining how to write the above
- Build verification via Bash tool (~1000+ tokens across tool calls)

That's **~2,500+ tokens wasted per generation** on stuff that never changes. Multiply across hundreds of generations and it's significant cost + latency.

On top of that, config mistakes cause build failures → retries → even more wasted tokens.

## Solution: Template Layer

Separate **infrastructure** (never changes, zero design impact) from **creative surface** (what actually matters for visual quality).

```
┌──────────────────────────────────────────────┐
│  TEMPLATE (pre-built, static)                │
│  package.json, tsconfig, vite.config,        │
│  main.tsx, index.html skeleton               │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│  CREATIVE (Claude generates)                 │
│  App.tsx, components/*, CSS, fonts, colors,  │
│  animations, layout, everything visual       │
└──────────────────────────────────────────────┘
```

**Key insight**: package.json, tsconfig, and vite.config have zero impact on design. Templating them doesn't constrain creativity at all — it just removes busywork.

## Architecture

### 1. Template Files (`templates/react-vite/`)

Store static files in the repo:

```
templates/react-vite/
├── package.json          # Fixed deps: react, react-dom, typescript, vite, tailwind
├── tsconfig.json         # Self-contained, noUnusedLocals: false, etc.
├── vite.config.ts        # Simple react plugin setup
├── src/
│   └── main.tsx          # Standard ReactDOM.createRoot entry
└── index.html.template   # Has {{TITLE}} and {{FONTS}} slots
```

These files are **checked into the repo** and maintained manually. They represent the known-good config that always builds.

### 2. Slimmed System Prompt

Current prompt wastes ~400 tokens on config rules. Replace with:

```
You are an expert frontend developer. Generate ONLY the creative files
for a web application. Infrastructure files (package.json, tsconfig,
vite.config, main.tsx) are pre-built — do not generate them.

Focus ALL your effort on:
- src/App.tsx (main application)
- src/components/* (any additional components)
- Any CSS files if needed beyond Tailwind

You control the visual identity through:
- Font choices (specify Google Font URLs)
- The entire App.tsx and component tree
- All Tailwind classes and custom CSS
- Animations, layout, color, typography — everything visual
```

This is ~60% shorter and focuses Claude on what matters.

### 3. Modified Structured Output

```typescript
interface GeneratedApp {
  appName: string;           // kebab-case name
  description: string;       // one sentence
  title: string;             // page <title>
  fonts: string[];           // Google Font URLs to inject into <head>
  files: {                   // ONLY creative files
    path: string;            // e.g. "src/App.tsx", "src/components/Header.tsx"
    content: string;
  }[];
}
```

Note: `files` no longer includes package.json, tsconfig, etc. Only `src/` files.

### 4. Pipeline Merge Logic (in `src/services/claude.ts` or deploy step)

```typescript
function mergeWithTemplate(generated: GeneratedApp): FullProject {
  // 1. Read template files from disk
  const templateDir = path.join(process.cwd(), 'templates/react-vite');
  const templateFiles = readTemplateFiles(templateDir);

  // 2. Process index.html template — inject fonts + title
  const indexHtml = templateFiles['index.html.template']
    .replace('{{TITLE}}', generated.title || generated.appName)
    .replace('{{FONTS}}', generated.fonts
      .map(url => `<link rel="stylesheet" href="${url}">`)
      .join('\n    '));

  // 3. Merge: template files + processed index.html + generated creative files
  return {
    ...generated,
    files: [
      ...Object.entries(templateFiles)
        .filter(([name]) => !name.endsWith('.template'))
        .map(([path, content]) => ({ path, content })),
      { path: 'index.html', content: indexHtml },
      ...generated.files,
    ],
  };
}
```

### 5. Build Verification — Move to Pipeline

Instead of Claude running `npm install && npm run build` via Bash tool (expensive in tokens + tool calls), do it in the Node.js pipeline:

```typescript
async function verifyBuild(mergedFiles: FullProject): Promise<boolean> {
  const buildDir = path.join(os.tmpdir(), `build-${Date.now()}`);

  // Write all files
  for (const file of mergedFiles.files) {
    const filePath = path.join(buildDir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content);
  }

  // Run build
  const result = execSync('npm install && npm run build', {
    cwd: buildDir,
    timeout: 60000,
  });

  // Clean up
  await fs.rm(buildDir, { recursive: true });

  return result.status === 0;
}
```

This completely removes the need for Claude to have Bash/Write/Read/Edit tools. Claude only needs the `Skill` tool.

## Token Savings Breakdown

| Source | Before | After | Saved |
|--------|--------|-------|-------|
| System prompt config rules | ~400 tokens | 0 | ~400 |
| Boilerplate in output | ~1,100 tokens | 0 | ~1,100 |
| Bash tool calls (build verify) | ~1,000+ tokens | 0 | ~1,000 |
| Build failure retries (avg) | ~500 tokens | 0 | ~500 |
| **Total per generation** | | | **~3,000 tokens** |

Plus faster generation (fewer tool calls = fewer round trips).

## Why This Won't Look Bland

The template covers **zero visual surface area**:
- `package.json` — dependency list, invisible
- `tsconfig.json` — compiler config, invisible
- `vite.config.ts` — bundler config, invisible
- `main.tsx` — `ReactDOM.createRoot(document.getElementById('root')!)` — invisible
- `index.html` — skeleton `<div id="root">` with dynamic fonts — Claude controls the fonts

Everything the user actually sees comes from Claude's creative files:
- `App.tsx` — the entire UI
- Components — all visual elements
- Tailwind classes — all styling decisions
- Font choices — Claude specifies via `fonts` array
- Colors, layout, animations, typography — all in Claude's hands

The SKILL.md design guidelines remain completely unchanged. Claude still gets the full creative brief about bold aesthetics, distinctive fonts, unexpected layouts, etc.

## Future: Template Variants (Phase 2)

Once the base template works, we could add specialized variants:

```
templates/
├── react-vite/          # Universal SPA (current)
├── dashboard/           # Grid layout, sidebar, charts preset
├── landing/             # Hero section, scroll sections
├── game/                # Canvas setup, game loop scaffold
└── tool/                # Form layout, input/output panels
```

Claude picks the variant based on the request. Each variant provides more relevant scaffolding (e.g. a dashboard template might include a sidebar component skeleton), saving even more tokens while giving Claude a better starting point.

This is optional and should only be pursued if the universal template proves the concept.

## Implementation Steps

1. **Create `templates/react-vite/` directory** with the 5 static files
2. **Add `title` and `fonts` fields** to the structured output schema in `claude.ts`
3. **Write merge function** that combines template + generated files
4. **Move build verification** from Claude (Bash tool) to pipeline (Node.js)
5. **Slim down the system prompt** — remove config rules, remove build verification instructions
6. **Remove unnecessary tools** — Claude no longer needs Bash, Write, Read, Edit
7. **Test with several generations** — compare quality before/after
8. **Tune** — if Claude still tries to generate boilerplate, strengthen the prompt

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude ignores instructions and generates boilerplate anyway | Strong prompt + schema validation (reject files matching template paths) |
| Template deps get outdated | Template files are in repo — update them like any dependency |
| Some apps need extra deps (e.g. chart library) | Add `extraDependencies` field to schema; pipeline merges into package.json |
| index.html needs more customization than just fonts | Add more slots as needed (e.g. `{{META}}`, `{{SCRIPTS}}`) |
| Build verification in pipeline can't fix errors | If build fails, either retry the full generation or accept the current Claude-based approach as fallback |
