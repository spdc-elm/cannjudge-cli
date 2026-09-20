import {
  readFile,
  realpath,
  readdir,
  mkdir,
  writeFile,
  lstat,
} from "node:fs/promises";
import { resolve, relative, sep, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ProjectFile, Submission } from "./api.ts";
export function safePath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`不安全的工程路径：${path}`);
  return path;
}
function allowedExtra(path: string, kind: string) {
  return kind === "npu_kernel_dev"
    ? /^(?=.{1,128}$)\w[\w.-]*\.(asc|h)$/.test(path) &&
        !["judge.asc", "data_utils.h", "main.asc"].includes(path)
    : /^(op_host|op_kernel|op_api)\/(?=.{1,128}$)\w[\w.-]*\.(cpp|h)$/.test(
        path,
      );
}
async function localFile(root: string, path: string) {
  const file = await realpath(join(root, safePath(path)));
  const rel = relative(root, file);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep))
    throw new Error(`工程文件链接越界：${path}`);
  const buffer = await readFile(file);
  if (buffer.length > 2 * 1024 * 1024)
    throw new Error(`文件超过 CLI 的 2 MiB 限制：${path}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}
export async function buildProject(
  template: ProjectFile[],
  options: {
    dir?: string;
    files?: string[];
    base?: Submission;
    problemId: string;
    userId?: string;
    kind?: string;
  },
) {
  const known = new Map<string, ProjectFile>();
  for (const f of template) {
    safePath(f.path);
    if (known.has(f.path)) throw new Error(`模板重复路径：${f.path}`);
    known.set(f.path, f);
  }
  const contents = new Map<string, string>();
  const origins = new Map<string, string>();
  const ignored: string[] = [];
  if (options.base) {
    if (options.base.problem_id !== options.problemId)
      throw new Error("--base 必须来自同一道题。");
    if (options.base.user_id !== options.userId)
      throw new Error("--base 必须是当前账户的提交。");
    if (!options.base.can_view_code || !options.base.files?.length)
      throw new Error("无法读取基础提交源码。");
    for (const f of options.base.files) {
      safePath(f.path);
      if (known.get(f.path)?.editable === false) continue;
      if (!known.has(f.path) && !allowedExtra(f.path, options.kind || ""))
        throw new Error(`基础提交包含不支持的额外路径：${f.path}`);
      contents.set(f.path, f.content);
      origins.set(f.path, "base");
    }
  }
  if (options.dir) {
    const root = await realpath(options.dir);
    const paths = new Set(template.map((f) => f.path));
    for (const folder of [
      "op_host",
      "op_kernel",
      "op_api",
      ...(options.kind === "npu_kernel_dev" ? ["."] : []),
    ]) {
      try {
        for (const f of await readdir(join(root, folder))) {
          const p = folder === "." ? f : `${folder}/${f}`;
          if (allowedExtra(p, options.kind || "")) paths.add(p);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    for (const path of paths) {
      if (known.get(path)?.editable === false) {
        ignored.push(path);
        continue;
      }
      try {
        contents.set(path, await localFile(root, path));
        origins.set(path, "local");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  for (const mapping of options.files || []) {
    const pos = mapping.indexOf("=");
    if (pos < 1) throw new Error("--file 格式：平台相对路径=本地文件");
    const path = safePath(mapping.slice(0, pos)),
      file = mapping.slice(pos + 1);
    if (known.get(path)?.editable === false)
      throw new Error(`平台只读文件不能提交：${path}`);
    if (!known.has(path) && !allowedExtra(path, options.kind || ""))
      throw new Error(`平台不支持该额外路径：${path}`);
    const content = await localFile(
      await realpath(dirname(resolve(file))),
      file.split(/[\\/]/).pop()!,
    );
    contents.set(path, content);
    origins.set(path, "override");
  }
  const missing = template
    .filter((f) => f.editable !== false && !contents.has(f.path))
    .map((f) => f.path);
  if (missing.length)
    throw new Error(
      `缺少可编辑文件：${missing.join(", ")}。提供完整 --dir 或指定 --base。`,
    );
  if (!contents.size) throw new Error("没有可提交文件。");
  if ([...contents.keys()].filter((p) => !known.has(p)).length > 20)
    throw new Error("额外源码文件超过平台的 20 个限制。");
  const files = [...contents]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({ path, content }));
  const manifest = files.map((f) => ({
    path: f.path,
    bytes: Buffer.byteLength(f.content),
    sha256: createHash("sha256").update(f.content).digest("hex"),
    source: origins.get(f.path),
  }));
  return { files, manifest, readonly: ignored };
}
export async function writeProject(files: ProjectFile[], out: string) {
  // Never follow output symlinks or overwrite existing files, including a template supplied path.
  for (const f of files) safePath(f.path);
  await mkdir(resolve(out), { recursive: true });
  const absolute = await realpath(out);
  for (const f of files) {
    const path = join(absolute, f.path);
    let parent = dirname(path);
    while (parent !== absolute) {
      try {
        if ((await lstat(parent)).isSymbolicLink())
          throw new Error(`输出路径含符号链接：${parent}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      parent = dirname(parent);
    }
    try {
      await lstat(path);
      throw new Error(`文件已存在，拒绝覆盖：${path}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  for (const f of files) {
    const path = join(absolute, f.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.content, { flag: "wx" });
  }
}
