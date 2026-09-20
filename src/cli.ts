#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Client, loadSession, ORIGIN } from "./api.ts";
import type { Submission, User } from "./api.ts";
import { auth } from "./auth.ts";
import { resolve, problemUrl, submissionId } from "./resolve.ts";
import { buildProject, writeProject } from "./project.ts";
import { summarize, watch, pending } from "./results.ts";
const HELP = `cannjudge — Node.js/TypeScript CLI (Node >=22.18)

  inspect URL [--problem SLUG|TITLE|ID] [--json]
    比赛链接 → 题目列表及题目链接；题目链接 → 完整 Markdown 题面。
  template URL --out DIR [--problem SELECTOR]
    下载完整工程模板；不覆盖已有文件。
  submit URL --dir DIR [--file REMOTE=LOCAL ...] [--dry-run] [--watch]
  submit URL --base SUBMISSION_URL --file REMOTE=LOCAL [--watch]
    按平台模板路径匹配；忽略只读文件，不上传 README/测试/构建目录。
    --base 必须是当前账户同一道题的提交，合成完整工程后一次提交。
  status SUBMISSION_URL|ID [--watch] [--interval 5] [--timeout 600]
  download SUBMISSION_URL|ID --out DIR
    导出自己的历史提交源码。
  submissions URL [--mine] [--page 1] [--limit 20]
  ranking URL [--problem SELECTOR] [--page 1] [--limit 20]
  auth captcha [--out DIR]
  auth login --account EMAIL --challenge FILE --code CODE [--password-stdin]
  auth import --file FILE|-    导入自己的浏览器会话 {user, cookie} JSON
  auth import --listen        临时本地表单导入（Cookie 不进入命令行）
  auth status | auth logout

所有命令支持 --json。进度写 stderr，结果写 stdout。
退出码：0 成功，1 操作错误，2 评测未通过，3 跟踪超时（不会重新提交）。
会话保存在 ~/.config/cannjudge-cli/session.json，权限 0600，不保存密码。
比赛中的题目编号以 inspect 返回的 ID/slug 为准，不使用页面行号。
`;
function positive(
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`需要 1–${max} 的整数，实际为 ${value}`);
  return n;
}
function print(value: unknown, json: boolean) {
  if (json || typeof value !== "string")
    console.log(JSON.stringify(value, null, json ? 2 : 2));
  else console.log(value);
}
async function main() {
  const { values: o, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      listen: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      problem: { type: "string" },
      dir: { type: "string" },
      out: { type: "string" },
      file: { type: "string", multiple: true },
      base: { type: "string" },
      "dry-run": { type: "boolean" },
      watch: { type: "boolean" },
      interval: { type: "string" },
      timeout: { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
      mine: { type: "boolean" },
      account: { type: "string" },
      challenge: { type: "string" },
      code: { type: "string" },
      "password-stdin": { type: "boolean" },
    },
  });
  const [command, input] = p;
  if (o.help || !command) {
    console.log(HELP);
    return;
  }
  if (p.length > 2) throw new Error("多余位置参数；路径含空格时请加引号。");
  const session = await loadSession();
  const client = new Client(session?.user, session?.cookie),
    json = !!o.json;
  if (command === "auth") {
    print(
      await auth(client, input || "status", {
        file: o.file?.[0],
        out: o.out,
        account: o.account,
        challenge: o.challenge,
        code: o.code,
        passwordStdin: o["password-stdin"],
        listen: o.listen,
      }),
      json,
    );
    return;
  }
  if (!input) throw new Error("缺少题目、比赛或提交记录链接；运行 --help。");
  if (["status", "download"].includes(command)) {
    const id = submissionId(input);
    if (command === "download") {
      const user = client.requireUser(),
        s = await client.submission(id);
      if (s.user_id !== user._id || !s.can_view_code || !s.files?.length)
        throw new Error("只能导出当前账户可读取的提交源码。");
      if (!o.out) throw new Error("需要 --out DIR。");
      await writeProject(s.files, o.out);
      print({ out: o.out, files: s.files.map((f) => f.path) }, json);
      return;
    }
    await showStatus(client, id, !!o.watch, o, json);
    return;
  }
  if (
    !["inspect", "template", "submit", "ranking", "submissions"].includes(
      command,
    )
  )
    throw new Error(`未知命令：${command}`);
  const r = await resolve(client, input, o.problem);
  if (r.target.kind === "submission")
    throw new Error("该链接是提交记录；请使用 status/download 或传题目链接。");
  const contest = r.contest!,
    problem = r.problem;
  const url = problem
    ? problemUrl(contest, problem, r.target.group)
    : `${ORIGIN}/${r.target.group || "public"}/${contest.name || contest._id}`;
  if (command === "inspect") {
    if (problem) {
      const data = {
        kind: "problem",
        id: problem._id,
        number: problem.ID,
        slug: problem.canonical_name || problem.name,
        title: problem.title,
        url,
        codeTemplate: problem.code_template,
        cannVersion: problem.cann_version,
        rankingSubmissionMode: problem.ranking_submission_mode,
        description: problem.desc,
      };
      print(
        json
          ? data
          : `${problem.title}\n${url}\nCANN ${problem.cann_version || "?"} · ${problem.code_template}\n\n${problem.desc || ""}`,
        json,
      );
    } else
      print(
        {
          kind: "contest",
          id: contest._id,
          title: contest.title,
          url,
          problems: r.problems?.map((p) => ({
            id: p._id,
            number: p.ID,
            slug: p.canonical_name || p.name,
            title: p.title,
            url: problemUrl(contest, p, r.target.group),
          })),
          next: "inspect <题目链接> 或 inspect <比赛链接> --problem <slug>",
        },
        json,
      );
    return;
  }
  if (command === "submissions") {
    let items: Submission[], total: number;
    if (o.mine) {
      const user = client.requireUser();
      if (!problem) throw new Error("--mine 需要题目链接或 --problem。");
      items = await client.request<Submission[]>(
        `/api/submissions/user/${user._id}/problem/${problem._id}`,
      );
      items.sort((a, b) =>
        String(b.create_time).localeCompare(String(a.create_time)),
      );
      total = items.length;
      const page = positive(o.page, 1),
        limit = positive(o.limit, 20, 100);
      items = items.slice((page - 1) * limit, page * limit);
    } else {
      const page = positive(o.page, 1),
        limit = positive(o.limit, 20, 100);
      const data = await client.request<{ list: Submission[]; total: number }>(
        "/api/submissions/global/list",
        {
          contestId: contest._id,
          problem: problem?.title,
          withCount: 1,
          skip: (page - 1) * limit,
          limit,
        },
      );
      items = data.list;
      total = data.total;
    }
    print(
      {
        total,
        rows: items.map((s) => ({
          id: s._id,
          number: s.ID,
          status: s.status,
          createdAt: s.create_time,
          url: `${ORIGIN}/submission/${s._id}`,
        })),
      },
      json,
    );
    return;
  }
  if (command === "ranking") {
    if (!problem && contest.show_total_ranking === false)
      throw new Error("比赛未开放总排行榜。");
    const now = Date.now(),
      end = Date.parse(contest.end_time || ""),
      freeze = Number(contest.freeze_duration || 0) * 60000;
    if (
      contest.ongoing !== true &&
      contest.freeze_ranking &&
      now < end &&
      now >= end - freeze
    )
      throw new Error("当前比赛已封榜。");
    const page = positive(o.page, 1),
      limit = positive(o.limit, 20, 100);
    type Rank = {
      rank?: number;
      score?: number;
      passCount?: number;
      submissionCount?: number;
      user?: User;
      submitter?: User;
      team?: { team_name?: string; name?: string };
      submission_id?: string;
      status?: string;
      result?: { time?: number }[];
    };
    let rows: Rank[], total: number;
    if (problem) {
      const data = await client.request<{ rows: Rank[]; total: number }>(
        `/api/problems/${problem._id}/ranking`,
        { ...client.query(), page, size: limit },
      );
      rows = data.rows;
      total = data.total;
    } else {
      rows = await client.request<Rank[]>(
        `/api/submissions/contest/${contest._id}/stats`,
      );
      rows.sort((a, b) =>
        contest.ranking_mode === "num"
          ? (b.passCount || 0) - (a.passCount || 0) ||
            (b.score || 0) - (a.score || 0) ||
            (b.submissionCount || 0) - (a.submissionCount || 0)
          : (b.score || 0) - (a.score || 0) ||
            (b.passCount || 0) - (a.passCount || 0) ||
            (b.submissionCount || 0) - (a.submissionCount || 0),
      );
      total = rows.length;
      rows = rows.slice((page - 1) * limit, page * limit);
    }
    print(
      {
        url,
        total,
        page,
        limit,
        rows: rows.map((x, i) => ({
          rank: x.rank ?? (page - 1) * limit + i + 1,
          name:
            x.team?.team_name ||
            x.team?.name ||
            x.submitter?.nickname ||
            x.user?.nickname,
          score: x.score,
          passed: x.passCount,
          status: x.status,
          timesUs: x.result?.map((v) => v.time),
          submission: x.submission_id
            ? `${ORIGIN}/submission/${x.submission_id}`
            : undefined,
        })),
      },
      json,
    );
    return;
  }
  if (!problem)
    throw new Error(
      "此操作需要题目链接，或比赛链接加 --problem。先运行 inspect 获取题目列表。",
    );
  const template = await client.template(problem._id);
  if (command === "template") {
    if (!o.out) throw new Error("需要 --out DIR。");
    await writeProject(template, o.out);
    print(
      {
        url,
        out: o.out,
        files: template.map((f) => ({
          path: f.path,
          editable: f.editable !== false,
        })),
      },
      json,
    );
    return;
  }
  const user = o["dry-run"] && !o.base ? client.user : client.requireUser();
  if (!o.dir && !o.file?.length)
    throw new Error("需要 --dir DIR 或 --file REMOTE=LOCAL。");
  const base = o.base
    ? await client.submission(submissionId(o.base))
    : undefined;
  const project = await buildProject(template, {
    dir: o.dir,
    files: o.file,
    base,
    problemId: problem._id,
    userId: user?._id,
    kind: problem.code_template,
  });
  const plan = {
    problemId: problem._id,
    url,
    user: user?.nickname,
    files: project.manifest,
    readonlyFilesOmitted: project.readonly,
  };
  if (o["dry-run"]) {
    print({ dryRun: true, ...plan }, json);
    return;
  }
  // Match the frontend: submit editable files in one request. No automatic POST retry.
  const response = await client.request<{ data?: { submissionId?: string } }>(
    "/api/submissions/submit",
    {},
    { problemId: problem._id, userId: user!._id, files: project.files },
  );
  const id = response.data?.submissionId;
  if (!id)
    throw new Error(
      "服务端响应缺少 submissionId；可能已提交，请先查询 submissions。",
    );
  if (o.watch) {
    process.stderr.write(`已提交 ${ORIGIN}/submission/${id}\n`);
    await showStatus(client, id, true, o, json);
  } else
    print(
      {
        id,
        url: `${ORIGIN}/submission/${id}`,
        files: project.manifest,
        next: `status ${id} --watch`,
      },
      json,
    );
}
async function showStatus(
  client: Client,
  id: string,
  follow: boolean,
  o: { interval?: string; timeout?: string },
  json: boolean,
) {
  const result = follow
    ? await watch(client, id, {
        intervalMs: positive(o.interval, 5, 60) * 1000,
        timeoutMs: positive(o.timeout, 600, 86400) * 1000,
        progress: (s) =>
          process.stderr.write(
            `${s.status} ${s.result?.filter((r) => r.testcase_status === "Pass").length || 0}/${s.result?.length || 0}\n`,
          ),
      })
    : { submission: await client.submission(id), timedOut: false };
  print(
    {
      ...summarize(result.submission),
      ...(result.timedOut
        ? { timedOut: true, resume: `status ${id} --watch` }
        : {}),
    },
    json,
  );
  if (result.timedOut) process.exitCode = 3;
  else if (
    result.submission.status !== "Pass" &&
    !pending(result.submission.status)
  )
    process.exitCode = 2;
}
main().catch((e) => {
  process.stderr.write(`cannjudge: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
