import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, ORIGIN } from "../src/api.ts";
import { loadSession, saveSession } from "../src/accounts.ts";
import { gitcodeLogin, renewGitCodeSession, sessionClient } from "../src/gitcode.ts";

const user = { _id: "1234567890abcdef12345678", ID: 7, nickname: "example" };
const other = { _id: "87654321abcdef1234567890", ID: 8, nickname: "other" };
const callback = ORIGIN + "/api/users/oauth/gitcode/callback";
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const moved = (url: string, headers = {}) => new Response(null, { status: 302, headers: { Location: url, ...headers } });
const tokenSession = { getToken: async () => "example-gitcode-token", refresh: async () => "example-refreshed-token" };

function oauth(t: TestContext, options: { init?: string; approved?: string; finish?: string; wrongUser?: boolean; first401?: boolean } = {}) {
  const counts = { authorize: 0, exchange: 0, oldReads: 0, newReads: 0 };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.href === ORIGIN + "/api/users/oauth/gitcode/authorize?scene=login") {
      assert.equal(headers.get("authorization"), null);
      return moved(options.init || "https://gitcode.com/oauth/authorize?" + new URLSearchParams({
        client_id: "example-client", redirect_uri: callback, response_type: "code", state: "example-state", scope: "all_user",
      }), { "Set-Cookie": "oauth_example=state; Path=/api; HttpOnly" });
    }
    if (url.href === "https://web-api.gitcode.com/uc/api/v1/oauth/authorize") {
      counts.authorize++;
      assert.equal(init?.redirect, "manual");
      assert.equal(headers.get("cookie"), null);
      assert.match(headers.get("authorization")!, /^Bearer example-(gitcode|refreshed)-token$/);
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("scopes"), "all_user");
      assert.equal(form.get("redirect_uri"), callback);
      if (options.first401 && counts.authorize === 1) return json({}, 401);
      return moved(options.approved || callback + "?code=example-code&state=example-state");
    }
    assert.equal(url.origin, ORIGIN, "tokens and tickets must never follow untrusted origins");
    assert.equal(headers.get("authorization"), null, "GitCode bearer must never reach Judge");
    if (url.pathname === "/api/users/oauth/gitcode/callback") {
      assert.equal(headers.get("cookie"), "oauth_example=state");
      return moved(options.finish || "/auth/gitcode/callback?mode=login&ticket=example-ticket");
    }
    if (url.pathname === "/api/users/oauth/gitcode/login/exchange") {
      counts.exchange++;
      assert.deepEqual(JSON.parse(String(init?.body)), { ticket: "example-ticket" });
      return json(options.wrongUser ? other : user, 200, { "Set-Cookie": "cannjudge_auth=example-fresh; Path=/api; HttpOnly" });
    }
    if (url.pathname === "/api/users/me/7") {
      if (headers.get("cookie")?.includes("cannjudge_auth=example-fresh")) {
        counts.newReads++;
        return json(user);
      }
      counts.oldReads++;
      return json({ code: 401, message: "expired" }, 401);
    }
    assert.fail("Unexpected OAuth request path");
  });
  return counts;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "cannjudge-gitcode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Test-only CANNLab adapter; no real credentials or network are used.
  await writeFile(join(dir, "auth.mjs"), `export class AuthSession {
    async getToken() { return 'example-gitcode-token'; }
    async refresh() { return 'example-refreshed-token'; }
  }`);
  const previous = process.env.CANNLAB_ROOT;
  process.env.CANNLAB_ROOT = dir;
  t.after(() => { if (previous === undefined) delete process.env.CANNLAB_ROOT; else process.env.CANNLAB_ROOT = previous; });
  return dir;
}

test("GitCode OAuth exchanges its token for a verified Judge cookie, recovering one GitCode 401", async t => {
  const counts = oauth(t, { first401: true });
  const result = await gitcodeLogin("unused", user, tokenSession);
  assert.deepEqual(result.user, user);
  assert.match(result.cookie, /cannjudge_auth=example-fresh/);
  assert.equal(counts.authorize, 2);
  assert.equal(counts.exchange, 1);
  assert.equal(counts.newReads, 1);
});

test("untrusted redirects, changed scopes, state mismatch and registration never exchange a ticket", async t => {
  for (const options of [
    { init: "https://untrusted.example/oauth/authorize" },
    { init: "https://gitcode.com/oauth/authorize?client_id=x&state=x&scope=all_key&redirect_uri=" + encodeURIComponent(callback) },
    { approved: "https://untrusted.example/callback?code=example-code&state=example-state" },
    { approved: callback + "?code=example-code&state=wrong-state" },
    { finish: "/auth/register?ticket=example-ticket" },
  ]) {
    await t.test(JSON.stringify(Object.keys(options)), async child => {
      const counts = oauth(child, options);
      await assert.rejects(gitcodeLogin("unused", user, tokenSession));
      assert.equal(counts.exchange, 0);
    });
  }
});

test("concurrent Judge 401s renew once, persist the profile and association, and preserve the active account", async t => {
  const dir = await fixture(t);
  await saveSession(other, "cannjudge_auth=other-example", dir, "other");
  const saved = await saveSession(user, "cannjudge_auth=expired-example", dir, "work", {
    activate: false, gitcodeAuthFile: join(dir, "gitcode-example.json"),
  });
  const counts = oauth(t);
  const client = sessionClient(saved, dir);
  assert.deepEqual(await Promise.all([client.currentUser(), client.currentUser()]), [user, user]);
  assert.equal(counts.authorize, 1);
  assert.equal(counts.oldReads, 2);
  assert.equal((await loadSession(dir))!.user._id, other._id);
  const fresh = (await loadSession(dir, "work"))!;
  assert.match(fresh.cookie, /example-fresh/);
  assert.equal(fresh.gitcodeAuthFile, saved.gitcodeAuthFile);
  assert.equal((await stat(join(dir, "accounts", `${user._id}.json`))).mode & 0o777, 0o600);
});

test("a wrong GitCode identity cannot overwrite a profile cookie or associate its credentials", async t => {
  const dir = await fixture(t);
  const saved = await saveSession(user, "cannjudge_auth=old-example", dir, "work");
  const file = join(dir, "accounts", `${user._id}.json`);
  const before = await readFile(file, "utf8");
  oauth(t, { wrongUser: true });
  await assert.rejects(renewGitCodeSession(saved, join(dir, "wrong-example.json"), dir), /身份.*不一致/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("only an explicit Judge 401 is replayed once; uncertain POSTs and 5xx are not replayed", async t => {
  for (const status of [401, 500, 429, "network"] as const) {
    let calls = 0, renewals = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (status === "network") throw new Error("example network interruption");
      return json({ code: status, message: "example rejected" }, status);
    });
    const client = new Client(user, "cannjudge_auth=example");
    client.reauthenticate = async () => { renewals++; };
    await assert.rejects(client.request("/api/submissions", {}, { files: [] }));
    assert.equal(calls, status === 401 ? 2 : 1);
    assert.equal(renewals, status === 401 ? 1 : 0);
  }
});
