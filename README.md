# CANNJudge CLI

用题目／比赛链接读题、下载模板、提交本地源码、跟踪评测和查榜。TypeScript，Node.js ≥ 22.18，零运行时依赖。不依赖浏览器自动化；登录过期时需重新登录。

```bash
node src/cli.ts --help
# 可选：注册 cannjudge 命令
npm link
```

下面用 `cannjudge`；未执行 `npm link` 时替换为 `node /绝对路径/cannjudge_cli/src/cli.ts`。开发检查使用 `npm ci && npm run check && npm test`，正常运行不需要安装依赖。

## 从链接定位

```bash
cannjudge inspect https://cannjudge.cn/public/ct_starcup_aiop_g3 --json
cannjudge inspect https://cannjudge.cn/public/ct_starcup_aiop_g3 --problem mhcheadcollapse
```

比赛链接返回每道题的 **slug、ID、标题和完整链接**；题目链接直接返回完整 Markdown 题面，保留公式和代码。`--problem` 接受精确 slug、题目 ID 或唯一的标题片段，歧义时报错。页面表格的“第几题”不作为题目 ID。也识别 `/problem/<id>`、`/contest/<id>`、小组路径、带 `/submit` 或 `/ranking` 的链接以及旧 `#/…` 链接。

所有命令支持 `--json`；stdout 只有结果，进度和错误走 stderr。`status` 默认不输出工程源码，避免占上下文。

## 登录与凭据

普通邮箱／手机号密码登录：

```bash
cannjudge auth captcha --out /tmp/cannjudge-captcha
# 自己打开 captcha.svg 查看验证码
cannjudge auth login --account YOUR_EMAIL \
  --challenge /tmp/cannjudge-captcha/challenge.json --code YOUR_CODE
# 密码从终端隐藏输入；自动化可用 --password-stdin，不提供 --password 参数
cannjudge auth status
cannjudge auth logout
```

GitCode／华为账号可先在网站登录，再导入**自己的已有浏览器会话**：

```bash
cannjudge auth import --file /private/path/session.json
# 或从 stdin 输入 JSON；避免把 Cookie 写进命令行参数和 shell 历史
cannjudge auth import --file -
# 或启动 5 分钟有效的本地表单，只监听 127.0.0.1
cannjudge auth import --listen
```

导入格式为 `{"user":{"_id":"内部账户ID","ID":123,"nickname":"昵称"},"cookie":"Cookie名=值"}`。`user` 取自本站 Local Storage 的 `cannjudge_user`，Cookie 取自本站已登录 **`/api/…` 请求**的 Cookie 请求头。实测会话名为 `cannjudge_auth`、路径为 `/api`、带 HttpOnly；检查网站根路径或 `document.cookie` 都可能看不到它。导入会先访问受认证保护的 `/api/users/me/<ID>`，确认 Cookie 和账户匹配后才保存；只有用户名／账户 ID 无法登录。

会话按真实账号 ID 保存在 `~/.config/cannjudge-cli/accounts/`（支持 `XDG_CONFIG_HOME` 或 `CANNJUDGE_CONFIG_DIR`），目录权限 `0700`、文件 `0600`。仅保存最小账户资料和会话 Cookie，不保存密码。旧 `session.json` 会自动迁移，原登录仍可用。

多账号登录／导入时可指定 `--name` 保存别名，未指定时以账号数字 ID 命名。新登录会成为默认账号，已有账号的会话保留。

```bash
cannjudge auth import --listen --name personal
cannjudge auth import --listen --name work
cannjudge auth list
cannjudge auth use personal
cannjudge usage --profile work --json  # 仅此命令使用 work，不改变默认账号
cannjudge auth status --profile work
cannjudge auth logout --profile work  # 仅移除 work 的本地会话
```

`--profile` 支持别名、账号数字 ID 或内部 ID。`auth list` 不显示 Cookie，也不宣称缓存会话仍有效；`auth status`、`auth use`、次数查询和提交会验证 Cookie 对应的真实身份。未找到账号或会话过期时直接报错，不自动换号。退出当前账号后也不会自动选中另一个账号。同一账号重新命名后，计数仍按账号 ID 保留。

## 当天提交次数

```bash
cannjudge usage --json
cannjudge usage --profile personal --json
```

平台限制为**每账号每天 50 次提交，北京时间 00:00 重置**。2026-09-21 已通过真实 HTTP 429 `daily_limit` 响应核实。CLI 只统计次数，不在提交前检查额度或拦截请求，限制由服务端执行。

`usage` 返回当前账号身份、北京时间日期和两组计数，不发送提交请求：

- `submittedToday`：分页读取官方账号提交历史，统计跨全部题目的当天次数，包含编译错误等已有提交，覆盖网页和其他机器的提交。
- `localToday`：本机 CLI 的 `attempted/accepted/rejected/unknown`。网络中断、服务端 5xx 或缺少提交 ID 归为 `unknown`；被 429 拒绝的请求归为 `rejected`，不算作已创建提交。

本机日志位于配置目录的 `submissions/<账号ID>.jsonl`，权限 `0600`，仅含时间、账号／题目／提交 ID 和结果，不记录 Cookie 或源码。从更新后开始记录，`--dry-run` 不计入。公开前端中未找到独立的配额预查接口，因此直接使用官方提交历史，不拿本机次数推断总用量。

## 工程与提交

```bash
P=https://cannjudge.cn/public/ct_starcup_aiop_g3/mhcheadcollapse
cannjudge template "$P" --out ./mhc
cannjudge submit "$P" --dir ./mhc --dry-run --json
cannjudge submit "$P" --dir ./mhc --watch
```

- 从服务器模板读取准确路径与可编辑属性，按相对路径匹配本地工程。缺少可编辑文件会报错。
- 平台的 CMake 文件为只读，由服务器提供。CLI 列出并跳过它们；本地改 CMake 不会改变线上构建。
- 默认只增加平台允许的 `op_host/`、`op_kernel/`、`op_api/` 中的 `.cpp/.h`，不扫描 README、测试、`.git` 或构建产物。`npu_kernel_dev` 模板按 `.asc/.h` 规则处理；它尚未做真实提交验证。
- `--dry-run` 列出提交文件、字节数、SHA-256 和来源，不发送提交请求，也不要求登录（读取历史基础提交除外）。

单文件更新以**自己的同题历史提交**为基础，CLI 合成完整源码一次提交，平台没有独立的“上传一片文件”操作：

```bash
cannjudge submit "$P" --base https://cannjudge.cn/submission/SUBMISSION_OBJECT_ID \
  --file op_kernel/mhc_head_collapse.cpp=./kernel.cpp --dry-run
# 核对后去掉 --dry-run；可加 --watch
```

`--file` 可重复使用，也可覆盖 `--dir` 中的对应文件。`--base` 提供其余文件，不会用空模板填补。`download SUBMISSION_URL --out DIR` 可以导出自己的历史工程。下载不覆盖已有文件，拒绝目录穿越及工程内部越界符号链接。旧版无 `files` 模板和理论题明确不支持。

## 评测、记录、排行榜

```bash
cannjudge status https://cannjudge.cn/submission/SUBMISSION_OBJECT_ID --watch
cannjudge status SUBMISSION_OBJECT_ID --watch --interval 5 --timeout 600 --json
cannjudge submissions "$P" --mine --limit 5
cannjudge ranking "$P" --limit 10
cannjudge ranking https://cannjudge.cn/public/ct_starcup_aiop_g3 --limit 10
```

`status` 输出各测试点的状态、用时、精度比例及错误信息。数字提交编号需登录后通过提交列表解析，推荐直接用提交链接或内部 ID。列表和排行榜支持 `--page` / `--limit`。

退出码：`0` 成功或未结束的单次查询，`1` 操作／网络错误，`2` 评测终态未通过，`3` 跟踪超时。超时保留提交链接，重新运行 `status --watch` 即可。提交 POST **不自动重试**；连接中断可能已经提交，先查 `submissions` 再决定是否重试。

## 验证与接口边界

必要测试位于 `test/`：链接消歧、工程匹配、凭据与路径边界、轮询、多账号迁移／隔离，以及北京时间跨日计数和提交结果记录。无大规模快照或前端测试。

接口依据 CANNJudge 自身公开前端代码及实际响应（2026-09-20）。这不是站方承诺稳定的 SDK；接口变动时应重新核对，不能把 API 失败当成空榜或评测通过。

2026-09-20 真实验证：复用已有网页登录 Cookie，完成会话导入／再次读取、比赛选题、题面读取、模板下载、历史工程导出、数字提交编号解析和两级排行榜查询。完整目录与单文件覆盖产生的源码哈希一致；通过 CLI 实际提交并跟踪的一次 MhcHeadCollapse 提交 **5/5 Pass**。邮箱密码登录请求与 Cookie 接收经过本地 HTTP 测试，真实账号采用会话导入路径，未另外验证密码登录。
