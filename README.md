# auto-email

全自动群发邮件，基于 Resend、Cloudflare Workers、KV 与 Cron Triggers。

## 功能

- 管理员登录：账号、密码与会话密钥通过 Cloudflare secrets 配置。
- 界面化配置：除 `RESEND_API_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SESSION_SECRET` 外，发件人、回复邮箱、主题、HTML/文本模板、收件人 CSV、批量大小、发送间隔、Cron 开关与附件均在网页控制台配置。
- 邮件预览：支持 `{{name}}`、`{{email}}` 等 CSV 字段变量渲染。
- 群发邮件：调用 Resend Email API 批量发送邮件，并记录每个收件人的状态。
- 附件：通过界面上传附件，附件内容存储在 KV 中，发送时随 Resend 请求提交。
- 状态看板：展示总量、发送中、成功、失败以及最近发送记录。
- 自动任务：Cloudflare Cron Trigger 会读取界面配置，并在开启自动群发时执行任务。

## 本地开发

```bash
npm install
npm run dev
```

## 一键部署到 Cloudflare

> 如果你已经把本项目 fork/推送到了自己的 GitHub 仓库，可以把下面链接中的 `YOUR_GITHUB_ACCOUNT` 替换成你的 GitHub 用户名或组织名。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_ACCOUNT/auto-email)

一键部署会在 Cloudflare 中创建 Worker 项目并拉取 GitHub 仓库代码。为了避免首次部署时因为示例 KV namespace id 无效而失败，`wrangler.toml` 默认不写死 KV id；部署完成后仍需要按下方教程绑定 KV namespace 并配置 secrets，否则登录、配置保存和 Resend 发信功能无法正常工作。

## Cloudflare 部署与配置教程

### 方式一：通过一键部署按钮

1. Fork 本仓库，或将代码推送到你自己的 GitHub 仓库。
2. 修改上方一键部署按钮 URL 中的 `YOUR_GITHUB_ACCOUNT`，确保 `url=` 指向你的仓库地址，例如：

   ```text
   https://deploy.workers.cloudflare.com/?url=https://github.com/your-name/auto-email
   ```

3. 点击按钮，登录 Cloudflare，并按页面提示选择账号、授权 GitHub 仓库和创建 Worker。
4. 部署完成后，进入 Cloudflare Dashboard 的 **Workers & Pages**，打开刚创建的 Worker。
5. 在 **Settings → Bindings** 中添加 KV namespace 绑定：
   - Variable name：`CONFIG_KV`
   - KV namespace：选择新建或已有的 namespace
6. 在 **Settings → Variables** 中添加以下 encrypted secrets：
   - `RESEND_API_KEY`：Resend API Key
   - `ADMIN_USERNAME`：后台登录账号
   - `ADMIN_PASSWORD`：后台登录密码
   - `SESSION_SECRET`：用于签名登录 Cookie 的随机长字符串
7. 在 **Settings → Triggers → Cron Triggers** 中确认存在 `*/30 * * * *`，或按你的发送计划调整 Cron 表达式。
8. 重新部署 Worker，然后访问 Worker 域名，使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录后台，在界面中配置发件人、收件人、邮件模板、附件、批量大小和自动任务开关。

### 方式二：通过 Wrangler CLI 部署

1. 安装依赖：

   ```bash
   npm install
   ```

2. 登录 Cloudflare：

   ```bash
   npx wrangler login
   ```

3. 创建 KV namespace：

   ```bash
   npx wrangler kv namespace create CONFIG_KV
   npx wrangler kv namespace create CONFIG_KV --preview
   ```

4. 如果你希望通过 `wrangler.toml` 管理 KV 绑定，可以取消 `wrangler.toml` 中 KV 示例块的注释，并将命令输出中的 `id` 和 `preview_id` 写入配置；如果你使用 Dashboard 绑定 KV，可以跳过这一步：

   ```toml
   [[kv_namespaces]]
   binding = "CONFIG_KV"
   id = "你的生产 KV namespace id"
   preview_id = "你的预览 KV namespace id"
   ```

5. 配置 secrets：

   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put ADMIN_USERNAME
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

6. 部署 Worker：

   ```bash
   npm run deploy
   ```

7. 打开部署输出中的 Worker URL，登录后台并完成界面配置。

## 常见部署问题

### 登录提示“服务端未配置 ADMIN_USERNAME、ADMIN_PASSWORD 或 SESSION_SECRET”

这三个值应该配置为 **Secret / Encrypted** 类型，而不是普通明文变量：

- `ADMIN_USERNAME`：后台登录账号
- `ADMIN_PASSWORD`：后台登录密码
- `SESSION_SECRET`：用于签名登录 Cookie 的随机长字符串，建议至少 32 位

如果你确认已经配置但仍然报错，请重点检查下面几点：

1. 变量名必须完全一致，区分大小写，不能写成 `ADMIN_USER`、`ADMIN_NAME`、`SESSION_KEY` 等其他名字。
2. Secrets 必须添加在 **当前访问域名对应的 Worker** 上：Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Variables and Secrets。
3. 如果使用 Cloudflare Git/一键部署，不要只配置“构建时环境变量”。登录运行时读取的是 Worker runtime secrets，需要在 Worker 的 Variables and Secrets 里配置。
4. 添加或修改 secrets 后，建议重新部署一次 Worker，或在 Dashboard 保存设置后等待最新版本生效。
5. 如果你有多个 Worker 或多个环境，请确认访问的域名对应的就是配置了这些 secrets 的那个 Worker。

通过 Wrangler CLI 配置时可以使用：

```bash
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

`RESEND_API_KEY` 也应该配置为 Secret 类型，但它只在发信时使用；登录页报这个错误时，主要缺的是上面三个登录相关 secrets。

### 部署后访问域名显示 `Hello World`

本项目代码不会返回 `Hello World`。正常情况下：

- 未登录访问 `/` 会跳转到 `/login`；
- 已登录但还没有绑定 `CONFIG_KV` 时，会显示“需要绑定 KV”的提示页；
- 已登录且 KV/secrets 配置完成后，会显示 Auto Email 控制台。

如果你看到 `Hello World`，通常表示线上运行的不是本仓库的 `src/index.ts`，而是 Cloudflare 创建 Worker 时的默认示例代码。请按下面步骤排查：

1. 确认访问的是本项目部署出来的 Worker 域名，而不是 Cloudflare 后台新建的另一个示例 Worker 域名。
2. 在 Cloudflare Dashboard 打开对应 Worker，进入 **Deployments**，确认最近一次部署来自你的 GitHub 仓库或本地 `wrangler deploy`，而不是 Dashboard 默认模板。
3. 如果使用一键部署或 Git 集成，请确认：
   - Build command：`npm install && npx wrangler deploy`
   - Deploy command：`npx wrangler deploy`
   - Root directory：仓库根目录
   - Wrangler 配置文件：仓库根目录的 `wrangler.toml`
4. 如果你在 Cloudflare Dashboard 的在线编辑器里看到 `return new Response("Hello World!")`，说明当前 Worker 仍是默认模板。请重新用本仓库部署，或把部署源切换到你的 GitHub 仓库后再次部署。
5. 部署完成后再配置 `CONFIG_KV` 绑定和 encrypted secrets：`RESEND_API_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SESSION_SECRET`。
6. 重新访问 Worker 域名；如果代码已正确部署，页面应进入 `/login` 登录页，而不是显示 `Hello World`。

### `KV namespace 'replace-with-production-kv-namespace-id' is not valid`

这是因为 `wrangler.toml` 中使用了示例占位符作为真实 KV namespace id。当前版本已经默认注释掉 KV namespace 配置，首次一键部署不会再带着无效占位符发布。

如果你需要在 `wrangler.toml` 中声明 KV 绑定，请先创建真实 namespace，再把真实 `id` / `preview_id` 填入配置；不要直接使用 `replace-with-production-kv-namespace-id`、`your-production-kv-namespace-id` 等示例文本。

也可以不在 `wrangler.toml` 中声明 KV，在首次部署成功后到 Cloudflare Dashboard 手动添加绑定：

- Binding type：Workers KV
- Variable name：`CONFIG_KV`
- KV namespace：选择你创建的 namespace

## 收件人 CSV 格式

首行推荐填写字段名，且必须包含 `email` 字段。其他字段可作为模板变量使用。

```csv
name,email,company
张三,zhangsan@example.com,Example Inc
李四,lisi@example.com,Demo LLC
```

邮件主题或正文中可以使用：

```text
你好 {{name}}，欢迎加入 {{company}}。
```

## 注意事项

- KV 中保存配置、附件与发送状态；大附件或高频发送场景建议改用 R2/D1/Queues。
- 当前实现会按配置的 `batchSize` 选取收件人列表前 N 条发送。
- 请确认发件域名已在 Resend 完成验证。
