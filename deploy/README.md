# GAORUI STONE · Cloudflare 部署与询盘后台

站点：8 个自包含 HTML（图片已内联）+ 询盘 API（Cloudflare Worker + D1）+ 询盘后台（admin.html）。

---

## 0. 需要准备的两件事

| 资源 | 说明 |
|---|---|
| **D1 数据库** | Cloudflare 免费额度足够（询盘量级远用不完）。存询盘、访问统计、登录会话。 |
| **两个 Secret** | `ADMIN_PASSWORD`（后台密码）、`ADMIN_SALT`（哈希盐）。**代码里不含任何口令**，源码可放心托管 GitHub。 |

> ⚠️ 不要复用旧站的默认口令。旧版曾把明文密码写在源码里，本版本改为 Secret 注入。
> 建议：密码 12 位以上；盐随便敲一串 32 位以上字符（如 `openssl rand -hex 16` 的结果，或手打乱码）。

---

## 路径 A：零命令行（推荐，不需要装 Node）

静态站用 **Pages 拖拽上传**，API 用 **Worker**，两者用不同域名，互不干扰。

### A1. 建 D1
1. Cloudflare Dashboard → **Storage & Databases → Databases → Create**
2. 名称填 `gaorui-inquiries` → 创建
3. 表结构**不用手动建**，Worker 首次收到请求时自动建表

### A2. 部署 API Worker
1. **Workers & Pages → Create → Worker → Get started（Hello World）→ 命名 `gaorui-api` → Deploy**
2. 进入该 Worker → **Code** 标签 → 把编辑器里的示例代码全部删掉 → 粘贴本目录 `gaorui-worker.js` 全文 → **Save and Deploy**
3. **Settings → Variables → 右侧 Secrets 区 → Add**：
   - `ADMIN_PASSWORD` = 你的后台密码
   - `ADMIN_SALT` = 一串随机字符
   - （可选）`NOTIFY_WEBHOOK` = Telegram / Slack / 飞书 / 企业微信机器人地址，新询盘会推送
   - （可选）`ALLOWED_ORIGINS` = `https://gaoruistone.com`（逗号分隔多个）
4. **Settings → Bindings → Add → D1 Database**：
   - Variable name 必须填 **`DB`** → 选 `gaorui-inquiries` → Save
5. **Settings → Domains & Routes → Add → Custom Domain**：填 `api.gaoruistone.com`
   （你的域名 DNS 已在 Cloudflare，会自动加记录并签发证书）

### A3. 改一处前端指向（重要）

静态站和 API 不同源，要把表单提交地址改成绝对 URL。
打开 `gaorui-demo/src/contact.src.html`，找到：

```html
<form class="reveal" id="inquiry-form" data-api="/api/inquiry" ...
```

把 `data-api="/api/inquiry"` 改成 `data-api="https://api.gaoruistone.com/api/inquiry"`，
然后在 `gaorui-demo/` 目录执行 `python3 build.py` 重新生成 8 个页面。

> 若你走路径 B（同一域名），这处保持 `/api/inquiry` 不用改。

### A4. 打包静态站并上传 Pages

```bash
cd /Users/huanghuajian/.sclaw/workspace/gaorui-demo
mkdir -p deploy/public
cp *.html deploy/public/
cp -r assets deploy/public/
cp deploy/admin.html deploy/public/
```

1. **Workers & Pages → Create → Pages → Get started → 把 `deploy/public` 文件夹拖进去 → Deploy**
2. 部署完成后 → **Custom domains → Add → `gaoruistone.com`**（再按需加 `www.gaoruistone.com`）
3. 后台地址即 `https://gaoruistone.com/admin.html`

### A5. 后台首次使用
- 打开 `/admin.html` → 若静态站与 API 不同源，展开页面底部**「服务地址」**填 `https://api.gaoruistone.com` → 输入 `ADMIN_PASSWORD` 登录
- **进去后第一件事：点右上角「修改密码」**，把口令从源码外的 Secret 换成只在库里存的哈希（此后改密不再依赖 Secret）

---

## 路径 B：单 Worker 同时托管静态站 + API（需要 Node/npx）

如果你习惯用命令行，一个 Worker 搞定全部，无需改前端地址。

```bash
cd /Users/huanghuajian/.sclaw/workspace/gaorui-demo
mkdir -p deploy/public && cp *.html deploy/public/ && cp -r assets deploy/public/ && cp deploy/admin.html deploy/public/
cd deploy
npx wrangler d1 create gaorui-inquiries          # 把返回的 database_id 填进 wrangler.toml
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SALT
npx wrangler deploy
npx wrangler domains add gaorui-stone.com gaorui-site   # 或到控制台绑定自定义域名
```

`wrangler.toml` 已在本目录备好，只需填 `database_id`。

---

## 部署后自检（三条命令，30 秒）

```bash
# 1. 静态站可访问
curl -I https://gaoruistone.com/index.html | head -1

# 2. 表单接口通（应返回 {"ok":true,"id":1}）
curl -s -X POST https://api.gaoruistone.com/api/inquiry \
  -H 'Content-Type: application/json' \
  -d '{"name":"Deploy Test","email":"test@example.com","message":"Deployment self-test inquiry, please ignore."}'

# 3. 后台登录（应返回 token）
curl -s -X POST https://api.gaoruistone.com/api/login \
  -H 'Content-Type: application/json' -d '{"password":"你的ADMIN_PASSWORD"}'
```

第 2 条成功后，去后台就能看到这条测试询盘 —— 整条链路（表单 → API → D1 → 后台）确认打通，然后把测试记录删掉。

---

## 询盘后台能做什么

- **列表**：按状态筛选（待跟进／已联系／报价中／已成交／未成交／归档）、关键词搜索（姓名、公司、邮箱、花色、正文）
- **单条详情**：完整留言、来源页、IP、提交与跟进时间
- **跟进**：改状态 + 写内部备注（客户不可见），一键「WhatsApp 回复」「邮件回复」
- **导出 CSV**：带 BOM，Excel 直接打开不乱码
- **访问统计**：今日/累计 PV、按页面、近 14 天趋势，与询盘数并排看转化
- **修改密码**：改密后所有旧登录会话失效

---

## 防垃圾与限制（已内置，无需配置）

| 机制 | 值 |
|---|---|
| 蜜罐字段 | 表单里隐藏的 `website` 字段，机器人填了则静默丢弃并返回成功 |
| 必填校验 | Name 必填；Email 与 WhatsApp 至少一项；Email 格式校验 |
| 长度上限 | 姓名 80／正文 4000／公司 120 等，超出截断 |
| 频率限制 | 同 IP 每分钟 ≤3 次、每天 ≤20 次，超出返回 429 |
| 跨站来源 | 只接受 `gaoruistone.com`、`www.gaoruistone.com`、`ALLOWED_ORIGINS` 与本 Worker 自身域名 |
| 会话 | 登录 token 72 小时过期，过期自动清理 |

---

## 兜底行为（不会因为后端故障丢询盘）

- 页面在**本地双击打开**（`file://`）：不发请求，直接打开邮件客户端预填内容
- **API 请求失败**（后端未部署、网络异常）：提示后用邮件兜底提交，客户已填内容不丢
- 邮件通知（`NOTIFY_WEBHOOK`）失败：不影响询盘落库，也不影响客户看到的成功提示

---

## 上线后建议顺手做

1. **Google Search Console + Bing Webmaster** 各提交一次 `sitemap.xml`（需要我生成就说）
2. `robots.txt` 里放行后台以外的路径，并 Disallow `/admin.html`
3. 把 `deploy/` 目录加入 `.gitignore` 之外正常提交 —— 源码不含口令，安全
4. 域名到期提醒：`gaoruistone.com` 到期 **2027-09-16**，建议在 Cloudflare 开自动续费
