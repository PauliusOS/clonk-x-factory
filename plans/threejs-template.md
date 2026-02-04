# Three.js Template Implementation Plan

## Overview
Add a new `threejs-react-vite` template that gets selected when tweets mention **3D**, **game**, or **threejs**. Uses React Three Fiber (R3F) + Drei for a React-idiomatic Three.js experience on top of the existing Vite + React + Tailwind stack.

## Why React Three Fiber instead of raw Three.js?
- The bot generates **React** apps — R3F lets Three.js code live naturally inside React components
- Drei provides dozens of ready-made helpers (OrbitControls, Environment, Text3D, etc.) so Claude can build rich scenes quickly
- TypeScript types work out of the box
- Same build pipeline (Vite + tsc) — no special bundler config needed

## Detection Keywords
In `src/index.ts`, add a new keyword check **before** the Convex backend check:

```
THREEJS_KEYWORDS = ['3d', 'game', 'threejs', 'three.js', 'webgl', 'webgpu', '3d game']
```

If any match → set `template: 'threejs'` which routes to the Three.js template + system prompt.

## Template: `templates/threejs-react-vite/`

Based on `react-vite` but with Three.js dependencies pre-installed:

### Files (identical to react-vite except where noted)

| File | Changes from react-vite |
|------|------------------------|
| `package.json` | Adds: `three`, `@react-three/fiber`, `@react-three/drei`, `@types/three` |
| `tsconfig.json` | Same as react-vite |
| `vite.config.ts` | Same as react-vite |
| `index.html.template` | Same as react-vite |
| `src/main.tsx` | Same as react-vite |
| `src/vite-env.d.ts` | Same as react-vite |

The key difference is the **package.json** shipping with Three.js + R3F + Drei pre-installed so Claude doesn't need to specify them as extraDependencies.

### Dependencies added:
- `three@^0.170.0` — Core 3D engine
- `@react-three/fiber@^9.1.0` — React renderer for Three.js
- `@react-three/drei@^10.0.0` — Useful helpers (OrbitControls, Environment, Text, etc.)
- `@types/three@^0.170.0` — TypeScript types (devDep)

## System Prompt: `makeThreeJsSystemPrompt(buildDir)`

A specialized prompt that tells Claude:
- Stack is React 18 + TypeScript + Vite + Tailwind + **Three.js via React Three Fiber**
- Use `<Canvas>` from `@react-three/fiber` as the 3D viewport
- Use helpers from `@react-three/drei` (OrbitControls, Environment, Text, MeshWobbleMaterial, etc.)
- The scene should be interactive (orbit controls, click handlers, hover effects)
- Ensure the canvas is responsive and fills the viewport (or a designated area)
- Include the frontend-design skill for UI chrome outside the 3D canvas
- Same build verification flow as react-vite (write files → npm install → npm run build → cleanup)

## Code Changes

### 1. `src/index.ts` — Add Three.js keyword detection
- Add `THREEJS_KEYWORDS` array
- Check before backend keywords
- Pass `template: 'threejs'` to pipeline

### 2. `src/pipeline.ts` — Route Three.js template
- Add `'threejs'` to `PipelineInput.backend` type (or add a separate `template` field)
- Actually better: add a `template?: 'threejs'` field to `PipelineInput` since this isn't a "backend" — it's a frontend template choice
- Route to `generateThreeJsApp()` when `template === 'threejs'`

### 3. `src/services/claude.ts` — Three.js generation
- Add `'threejs-react-vite'` to `TemplateName` union
- Add `makeThreeJsSystemPrompt(buildDir)` function
- Add `generateThreeJsApp()` export function
- Follows same pattern as `generateApp()` but uses threejs template + prompt

### 4. `templates/threejs-react-vite/` — Template files
- Copy from `react-vite`
- Modify `package.json` to include Three.js deps

## Flow

```
Tweet: "@clonkbot build me a 3D solar system"
  ↓
index.ts: detects "3d" keyword → template = 'threejs'
  ↓
pipeline.ts: routes to generateThreeJsApp()
  ↓
claude.ts:
  1. stageTemplateToBuildDir('threejs-react-vite', buildDir)
  2. Claude generates src/App.tsx with <Canvas>, 3D scene, etc.
  3. Build verification: npm install && npm run build
  4. mergeWithTemplate() combines template + creative files
  ↓
Deploy to Vercel (same as react-vite flow)
```

## Priority & Interactions
- Three.js detection runs **before** Convex backend detection
- If a tweet says "build me a 3D game with login" — Three.js wins (3D is the primary experience; auth can be added later)
- Three.js template is frontend-only (no Convex backend) — keeps it simple
