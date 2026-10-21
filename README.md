# 🦥 Notice Sloth

Reads your university notices so you don't have to.

Paste a week of notices from your university portal (Japanese or English). Gemma, Google's open-weight model, reads each one and tells you:

- what it is about, in one English line and one Japanese line
- whether it is actually addressed to you, compared against a short profile you write once
- what you must do, by when, and where

Then plain code sorts everything into **Do this / Good to know / Not for you** and gives you a calendar file (.ics) with a reminder the day before each deadline.

**Live demo:** https://notice-sloth.shotaro-takakura.workers.dev — press "Load sample notices (fictional)", then "Read them for me".

Built for the [DEV Hacktoberfest Open-Source AI Challenge, Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19).

## How it works

```
notices ──► split on "---" ──► Gemma (one call per notice, JSON schema) ──► normalise + validate
                                                                                   │
                         .ics (only "Do this" deadlines) ◄── bucket in code ◄──────┘
```

- `src/core.js` — everything that matters: the prompt, the JSON schema, validation (bad dates and times are dropped, not guessed), the bucket rule, and the .ics writer. Shared by the web app and the CLI.
- `src/worker.js` — Cloudflare Worker. Calls `@cf/google/gemma-4-26b-a4b-it` on Workers AI with Gemma 4's thinking turned off (`chat_template_kwargs: { enable_thinking: false }`), because extraction doesn't need it and thinking can use up the whole token budget before any answer comes out.
- `local/skim.mjs` — the same pipeline against Ollama, fully offline.
- `public/index.html` — a single page, no framework.

The model only reads. The decision is code:

| model says | bucket |
|---|---|
| not addressed to you (`applies_to_me: "no"`) | Not for you |
| you must act (`action_required` and not `action_optional`, with at least one task) | Do this |
| anything else (info, cancellations, opt-in events) | Good to know |

## Run it offline (nothing leaves your laptop)

Requires [Ollama](https://ollama.com) and Node 20+.

```bash
ollama pull gemma4:e2b        # about 4.6 GB, fits an 8 GB laptop
node local/skim.mjs public/samples/notices.txt --profile public/samples/profile.txt
```

It prints the buckets and writes `notice-sloth.ics`. Use a bigger model with `NOTICE_SLOTH_MODEL=gemma4:12b`.

## Deploy your own

```bash
npm install
npx wrangler login
npx wrangler deploy
```

The Worker needs only the Workers AI binding (already in `wrangler.jsonc`). One notice costs about 8 neurons.

## Tests

```bash
npm test
```

## Notes

- The sample notices in `public/samples/` are made up. They imitate the style of Japanese university notices; they are not from any real university.
- The hosted demo sends the text you paste to Workers AI and does not store it. If your notices contain anything personal, use the offline CLI.
- Limits: 8 notices per run, 4,000 characters each.

## License

MIT
