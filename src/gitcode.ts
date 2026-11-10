import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApiError, Client, configDir, mergeCookies, minimalUser, ORIGIN } from "./api.ts";
import type { User } from "./api.ts";
import { loadSession, saveSession } from "./accounts.ts";
import type { AccountSession } from "./accounts.ts";

interface GitCodeSession {
  getToken(): Promise<string>;
  refresh(): Promise<string>;
}
const CALLBACK = ORIGIN + "/api/users/oauth/gitcode/callback";
const AUTHORIZE = "https://web-api.gitcode.com/uc/api/v1/oauth/authorize";

async function cannlabSession(authFile: string): Promise<GitCodeSession> {
  const root = process.env.CANNLAB_ROOT || fileURLToPath(new URL("../../cannlab/", import.meta.url));
  let adapter;
  try { adapter = await import(pathToFileURL(resolve(root, "auth.mjs")).href); }
  catch { throw new Error("未找到 CANNLab 认证模块；请用 CANNLAB_ROOT 指定 CANNLab CLI 目录。"); }
  return new adapter.AuthSession({ authFile });
}

function redirect(response: Response, origin: string, path: string): URL {
  const location = response.headers.get("location");
  if (![302, 303].includes(response.status) || !location)
    throw new Error(`GitCode 登录跳转失败（HTTP ${response.status}）；请检查 GitCode 会话或使用网页登录。`);
  let url;
  try { url = new URL(location, origin); }
  catch { throw new Error("GitCode 登录返回无效跳转。"); }
  if (url.origin !== origin || url.pathname !== path || url.username || url.password)
    throw new Error("GitCode 登录返回未受信任的跳转，已停止。");
  return url;
}

export async function gitcodeLogin(
  authFile: string,
  expected: User,
  session?: GitCodeSession,
): Promise<{ user: User; cookie: string }> {
  // All redirects are inspected manually. GitCode tokens only go to GitCode;
  // OAuth codes/tickets and Judge cookies only go to the fixed Judge origin.
  const tokenSession = session || await cannlabSession(authFile);
  const init = await fetch(ORIGIN + "/api/users/oauth/gitcode/authorize?scene=login", {
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error("无法发起 Judge 的 GitCode 登录，请检查网络。"); });
  const authorize = redirect(init, "https://gitcode.com", "/oauth/authorize");
  const clientId = authorize.searchParams.get("client_id");
  const state = authorize.searchParams.get("state");
  const scope = authorize.searchParams.get("scope");
  if (!clientId || !state || authorize.searchParams.get("redirect_uri") !== CALLBACK ||
      authorize.searchParams.get("response_type") !== "code" || scope !== "all_user")
    throw new Error("Judge 的 GitCode 授权参数发生变化，已停止。");
  const approve = async (token: string) => fetch(AUTHORIZE, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://gitcode.com", Referer: authorize.href },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: CALLBACK,
      response_type: "code", state, scopes: scope, access: "true" }),
  }).catch(() => { throw new Error("GitCode 授权请求未完成，请检查网络后重试。"); });
  let approved = await approve(await tokenSession.getToken());
  if (approved.status === 401) approved = await approve(await tokenSession.refresh());
  const callback = redirect(approved, ORIGIN, "/api/users/oauth/gitcode/callback");
  if (callback.searchParams.get("state") !== state || !callback.searchParams.get("code"))
    throw new Error("GitCode 回调的 state 或授权码无效，已停止。");
  let cookie = mergeCookies("", init.headers);
  const result = await fetch(callback, {
    redirect: "manual", headers: { Cookie: cookie }, signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error("Judge OAuth 回调未完成，请重新发起登录。"); });
  cookie = mergeCookies(cookie, result.headers);
  const finish = redirect(result, ORIGIN, "/auth/gitcode/callback");
  const ticket = finish.searchParams.get("ticket");
  if (!ticket || finish.searchParams.has("error"))
    throw new Error("GitCode 未能登录已有 Judge 账号；请在网页检查账号绑定，CLI 不会自动注册或绑定账号。");
  const client = new Client(undefined, cookie);
  const user = minimalUser(await client.request("/api/users/oauth/gitcode/login/exchange", {}, { ticket }));
  if (user._id !== expected._id || user.ID !== expected.ID)
    throw new Error("GitCode 登录得到的 Judge 身份与所选 profile 不一致，未保存会话或关联。");
  client.user = user;
  await client.currentUser();
  return { user, cookie: client.cookie };
}

export async function renewGitCodeSession(
  saved: AccountSession,
  authFile = saved.gitcodeAuthFile,
  dir = configDir(),
) {
  if (!authFile) throw new Error("请用 auth gitcode --profile NAME --cannlab-auth FILE 关联已有 GitCode 凭据。");
  const fresh = await gitcodeLogin(resolve(authFile), saved.user);
  await saveSession(fresh.user, fresh.cookie, dir, saved.name, {
    activate: false, gitcodeAuthFile: resolve(authFile),
  });
  return fresh;
}

export function sessionClient(saved?: AccountSession, dir = configDir()): Client {
  const client = new Client(saved?.user, saved?.cookie);
  if (saved?.gitcodeAuthFile) client.reauthenticate = async () => {
    // Another CLI process may already have renewed this profile.
    const latest = await loadSession(dir, saved.user._id);
    if (latest && latest.cookie !== client.cookie) {
      const candidate = new Client(latest.user, latest.cookie);
      try {
        await candidate.currentUser();
        client.cookie = candidate.cookie;
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    }
    const fresh = await renewGitCodeSession(saved, undefined, dir);
    client.cookie = fresh.cookie;
  };
  return client;
}
