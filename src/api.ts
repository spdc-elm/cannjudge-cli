import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const ORIGIN = "https://cannjudge.cn";
export const configDir = () =>
  process.env.CANNJUDGE_CONFIG_DIR ||
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "cannjudge-cli",
  );
export interface User {
  _id: string;
  ID: number;
  nickname: string;
}
export interface Session {
  origin: string;
  user: User;
  cookie: string;
  savedAt: string;
}
export interface Entity {
  _id: string;
  ID?: number;
  name?: string;
  canonical_name?: string;
  title?: string;
}
export interface Contest extends Entity {
  group_id: string;
  ongoing?: boolean;
  desc?: string;
  ranking_mode?: string;
  show_total_ranking?: boolean;
  freeze_ranking?: boolean;
  freeze_duration?: number;
  end_time?: string;
}
export interface Problem extends Entity {
  contest_id: string;
  desc?: string;
  code_template?: string;
  cann_version?: string;
  ranking_submission_mode?: string;
}
export interface ProjectFile {
  path: string;
  content: string;
  editable?: boolean;
}
export interface CaseResult {
  testcase_id: string;
  testcase_status: string;
  time?: number;
  best_time?: number;
  precision_ratio?: number;
  msg?: string;
}
export interface Submission extends Entity {
  user_id: string;
  problem_id: string;
  status: string;
  result?: CaseResult[];
  files?: ProjectFile[];
  can_view_code?: boolean;
  user?: User;
  problem?: Problem;
  contest?: Contest;
  create_time?: string;
  msg?: string;
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export function minimalUser(value: unknown): User {
  const u = value as Partial<User> | null;
  if (
    !u ||
    !/^[a-f\d]{24}$/i.test(u._id || "") ||
    !Number.isSafeInteger(u.ID) ||
    Number(u.ID) <= 0
  )
    throw new Error(
      "无效登录对象：需要 _id、ID（来自自己的 cannjudge_user）。",
    );
  return { _id: u._id!, ID: u.ID!, nickname: String(u.nickname || "") };
}
export async function saveSession(
  user: User,
  cookie: string,
  dir = configDir(),
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = join(dir, `.session-${randomUUID()}`);
  await writeFile(
    temp,
    JSON.stringify(
      {
        origin: ORIGIN,
        user: minimalUser(user),
        cookie: validateCookie(cookie),
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await rename(temp, join(dir, "session.json"));
}
export async function loadSession(
  dir = configDir(),
): Promise<Session | undefined> {
  try {
    const s = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    ) as Session;
    if (s.origin !== ORIGIN) throw new Error("会话站点不匹配。");
    return {
      ...s,
      user: minimalUser(s.user),
      cookie: validateCookie(s.cookie),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function logout() {
  await rm(join(configDir(), "session.json"), { force: true });
}

export class Client {
  user?: User;
  origin: string;
  cookie: string;
  private submissionIds = new Map<string, string>();
  constructor(user?: User, cookie = "", origin = ORIGIN) {
    this.user = user;
    this.cookie = cookie;
    this.origin = origin;
  }
  requireUser(): User {
    if (!this.user) throw new Error("请先运行 auth login 或 auth import。");
    return this.user;
  }
  async request<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    data?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!path.startsWith("/api/")) throw new Error("无效 API 路径。");
    const url = new URL(path, this.origin);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: this.origin,
      Referer: this.origin + "/",
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (data !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method: data === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    } catch (e) {
      throw new Error(
        data === undefined
          ? `网络请求失败：${(e as Error).message}`
          : "POST 请求中断，服务端可能已接收；请先查询 submissions，勿盲目重试。",
      );
    }
    const jar = new Map(
      this.cookie
        .split(/; */)
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
    );
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(";")[0],
        i = pair.indexOf("=");
      if (i > 0) {
        if (/max-age=0(?:;|$)/i.test(item)) jar.delete(pair.slice(0, i));
        else jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new Error(
        data === undefined
          ? "API 响应读取中断。"
          : "POST 响应读取中断，可能已提交；请先查询 submissions，勿盲目重试。",
      );
    }
    let body: { code?: number; message?: string; msg?: string; error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        `API 返回非 JSON（HTTP ${response.status}）${data === undefined ? "" : "；可能已提交，请先查询 submissions，勿盲目重试。"}`,
        response.status,
      );
    }
    if (
      !response.ok ||
      (typeof body.code === "number" && body.code !== 0 && body.code !== 200)
    )
      throw new ApiError(
        String(
          body.message || body.msg || body.error || `HTTP ${response.status}`,
        ).slice(0, 2000),
        response.status,
      );
    return body as T;
  }
  query() {
    return this.user ? { userId: this.user._id } : {};
  }
  problem(id: string) {
    return this.request<Problem>(
      `/api/problems/${encodeURIComponent(id)}`,
      this.query(),
    );
  }
  async template(id: string): Promise<ProjectFile[]> {
    const r = await this.request<{ data?: { files?: ProjectFile[] } }>(
      `/api/problems/${encodeURIComponent(id)}/template`,
      this.query(),
    );
    if (!Array.isArray(r.data?.files) || !r.data.files.length)
      throw new Error(
        "该题没有 files 工程模板；暂不支持旧版四文件或理论题提交。",
      );
    return r.data.files;
  }
  async submission(id: string, timeoutMs?: number) {
    if (/^\d+$/.test(id)) {
      if (!this.submissionIds.has(id)) {
        this.requireUser();
        const r = await this.request<{ list: Submission[] }>(
          "/api/submissions/global/list",
          { q: id, limit: 100, skip: 0, withCount: 1 },
          undefined,
          timeoutMs,
        );
        const row = r.list.find((s) => String(s.ID) === id);
        if (!row) throw new Error("未找到该提交编号；请直接使用提交记录链接。");
        this.submissionIds.set(id, row._id);
      }
      id = this.submissionIds.get(id)!;
    }
    return this.request<Submission>(
      `/api/submissions/${encodeURIComponent(id)}`,
      this.query(),
      undefined,
      timeoutMs,
    );
  }
}

export function validateCookie(cookie: unknown): string {
  if (typeof cookie !== "string" || !cookie.trim() || /[\r\n]/.test(cookie))
    throw new Error("缺少有效会话 Cookie；仅有账户资料不能登录。");
  return cookie.trim();
}
