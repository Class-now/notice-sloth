import { EXTRACTION_SCHEMA, skim, toIcs, todayIn } from "./core.js";

export const MODEL = "@cf/google/gemma-4-26b-a4b-it";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Workers AI returns either { response } or an OpenAI-style { choices } depending on the model.
function replyText(out) {
  if (out == null) return "";
  if (typeof out.response === "string" || typeof out.response === "object") return out.response;
  const msg = out.choices?.[0]?.message?.content;
  return msg ?? "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/skim" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "send JSON: { notices, profile }" }, 400);
      }
      const offset = Number.isFinite(body.offsetMinutes) ? body.offsetMinutes : 540;
      const started = Date.now();
      const ask = async (messages) =>
        replyText(
          await env.AI.run(MODEL, {
            messages,
            max_tokens: 1200,
            temperature: 0.1,
            // Gemma 4 thinks by default and can spend the whole budget before answering.
            // Extraction does not need it, so switch it off.
            chat_template_kwargs: { enable_thinking: false },
            response_format: { type: "json_schema", json_schema: EXTRACTION_SCHEMA },
          })
        );
      const results = await skim(body.notices, String(body.profile || "").slice(0, 600), ask, {
        today: todayIn(offset),
      });
      if (results.length === 0) return json({ error: "no notices found" }, 400);
      return json({
        model: MODEL,
        ms: Date.now() - started,
        results,
        ics: toIcs(results, { offsetMinutes: offset }),
      });
    }

    if (url.pathname === "/api/health") return json({ ok: true, model: MODEL });

    return env.ASSETS.fetch(request);
  },
};
