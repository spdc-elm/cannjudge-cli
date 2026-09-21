import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client, ApiError, ORIGIN } from "../src/api.ts";
import {
  loadSession,
  saveSession,
  listAccounts,
  useAccount,
  logout,
} from "../src/accounts.ts";
import {
  beijingDay,
  getUsage,
  recordEvent,
  submitProject,
} from "../src/usage.ts";

const user = { _id: "1234567890abcdef12345678", ID: 7, nickname: "primary" };
const other = { _id: "87654321abcdef1234567890", ID: 8, nickname: "secondary" };
const now = new Date("2026-09-21T15:00:00.000Z");
async function temp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cannjudge-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const http = createServer(handler);
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise<void>((ok) => http.close(() => ok())));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}
function row(id: string, created: string, owner = user._id) {
  return {
    _id: id,
    user_id: owner,
    problem_id: "problem",
    create_time: created,
    status: "Compile Error",
  };
}
async function observe(
  dir: string,
  accountId = user._id,
  at = now.toISOString(),
) {
  await recordEvent(
    {
      requestId: "rejected-probe",
      accountId,
      problemId: "problem",
      at,
      kind: "attempt",
    },
    dir,
  );
  await recordEvent(
    {
      requestId: "rejected-probe",
      accountId,
      problemId: "problem",
      at,
      kind: "rejected",
      httpStatus: 429,
    },
    dir,
  );
}
test("legacy migration preserves credentials; profiles stay isolated and logout never selects another account", async (t) => {
  const dir = await temp(t);
  await writeFile(
    join(dir, "session.json"),
    JSON.stringify({
      origin: ORIGIN,
      user,
      cookie: "session=first",
      savedAt: now.toISOString(),
    }),
  );
  assert.equal((await loadSession(dir))?.cookie, "session=first");
  await assert.rejects(stat(join(dir, "session.json")), { code: "ENOENT" });
  await saveSession(other, "session=second", dir, "work");
  assert.equal((await loadSession(dir, "7"))?.cookie, "session=first");
  assert.equal((await loadSession(dir))?.user._id, other._id);
  assert.equal((await listAccounts(dir)).filter((s) => s.active).length, 1);
  assert(!JSON.stringify(await listAccounts(dir)).includes("session="));
  await assert.rejects(saveSession(user, "session=first", dir, "work"), /已被/);
  await assert.rejects(loadSession(dir, "missing"), /不存在/);
  await useAccount("7", dir);
  assert.equal((await loadSession(dir))?.user._id, user._id);
  await logout(dir);
  assert.equal(await loadSession(dir), undefined);
  assert.equal((await loadSession(dir, "work"))?.cookie, "session=second");
  assert.equal(
    (await stat(join(dir, "accounts", `${other._id}.json`))).mode & 0o777,
    0o600,
  );
});
test("usage counts all account history, including failures, with pagination and Beijing midnight", async (t) => {
  const dir = await temp(t);
  const rows = Array.from({ length: 101 }, (_, i) =>
    row(String(i), "2026-09-21T01:00:00Z"),
  );
  rows.push(
    row("boundary", "2026-09-20T16:00:00Z"),
    row("old", "2026-09-20T15:59:59Z"),
  );
  let pages = 0;
  const origin = await server(t, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === `/api/users/me/${user.ID}`)
      res.end(JSON.stringify(user));
    else if (url.pathname === `/api/submissions/user/${user._id}`) {
      pages++;
      const offset = Number(url.searchParams.get("skip"));
      res.end(
        JSON.stringify({
          list: rows.slice(offset, offset + 100),
          total: rows.length,
        }),
      );
    } else res.writeHead(404).end("{}");
  });
  const c = new Client(user, "session=first", origin);
  const q = await getUsage(c, dir, now);
  assert.equal(q.submittedToday, 102);
  assert.equal(pages, 2);
  assert.equal(
    beijingDay(new Date("2026-09-21T16:00:00.000Z")).date,
    "2026-09-22",
  );
  rows[0].user_id = other._id;
  await assert.rejects(getUsage(c, dir, now), /账号/);
});
test("local outcomes remain separate from official usage and are scoped to account and date", async (t) => {
  const dir = await temp(t);
  const origin = await server(t, (req, res) => {
    if (req.url?.startsWith("/api/users/me/"))
      res.end(JSON.stringify(req.url.endsWith("/7") ? user : other));
    else res.end(JSON.stringify({ list: [], total: 0 }));
  });
  await observe(dir);
  await recordEvent(
    {
      requestId: "lost-response",
      accountId: user._id,
      problemId: "p",
      at: now.toISOString(),
      kind: "attempt",
    },
    dir,
  );
  const c = new Client(user, "session=first", origin);
  const q = await getUsage(c, dir, now);
  assert.equal(q.submittedToday, 0);
  assert.deepEqual(q.localToday, {
    attempted: 2,
    accepted: 0,
    rejected: 1,
    unknown: 1,
  });
  const next = await getUsage(c, dir, new Date("2026-09-21T16:00:00.000Z"));
  assert.equal(next.submittedToday, 0);
  assert.equal(next.localToday.attempted, 0);
  const q2 = await getUsage(
    new Client(other, "session=second", origin),
    dir,
    now,
  );
  assert.equal(q2.localToday.attempted, 0);
});
test("429 is recorded, never automatically retried, and does not locally block the next explicit submit", async (t) => {
  const dir = await temp(t);
  let posts = 0;
  const origin = await server(t, (req, res) => {
    if (req.method === "POST") {
      posts++;
      res
        .writeHead(429)
        .end(JSON.stringify({ code: 429, message: "Daily limit reached" }));
    } else if (req.url === `/api/users/me/${user.ID}`)
      res.end(JSON.stringify(user));
    else res.end(JSON.stringify({ list: [], total: 0 }));
  });
  const c = new Client(user, "session=first", origin);
  await assert.rejects(
    submitProject(c, "p", [], dir),
    (e) => e instanceof ApiError && e.status === 429,
  );
  assert.equal(posts, 1);
  await assert.rejects(
    submitProject(c, "p", [], dir),
    (e) => e instanceof ApiError && e.status === 429,
  );
  assert.equal(posts, 2);
  const q = await getUsage(c, dir);
  assert.equal(q.localToday.rejected, 2);
  assert.equal(q.localToday.accepted, 0);
  const log = await readFile(
    join(dir, "submissions", `${user._id}.jsonl`),
    "utf8",
  );
  assert(!log.includes("session=first"));
});
test("accepted and interrupted requests are distinct, and mismatched sessions cannot submit", async (t) => {
  const dir = await temp(t);
  let posts = 0;
  const origin = await server(t, (req, res) => {
    if (req.method === "POST") {
      posts++;
      if (posts === 1)
        res.end(JSON.stringify({ data: { submissionId: "accepted" } }));
      else res.writeHead(500).end(JSON.stringify({ message: "internal" }));
    } else if (req.url?.startsWith("/api/users/me/"))
      res.end(JSON.stringify(user));
    else res.end(JSON.stringify({ list: [], total: 0 }));
  });
  const c = new Client(user, "session=first", origin);
  assert.equal(await submitProject(c, "p", [], dir), "accepted");
  await assert.rejects(submitProject(c, "p", [], dir), /internal/);
  const q = await getUsage(c, dir);
  assert.deepEqual(q.localToday, {
    attempted: 2,
    accepted: 1,
    rejected: 0,
    unknown: 1,
  });
  assert.equal(q.submittedToday, 0);
  // A session mismatch must fail before touching another account's history or submitting.
  const wrong = new Client(other, "session=first", origin);
  await assert.rejects(submitProject(wrong, "p", [], dir));
  assert.equal(posts, 2);
});
