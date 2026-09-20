import { Client, ORIGIN } from "./api.ts";
import type { Entity, Contest, Problem } from "./api.ts";
export interface Target {
  kind: "contest" | "problem" | "submission";
  id?: string;
  group?: string;
  contest?: string;
  problem?: string;
}
const hex = /^[a-f\d]{24}$/i;
export function parseTarget(input: string): Target {
  if (hex.test(input) || /^\d+$/.test(input))
    return { kind: "submission", id: input };
  const u = new URL(input, ORIGIN);
  if (u.origin !== ORIGIN || u.username || u.password)
    throw new Error("仅接受 https://cannjudge.cn 的链接。");
  const path = u.hash.startsWith("#/")
    ? u.hash.slice(1).split("?")[0]
    : u.pathname;
  const p = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (p.some((s) => /[\\/]/.test(s) || s === "." || s === ".."))
    throw new Error("无效链接路径。");
  if (p[0] === "submission" && p.length === 2)
    return { kind: "submission", id: p[1] };
  if (p[0] === "problem" && (p.length === 2 || p[2] === "editor"))
    return { kind: "problem", id: p[1] };
  if (p[0] === "contest" && p.length === 2)
    return { kind: "contest", id: p[1] };
  if (p.length === 5 && p[3] === "submission")
    return { kind: "submission", id: p[4] };
  if (
    p.length === 2 ||
    (p.length === 3 && ["ranking", "status"].includes(p[2]))
  )
    return { kind: "contest", group: p[0], contest: p[1] };
  if (
    p.length === 3 ||
    (p.length === 4 && ["submit", "ranking"].includes(p[3]))
  )
    return { kind: "problem", group: p[0], contest: p[1], problem: p[2] };
  throw new Error("无法识别链接。请传比赛、题目或提交记录链接。");
}
export function selectProblem(problems: Problem[], selector: string): Problem {
  const key = selector.toLocaleLowerCase();
  const exact = problems.filter((p) =>
    [p._id, String(p.ID), p.name, p.canonical_name, p.title].some(
      (v) => v?.toLocaleLowerCase() === key,
    ),
  );
  const matches = exact.length
    ? exact
    : problems.filter((p) =>
        [p.name, p.canonical_name, p.title].some((v) =>
          v?.toLocaleLowerCase().includes(key),
        ),
      );
  if (matches.length !== 1)
    throw new Error(
      `${matches.length ? "匹配到多道题" : "未找到题目"}：${selector}。请用 inspect 列出的 slug 或题目链接。`,
    );
  return matches[0];
}
export function problemUrl(
  contest: Contest,
  problem: Problem,
  group = "public",
) {
  return `${ORIGIN}/${encodeURIComponent(group)}/${encodeURIComponent(contest.name || contest._id)}/${encodeURIComponent(problem.canonical_name || problem.name || problem._id)}`;
}
export async function resolve(
  client: Client,
  input: string,
  selector?: string,
): Promise<{
  target: Target;
  contest?: Contest;
  problem?: Problem;
  problems?: Problem[];
}> {
  const target = parseTarget(input);
  if (target.kind === "submission") return { target };
  if (target.kind === "problem" && target.id) {
    const problem = await client.problem(target.id);
    const contest = await client.request<Contest>(
      `/api/contests/${problem.contest_id}`,
    );
    return { target, contest, problem };
  }
  let contest: Contest;
  if (target.id)
    contest = await client.request<Contest>(
      `/api/contests/${encodeURIComponent(target.id)}`,
    );
  else {
    const group = await client.request<Entity>(
      target.group === "public"
        ? "/api/groups/public"
        : `/api/groups/name/${encodeURIComponent(target.group!)}`,
    );
    contest = await client.request<Contest>(
      hex.test(target.contest!)
        ? `/api/contests/${target.contest}`
        : `/api/contests/name/${encodeURIComponent(target.contest!)}`,
      { groupId: group._id },
    );
    if (contest.group_id !== group._id)
      throw new Error("比赛不属于链接指定的小组。");
  }
  const problems = await client.request<Problem[]>(
    `/api/problems/contest/${contest._id}`,
    client.query(),
  );
  if (!Array.isArray(problems)) throw new Error("题目列表响应格式发生变化。");
  const picked = target.problem || selector;
  const problem = picked
    ? await client.problem(selectProblem(problems, picked)._id)
    : undefined;
  return { target, contest, problems, problem };
}
export function submissionId(input: string): string {
  const t = parseTarget(input);
  if (t.kind !== "submission" || !t.id || !/^(?:[a-f\d]{24}|\d+)$/i.test(t.id))
    throw new Error("需要提交记录链接或 ID。");
  return t.id;
}
