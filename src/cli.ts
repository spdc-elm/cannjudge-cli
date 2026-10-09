#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Client, ORIGIN } from "./api.ts";
import { loadSession, useAccount } from "./accounts.ts";
import { getUsage, submitProject } from "./usage.ts";
import type { Submission, User } from "./api.ts";
import { auth } from "./auth.ts";
import { resolve, problemUrl, submissionId } from "./resolve.ts";
import { buildProject, writeProject } from "./project.ts";
import { summarize, detail, watch, pending } from "./results.ts";
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
    评测摘要和 valid 有效性；Pass 不代表提交仍然有效。
  detail SUBMISSION_URL|ID [--include-code]
    原始详情字段；默认源码只显示路径、字节数和 SHA-256。
  download SUBMISSION_URL|ID --out DIR
    导出自己的历史提交源码。
  submissions URL [--mine] [--page 1] [--limit 20]
  ranking URL [--problem SELECTOR] [--page 1] [--limit 20]
  usage [--profile NAME] [--json]
    当前账号北京时间当天的官方提交次数和本机请求记录。
  auth captcha [--out DIR]
  auth login --account EMAIL --challenge FILE --code CODE [--password-stdin]
  auth import --file FILE|-    导入自己的浏览器会话 {user, cookie} JSON
  auth import --listen [--name NAME]  保存独立账号（登录也支持 --name）
  auth list | auth use NAME | auth status | auth logout

所有命令支持 --json、--profile NAME（仅本次选择账号）。进度写 stderr，结果写 stdout。
退出码：0 查询成功或评测通过，1 操作错误，2 status 评测未通过或提交无效，3 跟踪超时。
会话按账号保存在 ~/.config/cannjudge-cli/accounts/，权限 0600，不保存密码。
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
      "include-code": { type: "boolean" },
      interval: { type: "string" },
      timeout: { type: "string" },
      page: { type: "string" },
      limit: { type: "string" },
      mine: { type: "boolean" },
      account: { type: "string" },
      challenge: { type: "string" },
      code: { type: "string" },
      "password-stdin": { type: "boolean" },
      profile: { type: "string" },
      name: { type: "string" },
    },
  });
  const [command, input] = p;
  if (o.help || !command) {
    console.log(HELP);
    return;
  }
  if (o["include-code"] && command !== "detail")
    throw new Error("--include-code 仅用于 detail 查看完整源码。");
  if (o.watch && command === "detail")
    throw new Error("detail 是单次详情查询；跟踪评测请使用 status --watch。");
  if (command === "auth" && input === "use") {
    if (p.length !== 3 || o.profile)
      throw new Error("用法：auth use NAME（与 --profile 分开使用）。");
    const selected = await loadSession(undefined, p[2]);
    await new Client(selected?.user, selected?.cookie).currentUser();
    print(await useAccount(p[2]), !!o.json);
    return;
  }
  if (p.length > 2) throw new Error("多余位置参数；路径含空格时请加引号。");
  if (o.name && !(command === "auth" && ["login", "import"].includes(input)))
    throw new Error("--name 仅用于 auth login/import 保存账号别名。");
  const session = await loadSession(undefined, o.profile);
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
        name: o.name,
        profile: o.profile,
      }),
      json,
    );
    return;
  }
  if (command === "usage") {
    if (input || o.problem)
      throw new Error("usage 是账号级次数查询，不需要题目或比赛链接。");
    print(await getUsage(client), json);
    return;
  }
  if (!input) throw new Error("缺少题目、比赛或提交记录链接；运行 --help。");
  if (["status", "detail", "download"].includes(command)) {
    const id = submissionId(input);
    if (command === "detail") {
      print(detail(await client.submission(id), !!o["include-code"]), json);
      return;
    }
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
    throw new Error("该链接是提交记录；请使用 status/detail/download 或传题目链接。");
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
      if (!problem) throw new Error("--mine 需要题目链接或 --problem。");
      // The problem-specific endpoint omits valid. Account history preserves it.
      items = (await client.userSubmissions()).filter((s) => s.problem_id === problem._id);
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
          valid: s.valid ?? null,
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
      create_time?: string;
      submission?: { ID?: number };
      result?: { time?: number }[];
    };
    let rows: Rank[], total: number;
    let testcases: unknown[] | undefined;
    if (problem) {
      const data = await client.request<{ rows: Rank[]; total: number; testcases?: unknown[] }>(
        `/api/problems/${problem._id}/ranking`,
        { ...client.query(), page, size: limit },
      );
      rows = data.rows;
      total = data.total;
      testcases = data.testcases;
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
        rankingSubmissionMode: problem?.ranking_submission_mode,
        testcases,
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
          submitter: x.submitter || x.user,
          submissionNumber: x.submission?.ID,
          createdAt: x.create_time,
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
  const id = await submitProject(client, problem._id, project.files);
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
            `${s.status} valid=${s.valid ?? "unknown"} ${s.result?.filter((r) => r.testcase_status === "Pass").length || 0}/${s.result?.length || 0}\n`,
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
    result.submission.valid === false ||
    (result.submission.status !== "Pass" && !pending(result.submission.status))
  )
    process.exitCode = 2;
}
main().catch((e) => {
  process.stderr.write(`cannjudge: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
