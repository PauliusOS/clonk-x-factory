# Plan: Integrate BankrBot Token Deployment into Clonk X Factory

## Overview

Add the ability for users to request a crypto token be created alongside their generated app. When a user tweets something like `@clonkbot build a meme dashboard with a coin`, the bot will:

1. Detect the "coin/token" intent from the tweet
2. Generate and deploy the web app (existing flow)
3. Tag `@bankrbot` in the reply tweet to trigger token deployment, routing fees to the original user
4. BankrBot handles everything — wallet creation, on-chain deploy, fee routing

## Bankr Skill — Installed

The bankr skill has been installed to `.claude/skills/bankr/` with the full SKILL.md and all reference docs. This gives Claude Code agents access to bankr documentation when generating apps.

---

## The "Cheat Code" Approach: Tag @bankrbot in Our Reply

### How It Works

Instead of integrating the Bankr API, we simply **tag @bankrbot in our reply tweet** with a natural language token deployment command. BankrBot is a real bot on X that listens for mentions and deploys tokens automatically.

### Why This Works

1. **BankrBot already handles everything** — wallet creation (via Privy), on-chain deployment (via Clanker), liquidity pool setup, fee routing
2. **Fee routing to X handles is supported** — Bankr docs confirm this exact syntax:
   - `"deploy a token where fees go to @0xdeployer on x"`
   - `"deploy TeamToken with fees going to 0x1234..."`
   - `"launch MyToken and make @handle the beneficiary"`
3. **The user gets real ownership** — BankrBot creates a Privy wallet for the fee recipient's X account, so the original user who tagged @clonkbot receives the 57% creator fee share
4. **Zero API integration required** — no Bankr API key, no polling, no new service file, no environment variables

### The Flow

```
1. User tweets: "@clonkbot build a meme dashboard with a coin"

2. Clonkbot processes the build request (existing flow):
   - Generate app via Claude
   - Deploy to Vercel
   - Create GitHub repo
   - Take screenshot

3. Clonkbot replies (modified to include @bankrbot tag):
   "✅ App live: https://meme-dashboard-a3f1b2.vercel.app
    📝 Source: https://github.com/clonkbot/meme-dashboard-a3f1b2

    @bankrbot deploy a token called Meme Dashboard with symbol MEMED
    on Base with fees going to @originaluser
    Website: https://meme-dashboard-a3f1b2.vercel.app"

4. BankrBot sees the mention, deploys the token, replies in the thread:
   "$MEMED deployed via clanker on base: 0x1234...
    fees to @originaluser
    trade: https://bankr.bot/..."

5. The user now has:
   - A live app
   - A GitHub repo
   - A token on Base with THEIR fee share
   - All in one tweet thread
```

### Key Evidence This Works

**Fee routing to X handles (confirmed in Bankr docs):**
> "deploy a token where fees go to @0xdeployer on x"
> Source: https://docs.bankr.bot/token-launching/fee-splitting

**BankrBot reply format (seen in the wild):**
> "$STARKBOT deployed via clanker on base: 0x587c... fees to @ethereumdegen"
> Source: https://x.com/bankrbot/status/2016825605766226051

**Social deployment documented:**
> Tag @bankrbot on X for instant deployment with social proof
> Source: https://docs.bankr.bot/guides/social-deployment

**Fee structure on Base (Clanker):**
| Recipient | Share of 1.2% swap fee |
|-----------|----------------------|
| Fee beneficiary (the user we route to) | 57% |
| Bankr | 36.1% |
| Bankr Ecosystem | 1.9% |
| Protocol (Doppler) | 5% |

---

## Risks & Unknowns

### 1. Bot-to-Bot Filtering (BIGGEST RISK)

**The Grok incident:** In March 2025, BankrBot disabled interactions with Grok after it accidentally created 17 tokens. The block was Grok-specific — Bankr's founder said "We've made it so Bankr no longer responds to Grok on X."

**Risk for us:** BankrBot may block our bot too, especially if we're generating high-volume token requests. However:
- The Grok block was because Grok had no wallet management ability and couldn't "responsibly manage its own wallet and safeguard its funds"
- Our use case is intentional, user-initiated, and we're routing fees to real users
- We could reach out to the Bankr team proactively to whitelist @clonkbot or get explicit approval
- Our volume would be much lower than Grok's viral flood

**Mitigation:** Contact Bankr team before launch. They'd likely welcome this — it drives Bankr usage and fee revenue for them (they get 36.1% of every swap).

### 2. BankrBot Response Time

BankrBot processes mentions asynchronously. The token won't be deployed instantly — there could be a delay of seconds to minutes. But that's fine because:
- Our reply with the app link goes out immediately
- BankrBot's reply with the token address comes as a follow-up in the same thread
- Users see the token appear in the thread naturally

### 3. Rate Limits

BankrBot has deployment limits:
- Standard: 50 tokens/day on Base
- Bankr Club: 100/day

Since the deployer wallet is **our bot's Bankr wallet** (whoever posts the tweet), these limits apply to us. 50/day is plenty for our volume, but worth tracking.

### 4. Tweet Character Limit

X has a 280 character limit. Our reply needs to fit:
- App URL
- GitHub URL
- The @bankrbot deploy command with token name, symbol, and fee routing

This is tight. We may need to:
- Shorten the reply text
- Skip the GitHub link (users can find it in the app)
- Use abbreviated phrasing for the bankrbot command
- Or split into two tweets (reply + quote tweet)

**Example fitting in 280 chars:**
```
✅ https://meme-dashboard-a3f1b2.vercel.app
📝 https://github.com/clonkbot/meme-dashboard-a3f1b2

@bankrbot deploy Meme Dashboard symbol MEMED on Base fees to @originaluser
```
(~175 chars — fits with room to spare)

### 5. Token Name Conflicts

If someone already deployed a token with the same name/symbol, deployment might fail. BankrBot should handle this gracefully in its reply.

### 6. Who Actually "Owns" the Token?

Based on how BankrBot works with Privy:
- **The deployer** (whoever tweets the @bankrbot command) = our bot = gets a Privy wallet
- **The fee beneficiary** (@originaluser) = gets the 57% fee share routed to them
- The token is technically deployed from **our bot's wallet**, but the economic benefit (fees) goes to the user
- The user does NOT get metadata control (token name, image updates) — that stays with the deployer

This is a good tradeoff: the user gets the money, we handle the logistics.

---

## Implementation Plan

### Step 1: Add Token Detection to Tweet Processing

**File: `src/index.ts`** (~10 lines)

```typescript
const TOKEN_KEYWORDS = ['coin', 'token', 'memecoin', 'meme coin', 'crypto',
                         'launch token', 'deploy token'];
const wantsToken = TOKEN_KEYWORDS.some(kw => tweetLower.includes(kw));
```

Pass `wantsToken` through to pipeline via `PipelineInput`.

Consider adding a secondary AI classification check: "Does this user actually want a crypto token launched?" — to avoid false positives from "flip a coin" etc.

### Step 2: Add Token Symbol to Claude's Structured Output

**File: `src/services/claude.ts`** (~15 lines)

Add optional `tokenSymbol` to `OUTPUT_SCHEMA`:

```typescript
tokenSymbol: {
  type: 'string',
  description: 'Suggested 3-5 character token ticker symbol. Only if user requested a coin/token.',
},
```

Conditional system prompt addition when token is requested:

```
The user wants a crypto token launched alongside this app. Suggest a creative,
memorable 3-5 character token symbol in "tokenSymbol". Make it relevant to
the app's theme.
```

### Step 3: Modify the Reply Tweet

**File: `src/pipeline.ts`** (~15 lines)

Add `token?: 'bankr'` to `PipelineInput` interface.

When `input.token === 'bankr'`, append a @bankrbot command to the reply:

```typescript
const tokenSymbol = generatedApp.tokenSymbol
  || generatedApp.appName.replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase();

const bankrCommand = input.token === 'bankr'
  ? `\n\n@bankrbot deploy ${generatedApp.appName} symbol ${tokenSymbol} on Base fees to @${input.username}`
  : '';

const replyText = `✅ ${vercelUrl}${backendNote}\n📝 ${githubUrl}${bankrCommand}`;
```

### Step 4: That's It

No new service file. No API key. No polling. No environment variables. No Dockerfile changes.

---

## Files Changed Summary

| File | Change Type | Lines | Description |
|------|------------|-------|-------------|
| `src/index.ts` | Modified | ~10 | Add `TOKEN_KEYWORDS`, pass `token` flag to pipeline |
| `src/pipeline.ts` | Modified | ~15 | Add `token` to `PipelineInput`, append @bankrbot command to reply |
| `src/services/claude.ts` | Modified | ~15 | Optional `tokenSymbol` in output, conditional prompt |
| `.claude/skills/bankr/` | Already done | — | Bankr skill installed |

**Total: ~40 lines of code changes**

---

## Comparison: This Approach vs API Integration

| Aspect | Tag @bankrbot (this plan) | Bankr Agent API |
|--------|--------------------------|-----------------|
| Lines of code | ~40 | ~150 |
| New files | 0 | 1 (bankr.ts service) |
| API key needed | No | Yes (BANKR_API_KEY) |
| Environment changes | None | New env var + Railway config |
| Dockerfile changes | None | None |
| User gets fees | Yes (57% via fee routing) | No (our wallet gets fees) |
| Token ownership | Deployed by our bot, fees to user | Fully owned by our bot |
| Reliability | Depends on BankrBot being up | Direct API control |
| Error handling | BankrBot handles it (replies with error) | We control retry logic |
| Token in reply | BankrBot replies separately in thread | We include in our reply |
| Latency | BankrBot responds async (seconds-minutes) | We poll and include in reply |

---

## Pre-Launch Checklist

- [ ] **Contact Bankr team** — Introduce @clonkbot, explain the use case, ask about bot-to-bot policy, ideally get whitelisted
- [ ] **Test manually** — From the @clonkbot X account, post a tweet tagging @bankrbot with a deploy command + fee routing to see if it works
- [ ] **Verify fee routing** — Confirm the fee beneficiary is actually set to the @handle we specify
- [ ] **Test character limits** — Ensure the full reply with bankrbot command fits in 280 chars
- [ ] **Add token classification** — AI check to avoid false positives ("flip a coin" ≠ "deploy a coin")

---

## Future Enhancements (V2+)

1. **Parse BankrBot's reply** — Monitor the thread for BankrBot's response, extract the contract address, and post a follow-up tweet with a clean summary
2. **Token image** — Use the app screenshot as the token image (would need API integration for this)
3. **Embed token in app** — Inject token info into the generated app itself (contract address, DEX link)
4. **Fallback to API** — If BankrBot doesn't respond within X minutes, fall back to Agent API deployment

---

## Sources

- [Bankr Fee Redirecting Docs](https://docs.bankr.bot/token-launching/fee-splitting) — confirms `"fees go to @handle on x"` syntax
- [Bankr Social Deployment Guide](https://docs.bankr.bot/guides/social-deployment) — deploy via @bankrbot on X
- [Bankr Token Launching Overview](https://docs.bankr.bot/token-launching/overview) — fee structure, rate limits
- [Bankr Self-Sustaining Agent Guide](https://docs.bankr.bot/guides/self-sustaining-agent) — agent revenue model
- [BankrBot $STARKBOT Example](https://x.com/bankrbot/status/2016825605766226051) — real example of "fees to @handle"
- [Privy/BankrBot Case Study](https://privy.io/blog/bankrbot-case-study) — Privy wallet architecture
- [The Block: Grok/BankrBot Incident](https://www.theblock.co/post/346027/bankrbot-ends-groks-unintentional-token-creation-spree-by-disabling-interactions-on-x) — bot filtering context
- [Gate.io: What is Bankr Bot](https://www.gate.com/learn/articles/what-is-bankr-bot/9357) — overview
- [0x Bankr Case Study](https://0x.org/case-studies/bankr) — technical architecture
- [BankrBot/openclaw-skills](https://github.com/BankrBot/openclaw-skills) — skill source
