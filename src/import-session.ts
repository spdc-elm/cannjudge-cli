import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { Client } from "./api.ts";
import { minimalUser, validateCookie, saveSession } from "./api.ts";
export async function importSession(
  client: Client,
  data: { user: unknown; cookie: unknown },
) {
  const user = minimalUser(data.user);
  client.cookie = validateCookie(data.cookie);
  const current = minimalUser(await client.request(`/api/users/me/${user.ID}`));
  if (current._id !== user._id || current.ID !== user.ID)
    throw new Error("登录对象与会话账户不一致。");
  await saveSession(current, client.cookie);
  return { loggedIn: true, user: current };
}
export async function listenImport(client: Client) {
  const path = "/" + randomBytes(24).toString("hex");
  return await new Promise<Awaited<ReturnType<typeof importSession>>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("等待导入会话超时。"));
      }, 300_000);
      const server = createServer(async (req, res) => {
        if (req.url !== path) {
          res.writeHead(404).end();
          return;
        }
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        if (
          req.headers.host !== new URL(origin).host ||
          (req.headers.origin && req.headers.origin !== origin)
        ) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        );
        if (req.method === "GET") {
          res.end(
            '<title>CANNJudge CLI 会话导入</title><h1>导入自己的 CANNJudge 会话</h1><form method="post"><label>会话 JSON <input type="password" name="session" autocomplete="off" aria-label="会话 JSON"></label><button>保存会话</button></form>',
          );
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        try {
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 65536) throw new Error("会话数据过大。");
          }
          const data = JSON.parse(
            new URLSearchParams(raw).get("session") || "",
          );
          const result = await importSession(client, data);
          res.end("<p>会话已验证并保存，可以关闭此页面。</p>");
          clearTimeout(timer);
          server.close();
          resolve(result);
        } catch (e) {
          res.statusCode = 400;
          res.end("<p>会话验证失败，请检查登录状态后重试。</p>");
          process.stderr.write(`导入失败：${(e as Error).message}\n`);
        }
      });
      server.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.listen(0, "127.0.0.1", () =>
        process.stderr.write(
          `会话导入页面（5 分钟有效）：http://127.0.0.1:${(server.address() as { port: number }).port}${path}\n`,
        ),
      );
    },
  );
}
