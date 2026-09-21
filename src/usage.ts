import { appendFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, configDir } from "./api.ts";
import type { Client, ProjectFile, Submission } from "./api.ts";
import { privateDirectory } from "./accounts.ts";

export function beijingDay(now: Date) {
  const date = new Date(now.getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const start = new Date(`${date}T00:00:00+08:00`);
  return {
    date,
    start: start.toISOString(),
    resetAt: new Date(start.getTime() + 86400_000).toISOString(),
  };
}
interface JournalEvent {
  requestId: string;
  accountId: string;
  problemId: string;
  at: string;
  kind: "attempt" | "accepted" | "rejected" | "unknown";
  submissionId?: string;
  httpStatus?: number;
}
function journalPath(dir: string, accountId: string) {
  if (!/^[a-f\d]{24}$/i.test(accountId)) throw new Error("无效账号 ID。");
  return join(dir, "submissions", `${accountId}.jsonl`);
}
export async function recordEvent(event: JournalEvent, dir = configDir()) {
  await privateDirectory(dir);
  await privateDirectory(join(dir, "submissions"));
  const path = journalPath(dir, event.accountId);
  // One append per event avoids read/modify/write races between CLI processes.
  await appendFile(path, JSON.stringify(event) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}
async function readJournal(
  dir: string,
  accountId: string,
): Promise<JournalEvent[]> {
  try {
    const text = await readFile(journalPath(dir, accountId), "utf8");
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEvent);
    if (
      events.some(
        (e) =>
          e.accountId !== accountId ||
          !e.requestId ||
          !Number.isFinite(Date.parse(e.at)),
      )
    )
      throw new Error("提交记录与账号不一致或数据损坏。");
    return events;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
function localCounts(
  events: JournalEvent[],
  day: ReturnType<typeof beijingDay>,
) {
  const attempts = events.filter(
    (e) => e.kind === "attempt" && e.at >= day.start && e.at < day.resetAt,
  );
  const outcomes = new Map(
    events.filter((e) => e.kind !== "attempt").map((e) => [e.requestId, e]),
  );
  const counts = { attempted: 0, accepted: 0, rejected: 0, unknown: 0 };
  for (const id of new Set(attempts.map((e) => e.requestId))) {
    counts.attempted++;
    const kind = outcomes.get(id)?.kind;
    if (kind === "accepted" || kind === "rejected") counts[kind]++;
    else counts.unknown++;
  }
  return counts;
}
async function todaySubmissions(
  client: Client,
  accountId: string,
  day: ReturnType<typeof beijingDay>,
) {
  const ids = new Set<string>();
  let skip = 0,
    previous = Infinity;
  for (let page = 0; page < 100; page++) {
    const data = await client.request<{ list: Submission[]; total: number }>(
      `/api/submissions/user/${accountId}`,
      { withCount: 1, order: "desc", strict: 1, limit: 100, skip },
    );
    if (
      !Array.isArray(data.list) ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0
    )
      throw new Error("提交列表格式变化，无法统计次数。");
    let older = false;
    for (const row of data.list) {
      const stamp = Date.parse(row.create_time || "");
      if (
        row.user_id !== accountId ||
        !row._id ||
        !Number.isFinite(stamp) ||
        stamp > previous
      )
        throw new Error("提交记录的账号、时间或排序不符合预期，请重新查询。");
      previous = stamp;
      if (stamp < Date.parse(day.start)) older = true;
      else if (stamp < Date.parse(day.resetAt)) ids.add(row._id);
    }
    skip += data.list.length;
    if (older || skip >= data.total) return ids.size;
    if (!data.list.length)
      throw new Error("提交列表分页不完整，无法统计次数。");
  }
  throw new Error("提交列表超过查询页数上限，未返回不完整的次数统计。");
}
export async function getUsage(
  client: Client,
  dir = configDir(),
  now = new Date(),
) {
  const account = await client.currentUser();
  const day = beijingDay(now);
  const submittedToday = await todaySubmissions(client, account._id, day);
  const events = await readJournal(dir, account._id);
  return {
    account,
    date: day.date,
    timezone: "Asia/Shanghai",
    scope: "account_all_problems",
    submittedToday,
    source: "official_submission_history",
    localToday: localCounts(events, day),
    checkedAt: now.toISOString(),
  };
}
export async function submitProject(
  client: Client,
  problemId: string,
  files: ProjectFile[],
  dir = configDir(),
) {
  const account = await client.currentUser();
  const requestId = randomUUID();
  const common = { requestId, accountId: account._id, problemId };
  await recordEvent(
    { ...common, at: new Date().toISOString(), kind: "attempt" },
    dir,
  );
  let id: string;
  try {
    const response = await client.request<{ data?: { submissionId?: string } }>(
      "/api/submissions/submit",
      {},
      { problemId, userId: account._id, files },
    );
    if (!response.data?.submissionId)
      throw new Error(
        "服务端响应缺少 submissionId；可能已提交，请先查询 submissions。",
      );
    id = response.data.submissionId;
  } catch (error) {
    const rejected =
      error instanceof ApiError && error.status >= 400 && error.status < 500;
    try {
      await recordEvent(
        {
          ...common,
          at: new Date().toISOString(),
          kind: rejected ? "rejected" : "unknown",
          httpStatus: error instanceof ApiError ? error.status : undefined,
        },
        dir,
      );
    } catch {
      process.stderr.write("本地提交结果记录写入失败；不要据此重试提交。\n");
    }
    throw error;
  }
  // A journal failure after acceptance must never hide the submission ID or encourage retry.
  try {
    await recordEvent(
      {
        ...common,
        at: new Date().toISOString(),
        kind: "accepted",
        submissionId: id,
      },
      dir,
    );
  } catch {
    process.stderr.write(`已创建提交 ${id}，但本地计数写入失败。\n`);
  }
  return id;
}
