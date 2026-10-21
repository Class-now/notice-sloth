import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketOf, normalise, parseModelJson, skim, splitNotices, toIcs, todayIn } from "../src/core.js";

test("splits notices on --- lines and caps the count", () => {
  assert.deepEqual(splitNotices("a\n---\nb\n -----  \nc"), ["a", "b", "c"]);
  assert.equal(splitNotices(Array(20).fill("x").join("\n---\n")).length, 8);
});

test("parses JSON wrapped in fences or chatter", () => {
  assert.deepEqual(parseModelJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseModelJson("no json here"));
});

test("drops invented or malformed dates and times", () => {
  const n = normalise({
    applies_to_me: "maybe",
    action_required: true,
    tasks: [
      { what: "submit", due_date: "2026-02-30", due_time: "17:00" },
      { what: "attend", due_date: "2026-11-05", due_time: "25:00" },
      { what: "apply", due_date: "2026-11-07", due_time: "17:00", where: "" },
    ],
  });
  assert.equal(n.applies_to_me, "unclear");
  assert.equal(n.tasks[0].due_date, null);
  assert.equal(n.tasks[0].due_time, null);
  assert.equal(n.tasks[1].due_time, null);
  assert.equal(n.tasks[2].due_time, "17:00");
  assert.equal(n.tasks[2].where, null);
});

test("bucket is decided in code", () => {
  const base = normalise({ action_required: true, tasks: [{ what: "x" }] });
  assert.equal(bucketOf({ ...base, applies_to_me: "yes" }), "do");
  assert.equal(bucketOf({ ...base, applies_to_me: "unclear" }), "do");
  assert.equal(bucketOf({ ...base, applies_to_me: "no" }), "skip");
  assert.equal(bucketOf({ ...base, action_required: false }), "fyi");
  assert.equal(bucketOf({ ...base, applies_to_me: "yes", action_optional: true }), "fyi");
});

test("ics: timed deadline converted from JST to UTC, all-day otherwise, only for 'do'", () => {
  const results = [
    { bucket: "do", title: "T", summary_en: "s", summary_ja: "j", tasks: [
      { what: "Fix courses", due_date: "2026-10-31", due_time: "17:00", where: "portal" },
      { what: "Renew", due_date: "2026-11-14", due_time: null, where: null },
    ] },
    { bucket: "skip", title: "S", summary_en: "", summary_ja: "", tasks: [{ what: "no", due_date: "2026-11-05", due_time: null }] },
  ];
  const ics = toIcs(results, { now: new Date("2026-10-22T00:00:00Z") });
  assert.match(ics, /DTEND:20261031T080000Z/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261114/);
  assert.match(ics, /DTEND;VALUE=DATE:20261115/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(ics.split("\r\n").every((l) => l.length <= 75));
});

test("todayIn uses the given offset", () => {
  assert.equal(todayIn(540, new Date("2026-10-21T16:00:00Z")), "2026-10-22");
  assert.equal(todayIn(-420, new Date("2026-10-21T03:00:00Z")), "2026-10-20");
});

test("skim survives a broken model reply and sorts do first", async () => {
  const replies = [
    '{"title":"A","applies_to_me":"no","action_required":true,"tasks":[{"what":"x","due_date":"2026-11-01"}]}',
    "garbage",
    '{"title":"C","applies_to_me":"yes","action_required":true,"tasks":[{"what":"y","due_date":"2026-10-30"}]}',
  ];
  let i = 0;
  const out = await skim("a\n---\nb\n---\nc", "", async () => replies[i++], { today: "2026-10-22" });
  assert.deepEqual(out.map((r) => r.bucket), ["do", "fyi", "skip"]);
  assert.ok(out[1].error);
});
