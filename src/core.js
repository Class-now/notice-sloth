// Shared logic for the Worker (Gemma on Workers AI) and the local CLI (Gemma on Ollama).
// The model only reads text. Everything that decides what you see — the bucket,
// the dates, the calendar file — is plain code in this file.

export const MAX_NOTICES = 8;
export const MAX_CHARS_PER_NOTICE = 4000;

// JSON schema the model must fill. Kept small on purpose: small open models
// follow short schemas much more reliably than long ones.
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary_en: { type: "string" },
    summary_ja: { type: "string" },
    audience: { type: "string" },
    applies_to_me: { type: "string", enum: ["yes", "no", "unclear"] },
    applies_reason: { type: "string" },
    action_required: { type: "boolean" },
    action_optional: { type: "boolean" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          what: { type: "string" },
          due_date: { type: ["string", "null"] },
          due_time: { type: ["string", "null"] },
          where: { type: ["string", "null"] },
        },
        required: ["what", "due_date", "due_time", "where"],
      },
    },
  },
  required: [
    "title",
    "summary_en",
    "summary_ja",
    "audience",
    "applies_to_me",
    "applies_reason",
    "action_required",
    "action_optional",
    "tasks",
  ],
};

export function splitNotices(raw) {
  return String(raw || "")
    .split(/\n\s*-{3,}\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_NOTICES)
    .map((s) => s.slice(0, MAX_CHARS_PER_NOTICE));
}

export function buildMessages(notice, profile, today) {
  const system = [
    "You read university notices for a lazy student so they never have to.",
    "Return ONLY a JSON object that matches the schema. No prose, no code fences.",
    "Fields:",
    "- title: short title of the notice, in the notice's language.",
    "- summary_en: one plain English sentence: what this notice is about.",
    "- summary_ja: the same sentence in natural Japanese.",
    "- audience: who the notice is addressed to, as written in the notice.",
    "- applies_to_me: compare audience with the student profile. 'yes' if the student is clearly included, 'no' if clearly excluded, 'unclear' otherwise.",
    "- applies_reason: one short sentence explaining that judgement.",
    "- action_required: true only if the notice asks the reader to do something (submit, register, attend, pay, reply).",
    "- action_optional: true if the action is opt-in (e.g. 'apply if you are interested'); false if the reader loses something by not doing it.",
    "- tasks: each concrete thing to do. due_date as YYYY-MM-DD, due_time as HH:MM (24h), where = place or URL or office. Use null when the notice does not say.",
    `Today is ${today}. When a date has no year, pick the next occurrence on or after today.`,
    "Never invent dates, places or tasks that are not in the notice.",
  ].join("\n");
  const user = `Student profile:\n${profile || "(not given)"}\n\nNotice:\n${notice}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// Pull the first JSON object out of a model reply (tolerates code fences / chatter).
export function parseModelJson(text) {
  if (text && typeof text === "object") return text;
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  return JSON.parse(s.slice(start, end + 1));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(d) {
  if (typeof d !== "string" || !DATE_RE.test(d)) return null;
  const t = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d ? null : d;
}

function str(v, max = 400) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// Normalise whatever the model produced into a shape the UI can trust.
export function normalise(raw) {
  const applies = ["yes", "no", "unclear"].includes(raw?.applies_to_me) ? raw.applies_to_me : "unclear";
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
  return {
    title: str(raw?.title, 120) || "(untitled notice)",
    summary_en: str(raw?.summary_en),
    summary_ja: str(raw?.summary_ja),
    audience: str(raw?.audience, 200),
    applies_to_me: applies,
    applies_reason: str(raw?.applies_reason),
    action_required: raw?.action_required === true,
    action_optional: raw?.action_optional === true,
    tasks: tasks.slice(0, 6).map((t) => {
      const due_date = validDate(t?.due_date);
      return {
        what: str(t?.what, 200) || "(no description)",
        due_date,
        due_time: due_date && TIME_RE.test(t?.due_time ?? "") ? t.due_time : null,
        where: str(t?.where, 200) || null,
      };
    }),
  };
}

// The decision is code, not model: "do" only when there is something you must do
// AND it is not clearly for someone else. Opt-in events stay in FYI.
export function bucketOf(n) {
  if (n.applies_to_me === "no") return "skip";
  if (n.action_required && !n.action_optional && n.tasks.length > 0) return "do";
  return "fyi";
}

const BUCKET_ORDER = { do: 0, fyi: 1, skip: 2 };

export function sortResults(results) {
  const firstDue = (r) => r.tasks.map((t) => t.due_date).filter(Boolean).sort()[0] || "9999-12-31";
  return [...results].sort(
    (a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || firstDue(a).localeCompare(firstDue(b))
  );
}

// ---------- .ics ----------

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

function fold(line) {
  // RFC 5545: lines longer than 75 octets are folded. Fold by characters (safe for UTF-8 readers).
  const out = [];
  let rest = line;
  while (rest.length > 60) {
    out.push(rest.slice(0, 60));
    rest = " " + rest.slice(60);
  }
  out.push(rest);
  return out.join("\r\n");
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// offsetMinutes: local time zone offset from UTC (JST = +540).
export function toIcs(results, { offsetMinutes = 540, now = new Date() } = {}) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//notice-sloth//EN", "CALSCALE:GREGORIAN"];
  let i = 0;
  for (const r of results) {
    if (r.bucket !== "do") continue;
    for (const t of r.tasks) {
      if (!t.due_date) continue;
      i += 1;
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:notice-sloth-${utcStamp(now)}-${i}@notice-sloth`);
      lines.push(`DTSTAMP:${utcStamp(now)}`);
      if (t.due_time) {
        const [h, m] = t.due_time.split(":").map(Number);
        const local = Date.UTC(...t.due_date.split("-").map((v, k) => (k === 1 ? Number(v) - 1 : Number(v))), h, m);
        const start = new Date(local - offsetMinutes * 60000);
        lines.push(`DTSTART:${utcStamp(new Date(start.getTime() - 30 * 60000))}`);
        lines.push(`DTEND:${utcStamp(start)}`);
      } else {
        const d = t.due_date.replace(/-/g, "");
        const next = new Date(`${t.due_date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        lines.push(`DTSTART;VALUE=DATE:${d}`);
        lines.push(`DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`);
      }
      lines.push(fold(`SUMMARY:${icsEscape(`[Due] ${t.what}`)}`));
      const desc = [r.title, r.summary_en, r.summary_ja, t.where ? `Where: ${t.where}` : ""].filter(Boolean).join("\n");
      lines.push(fold(`DESCRIPTION:${icsEscape(desc)}`));
      if (t.where) lines.push(fold(`LOCATION:${icsEscape(t.where)}`));
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P1D", fold(`DESCRIPTION:${icsEscape(t.what)}`), "END:VALARM");
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function todayIn(offsetMinutes = 540, now = new Date()) {
  return new Date(now.getTime() + offsetMinutes * 60000).toISOString().slice(0, 10);
}

// Run every notice through `ask(messages) -> text|object`, then decide in code.
export async function skim(rawNotices, profile, ask, { today = todayIn() } = {}) {
  const notices = splitNotices(rawNotices);
  const results = await Promise.all(
    notices.map(async (notice, index) => {
      try {
        const n = normalise(parseModelJson(await ask(buildMessages(notice, profile, today))));
        return { index, ...n, bucket: bucketOf(n) };
      } catch (e) {
        return {
          index,
          ...normalise({ title: notice.split("\n")[0].slice(0, 80) }),
          bucket: "fyi",
          error: String(e?.message || e),
        };
      }
    })
  );
  return sortResults(results);
}
