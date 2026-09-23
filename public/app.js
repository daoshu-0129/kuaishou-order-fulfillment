const $ = (selector) => document.querySelector(selector);
const api = async (url, options = {}) => {
  const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || '请求失败');
  return body;
};
const text = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
let orders = [];

async function loadFiling() {
  try {
    const { icpBeianNumber } = await api('/api/public-config');
    if (!icpBeianNumber) return;
    $('#filing-link').textContent = icpBeianNumber;
    $('#filing-footer').hidden = false;
  } catch (_) { /* A filing footer must never prevent the application from loading. */ }
}
function message(value, error = false) {
  const node = $('#action-message'); node.textContent = value; node.classList.toggle('error', error);
}
function selectedIds() { return [...document.querySelectorAll('.order-select:checked')].map((input) => input.value); }
function renderOrders() {
  $('#orders-body').innerHTML = orders.map((order) => `<tr>
    <td><input class="order-select" type="checkbox" value="${text(order.id)}" /></td>
    <td><strong>${text(order.orderNo)}</strong><small>${new Date(order.createdAt).toLocaleString('zh-CN')}</small></td>
    <td>${order.items.map((item) => `<span class="item">${text(item.name || item.title || '商品')} × ${text(item.quantity || item.count || 1)}</span>`).join('')}</td>
    <td>${text(order.receiverName || '–')}<small>${text(order.receiverMobile || '')}</small><small>${text(order.receiverAddress || '')}</small></td>
    <td>¥${text(order.amount)}</td><td><span class="status">${text(order.status)}</span></td>
    <td>${order.shipment ? `<span>${text(order.shipment.carrierCode)}</span><small>${text(order.shipment.trackingNo)}</small><small>${text(order.shipment.status)}</small>` : '<span class="muted">未导入</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无订单。完成快手授权后点击“同步订单”。</td></tr>';
}
async function refresh() {
  const status = $('#status-filter').value; const query = $('#search').value.trim();
  const [dashboard, list] = await Promise.all([api('/api/dashboard'), api(`/api/orders?status=${encodeURIComponent(status)}&query=${encodeURIComponent(query)}`)]);
  $('#stat-total').textContent = dashboard.total; $('#stat-pending').textContent = dashboard.pending; $('#stat-ready').textContent = dashboard.ready; $('#stat-submitted').textContent = dashboard.submitted;
  orders = list.orders; renderOrders(); $('#select-all').checked = false;
}
async function loadApp() {
  const me = await api('/api/me');
  $('#login-view').hidden = me.authenticated; $('#app-view').hidden = !me.authenticated;
  if (!me.authenticated) return;
  const config = await api('/api/config');
  $('#mode-badge').textContent = config.demoMode ? '演示数据已启用' : '生产模式';
  const warnings = [];
  if (!config.oauthConfigured) warnings.push('尚未配置快手 OAuth 参数：目前仅可使用演示数据和物流导入流程。');
  else if (!config.shopConnected) warnings.push('OAuth 参数已配置，请点击“授权快手店铺”完成店铺授权。');
  if (!config.orderApiConfigured || !config.shipmentApiConfigured) warnings.push('订单与发货接口地址需按快手电商开放平台审核后的文档配置。');
  $('#setup-notice').hidden = !warnings.length; $('#setup-notice').textContent = warnings.join(' ');
  await refresh();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-message').textContent = '';
  try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; await loadApp(); }
  catch (error) { $('#login-message').textContent = error.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
$('#reload').addEventListener('click', () => refresh().catch((error) => message(error.message, true)));
$('#status-filter').addEventListener('change', () => refresh().catch((error) => message(error.message, true)));
$('#search').addEventListener('keydown', (event) => { if (event.key === 'Enter') refresh().catch((error) => message(error.message, true)); });
$('#select-all').addEventListener('change', (event) => document.querySelectorAll('.order-select').forEach((input) => { input.checked = event.target.checked; }));
$('#export-orders').addEventListener('click', () => {
  const ids = selectedIds(); if (!ids.length) return message('请先勾选需要导出的订单。', true);
  window.location.assign(`/api/orders/export?ids=${encodeURIComponent(ids.join(','))}`); message(`正在导出 ${ids.length} 笔订单。`);
});
$('#import-shipments').addEventListener('click', async () => {
  try { const result = await api('/api/shipments/import', { method: 'POST', body: JSON.stringify({ csvText: $('#shipment-csv').value }) }); message(`已导入 ${result.saved} 条物流单号。${result.errors.join('；')}`); await refresh(); }
  catch (error) { message(error.message, true); }
});
$('#submit-shipments').addEventListener('click', async () => {
  if (!confirm('将把所有“待提交”的物流单号发送到快手。确认继续？')) return;
  try { const result = await api('/api/shipments/submit', { method: 'POST', body: '{}' }); message(`已提交 ${result.submitted} 条。${result.errors.join('；')}`); await refresh(); }
  catch (error) { message(error.message, true); }
});
$('#sync-orders').addEventListener('click', async () => {
  try { const result = await api('/api/orders/sync', { method: 'POST', body: '{}' }); message(`已同步 ${result.saved} 笔订单。`); await refresh(); }
  catch (error) { message(error.message, true); }
});
$('#connect-shop').addEventListener('click', async () => {
  try { const result = await api('/api/kuaishou/connect'); window.location.assign(result.authorizeUrl); }
  catch (error) { message(error.message, true); }
});
loadFiling().finally(() => loadApp().catch((error) => { $('#login-message').textContent = error.message; }));

