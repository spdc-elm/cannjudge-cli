import { importSession, listenImport } from "./import-session.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client, configDir, minimalUser } from "./api.ts";
import { saveSession, logout, listAccounts } from "./accounts.ts";
export async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
async function password() {
  if (!process.stdin.isTTY)
    throw new Error("非交互输入请使用 --password-stdin。");
  process.stderr.write("密码（不回显）：");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((ok, fail) => {
      let value = "";
      const done = () => process.stdin.off("data", onData);
      const onData = (chunk: Buffer) => {
        for (const c of chunk.toString()) {
          if (c === "\u0003") {
            done();
            fail(new Error("登录已取消。"));
            return;
          }
          if (c === "\r" || c === "\n") {
            done();
            ok(value);
            return;
          }
          if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
          else if (c >= " ") value += c;
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}
export async function auth(
  client: Client,
  action: string,
  opts: {
    file?: string;
    out?: string;
    account?: string;
    challenge?: string;
    code?: string;
    passwordStdin?: boolean;
    listen?: boolean;
    name?: string;
    profile?: string;
  },
) {
  if (action === "logout") {
    await logout(undefined, opts.profile);
    return { loggedIn: false };
  }
  if (action === "list")
    return {
      accounts: await listAccounts(),
      note: "本地保存的账号；会话有效性请用 auth status 检查。",
    };
  if (action === "status") {
    if (!client.user) return { loggedIn: false };
    const user = await client.currentUser();
    return {
      loggedIn: true,
      user,
      sessionFile: join(configDir(), "accounts", `${user._id}.json`),
    };
  }
  if (action === "import") {
    if (opts.listen) return listenImport(client, opts.name);
    if (!opts.file)
      throw new Error(
        "auth import --file FILE|-，或 --listen。需要自己的 {user, cookie} JSON。",
      );
    const data = JSON.parse(
      opts.file === "-" ? await readStdin() : await readFile(opts.file, "utf8"),
    );
    return importSession(client, data, opts.name);
  }
  if (action === "captcha") {
    const c = await client.request<{ captchaId: string; image: string }>(
      "/api/users/captcha",
    );
    if (!c.captchaId || !c.image?.includes("<svg"))
      throw new Error("验证码格式发生变化。");
    const dir = resolve(opts.out || join(configDir(), "captcha"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "captcha.svg"), c.image, { mode: 0o600 });
    await writeFile(
      join(dir, "challenge.json"),
      JSON.stringify({ captchaId: c.captchaId }),
      { mode: 0o600 },
    );
    return {
      image: join(dir, "captcha.svg"),
      challenge: join(dir, "challenge.json"),
      next: "请自行查看验证码，再运行 auth login --account EMAIL --challenge PATH --code CODE；密码交互输入。",
    };
  }
  if (action === "login") {
    if (!opts.account || !opts.challenge || !opts.code)
      throw new Error(
        "先运行 auth captcha，然后 auth login --account EMAIL --challenge challenge.json --code CODE。",
      );
    const challenge = JSON.parse(await readFile(opts.challenge, "utf8"));
    if (!challenge.captchaId) throw new Error("缺少 captchaId。");
    const secret = opts.passwordStdin
      ? (await readStdin()).replace(/\r?\n$/, "")
      : await password();
    if (!secret) throw new Error("密码不能为空。");
    client.cookie = "";
    client.user = undefined;
    const user = minimalUser(
      await client.request(
        "/api/users/login",
        {},
        {
          loginType: /^1\d{10}$|^\d{6,15}$/.test(opts.account)
            ? "phone"
            : "email",
          account: opts.account,
          password: secret,
          captchaId: challenge.captchaId,
          captchaCode: opts.code,
        },
      ),
    );
    await saveSession(user, client.cookie, undefined, opts.name);
    return { loggedIn: true, user };
  }
  throw new Error(
    "auth 子命令：captcha / login / import / status / list / use / logout",
  );
}
