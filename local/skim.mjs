#!/usr/bin/env node
// Same skim, fully offline: Gemma on Ollama, nothing leaves your laptop.
//
//   ollama pull gemma4:e2b          # ~4.6 GB, fits an 8 GB laptop
//   node local/skim.mjs public/samples/notices.txt --profile public/samples/profile.txt
//
// Writes notice-sloth.ics next to you and prints the buckets.
// Env: OLLAMA_HOST (default http://localhost:11434), NOTICE_SLOTH_MODEL (default gemma4:e2b)

import { readFileSync, writeFileSync } from "node:fs";
import { EXTRACTION_SCHEMA, skim, toIcs } from "../src/core.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const profileFlag = args.indexOf("--profile");
if (!file) {
  console.error("usage: node local/skim.mjs <notices.txt> [--profile profile.txt] [--out file.ics]");
  process.exit(1);
}
const outFlag = args.indexOf("--out");
const out = outFlag >= 0 ? args[outFlag + 1] : "notice-sloth.ics";
const notices = readFileSync(file, "utf8");
const profile = profileFlag >= 0 ? readFileSync(args[profileFlag + 1], "utf8") : "";

const host = process.env.OLLAMA_HOST || "http://localhost:11434";
const model = process.env.NOTICE_SLOTH_MODEL || "gemma4:e2b";

// Ollama runs one request at a time on a small laptop; queue them instead of flooding it.
let chain = Promise.resolve();
const ask = (messages) => {
  const run = async () => {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, think: false, format: EXTRACTION_SCHEMA, options: { temperature: 0.1 } }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    return (await res.json()).message.content;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
};

const started = Date.now();
const results = await skim(notices, profile, ask);
writeFileSync(out, toIcs(results));

const label = { do: "DO", fyi: "FYI", skip: "SKIP" };
for (const r of results) {
  console.log(`\n[${label[r.bucket]}] ${r.title}`);
  console.log(`  ${r.summary_en}`);
  if (r.applies_reason) console.log(`  for me? ${r.applies_to_me} — ${r.applies_reason}`);
  for (const t of r.tasks) console.log(`  - ${t.what}${t.due_date ? ` (due ${t.due_date}${t.due_time ? " " + t.due_time : ""})` : ""}`);
  if (r.error) console.log(`  ! ${r.error}`);
}
console.log(`\n${results.length} notices, ${((Date.now() - started) / 1000).toFixed(1)}s with ${model}. Calendar: ${out}`);
