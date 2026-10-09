import { join } from "node:path";
import { homedir } from "node:os";

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
  [key: string]: unknown;
  user_id: string;
  problem_id: string;
  status: string;
  valid?: boolean;
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
  async currentUser(): Promise<User> {
    const saved = this.requireUser();
    const actual = minimalUser(await this.request(`/api/users/me/${saved.ID}`));
    if (actual._id !== saved._id || actual.ID !== saved.ID)
      throw new Error("会话 Cookie 与所选账号不一致，请重新登录该账号。");
    return actual;
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
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    if (/^\d+$/.test(id)) {
      if (!this.submissionIds.has(id)) {
        const rows = await this.userSubmissions(timeoutMs);
        const row = rows.find((s) => String(s.ID) === id);
        if (!row) throw new Error("当前账号未找到该提交编号；请核对 --profile 或使用提交记录链接。");
        this.submissionIds.set(id, row._id);
      }
      id = this.submissionIds.get(id)!;
    }
    return this.request<Submission>(
      `/api/submissions/${encodeURIComponent(id)}`,
      this.query(),
      undefined,
      deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
    );
  }
  async userSubmissions(timeoutMs?: number): Promise<Submission[]> {
    const user = this.requireUser();
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const rows: Submission[] = [], ids = new Set<string>();
    for (let page = 0; page < 100; page++) {
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error("读取账号提交历史超时；请使用提交记录链接。");
      const data = await this.request<{ list: Submission[]; total: number }>(
        `/api/submissions/user/${user._id}`,
        { withCount: 1, order: "desc", strict: 1, limit: 100, skip: rows.length },
        undefined,
        deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
      );
      if (!Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0)
        throw new Error("账号提交历史格式变化，无法返回完整记录。");
      for (const row of data.list) {
        if (row.user_id !== user._id || !row._id || ids.has(row._id))
          throw new Error("账号提交历史出现账号不匹配或重复记录，请重新查询。");
        ids.add(row._id);
        rows.push(row);
      }
      if (rows.length >= data.total) return rows;
      if (!data.list.length) throw new Error("账号提交历史分页不完整。");
    }
    throw new Error("账号提交历史超过查询页数上限，未返回不完整记录。");
  }
}

export function validateCookie(cookie: unknown): string {
  if (typeof cookie !== "string" || !cookie.trim() || /[\r\n]/.test(cookie))
    throw new Error("缺少有效会话 Cookie；仅有账户资料不能登录。");
  return cookie.trim();
}
