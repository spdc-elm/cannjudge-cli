import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir, minimalUser, validateCookie, ORIGIN } from "./api.ts";
import type { Session, User } from "./api.ts";

export interface AccountSession extends Session {
  name: string;
}

export async function privateDirectory(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function atomicJson(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
function validateSession(value: unknown): AccountSession {
  const s = value as AccountSession;
  if (s?.origin !== ORIGIN) throw new Error("会话站点不匹配。");
  const user = minimalUser(s.user);
  return {
    origin: ORIGIN,
    user,
    cookie: validateCookie(s.cookie),
    savedAt: s.savedAt,
    name: validateName(s.name || String(user.ID)),
  };
}
function validateName(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name))
    throw new Error("账号别名须为 1–64 位字母、数字、下划线、点或短横线。");
  return name;
}
async function prepare(dir: string) {
  await privateDirectory(dir);
  await privateDirectory(join(dir, "accounts"));
  // Move the old single session once, preserving its identity and credentials.
  const legacy = await readJson(join(dir, "session.json"));
  if (legacy !== undefined) {
    const session = validateSession(legacy);
    const file = join(dir, "accounts", `${session.user._id}.json`);
    if ((await readJson(file)) === undefined) await atomicJson(file, session);
    if ((await readJson(join(dir, "active.json"))) === undefined)
      await atomicJson(join(dir, "active.json"), session.user._id);
    await rm(join(dir, "session.json"), { force: true });
  }
}
async function sessions(dir: string): Promise<AccountSession[]> {
  await prepare(dir);
  const result: AccountSession[] = [];
  for (const file of (await readdir(join(dir, "accounts"))).sort()) {
    if (!/^[a-f\d]{24}\.json$/i.test(file)) continue;
    const session = validateSession(
      await readJson(join(dir, "accounts", file)),
    );
    if (file !== `${session.user._id}.json`)
      throw new Error("账号文件与保存的身份不匹配。");
    result.push(session);
  }
  return result;
}
function select(all: AccountSession[], selector: string) {
  const matches = all.filter((s) =>
    [s.name, s.user._id, String(s.user.ID)].includes(selector),
  );
  if (matches.length !== 1)
    throw new Error(
      `账号不存在或有歧义：${selector}。运行 auth list 查看已保存账号。`,
    );
  return matches[0];
}
export async function loadSession(
  dir = configDir(),
  profile?: string,
): Promise<AccountSession | undefined> {
  const all = await sessions(dir);
  const selected = profile || (await readJson(join(dir, "active.json")));
  if (selected === undefined || selected === null) return undefined;
  if (typeof selected !== "string") throw new Error("当前账号配置无效。");
  return select(all, selected);
}
export async function saveSession(
  user: User,
  cookie: string,
  dir = configDir(),
  name?: string,
) {
  const cleanUser = minimalUser(user),
    cleanCookie = validateCookie(cookie);
  const all = await sessions(dir);
  const alias = validateName(
    name ||
      all.find((s) => s.user._id === cleanUser._id)?.name ||
      String(cleanUser.ID),
  );
  if (
    all.some(
      (s) =>
        s.user._id !== cleanUser._id &&
        [s.name, s.user._id, String(s.user.ID)].some((key) =>
          [alias, cleanUser._id, String(cleanUser.ID)].includes(key),
        ),
    )
  )
    throw new Error(`别名或编号已被其他账号使用：${alias}`);
  const session: AccountSession = {
    origin: ORIGIN,
    user: cleanUser,
    cookie: cleanCookie,
    savedAt: new Date().toISOString(),
    name: alias,
  };
  await atomicJson(join(dir, "accounts", `${user._id}.json`), session);
  await atomicJson(join(dir, "active.json"), user._id);
  return session;
}
export async function listAccounts(dir = configDir()) {
  const all = await sessions(dir),
    active = await readJson(join(dir, "active.json"));
  return all.map((s) => ({
    name: s.name,
    user: s.user,
    active: active === s.user._id,
    savedAt: s.savedAt,
  }));
}
export async function useAccount(profile: string, dir = configDir()) {
  const session = select(await sessions(dir), profile);
  await atomicJson(join(dir, "active.json"), session.user._id);
  return { name: session.name, user: session.user };
}
export async function logout(dir = configDir(), profile?: string) {
  const session = await loadSession(dir, profile);
  if (!session) return;
  await rm(join(dir, "accounts", `${session.user._id}.json`));
  if ((await readJson(join(dir, "active.json"))) === session.user._id)
    await atomicJson(join(dir, "active.json"), null);
}
