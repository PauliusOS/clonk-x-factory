---
name: convex-backend
description: Guidelines for generating full-stack Convex applications with real-time database, server functions, and WorkOS AuthKit authentication.
---

This skill guides creation of full-stack Convex applications with a real-time backend. The app uses Convex for the database, server functions (queries/mutations/actions), and WorkOS AuthKit for authentication.

## Architecture

The app is a React + Vite frontend connected to a Convex backend. Key infrastructure files are pre-staged:

- `src/main.tsx` — already wraps `<App />` in `<ConvexAuthProvider>`
- `convex/auth.ts` — already configures `convexAuth({})`
- `convex/auth.config.ts` — already configures WorkOS provider

You generate:
- `convex/schema.ts` — the database schema (REQUIRED)
- `convex/*.ts` — server functions (queries, mutations, actions)
- `src/App.tsx` — the main React component (REQUIRED)
- `src/components/*` — additional React components
- Any `.css` files if needed beyond Tailwind

## Convex Schema

Define your data model in `convex/schema.ts`. This is the single source of truth for the database.

```typescript
import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  // Add your tables here:
  tasks: defineTable({
    text: v.string(),
    completed: v.boolean(),
    userId: v.id("users"),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
});
```

Always include `...authTables` to support authentication. Use `v.id("tableName")` for references.

### Validators

Use Convex validators (`v`) for all fields:
- `v.string()`, `v.number()`, `v.boolean()`, `v.null()`
- `v.id("tableName")` — reference to another table
- `v.array(v.string())` — arrays
- `v.object({ key: v.string() })` — nested objects
- `v.optional(v.string())` — optional fields
- `v.union(v.string(), v.null())` — union types

### Indexes

Define indexes for any field you query or filter by:
```typescript
.index("by_user", ["userId"])
.index("by_status", ["completed"])
.index("by_user_and_status", ["userId", "completed"])
```

## Server Functions

Organize functions by domain. One file per domain (e.g., `convex/tasks.ts`, `convex/messages.ts`).

### Queries (real-time, reactive)

```typescript
import { query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("tasks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});
```

### Mutations (write data)

```typescript
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const create = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("tasks", {
      text: args.text,
      completed: false,
      userId,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const task = await ctx.db.get(args.id);
    if (!task || task.userId !== userId) throw new Error("Not found");
    await ctx.db.delete(args.id);
  },
});
```

### Actions (external APIs, side effects)

Use `action` for calling external APIs. Actions cannot read/write the database directly — use `ctx.runMutation` or `ctx.runQuery` to interact with data.

```typescript
import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

export const generateSummary = action({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(api.tasks.get, { id: args.taskId });
    // Call external API...
    await ctx.runMutation(api.tasks.update, { id: args.taskId, summary: result });
  },
});
```

## React Patterns

### Reading data (live, reactive)

```typescript
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

function TaskList() {
  const tasks = useQuery(api.tasks.list);
  if (tasks === undefined) return <div>Loading...</div>;
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task._id}>{task.text}</li>
      ))}
    </ul>
  );
}
```

`useQuery` returns `undefined` while loading, then the data. It automatically updates in real-time when data changes.

### Writing data

```typescript
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

function AddTask() {
  const create = useMutation(api.tasks.create);
  const handleSubmit = (text: string) => {
    create({ text });  // fire-and-forget, UI updates reactively
  };
  // ...
}
```

### Running actions

```typescript
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

const runSummary = useAction(api.tasks.generateSummary);
```

### Authentication

```typescript
import { useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";

function AuthButton() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();

  if (isLoading) return <div>Loading...</div>;
  if (isAuthenticated) {
    return <button onClick={() => signOut()}>Sign Out</button>;
  }
  return <button onClick={() => signIn("workos")}>Sign In</button>;
}
```

Always check `isAuthenticated` before showing protected content. Show a sign-in button for unauthenticated users.

## Important Rules

1. **Always include `convex/schema.ts`** — this is required for the Convex backend to work
2. **Always include `...authTables`** in the schema — required for authentication
3. **Use `getAuthUserId(ctx)`** in server functions to get the current user
4. **Queries are reactive** — no polling or refetching needed, data updates automatically
5. **Mutations are optimistic** — UI updates before server confirms
6. **Never import server code in client** — use `api` from `_generated/api` for type-safe references
7. **File paths**: server functions go in `convex/*.ts`, React components go in `src/`
8. **Do NOT create `convex/auth.ts` or `convex/auth.config.ts`** — these are pre-staged in the template
9. **Do NOT create `src/main.tsx`** — this is pre-staged with ConvexAuthProvider
10. **Do NOT use `convex/convex.config.ts`** — not needed unless using components
11. **Do NOT create or modify files in `convex/_generated/`** — stub files are pre-staged so tsc passes. Real generated files are created by `npx convex deploy` later.

## Build Verification

The build verification for Convex apps:
1. Write files to `/tmp/app-build/src/` and `/tmp/app-build/convex/` using the Write tool
2. Run: `cd /tmp/app-build && npm install 2>&1`
3. Run: `cd /tmp/app-build && npm run build 2>&1`
4. If build fails, fix errors and retry (max 2 retries)
5. Do NOT clean up `/tmp/app-build` — the pipeline needs it to deploy Convex functions

Note: `convex/_generated/` contains stub files so tsc passes. The real generated types are created when the pipeline runs `npx convex deploy` after you finish. Do NOT try to run `npx convex dev` or `npx convex codegen`.
