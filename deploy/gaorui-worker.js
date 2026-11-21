// GAORUI STONE · Cloudflare Worker（询盘 API + 访问统计 + 静态托管）
// 依赖绑定：D1 数据库 DB、静态资源 ASSETS
// 必需 Secret：ADMIN_PASSWORD（首次启动后写入 D1 并可用后台改密）、ADMIN_SALT（哈希盐）
// 可选 Secret：NOTIFY_WEBHOOK（新询盘推送到 Telegram/Slack/飞书/企微机器人）
// 可选 Secret：ALLOWED_ORIGINS（逗号分隔，默认允许 gaoruistone.com 与本 Worker 自身域名）
//
// 设计说明：不在代码里写死任何口令。金灏旧版把明文密码放在源码中，本版本改为
// 从 Worker Secret 读取、仅在首次运行时以 sha256(pwd+salt) 落库，源码可安全托管。

const TOKEN_TTL_HOURS = 72;
const SITE_HOST = 'gaoruistone.com';

// ---------------- 工具 ----------------

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(new TextEncoder().encode(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

const bad = (msg) => json({ ok: false, error: msg }, 400);
const unauthorized = (msg = 'Not signed in or session expired') => json({ ok: false, error: msg }, 401);

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const clean = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// 只接受本站与可信来源的跨站提交
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  const allow = new Set([`https://${SITE_HOST}`, `https://www.${SITE_HOST}`]);
  if (env && env.ALLOWED_ORIGINS) {
    String(env.ALLOWED_ORIGINS).split(',').forEach((o) => allow.add(o.trim()));
  }
  try {
    allow.add(new URL(request.url).origin); // 部署预览用的 workers.dev 自身域名
  } catch (e) { /* ignore */ }
  if (!allow.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// ---------------- Schema（进程内只建一次） ----------------

let schemaReady = false;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inquiries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     company TEXT, country TEXT, email TEXT, whatsapp TEXT,
     project TEXT, area TEXT, finish TEXT, message TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'new',
     note TEXT,
     page TEXT, ip TEXT, user_agent TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
     updated_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status)`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries(created_at)`,
  `CREATE TABLE IF NOT EXISTS rate (ip TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (ip, bucket))`,
  `CREATE TABLE IF NOT EXISTS visits (path TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (path, day))`,
];

async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await env.DB.prepare(sql).run();
  schemaReady = true;
}

// 首次运行：把 Secret 里的口令哈希入库。之后以库内哈希为准（可后台改密）。
async function ensureAdminSeed(env) {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'admin_password'`).first();
  if (row) return true;
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SALT) return false;
  const hash = await sha256(String(env.ADMIN_PASSWORD) + String(env.ADMIN_SALT));
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('admin_password', ?)`).bind(hash).run();
  return true;
}

async function currentSalt(env) {
  // 盐优先用 Secret；没有则生成随机盐存库，保证哈希不可彩虹表反推
  if (env.ADMIN_SALT) return String(env.ADMIN_SALT);
  let row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'pwd_salt'`).first();
  if (!row) {
    const s = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('pwd_salt', ?)`).bind(s).run();
    return s;
  }
  return row.value;
}

// ---------------- 认证 ----------------

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function isAdmin(env, token) {
  if (!token) return false;
  const row = await env.DB.prepare(`SELECT created_at FROM sessions WHERE token = ?`).bind(token).first();
  if (!row) return false;
  // created_at 以 UTC 存储（datetime('now')），按 72h 过期
  const t = Date.parse(row.created_at.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && Date.now() - t < TOKEN_TTL_HOURS * 3600 * 1000;
}

async function login(env, body) {
  if (!(await ensureAdminSeed(env))) {
    return json({ ok: false, error: 'Admin password not configured. Set the ADMIN_PASSWORD and ADMIN_SALT secrets.' }, 503);
  }
  const salt = await currentSalt(env);
  const hash = await sha256(String(body.password || '') + salt);
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'admin_password'`).first();
  if (!row || row.value !== hash) return unauthorized('Wrong password');
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(`INSERT INTO sessions (token, created_at) VALUES (?, datetime('now'))`).bind(token).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE datetime(created_at) < datetime('now', ?)`)
    .bind(`-${TOKEN_TTL_HOURS} hours`).run();
  return json({ ok: true, token });
}

async function changePassword(env, body) {
  const salt = await currentSalt(env);
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'admin_password'`).first();
  if (!row) return bad('Admin not initialised');
  if (row.value !== await sha256(String(body.old || '') + salt)) return unauthorized('Current password is wrong');
  const next = String(body.next || '');
  if (next.length < 8) return bad('New password must be at least 8 characters');
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'admin_password'`)
    .bind(await sha256(next + salt)).run();
  await env.DB.prepare(`DELETE FROM sessions`).run(); // 改密后强制全部重新登录
  return json({ ok: true });
}

// ---------------- 询盘 ----------------

async function tooFrequent(env, ip) {
  const now = new Date();
  const minBucket = now.toISOString().slice(0, 16);          // yyyy-mm-ddThh:mm
  const dayBucket = now.toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO rate (ip, bucket, count) VALUES (?, ?, 1)
     ON CONFLICT(ip, bucket) DO UPDATE SET count = count + 1`
  ).bind(ip, minBucket).run();
  const perMin = await env.DB.prepare(
    `SELECT COALESCE(SUM(count),0) AS c FROM rate WHERE ip = ? AND length(bucket) = 16 AND bucket >= ?`
  ).bind(ip, new Date(now.getTime() - 60000).toISOString().slice(0, 16)).first();
  const perDay = await env.DB.prepare(
    `SELECT COALESCE(SUM(count),0) AS c FROM rate WHERE ip = ? AND length(bucket) = 10 AND bucket = ?`
  ).bind(ip, dayBucket).first();
  return (perMin.c > 3) || (perDay.c > 20);
}

async function submitInquiry(env, request, body) {
  const name = clean(body.name, 80);
  const message = clean(body.message, 4000);
  const email = clean(body.email, 120);
  const whatsapp = clean(body.whatsapp, 40);

  // 蜜罐：正常表单里这个字段被 CSS 隐藏，人不会填；填了直接假成功丢弃
  if (clean(body.website, 200)) return json({ ok: true });

  if (!name) return bad('Name is required.');
  if (!message && !email && !whatsapp) return bad('Please add a message or your contact details.');
  if (message.length < 5 && !email && !whatsapp) return bad('Please tell us a little more.');
  if (email && !EMAIL_RE.test(email)) return bad('That email address does not look right.');
  if (!email && !whatsapp) return bad('Please provide an email or WhatsApp number so we can reply.');

  const ip = (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  if (ip && await tooFrequent(env, ip)) {
    return json({ ok: false, error: 'Too many submissions from this address. Please try again in a minute or use WhatsApp.' }, 429);
  }

  const info = await env.DB.prepare(
    `INSERT INTO inquiries (name, company, country, email, whatsapp, project, area, finish, message, page, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    name, clean(body.company, 120), clean(body.country, 80), email, whatsapp,
    clean(body.project, 60), clean(body.area, 60), clean(body.finish, 160), message,
    clean(body.page, 120), ip, clean(request.headers.get('User-Agent'), 250)
  ).run();

  if (env.NOTIFY_WEBHOOK) {
    const text = `New inquiry #${info.meta.last_row_id}\n${name} · ${clean(body.company, 120) || '-'} · ${clean(body.country, 80) || '-'}\n` +
      `${email || whatsapp || 'no contact'}\nProject: ${clean(body.project, 60) || '-'} | Area: ${clean(body.area, 60) || '-'} | Finish: ${clean(body.finish, 160) || '-'}\n` +
      `${message.slice(0, 500)}`;
    // 通知失败不能影响客户提交结果
    fetch(env.NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }

  return json({ ok: true, id: Number(info.meta.last_row_id) });
}

async function listInquiries(env, url) {
  const status = url.searchParams.get('status') || '';
  const q = clean(url.searchParams.get('q'), 60);
  let sql = `SELECT id, name, company, country, email, whatsapp, project, area, finish, message, status, note, page, created_at, updated_at FROM inquiries WHERE 1=1`;
  const args = [];
  if (['new', 'contacted', 'quoting', 'won', 'lost', 'archived'].includes(status)) { sql += ` AND status = ?`; args.push(status); }
  if (q) {
    sql += ` AND (name LIKE ? OR company LIKE ? OR email LIKE ? OR whatsapp LIKE ? OR finish LIKE ? OR message LIKE ?)`;
    const like = `%${q}%`;
    for (let i = 0; i < 6; i++) args.push(like);
  }
  sql += ` ORDER BY id DESC LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const counts = await env.DB.prepare(`SELECT status, COUNT(*) AS c FROM inquiries GROUP BY status`).all();
  return json({ ok: true, items: results, counts: counts.results });
}

const STATUS_SET = ['new', 'contacted', 'quoting', 'won', 'lost', 'archived'];

async function updateInquiry(env, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad('Bad id');
  const status = String(body.status || '');
  const note = clean(body.note, 1000);
  if (status && !STATUS_SET.includes(status)) return bad('Unknown status');
  await env.DB.prepare(`UPDATE inquiries SET status = COALESCE(NULLIF(?, ''), status), note = ?, updated_at = datetime('now','+8 hours') WHERE id = ?`)
    .bind(status, note, id).run();
  return json({ ok: true });
}

async function deleteInquiry(env, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return bad('Bad id');
  await env.DB.prepare(`DELETE FROM inquiries WHERE id = ?`).bind(n).run();
  return json({ ok: true });
}

// CSV 导出（外贸跟进常用，直接丢进 Excel）
async function exportCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, name, company, country, email, whatsapp, project, area, finish, status, message, note FROM inquiries ORDER BY id DESC`
  ).all();
  const head = ['id', 'date', 'name', 'company', 'country', 'email', 'whatsapp', 'project', 'area', 'finish', 'status', 'message', 'note'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [head.join(',')].concat(results.map((r) => head.map((h) => esc(r[h])).join(','))).join('\r\n');
  return new Response('\ufeff' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="gaorui-inquiries-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

// ---------------- 统计 ----------------

async function trackVisit(env, url) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const path = (url.pathname || '/').slice(0, 200);
    await env.DB.prepare(
      `INSERT INTO visits (path, day, count) VALUES (?, ?, 1)
       ON CONFLICT(path, day) DO UPDATE SET count = count + 1`
    ).bind(path, day).run();
  } catch (e) { /* 统计失败不影响页面 */ }
}

async function stats(env) {
  const today = new Date().toISOString().slice(0, 10);
  const v = await env.DB.prepare(
    `SELECT COALESCE(SUM(count),0) AS total,
            COALESCE(SUM(CASE WHEN day = ? THEN count ELSE 0 END),0) AS today FROM visits`
  ).bind(today).first();
  const byPath = await env.DB.prepare(`SELECT path, SUM(count) AS count FROM visits GROUP BY path ORDER BY count DESC LIMIT 30`).all();
  const days = await env.DB.prepare(`SELECT day, SUM(count) AS count FROM visits GROUP BY day ORDER BY day DESC LIMIT 14`).all();
  const inq = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN substr(created_at,1,10) = ? THEN 1 ELSE 0 END),0) AS today,
            COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END),0) AS pending
     FROM inquiries`
  ).bind(today).first();
  return json({ ok: true, visits: v, byPath: byPath.results, days: days.results, inquiries: inq });
}

// ---------------- 入口 ----------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Cloudflare 内部路由放行（邮件保护、R2 代理等）
    if (url.pathname.startsWith('/cdn-cgi/')) return fetch(request);

    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname.startsWith('/api/')) {
      if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" is missing' }, 500, cors);
      await ensureSchema(env);
      const path = url.pathname.replace(/^\/api\//, '');
      const body = ['POST', 'PUT'].includes(request.method) ? await readBody(request) : {};

      // 公开
      if (path === 'inquiry' && request.method === 'POST') return submitInquiry(env, request, body);
      if (path === 'login' && request.method === 'POST') return login(env, body);

      // 需登录
      const token = bearer(request);
      if (!(await isAdmin(env, token))) {
        return json({ ok: false, error: 'Not signed in or session expired' }, 401, cors);
      }
      if (path === 'inquiries' && request.method === 'GET') return listInquiries(env, url);
      if (path === 'inquiries' && request.method === 'PUT') return updateInquiry(env, body);
      if (path === 'inquiries' && request.method === 'DELETE') return deleteInquiry(env, url.searchParams.get('id'));
      if (path === 'export.csv' && request.method === 'GET') return exportCsv(env);
      if (path === 'stats' && request.method === 'GET') return stats(env);
      if (path === 'password' && request.method === 'POST') return changePassword(env, body);
      return json({ ok: false, error: 'Unknown endpoint' }, 404, cors);
    }

    // 页面访问统计
    const last = url.pathname.split('/').pop() || '';
    if (request.method === 'GET' && env.DB && (url.pathname === '/' || /\.html$/i.test(url.pathname) || last.indexOf('.') === -1)) {
      ctx.waitUntil((async () => { await ensureSchema(env); await trackVisit(env, url); })());
    }

    // 静态资源映射（wrangler 里 html_handling="none"，ASSETS 不做 URL 规范化，需要显式兜底）
    if (env.ASSETS && request.method === 'GET') {
      // 根路径 → index.html
      if (url.pathname === '/') {
        const r = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
        if (r.status !== 404) return r;
      }
      // 无扩展名路径 → 同名 .html（/products → /products.html），保证旧链接不 404
      if (!url.pathname.includes('.') && !url.pathname.endsWith('/')) {
        const r = await env.ASSETS.fetch(new Request(`${url.origin}${url.pathname}.html`, request));
        if (r.status !== 404) return r;
      }
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('ASSETS binding missing', { status: 500 });
  },
};
