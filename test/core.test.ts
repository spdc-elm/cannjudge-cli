import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Client, saveSession, loadSession, minimalUser } from "../src/api.ts";
import type { Problem, ProjectFile, Submission } from "../src/api.ts";
import { parseTarget, selectProblem, submissionId } from "../src/resolve.ts";
import { buildProject, writeProject, safePath } from "../src/project.ts";
import { watch, summarize } from "../src/results.ts";
const user = { _id: "1234567890abcdef12345678", ID: 7, nickname: "test" };
const files: ProjectFile[] = [
  { path: "CMakeLists.txt", content: "server cmake", editable: false },
  { path: "op_host/op.cpp", content: "template host", editable: true },
  { path: "op_kernel/op.cpp", content: "template kernel", editable: true },
];
async function temp(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "cannjudge-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("competition/problem/submission URLs, legacy hash, and unambiguous selection", () => {
  assert.deepEqual(parseTarget("https://cannjudge.cn/public/c/mhc/submit"), {
    kind: "problem",
    group: "public",
    contest: "c",
    problem: "mhc",
  });
  assert.equal(
    parseTarget("https://cannjudge.cn/#/public/c/ranking").kind,
    "contest",
  );
  assert.equal(
    submissionId(
      "https://cannjudge.cn/public/c/mhc/submission/1234567890abcdef12345678",
    ),
    "1234567890abcdef12345678",
  );
  assert.throws(() => parseTarget("https://evil.example/public/c/mhc"));
  assert.throws(() =>
    parseTarget("https://cannjudge.cn/public/c/%2e%2e%2fsecret"),
  );
  const p: Problem[] = [
    { _id: "a", ID: 304, name: "mhc", title: "MHC Head", contest_id: "c" },
    {
      _id: "b",
      ID: 305,
      name: "mhc-grad",
      title: "MHC Gradient",
      contest_id: "c",
    },
  ];
  assert.equal(selectProblem(p, "304")._id, "a");
  assert.equal(selectProblem(p, "mhc")._id, "a");
  assert.throws(() => selectProblem(p, "MHC "), /多道/);
  assert.throws(() => selectProblem(p, "1"), /未找到/);
});
test("directory selection sends only editable template and supported extra source files", async (t) => {
  const root = await temp(t);
  await writeProject(files, root);
  await writeFile(join(root, "README.md"), "private notes");
  await writeFile(join(root, "op_host", "extra.h"), "header");
  const p = await buildProject(files, { dir: root, problemId: "p" });
  assert.deepEqual(
    p.files.map((f) => f.path),
    ["op_host/extra.h", "op_host/op.cpp", "op_kernel/op.cpp"],
  );
  assert.deepEqual(p.readonly, ["CMakeLists.txt"]);
  assert.equal(p.manifest[0].sha256.length, 64);
  await rm(join(root, "op_kernel/op.cpp"));
  await assert.rejects(
    buildProject(files, { dir: root, problemId: "p" }),
    /缺少/,
  );
});
test("single-file overlay preserves other source and rejects wrong problem/account/readonly changes", async (t) => {
  const root = await temp(t);
  await writeFile(join(root, "kernel.cpp"), "new kernel");
  const base: Submission = {
    _id: "s",
    problem_id: "p",
    user_id: user._id,
    status: "Pass",
    files,
    can_view_code: true,
  };
  const opts = {
    problemId: "p",
    userId: user._id,
    base,
    files: [`op_kernel/op.cpp=${join(root, "kernel.cpp")}`],
  };
  const p = await buildProject(files, opts);
  assert.equal(
    p.files.find((f) => f.path === "op_host/op.cpp")?.content,
    "template host",
  );
  assert.equal(
    p.files.find((f) => f.path === "op_kernel/op.cpp")?.content,
    "new kernel",
  );
  await assert.rejects(
    buildProject(files, { ...opts, problemId: "other" }),
    /同一道题/,
  );
  await assert.rejects(
    buildProject(files, { ...opts, userId: "other" }),
    /当前账户/,
  );
  await assert.rejects(
    buildProject(files, {
      ...opts,
      files: [`CMakeLists.txt=${join(root, "kernel.cpp")}`],
    }),
    /只读/,
  );
});
test("download and upload reject traversal, overwrite, and escaping symlinks", async (t) => {
  const root = await temp(t),
    out = join(root, "out");
  await mkdir(out);
  for (const p of ["../a", "/etc/passwd", "a/../../b", "a\\b", "C:/x", "a//b"])
    assert.throws(() => safePath(p));
  await symlink(root, join(out, "op_host"));
  await assert.rejects(writeProject(files, out), /符号链接/);
  await writeProject(files, join(root, "project"));
  await assert.rejects(writeProject(files, join(root, "project")), /已存在/);
  await writeFile(join(root, "secret.h"), "private");
  await symlink(join(root, "secret.h"), join(root, "project/op_host/escape.h"));
  await assert.rejects(
    buildProject(files, { dir: join(root, "project"), problemId: "p" }),
    /越界/,
  );
});
test("credentials persist privately without passwords and validate the origin", async (t) => {
  const root = join(await temp(t), "config");
  await saveSession(
    minimalUser({ ...user, password: "never-save" }),
    "session=secret",
    root,
  );
  assert.deepEqual((await loadSession(root))?.user, user);
  const raw = await readFile(join(root, "session.json"), "utf8");
  assert(!raw.includes("never-save"));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "session.json"))).mode & 0o777, 0o600);
  await assert.rejects(saveSession(user, "bad\r\nheader", root));
  await writeFile(
    join(root, "session.json"),
    raw.replace("https://cannjudge.cn", "https://evil.example"),
  );
  await assert.rejects(loadSession(root), /站点/);
});
test("HTTP login captures session cookie, subsequent requests use it, failed POST is not retried", async (t) => {
  let posts = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/api/users/login") {
      posts++;
      assert.equal(req.method, "POST");
      let text = "";
      for await (const c of req) text += c;
      assert.equal(JSON.parse(text).password, "secret");
      res.setHeader("Set-Cookie", "session=valid; Path=/; HttpOnly; Secure");
      res.end(JSON.stringify(user));
    } else if (req.url === "/api/fail") {
      posts++;
      res.writeHead(500).end(JSON.stringify({ message: "failed" }));
    } else if (req.headers.cookie === "session=valid")
      res.end(JSON.stringify({ ok: true }));
    else res.writeHead(401).end(JSON.stringify({ message: "login required" }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const c = new Client(undefined, "", origin);
  await assert.rejects(c.request("/api/private"), /login required/);
  await c.request(
    "/api/users/login",
    {},
    { account: "test", password: "secret" },
  );
  assert.equal(c.cookie, "session=valid");
  assert.deepEqual(await c.request("/api/private"), { ok: true });
  await assert.rejects(c.request("/api/fail", {}, {}), /failed/);
  assert.equal(posts, 2);
});
test("watch follows running to Pass, preserves case errors, and times out without resubmitting", async () => {
  let calls = 0;
  const base: Submission = {
    _id: "s",
    problem_id: "p",
    user_id: user._id,
    status: "Running",
    result: [],
  };
  const done = await watch(
    {
      submission: async () => ({
        ...base,
        status: ++calls < 2 ? "Running" : "Pass",
        result:
          calls < 2
            ? []
            : [{ testcase_id: "t", testcase_status: "Pass", time: 2.5 }],
      }),
    },
    "s",
    { intervalMs: 1, timeoutMs: 1000 },
  );
  assert.equal(done.timedOut, false);
  assert.equal(summarize(done.submission).passed, 1);
  assert.equal(calls, 2);
  const timed = await watch({ submission: async () => base }, "s", {
    intervalMs: 5,
    timeoutMs: 12,
  });
  assert.equal(timed.timedOut, true);
  const fail = await watch(
    {
      submission: async () => ({
        ...base,
        status: "Fail",
        result: [
          {
            testcase_id: "t",
            testcase_status: "Fail",
            msg: "precision mismatch",
          },
        ],
      }),
    },
    "s",
    { intervalMs: 1, timeoutMs: 100 },
  );
  assert.equal(
    summarize(fail.submission).cases[0].message,
    "precision mismatch",
  );
});
