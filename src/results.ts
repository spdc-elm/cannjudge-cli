import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { Client, Submission } from "./api.ts";
import { ORIGIN } from "./api.ts";
export function summarize(s: Submission) {
  const cases = (s.result || []).filter((r) => r.testcase_status !== "Hidden");
  return {
    id: s._id,
    number: s.ID,
    url: `${ORIGIN}/submission/${s._id}`,
    status: s.status,
    valid: s.valid ?? null,
    problem: s.problem?.title || s.problem_id,
    createdAt: s.create_time,
    passed: cases.filter((r) => r.testcase_status === "Pass").length,
    total: cases.length,
    hidden: (s.result || []).length - cases.length,
    message: s.msg || undefined,
    cases: cases.map((r, i) => ({
      index: i + 1,
      testcaseId: r.testcase_id,
      status: r.testcase_status,
      timeUs: r.time,
      bestTimeUs: r.best_time,
      precisionRatio: r.precision_ratio,
      message: r.msg || undefined,
    })),
  };
}
export function detail(s: Submission, includeCode = false) {
  if (includeCode) return s;
  const manifest = (content: string) => ({
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const result: Record<string, unknown> = { ...s };
  if (s.files) result.files = s.files.map(({ content, ...file }) => ({ ...file, ...manifest(content) }));
  const legacyCode: Record<string, unknown> = {};
  for (const key of ["tiling_h", "tiling_key_h", "tiling_key_cpp", "host_cpp", "kernel_cpp"]) {
    if (typeof s[key] === "string" && s[key]) legacyCode[key] = manifest(s[key]);
    delete result[key];
  }
  if (Object.keys(legacyCode).length) result.legacyCode = legacyCode;
  return result;
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
    const fingerprint = JSON.stringify([last.status, last.valid, last.result]);
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
