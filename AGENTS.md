# CANNJudge CLI

- 入口：`node src/cli.ts --help`。Node ≥22.18；运行零依赖，开发用 `npm ci`。
- 用户给比赛链接时，先 `inspect URL --json` 获取题目 slug 和链接；再 `inspect URL --problem SLUG` 读题。不猜页面行号与内部 ID 的对应关系。
- 提交前 `submit URL --dir DIR --dry-run --json` 核对文件；成功提交后用返回链接 `status URL --watch`。单文件更新必须指定自己的同题 `--base`。
- 用 `auth status` 检查真实会话；浏览器显示昵称不代表 Cookie 有效。凭据只进配置目录，禁止写入仓库、日志或测试夹具。
- 提交超时不能直接重试，先查 `submissions`。保留题面与评测错误原文，不臆造通过状态。
- 修改后执行 `npm run check && npm test`；真实提交只在用户授权的题目上做。环境与接口细节见 README.md。
