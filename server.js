'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEMO_MODE = String(process.env.DEMO_MODE || '').toLowerCase() === 'true';
const COOKIE_NAME = 'ks_fulfillment_session';
const sessions = new Map();
const loginAttempts = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'order-fulfillment.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    order_no TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    buyer_nickname TEXT,
    receiver_name TEXT,
    receiver_mobile TEXT,
    receiver_address TEXT,
    amount_fen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    raw_payload_json TEXT NOT NULL DEFAULT '{}',
    synced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shipment_drafts (
    order_id TEXT PRIMARY KEY,
    carrier_code TEXT NOT NULL,
    tracking_no TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    response_json TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function setting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now());
}
function audit(eventType, summary) {
  db.prepare('INSERT INTO audit_events(event_type, summary, created_at) VALUES (?, ?, ?)').run(eventType, summary, now());
}
function encryptionKey() {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY 必须是 Base64 编码的 32 字节随机值');
  return key;
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function decrypt(value) {
  const data = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
function getToken() {
  const token = setting('kuaishou_access_token');
  return token ? decrypt(token) : null;
}
function configured(value) { return Boolean(value && value.trim()); }
function kuaishouReady() {
  return configured(process.env.KUAISHOU_APP_KEY) && configured(process.env.KUAISHOU_APP_SECRET)
    && configured(process.env.KUAISHOU_REDIRECT_URI) && configured(process.env.KUAISHOU_OAUTH_AUTHORIZE_URL)
    && configured(process.env.KUAISHOU_OAUTH_TOKEN_URL);
}
function jsonError(res, status, message) { return res.status(status).json({ error: message }); }
function safeText(value, max = 500) { return String(value || '').trim().slice(0, max); }
function parseItems(value) { try { return JSON.parse(value || '[]'); } catch { return []; } }
function money(fen) { return (Number(fen || 0) / 100).toFixed(2); }

function setSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  next();
}
app.use(setSecurityHeaders);
app.use(express.json({ limit: '1mb' }));

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((item) => {
    const index = item.indexOf('=');
    return index < 0 ? [] : [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }).filter((pair) => pair.length));
}
function currentSession(req) { return sessions.get(parseCookies(req.headers.cookie)[COOKIE_NAME]); }
function requireAuth(req, res, next) {
  const session = currentSession(req);
  if (!session || session.expiresAt < Date.now()) return jsonError(res, 401, '请先登录');
  req.session = session;
  next();
}
function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 8}${IS_PRODUCTION ? '; Secure' : ''}`;
}
function clearCookie(res) { res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PRODUCTION ? '; Secure' : ''}`); }
function clientKey(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
function blockedLogin(req) {
  const record = loginAttempts.get(clientKey(req));
  return record && record.until > Date.now();
}
function failedLogin(req) {
  const key = clientKey(req);
  const record = loginAttempts.get(key) || { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= 5) record.until = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(key, record);
}

function csvCell(value) {
  const text = String(value ?? '');
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}
function csvLine(values) { return values.map(csvCell).join(','); }
function parseCsvLine(line) {
  const cells = []; let cell = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
function parseShipmentCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('CSV 至少需要表头和一条数据');
  const headers = parseCsvLine(lines.shift()).map((value) => value.toLowerCase().replace(/[_\s-]/g, ''));
  const pos = (names) => headers.findIndex((header) => names.includes(header));
  const orderNo = pos(['orderno', '订单号']);
  const carrierCode = pos(['carriercode', '快递公司编码', '物流公司编码']);
  const trackingNo = pos(['trackingno', '运单号', '物流单号']);
  if ([orderNo, carrierCode, trackingNo].some((index) => index < 0)) throw new Error('CSV 表头必须包含 orderNo、carrierCode、trackingNo');
  return lines.map((line, index) => {
    const cells = parseCsvLine(line);
    return { row: index + 2, orderNo: safeText(cells[orderNo], 80), carrierCode: safeText(cells[carrierCode], 80), trackingNo: safeText(cells[trackingNo], 100) };
  });
}

function seedDemoOrders() {
  if (!DEMO_MODE || db.prepare('SELECT COUNT(*) AS count FROM orders').get().count > 0) return;
  const timestamp = now();
  const rows = [
    ['demo-10001', 'KS202609230001', '待发货', '小王', '张**', '138****1234', '北京市海淀区示例路 88 号', 12900, '2026-09-23T02:15:00.000Z', [{ name: '示例商品 A', sku: '默认', quantity: 1 }]],
    ['demo-10002', 'KS202609230002', '待发货', '阿星', '李**', '139****5678', '上海市浦东新区示例街 18 号', 25800, '2026-09-23T03:40:00.000Z', [{ name: '示例商品 B', sku: '蓝色 / M', quantity: 2 }]],
    ['demo-10003', 'KS202609230003', '已发货', '乐乐', '陈**', '136****1111', '广州市天河区示例大道 6 号', 9900, '2026-09-22T09:05:00.000Z', [{ name: '示例商品 C', sku: '标准', quantity: 1 }]]
  ];
  const insert = db.prepare(`INSERT INTO orders(order_id, order_no, status, buyer_nickname, receiver_name, receiver_mobile, receiver_address, amount_fen, created_at, items_json, raw_payload_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`);
  const transaction = db.transaction(() => rows.forEach((row) => insert.run(...row, JSON.stringify(row[9]), timestamp)));
  transaction();
  audit('demo_seeded', '已创建 3 条无真实买家数据的演示订单');
}
seedDemoOrders();

function orderFromPayload(source) {
  const orderId = safeText(source.orderId || source.order_id || source.id || source.order?.id, 100);
  const orderNo = safeText(source.orderNo || source.order_no || source.orderId || source.order_id, 100);
  if (!orderId || !orderNo) return null;
  const receiver = source.receiver || source.address || {};
  const items = source.items || source.orderItems || source.itemList || [];
  return {
    orderId,
    orderNo,
    status: safeText(source.statusText || source.status || '待发货', 40),
    buyerNickname: safeText(source.buyerNickname || source.buyer_name || source.buyer?.nickname, 100),
    receiverName: safeText(receiver.name || source.receiverName, 100),
    receiverMobile: safeText(receiver.mobile || receiver.phone || source.receiverMobile, 100),
    receiverAddress: safeText(receiver.address || source.receiverAddress || source.addressText, 500),
    amountFen: Number(source.amountFen || source.totalAmount || source.total_amount || 0),
    createdAt: new Date(source.createdAt || source.createTime || Date.now()).toISOString(),
    items: Array.isArray(items) ? items : [],
    raw: source
  };
}
function saveOrders(payload) {
  const candidates = Array.isArray(payload) ? payload : (payload.orders || payload.data || payload.list || payload.result?.list || []);
  const upsert = db.prepare(`INSERT INTO orders(order_id, order_no, status, buyer_nickname, receiver_name, receiver_mobile, receiver_address, amount_fen, created_at, items_json, raw_payload_json, synced_at)
    VALUES (@orderId, @orderNo, @status, @buyerNickname, @receiverName, @receiverMobile, @receiverAddress, @amountFen, @createdAt, @itemsJson, @rawJson, @syncedAt)
    ON CONFLICT(order_id) DO UPDATE SET order_no=excluded.order_no, status=excluded.status, buyer_nickname=excluded.buyer_nickname,
      receiver_name=excluded.receiver_name, receiver_mobile=excluded.receiver_mobile, receiver_address=excluded.receiver_address,
      amount_fen=excluded.amount_fen, items_json=excluded.items_json, raw_payload_json=excluded.raw_payload_json, synced_at=excluded.synced_at`);
  let saved = 0;
  const transaction = db.transaction(() => candidates.forEach((candidate) => {
    const order = orderFromPayload(candidate);
    if (!order) return;
    upsert.run({ ...order, itemsJson: JSON.stringify(order.items), rawJson: JSON.stringify(order.raw), syncedAt: now() });
    saved += 1;
  }));
  transaction();
  return saved;
}

async function tokenExchange(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    app_id: process.env.KUAISHOU_APP_KEY,
    app_secret: process.env.KUAISHOU_APP_SECRET,
    redirect_uri: process.env.KUAISHOU_REDIRECT_URI
  });
  const response = await fetch(process.env.KUAISHOU_OAUTH_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: params
  });
  if (!response.ok) throw new Error(`授权令牌交换失败（HTTP ${response.status}）`);
  const body = await response.json();
  const accessToken = body.access_token || body.data?.access_token;
  if (!accessToken) throw new Error('快手接口未返回 access_token；请核对应用类型、令牌地址和参数名称');
  setSetting('kuaishou_access_token', encrypt(accessToken));
  if (body.refresh_token || body.data?.refresh_token) setSetting('kuaishou_refresh_token', encrypt(body.refresh_token || body.data.refresh_token));
  setSetting('kuaishou_connected_at', now());
  return body;
}
async function platformRequest(url, method, payload) {
  const accessToken = getToken();
  if (!accessToken) throw new Error('快手店铺尚未授权');
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'X-Kuaishou-App-Key': process.env.KUAISHOU_APP_KEY || ''
    },
    body: method === 'GET' ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
  if (!response.ok) throw new Error(`快手接口请求失败（HTTP ${response.status}）`);
  return body;
}

app.get('/api/health', (req, res) => res.json({ ok: true, timestamp: now() }));
app.post('/api/auth/login', (req, res) => {
  if (blockedLogin(req)) return jsonError(res, 429, '登录尝试过多，请 15 分钟后再试');
  const password = String(req.body?.password || '');
  const expected = process.env.ADMIN_PASSWORD || '';
  const suppliedBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    failedLogin(req); return jsonError(res, 401, '密码错误，或尚未配置 ADMIN_PASSWORD');
  }
  loginAttempts.delete(clientKey(req));
  const id = randomToken();
  sessions.set(id, { createdAt: Date.now(), expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(id)}; ${cookieOptions()}`);
  audit('login', '管理员登录');
  res.json({ ok: true });
});
app.post('/api/auth/logout', requireAuth, (req, res) => {
  sessions.delete(parseCookies(req.headers.cookie)[COOKIE_NAME]); clearCookie(res); audit('logout', '管理员退出登录'); res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ authenticated: Boolean(currentSession(req)) }));

app.get('/api/config', requireAuth, (req, res) => res.json({
  demoMode: DEMO_MODE,
  oauthConfigured: kuaishouReady(),
  shopConnected: Boolean(setting('kuaishou_access_token')),
  orderApiConfigured: configured(process.env.KUAISHOU_ORDER_LIST_URL),
  shipmentApiConfigured: configured(process.env.KUAISHOU_SHIPMENT_SUBMIT_URL),
  connectedAt: setting('kuaishou_connected_at')
}));
app.get('/api/orders', requireAuth, (req, res) => {
  const status = safeText(req.query.status, 40);
  const query = safeText(req.query.query, 100);
  const rows = db.prepare(`SELECT o.*, s.carrier_code, s.tracking_no, s.status AS shipment_status
    FROM orders o LEFT JOIN shipment_drafts s ON s.order_id = o.order_id
    WHERE (? = '' OR o.status = ?) AND (? = '' OR o.order_no LIKE ? OR o.buyer_nickname LIKE ?)
    ORDER BY o.created_at DESC LIMIT 500`).all(status, status, query, `%${query}%`, `%${query}%`);
  res.json({ orders: rows.map((row) => ({
    id: row.order_id, orderNo: row.order_no, status: row.status, buyerNickname: row.buyer_nickname,
    receiverName: row.receiver_name, receiverMobile: row.receiver_mobile, receiverAddress: row.receiver_address,
    amount: money(row.amount_fen), createdAt: row.created_at, items: parseItems(row.items_json),
    shipment: row.tracking_no ? { carrierCode: row.carrier_code, trackingNo: row.tracking_no, status: row.shipment_status } : null
  })) });
});
app.get('/api/dashboard', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
  const pending = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status LIKE '%待发货%'").get().count;
  const ready = db.prepare("SELECT COUNT(*) AS count FROM shipment_drafts WHERE status = 'ready'").get().count;
  const submitted = db.prepare("SELECT COUNT(*) AS count FROM shipment_drafts WHERE status = 'submitted'").get().count;
  res.json({ total, pending, ready, submitted });
});
app.get('/api/orders/export', requireAuth, (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((id) => safeText(id, 100)).filter(Boolean).slice(0, 500);
  if (!ids.length) return jsonError(res, 400, '请至少选择一笔订单');
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT o.*, s.carrier_code, s.tracking_no FROM orders o LEFT JOIN shipment_drafts s ON s.order_id = o.order_id WHERE o.order_id IN (${placeholders})`).all(...ids);
  const output = [csvLine(['订单号', '订单状态', '买家昵称', '收件人', '手机', '收货地址', '商品明细', '实付金额', '快递公司编码', '运单号', '下单时间'])];
  rows.forEach((row) => output.push(csvLine([
    row.order_no, row.status, row.buyer_nickname, row.receiver_name, row.receiver_mobile, row.receiver_address,
    parseItems(row.items_json).map((item) => `${item.name || item.title || '商品'} × ${item.quantity || item.count || 1}`).join(' | '),
    money(row.amount_fen), row.carrier_code || '', row.tracking_no || '', row.created_at
  ])));
  audit('orders_exported', `导出 ${rows.length} 笔订单`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kuaishou-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${output.join('\r\n')}`);
});
app.post('/api/shipments/import', requireAuth, (req, res) => {
  try {
    const rows = parseShipmentCsv(req.body?.csvText);
    const findOrder = db.prepare('SELECT order_id FROM orders WHERE order_no = ?');
    const upsert = db.prepare(`INSERT INTO shipment_drafts(order_id, carrier_code, tracking_no, status, updated_at)
      VALUES (?, ?, ?, 'ready', ?) ON CONFLICT(order_id) DO UPDATE SET carrier_code=excluded.carrier_code, tracking_no=excluded.tracking_no, status='ready', response_json=NULL, updated_at=excluded.updated_at`);
    const errors = []; let saved = 0;
    const transaction = db.transaction(() => rows.forEach((row) => {
      if (!row.orderNo || !row.carrierCode || !row.trackingNo) { errors.push(`第 ${row.row} 行缺少必填值`); return; }
      const order = findOrder.get(row.orderNo);
      if (!order) { errors.push(`第 ${row.row} 行订单号不存在：${row.orderNo}`); return; }
      upsert.run(order.order_id, row.carrierCode, row.trackingNo, now()); saved += 1;
    }));
    transaction(); audit('shipments_imported', `导入 ${saved} 条物流单号`);
    res.json({ saved, errors });
  } catch (error) { jsonError(res, 400, error.message); }
});
app.post('/api/shipments/submit', requireAuth, async (req, res) => {
  if (!configured(process.env.KUAISHOU_SHIPMENT_SUBMIT_URL)) return jsonError(res, 412, '尚未配置快手发货接口地址');
  const rows = db.prepare(`SELECT o.order_id, o.order_no, s.carrier_code, s.tracking_no FROM shipment_drafts s JOIN orders o ON o.order_id=s.order_id WHERE s.status='ready' LIMIT 100`).all();
  if (!rows.length) return jsonError(res, 400, '没有待提交的发货单');
  const update = db.prepare("UPDATE shipment_drafts SET status='submitted', response_json=?, updated_at=? WHERE order_id=?");
  const errors = []; let submitted = 0;
  for (const row of rows) {
    try {
      const response = await platformRequest(process.env.KUAISHOU_SHIPMENT_SUBMIT_URL, process.env.KUAISHOU_SHIPMENT_HTTP_METHOD || 'POST', {
        orderId: row.order_id, orderNo: row.order_no, carrierCode: row.carrier_code, trackingNo: row.tracking_no
      });
      update.run(JSON.stringify(response).slice(0, 5000), now(), row.order_id); submitted += 1;
    } catch (error) { errors.push(`${row.order_no}: ${error.message}`); }
  }
  audit('shipments_submitted', `向快手提交 ${submitted} 条发货信息`);
  res.json({ submitted, errors });
});
app.get('/api/kuaishou/connect', requireAuth, (req, res) => {
  if (!kuaishouReady()) return jsonError(res, 412, '尚未完成快手 OAuth 环境变量配置');
  const state = randomToken(24);
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO oauth_states(state_hash, expires_at) VALUES (?, ?)').run(sha256(state), Date.now() + 10 * 60 * 1000);
  const url = new URL(process.env.KUAISHOU_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('app_id', process.env.KUAISHOU_APP_KEY);
  url.searchParams.set('redirect_uri', process.env.KUAISHOU_REDIRECT_URI);
  url.searchParams.set('state', state);
  res.json({ authorizeUrl: url.toString() });
});
app.get('/api/kuaishou/callback', async (req, res) => {
  const code = safeText(req.query.code, 1000); const state = safeText(req.query.state, 1000);
  const found = state && db.prepare('SELECT state_hash FROM oauth_states WHERE state_hash = ? AND expires_at > ?').get(sha256(state), Date.now());
  if (!code || !found) return res.status(400).send('授权请求无效或已过期，请返回系统后重新发起授权。');
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(sha256(state));
  try { await tokenExchange(code); audit('kuaishou_authorized', '快手店铺授权成功'); res.redirect('/?connected=1'); }
  catch (error) { audit('kuaishou_authorization_failed', '快手店铺授权失败'); res.status(502).send(`授权失败：${error.message}`); }
});
app.post('/api/orders/sync', requireAuth, async (req, res) => {
  if (!configured(process.env.KUAISHOU_ORDER_LIST_URL)) return jsonError(res, 412, '尚未配置快手订单查询接口地址');
  try {
    const payload = { pageNumber: Number(req.body?.pageNumber || 1), pageSize: Math.min(Number(req.body?.pageSize || 100), 100), queryType: 1, type: 1 };
    const result = await platformRequest(process.env.KUAISHOU_ORDER_LIST_URL, process.env.KUAISHOU_ORDER_LIST_HTTP_METHOD || 'POST', payload);
    const saved = saveOrders(result); audit('orders_synced', `从快手同步 ${saved} 笔订单`); res.json({ saved });
  } catch (error) { jsonError(res, 502, error.message); }
});

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.use((error, req, res, next) => { console.error(error); jsonError(res, 500, '服务器处理请求时发生错误'); });
app.listen(PORT, () => console.log(`Kuaishou fulfillment service listening on ${PORT}`));

