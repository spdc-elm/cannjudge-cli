import { setTimeout as sleep } from "node:timers/promises";
import type { Client, Submission } from "./api.ts";
import { ORIGIN } from "./api.ts";
export function summarize(s: Submission) {
  const cases = (s.result || []).filter((r) => r.testcase_status !== "Hidden");
  return {
    id: s._id,
    number: s.ID,
    url: `${ORIGIN}/submission/${s._id}`,
    status: s.status,
    problem: s.problem?.title || s.problem_id,
    createdAt: s.create_time,
    passed: cases.filter((r) => r.testcase_status === "Pass").length,
    total: cases.length,
    hidden: (s.result || []).length - cases.length,
    message: s.msg || undefined,
    cases: cases.map((r, i) => ({
      index: i + 1,
      status: r.testcase_status,
      timeUs: r.time,
      bestTimeUs: r.best_time,
      precisionRatio: r.precision_ratio,
      message: r.msg || undefined,
    })),
  };
}
export function pending(status: string) {
  return /^(waiting|pending|running|queued|queuing|compiling|judging)$/i.test(
    status,
  );
}
export async function watch(
  client: Pick<Client, "submission">,
  id: string,
  options: {
    intervalMs: number;
    timeoutMs: number;
    progress?: (s: Submission) => void;
  },
) {
  if (options.intervalMs < 1 || options.timeoutMs < 1)
    throw new Error("轮询间隔和超时必须为正数。");
  const deadline = Date.now() + options.timeoutMs;
  let previous = "",
    last: Submission | undefined;
  while (Date.now() < deadline) {
    try {
      last = await client.submission(
        id,
        Math.max(1, Math.min(30_000, deadline - Date.now())),
      );
    } catch (e) {
      if (last && Date.now() >= deadline)
        return { submission: last, timedOut: true };
      throw e;
    }
    const fingerprint = JSON.stringify([last.status, last.result]);
    if (fingerprint !== previous) {
      options.progress?.(last);
      previous = fingerprint;
    }
    if (!pending(last.status)) return { submission: last, timedOut: false };
    await sleep(
      Math.max(0, Math.min(options.intervalMs, deadline - Date.now())),
    );
  }
  return { submission: last!, timedOut: true };
}
