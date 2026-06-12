interface Env {
  CONFIG_KV?: KVNamespace;
  RESEND_API_KEY: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}

type SendStatus = "pending" | "sending" | "sent" | "failed";

type AttachmentRecord = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  base64: string;
  createdAt: string;
};

type Recipient = {
  email: string;
  name?: string;
  data: Record<string, string>;
};

type AppConfig = {
  from: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  recipients: string;
  batchSize: number;
  throttleMs: number;
  cronEnabled: boolean;
  cronOnlyOncePerHours: number;
  attachmentIds: string[];
  updatedAt?: string;
  lastCronRunAt?: string;
};

type SendRecord = {
  id: string;
  taskId: string;
  email: string;
  subject: string;
  status: SendStatus;
  source: "manual" | "cron";
  resendId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

const CONFIG_KEY = "app:config";
const STATUS_INDEX_KEY = "send:index";
const CRON_LOCK_KEY = "cron:lock";
const SESSION_COOKIE = "auto_email_session";
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_STATUS_RECORDS = 500;

const DEFAULT_CONFIG: AppConfig = {
  from: "",
  replyTo: "",
  subject: "欢迎，{{name}}",
  html: "<h1>你好 {{name}}</h1><p>这是一封来自 Auto Email 的测试邮件。</p>",
  text: "你好 {{name}}，这是一封来自 Auto Email 的测试邮件。",
  recipients: "name,email\n张三,zhangsan@example.com",
  batchSize: 10,
  throttleMs: 0,
  cronEnabled: false,
  cronOnlyOncePerHours: 24,
  attachmentIds: [],
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.CONFIG_KV) ctx.waitUntil(runCronSend(env));
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/login" && request.method === "GET") {
    return htmlResponse(renderLoginPage());
  }
  if (pathname === "/login" && request.method === "POST") {
    return login(request, env);
  }
  if (pathname === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login",
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  if (!(await isAuthenticated(request, env))) {
    if (pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, 401);
    return Response.redirect(`${url.origin}/login`, 303);
  }

  if (!env.CONFIG_KV) {
    if (pathname.startsWith("/api/")) return json({ error: "CONFIG_KV binding is not configured. Please bind a Workers KV namespace named CONFIG_KV in Cloudflare." }, 503);
    if (pathname === "/" && request.method === "GET") return htmlResponse(renderSetupPage());
  }

  if (pathname === "/" && request.method === "GET") return htmlResponse(renderAppPage());
  if (pathname === "/api/config" && request.method === "GET") return getConfig(env);
  if (pathname === "/api/config" && request.method === "POST") return saveConfig(request, env);
  if (pathname === "/api/preview" && request.method === "POST") return previewEmail(request, env);
  if (pathname === "/api/send" && request.method === "POST") {
    const result = await createAndSendBatch(env, "manual");
    ctx.waitUntil(Promise.resolve());
    return json(result);
  }
  if (pathname === "/api/send-status" && request.method === "GET") return getSendStatus(env);
  if (pathname === "/api/attachments" && request.method === "GET") return listAttachments(env);
  if (pathname === "/api/attachments" && request.method === "POST") return uploadAttachment(request, env);
  if (pathname.startsWith("/api/attachments/") && request.method === "DELETE") {
    return deleteAttachment(pathname.split("/").pop() || "", env);
  }
  return new Response("Not Found", { status: 404 });
}

async function login(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const username = String(form.get("username") || "");
  const password = String(form.get("password") || "");
  const missingSecrets = getMissingAdminSecrets(env);
  if (missingSecrets.length > 0) {
    return htmlResponse(renderLoginPage(`服务端缺少以下运行时密钥：${missingSecrets.join(", ")}。请在当前 Worker 的 Variables and Secrets 中添加 Secret 类型变量，保存后重新部署。`), 500);
  }
  if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
    return htmlResponse(renderLoginPage("账号或密码错误。"), 401);
  }
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 8;
  const signature = await sign(`${username}.${expires}`, env.SESSION_SECRET);
  const value = `${encodeURIComponent(username)}.${expires}.${signature}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 8}`,
    },
  });
}

function getMissingAdminSecrets(env: Env): string[] {
  return ["ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_SECRET"].filter((key) => !env[key as keyof Env]);
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match || !env.SESSION_SECRET) return false;
  const [encodedUser, expiresText, signature] = match[1].split(".");
  const username = decodeURIComponent(encodedUser || "");
  const expires = Number(expiresText);
  if (!username || !expires || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(`${username}.${expires}`, env.SESSION_SECRET);
  return username === env.ADMIN_USERNAME && timingSafeEqual(signature || "", expected);
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function getConfig(env: Env): Promise<Response> {
  const config = await readConfig(env);
  const attachments = await readAttachments(env, config.attachmentIds);
  return json({ config, attachments: attachments.map(stripAttachmentContent) });
}

async function saveConfig(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<AppConfig>;
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    ...(await readConfig(env)),
    ...body,
    batchSize: clamp(Number(body.batchSize ?? DEFAULT_CONFIG.batchSize), 1, 100),
    throttleMs: clamp(Number(body.throttleMs ?? DEFAULT_CONFIG.throttleMs), 0, 10000),
    cronOnlyOncePerHours: clamp(Number(body.cronOnlyOncePerHours ?? DEFAULT_CONFIG.cronOnlyOncePerHours), 1, 720),
    cronEnabled: Boolean(body.cronEnabled),
    attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
    updatedAt: new Date().toISOString(),
  };
  const validation = validateConfig(config);
  if (validation.length) return json({ errors: validation }, 400);
  await env.CONFIG_KV!.put(CONFIG_KEY, JSON.stringify(config));
  return json({ config });
}

async function previewEmail(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<AppConfig> & { sample?: Record<string, string> };
  const config = { ...(await readConfig(env)), ...body };
  const sample = body.sample || { name: "预览用户", email: "preview@example.com" };
  return json({
    subject: renderTemplate(config.subject, sample),
    html: renderTemplate(config.html, sample),
    text: renderTemplate(config.text, sample),
  });
}

async function uploadAttachment(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "请选择附件文件。" }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return json({ error: "附件不能超过 5MB。" }, 400);
  const id = crypto.randomUUID();
  const record: AttachmentRecord = {
    id,
    name: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    base64: arrayBufferToBase64(await file.arrayBuffer()),
    createdAt: new Date().toISOString(),
  };
  await env.CONFIG_KV!.put(attachmentKey(id), JSON.stringify(record));
  const config = await readConfig(env);
  config.attachmentIds = Array.from(new Set([...config.attachmentIds, id]));
  config.updatedAt = new Date().toISOString();
  await env.CONFIG_KV!.put(CONFIG_KEY, JSON.stringify(config));
  return json({ attachment: stripAttachmentContent(record), config });
}

async function listAttachments(env: Env): Promise<Response> {
  const config = await readConfig(env);
  const attachments = await readAttachments(env, config.attachmentIds);
  return json({ attachments: attachments.map(stripAttachmentContent) });
}

async function deleteAttachment(id: string, env: Env): Promise<Response> {
  const config = await readConfig(env);
  config.attachmentIds = config.attachmentIds.filter((item) => item !== id);
  config.updatedAt = new Date().toISOString();
  await Promise.all([env.CONFIG_KV!.delete(attachmentKey(id)), env.CONFIG_KV!.put(CONFIG_KEY, JSON.stringify(config))]);
  return json({ ok: true, config });
}

async function createAndSendBatch(env: Env, source: "manual" | "cron"): Promise<{ taskId: string; total: number; sent: number; failed: number }> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const config = await readConfig(env);
  const validation = validateConfig(config);
  if (validation.length) throw new Error(validation.join(" "));
  const recipients = parseRecipients(config.recipients).slice(0, config.batchSize);
  const taskId = `${source}-${Date.now()}`;
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const record: SendRecord = {
      id: crypto.randomUUID(),
      taskId,
      email: recipient.email,
      subject: renderTemplate(config.subject, { ...recipient.data, email: recipient.email, name: recipient.name || "" }),
      status: "sending",
      source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveSendRecord(env, record);
    try {
      const resendId = await sendEmail(env, config, recipient);
      record.status = "sent";
      record.resendId = resendId;
      sent++;
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      failed++;
    }
    record.updatedAt = new Date().toISOString();
    await saveSendRecord(env, record);
    if (config.throttleMs > 0) await sleep(config.throttleMs);
  }
  return { taskId, total: recipients.length, sent, failed };
}

async function sendEmail(env: Env, config: AppConfig, recipient: Recipient): Promise<string | undefined> {
  const data = { ...recipient.data, email: recipient.email, name: recipient.name || "" };
  const attachments = await readAttachments(env, config.attachmentIds);
  const payload = {
    from: config.from,
    to: [recipient.email],
    reply_to: config.replyTo || undefined,
    subject: renderTemplate(config.subject, data),
    html: renderTemplate(config.html, data),
    text: renderTemplate(config.text, data),
    attachments: attachments.map((attachment) => ({
      filename: attachment.name,
      content: attachment.base64,
      content_type: attachment.contentType,
    })),
  };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!response.ok) throw new Error(result.message || result.name || `Resend API failed with ${response.status}`);
  return result.id;
}

async function runCronSend(env: Env): Promise<void> {
  const config = await readConfig(env);
  if (!config.cronEnabled) return;
  const now = Date.now();
  const lastRun = config.lastCronRunAt ? Date.parse(config.lastCronRunAt) : 0;
  if (lastRun && now - lastRun < config.cronOnlyOncePerHours * 60 * 60 * 1000) return;
  const locked = await env.CONFIG_KV!.get(CRON_LOCK_KEY);
  if (locked && now - Number(locked) < 10 * 60 * 1000) return;
  await env.CONFIG_KV!.put(CRON_LOCK_KEY, String(now), { expirationTtl: 600 });
  try {
    await createAndSendBatch(env, "cron");
    config.lastCronRunAt = new Date().toISOString();
    await env.CONFIG_KV!.put(CONFIG_KEY, JSON.stringify(config));
  } finally {
    await env.CONFIG_KV!.delete(CRON_LOCK_KEY);
  }
}

async function getSendStatus(env: Env): Promise<Response> {
  const records = await readSendRecords(env);
  const summary = records.reduce(
    (acc, record) => {
      acc.total++;
      acc[record.status]++;
      return acc;
    },
    { total: 0, pending: 0, sending: 0, sent: 0, failed: 0 } as Record<SendStatus | "total", number>,
  );
  return json({ summary, records });
}

async function saveSendRecord(env: Env, record: SendRecord): Promise<void> {
  await env.CONFIG_KV!.put(sendRecordKey(record.id), JSON.stringify(record));
  const index = await readStatusIndex(env);
  const next = [record.id, ...index.filter((id) => id !== record.id)].slice(0, MAX_STATUS_RECORDS);
  await env.CONFIG_KV!.put(STATUS_INDEX_KEY, JSON.stringify(next));
}

async function readSendRecords(env: Env): Promise<SendRecord[]> {
  const index = await readStatusIndex(env);
  const records = await Promise.all(index.map((id) => env.CONFIG_KV!.get<SendRecord>(sendRecordKey(id), "json")));
  return records.filter((record): record is SendRecord => Boolean(record));
}

async function readStatusIndex(env: Env): Promise<string[]> {
  return (await env.CONFIG_KV!.get<string[]>(STATUS_INDEX_KEY, "json")) || [];
}

async function readConfig(env: Env): Promise<AppConfig> {
  const stored = await env.CONFIG_KV!.get<Partial<AppConfig>>(CONFIG_KEY, "json");
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function readAttachments(env: Env, ids: string[]): Promise<AttachmentRecord[]> {
  const records = await Promise.all(ids.map((id) => env.CONFIG_KV!.get<AttachmentRecord>(attachmentKey(id), "json")));
  return records.filter((record): record is AttachmentRecord => Boolean(record));
}

function stripAttachmentContent(attachment: AttachmentRecord): Omit<AttachmentRecord, "base64"> {
  const { base64: _base64, ...safe } = attachment;
  return safe;
}

function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!isEmailLike(config.from)) errors.push("请配置有效的发件人邮箱。");
  if (config.replyTo && !isEmailLike(config.replyTo)) errors.push("回复邮箱格式不正确。");
  if (!config.subject.trim()) errors.push("邮件主题不能为空。");
  if (!config.html.trim() && !config.text.trim()) errors.push("HTML 或纯文本内容至少填写一项。");
  if (parseRecipients(config.recipients).length === 0) errors.push("请至少配置一个有效收件人。");
  return errors;
}

function parseRecipients(input: string): Recipient[] {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((item) => item.trim());
  const hasHeader = headers.includes("email");
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.flatMap((line) => {
    const values = line.split(",").map((item) => item.trim());
    const data: Record<string, string> = {};
    if (hasHeader) headers.forEach((header, index) => (data[header] = values[index] || ""));
    const email = hasHeader ? data.email : values[0];
    if (!isEmailLike(email)) return [];
    return [{ email, name: data.name || values[0], data: hasHeader ? data : { email, name: values[1] || "" } }];
  });
}

function renderTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key: string) => escapeHtml(data[key] || ""));
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachmentKey(id: string): string {
  return `attachment:${id}`;
}

function sendRecordKey(id: string): string {
  return `send:${id}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function base64Url(buffer: ArrayBuffer): string {
  return arrayBufferToBase64(buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] || char);
}

function renderSetupPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配置 CONFIG_KV</title>${style()}</head><body class="login"><main class="card login-card"><h1>需要绑定 KV</h1><p>Worker 已部署成功，但还没有绑定名为 <strong>CONFIG_KV</strong> 的 Workers KV namespace。</p><div class="alert">请在 Cloudflare Dashboard → Workers & Pages → 当前 Worker → Settings → Bindings 中添加 KV 绑定，变量名必须为 CONFIG_KV，然后重新部署或保存设置。</div><form method="post" action="/logout"><button class="secondary">退出登录</button></form></main></body></html>`;
}

function renderLoginPage(error = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 Auto Email</title>${style()}</head><body class="login"><main class="card login-card"><h1>Auto Email</h1><p>登录后管理 Resend 群发邮件任务。</p>${error ? `<div class="alert">${escapeHtml(error)}</div>` : ""}<form method="post" action="/login"><label>账号<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required minlength="1"></label><button type="submit">登录</button></form></main></body></html>`;
}

function renderAppPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto Email</title>${style()}</head><body><header><div><h1>Auto Email</h1><p>基于 Resend 与 Cloudflare Workers 的群发邮件控制台</p></div><form method="post" action="/logout"><button class="secondary">退出</button></form></header><main class="grid"><section class="card"><h2>发送配置</h2><div id="errors"></div><label>发件人 From<input id="from" placeholder="news@example.com"></label><label>回复邮箱 Reply-To<input id="replyTo" placeholder="support@example.com"></label><label>邮件主题<input id="subject"></label><label>HTML 内容<textarea id="html" rows="10"></textarea></label><label>纯文本内容<textarea id="text" rows="5"></textarea></label><label>收件人 CSV<textarea id="recipients" rows="8" placeholder="name,email\n张三,zhangsan@example.com"></textarea></label><div class="row"><label>批量大小<input id="batchSize" type="number" min="1" max="100"></label><label>发送间隔(ms)<input id="throttleMs" type="number" min="0" max="10000"></label></div><div class="row"><label class="check"><input id="cronEnabled" type="checkbox"> 启用 Cron 自动群发</label><label>Cron 最小间隔(小时)<input id="cronOnlyOncePerHours" type="number" min="1" max="720"></label></div><div class="actions"><button id="save">保存配置</button><button id="preview" class="secondary">预览邮件</button><button id="send" class="danger">立即群发</button></div></section><section class="card"><h2>附件</h2><form id="attachmentForm"><input id="attachment" name="file" type="file"><button>上传附件</button></form><ul id="attachments"></ul><h2>预览</h2><div><strong id="previewSubject"></strong></div><iframe id="previewFrame" title="邮件预览"></iframe></section><section class="card wide"><h2>发送状态</h2><div id="summary" class="summary"></div><table><thead><tr><th>时间</th><th>收件人</th><th>主题</th><th>来源</th><th>状态</th><th>错误</th></tr></thead><tbody id="records"></tbody></table></section></main><script>${clientScript()}</script></body></html>`;
}

function style(): string {
  return `<style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}body{margin:0}header{display:flex;justify-content:space-between;align-items:center;padding:24px 32px;background:#111827;color:white}h1,h2{margin:.2rem 0}p{color:#64748b}.login{display:grid;min-height:100vh;place-items:center}.card{background:white;border:1px solid #e5e7eb;border-radius:18px;box-shadow:0 12px 40px #0f172a12;padding:24px}.login-card{width:min(420px,calc(100vw - 32px))}.grid{display:grid;grid-template-columns:minmax(380px,1.1fr) minmax(320px,.9fr);gap:24px;padding:24px}.wide{grid-column:1/-1}label{display:grid;gap:6px;margin:12px 0;font-weight:650}input,textarea{font:inherit;border:1px solid #cbd5e1;border-radius:10px;padding:10px;background:#fff}textarea{resize:vertical}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.check{display:flex;align-items:center;gap:8px}button{border:0;border-radius:10px;background:#2563eb;color:white;padding:10px 14px;font-weight:700;cursor:pointer}.secondary{background:#475569}.danger{background:#dc2626}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.alert{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:10px;margin:12px 0}iframe{width:100%;height:380px;border:1px solid #cbd5e1;border-radius:12px;background:white}.summary{display:flex;gap:12px;flex-wrap:wrap}.pill{border-radius:999px;padding:6px 10px;background:#eef2ff;color:#3730a3;font-weight:700}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;border-bottom:1px solid #e5e7eb;padding:10px;vertical-align:top}#attachments li{display:flex;justify-content:space-between;gap:8px;margin:8px 0}@media(max-width:900px){.grid{grid-template-columns:1fr;padding:12px}header{padding:18px}}</style>`;
}

function clientScript(): string {
  return `const $=id=>document.getElementById(id);let current={attachmentIds:[]};async function api(path,options={}){const r=await fetch(path,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||(data.errors||[]).join(' ')||'请求失败');return data}function readForm(){return{from:$('from').value,replyTo:$('replyTo').value,subject:$('subject').value,html:$('html').value,text:$('text').value,recipients:$('recipients').value,batchSize:Number($('batchSize').value),throttleMs:Number($('throttleMs').value),cronEnabled:$('cronEnabled').checked,cronOnlyOncePerHours:Number($('cronOnlyOncePerHours').value),attachmentIds:current.attachmentIds||[]}}function fill(c){current=c;for(const k of ['from','replyTo','subject','html','text','recipients','batchSize','throttleMs','cronOnlyOncePerHours'])$(k).value=c[k]??'';$('cronEnabled').checked=!!c.cronEnabled}function showError(e){$('errors').innerHTML='<div class="alert">'+String(e.message||e)+'</div>'}function clearError(){$('errors').innerHTML=''}function renderAttachments(items){$('attachments').innerHTML=items.map(a=>'<li><span>'+a.name+' ('+Math.round(a.size/1024)+'KB)</span><button class="secondary" data-id="'+a.id+'">删除</button></li>').join('');$('attachments').querySelectorAll('button').forEach(b=>b.onclick=async()=>{await fetch('/api/attachments/'+b.dataset.id,{method:'DELETE'});await load()})}async function load(){const data=await api('/api/config');fill(data.config);renderAttachments(data.attachments);await loadStatus()}async function save(){clearError();const data=await api('/api/config',{method:'POST',body:JSON.stringify(readForm())});fill(data.config)}async function preview(){clearError();const data=await api('/api/preview',{method:'POST',body:JSON.stringify(readForm())});$('previewSubject').textContent=data.subject;$('previewFrame').srcdoc=data.html||('<pre>'+data.text+'</pre>')}async function sendNow(){clearError();if(!confirm('确定立即按当前已保存配置群发？'))return;await save();await api('/api/send',{method:'POST',body:'{}'});await loadStatus()}async function loadStatus(){const data=await api('/api/send-status');$('summary').innerHTML=Object.entries(data.summary).map(([k,v])=>'<span class="pill">'+k+': '+v+'</span>').join('');$('records').innerHTML=data.records.map(r=>'<tr><td>'+r.updatedAt+'</td><td>'+r.email+'</td><td>'+r.subject+'</td><td>'+r.source+'</td><td>'+r.status+'</td><td>'+(r.error||'')+'</td></tr>').join('')}async function upload(e){e.preventDefault();clearError();const fd=new FormData();const file=$('attachment').files[0];if(!file)return;fd.append('file',file);const r=await fetch('/api/attachments',{method:'POST',body:fd});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'上传失败');await load()}$('save').onclick=()=>save().catch(showError);$('preview').onclick=()=>preview().catch(showError);$('send').onclick=()=>sendNow().catch(showError);$('attachmentForm').onsubmit=e=>upload(e).catch(showError);setInterval(()=>loadStatus().catch(()=>{}),5000);load().catch(showError);`;
}
