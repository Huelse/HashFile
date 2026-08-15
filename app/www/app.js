'use strict';

const $ = id => document.getElementById(id);

// 路径需在 setupInputClear() 之前写入，否则清除按钮会被判为空值而隐藏；
// 自动计算则延到文件末尾（此处 run() 依赖的 const 尚在 TDZ 中）
const _initPath = new URLSearchParams(window.location.search).get('path');
if (_initPath) $('path').value = _initPath;

const pathInput      = $('path');
const pathWrap       = $('path-wrap');
const pathPick       = $('path-pick');
const pathPickMenu   = $('path-pick-menu');
const recursiveChk   = $('recursive');
const expectedInput  = $('expected');
const timeoutSel     = $('timeout-sel');
const submitBtn      = $('submit');
const abortBtn       = $('abort-btn');
const clearBtn       = $('clear-btn');
const historyBtn     = $('history-btn');
const historySearch  = $('history-search');
const historySearchBtn = $('history-search-btn');
const historyDupBtn  = $('history-dup-btn');
const historyPager   = $('history-pager');
const loadingEl      = $('loading');
const loadingText    = $('loading-text');
const errorBox       = $('error-box');
const resultsEl      = $('results');
const resultsBody    = $('results-body');
const summaryEl      = $('summary');
const thStatus       = $('th-status');
const historyOverlay = $('history-overlay');
const historyList    = $('history-list');
const historyClose   = $('history-close');

const ALGO_ORDER = ['sha256', 'md5', 'sha1', 'sha512', 'blake3'];

// Accumulated results: Map<filePath, Map<algo, resultEntry>>
const state = new Map();

// Active fetch controller + server-side task id (for abort)
let activeController = null;
let currentTaskId = null;
let cancelRequested = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Algo chips ──────────────────────────────────────────────
document.querySelectorAll('.algo-chip input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', () => {
    cb.closest('.algo-chip').classList.toggle('selected', cb.checked);
  });
});

function getSelectedAlgos() {
  return [...document.querySelectorAll('.algo-chip input[type="checkbox"]:checked')]
    .map(cb => cb.value);
}

// ── Expected input → live re-verify ─────────────────────────
// 校验值变化要整表重绘，逐次按键都重绘在大结果集上会卡顿，故做短去抖
let _expectedTimer = null;
expectedInput.addEventListener('input', () => {
  clearTimeout(_expectedTimer);
  _expectedTimer = setTimeout(() => { if (state.size > 0) renderFromState(); }, 150);
});

// ── Abort ───────────────────────────────────────────────────
function sendCancel(id) {
  // 通知服务端取消任务（杀掉哈希子进程），下一次轮询会返回 cancelled
  fetch('api/hash?id=' + id, { method: 'DELETE' }).catch(() => {});
}

abortBtn.addEventListener('click', () => {
  if (!cancelRequested) {
    cancelRequested = true;
    // 任务 id 尚未返回时只挂起取消，run() 拿到 id 后立即补发，
    // 避免服务端任务成为无人认领、无法取消的孤儿
    if (currentTaskId) sendCancel(currentTaskId);
  } else if (activeController) {
    // 第二次点击：取消未生效（如服务端卡住）时强制断开客户端轮询
    activeController.abort();
  }
});

// ── Submit ──────────────────────────────────────────────────
submitBtn.addEventListener('click', run);
pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

async function run() {
  if (activeController) return;  // 已有任务进行中（回车键不受 submitBtn.disabled 约束）
  const path = realPath.trim();  // 输入框失焦时显示的是语义化路径，真实路径只认 realPath
  if (!path) { showError('请输入文件或目录路径'); return; }

  const algos = getSelectedAlgos();
  if (algos.length === 0) { showError('请至少选择一种哈希算法'); return; }

  const params = new URLSearchParams({
    path,
    algo: algos.join(','),
    recursive: recursiveChk.checked,
  });
  const expected = expectedInput.value.trim();
  if (expected) params.set('expected', expected);

  params.set('timeout', timeoutSel.value);  // 0 = 无限制（单个文件的哈希超时，由服务端执行）
  activeController = new AbortController();
  cancelRequested = false;

  setLoading(true);
  clearError();

  try {
    // 提交任务后轮询结果：大文件计算耗时可远超网关的 5 分钟代理超时，
    // 同步等待会被网关 504 掐断，改为短请求轮询
    const res = await fetch('api/hash?' + params, { signal: activeController.signal });
    const data = await res.json();
    if (!data.success) { showError(data.error || '计算失败'); return; }
    currentTaskId = data.task;
    if (cancelRequested) sendCancel(currentTaskId);  // 中止点在任务 id 返回之前：补发取消

    // pollTask 对每个增量分片（含终态那次）都会回调 onProgress，所以这里不再做
    // 兜底合并——增量协议下重复喂同一批结果会把行渲染两遍
    const d = await pollTask(data.task, activeController.signal, partial => {
      mergeResults(partial);
      renderNewRows(partial);
    });
    if (d.status === 'error') { showError(d.error || '计算失败'); return; }
    if (d.status === 'cancelled') {
      showError(state.size > 0 ? '已中止计算，已完成部分的结果已保留' : '已中止计算');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      showError('已中止计算');
    } else {
      showError('网络请求失败：' + e.message);
    }
  } finally {
    currentTaskId = null;
    activeController = null;
    setLoading(false);
  }
}

async function pollTask(id, signal, onProgress) {
  let delay = 1000;
  let failures = 0;
  let have = 0;  // 已收到的结果条数，作为下次请求的 since 游标
  while (true) {
    await sleep(delay);
    let d;
    try {
      // since 让服务端只回传增量：全量轮询下响应体与前端合并开销都是 O(结果数)
      const res = await fetch(`api/hash/status?id=${id}&since=${have}`, { signal });
      d = await res.json();
      failures = 0;
    } catch (e) {
      if (e.name === 'AbortError' || ++failures >= 3) throw e;
      // 长任务轮询次数多，容忍偶发网络抖动，连续 3 次失败才放弃。
      // delay 可能刚被 more 分支置 0（见下），重试前必须抬回来，
      // 否则网络一抖就是零间隔连打三次。
      delay = Math.max(delay, 1000);
      continue;
    }
    if (!d.success) return { status: 'error', error: d.error || '查询任务状态失败' };
    // 运行中即时合并已完成的结果并渲染，让用户不必等全部算完才看到
    if (d.results && d.results.length) {
      have += d.results.length;
      if (onProgress) onProgress(d.results);
    }
    if (d.total > 1) loadingText.textContent = `计算中（${d.done}/${d.total}），请稍候…`;
    // 服务端单次最多回 STATUS_CHUNK 条；还有积压就立刻续拉。这个判断必须排在
    // 终态判断之前，否则任务已 done 时会漏掉尾部未取的分片
    if (d.more) { delay = 0; continue; }
    if (d.status !== 'running') return d;
    delay = Math.min(delay + 500, 3000);  // 缓步退避，长任务减少无谓轮询
  }
}

// ── Clear ───────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  state.clear();
  renderFromState();  // 同步清掉 DOM 与 renderedRows/counts，否则增量渲染基准会失配
  clearError();
});

// ── Input clear (✕) ─────────────────────────────────────────
// 通用：给输入框绑定尾部清除按钮，空值时隐藏；onClear 用于清空后回调
function setupInputClear(input, onClear) {
  const wrap = input.closest('.input-wrap');
  const btn = wrap.querySelector('.input-clear');
  const sync = () => wrap.classList.toggle('is-empty', !input.value);
  input.addEventListener('input', sync);
  // onClear 先于 sync：路径框的回调会连带复位真实路径与展示态，sync 需要看到最终值
  btn.addEventListener('click', () => { input.value = ''; input.focus(); onClear && onClear(); sync(); });
  sync();
}
setupInputClear(pathInput, () => {                           // 路径：真实值与展示态一并复位
  realPath = '';
  pathInput.value = '';
  pathInput.classList.remove('is-semantic');
});
setupInputClear(expectedInput, () => { if (state.size > 0) renderFromState(); });  // 校验值：清空后重新渲染
setupInputClear(historySearch, () => doHistorySearch());     // 历史搜索：清空即重新搜索

// ── 语义化路径 ───────────────────────────────────────────────
// fnOS 要求应用不要直接展示 /vol1/... 内部路径。convertPath 只有后端 API，
// 故经 /api/convert-path 代理。真实路径始终是 realPath，输入框里的值只是展示。
const semCache = new Map();          // 真实路径 → 语义化路径（null = 已确认无法转换）
const CONVERT_BATCH = 50;            // 单次请求的路径数：GET 查询串不宜过长
let semLanguage = navigator.language || 'zh-CN';
let semDisabled = false;             // 开放平台不可用（低版本 / 无 token）后整页停止尝试

async function convertPaths(paths) {
  if (semDisabled || paths.length === 0) return;
  // 等 SDK 落定再发请求，否则 ?path= 入口的首次转换会赶在平台语言拿到之前，
  // 用浏览器语言转出与界面不一致的路径文案（await undefined 也是安全的）
  await window.__sdkReady;
  if (semDisabled) return;
  const params = new URLSearchParams();
  for (const p of paths) params.append('path', p);
  params.set('language', semLanguage);
  try {
    const res = await fetch('api/convert-path?' + params);
    // 网关层的失败（应用未起来、502 等）拿不到 JSON，单独报一下便于真机排障
    if (!res.ok) { semDisabled = true; console.warn('convert-path HTTP ' + res.status); return; }
    const d = await res.json();
    if (!d.success) { semDisabled = true; console.warn('convert-path unavailable:', d.reason || ''); return; }
    // 没回传的路径记 null，避免对同一路径反复发请求
    for (const p of paths) semCache.set(p, d.paths[p] || null);
  } catch (e) {
    semDisabled = true;
    console.warn('convert-path failed:', e);
  }
}

// ── 路径输入框：失焦显示语义化路径，聚焦显示真实路径 ─────────
let realPath = _initPath || '';
let _semSeq = 0;

pathInput.addEventListener('focus', () => {
  if (!pathInput.classList.contains('is-semantic')) return;
  pathInput.classList.remove('is-semantic');
  pathInput.value = realPath;
});

pathInput.addEventListener('input', () => { realPath = pathInput.value; });

pathInput.addEventListener('blur', showSemantic);

async function showSemantic() {
  const p = realPath.trim();
  if (!p) return;
  const seq = ++_semSeq;
  if (!semCache.has(p)) await convertPaths([p]);
  const sem = semCache.get(p);
  // 请求返回时用户可能已重新聚焦或改了路径：状态变了就丢弃这次结果
  if (seq !== _semSeq || !sem || document.activeElement === pathInput || realPath.trim() !== p) return;
  pathInput.value = sem;
  pathInput.classList.add('is-semantic');
}

// 由选择器写回路径：派发 input 事件复用 setupInputClear 的空值同步与上面的 realPath 更新
function setPath(p) {
  pathInput.classList.remove('is-semantic');
  pathInput.value = p;
  pathInput.dispatchEvent(new Event('input'));
  showSemantic();
}

// ── 结果表格的文件列 tooltip ─────────────────────────────────
// 转换是异步的，拿到后只改已渲染行的 title 属性，不重绘表格，
// 保持增量渲染「单轮开销只与新增条数有关」的特性。
let _semPending = new Set();
let _semTimer = null;

function queueConvert(files) {
  if (semDisabled) return;
  for (const f of files) if (!semCache.has(f)) _semPending.add(f);
  scheduleConvert();
}

function scheduleConvert() {
  if (semDisabled || _semTimer || _semPending.size === 0) return;
  // 短去抖：大目录递归时结果分片密集到达，逐片请求没有意义
  _semTimer = setTimeout(async () => {
    _semTimer = null;
    const all = [..._semPending];
    _semPending = new Set(all.slice(CONVERT_BATCH));
    await convertPaths(all.slice(0, CONVERT_BATCH));
    applyRowTitles();
    scheduleConvert();
  }, 300);
}

function applyRowTitles() {
  const cells = resultsBody.children;
  const n = Math.min(renderedRows.length, cells.length);
  for (let i = 0; i < n; i++) {
    const sem = semCache.get(renderedRows[i].file);
    if (sem) cells[i].firstElementChild.title = sem;
  }
}

// ── fnOS 文件选择器 ──────────────────────────────────────────
let _sdk = null;

window.__sdkReady.then(ctx => {
  if (ctx.language) semLanguage = ctx.language;
  if (!ctx.usable) return;   // 低版本系统或独立浏览器窗口：不显示按钮，路径仍可手输
  _sdk = ctx.sdk;
  pathPick.hidden = false;
  pathWrap.classList.add('has-pick');
  document.body.classList.add('has-sdk');   // 各表格里的「打开目录」据此显隐
});

// 系统图标走 fnOS 根路径的 /static/…，脱离宿主（本地直连、独立窗口）会 404，
// 这时换回 emoji，免得留一个破图标
$('pick-icon').addEventListener('error', function () {
  const span = document.createElement('span');
  span.className = 'pick-icon';
  span.textContent = '🗂';
  this.replaceWith(span);
});

function closePickMenu() {
  pathPickMenu.hidden = true;
  pathPick.setAttribute('aria-expanded', 'false');
}

pathPick.addEventListener('click', e => {
  e.stopPropagation();
  const open = pathPickMenu.hidden;
  pathPickMenu.hidden = !open;
  pathPick.setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', e => {
  if (!pathPickMenu.hidden && !pathPickMenu.contains(e.target)) closePickMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !pathPickMenu.hidden) closePickMenu();
});

pathPickMenu.addEventListener('click', e => {
  const btn = e.target.closest('button[data-kind]');
  if (btn) pickPath(btn.dataset.kind === 'dir');
});

async function pickPath(directory) {
  closePickMenu();
  if (!_sdk) return;
  try {
    // 选择完成后系统会自动把该路径授权给本应用。目录只支持单选，
    // 文件也限定单选：输入框只承载一个路径。
    const res = await _sdk.pickUserFile({
      directory,
      multiple: false,
      title: directory ? '选择目录' : '选择文件',
      okText: '确认授权',
      sidebarGroup: ['myFiles', 'otherShare', 'external', 'remote', 'favorites', 'team'],
    });
    // 用户关掉授权弹窗时，宿主回的是 undefined 或 code≠0 + 通用文案
    // （"Operation failed"），与真正的失败无从区分，一律静默处理，
    // 不往错误框里塞看不懂的提示。文档给的用法也是只认 data 有没有路径。
    const picked = res && res.data && res.data[0];
    if (!picked) { console.warn('pickUserFile:', res); return; }
    clearError();
    setPath(picked);
    refreshAccessIfOpen();
  } catch (e) {
    console.warn('pickUserFile failed:', e);   // 关闭弹窗也可能以 reject 形式回来
  }
}

// ── 已授权目录 ───────────────────────────────────────────────
// 目录授权由 pickUserFile 写入，可经后端 getUserAccessibleFolders 按 uid 查询、
// delUserAccessibleFolder 删除。uid 由服务端从网关注入的身份头取，前端不传。
const accessBtn     = $('access-btn');
const accessOverlay = $('access-overlay');
const accessList    = $('access-list');
const accessClose   = $('access-close');

// 探一次：只有真的取得到列表（系统版本够、scope 已授予）才显示入口
fetch('api/user-access')
  .then(r => r.json())
  .then(d => { if (d.success) accessBtn.hidden = false; })
  .catch(() => { /* 不支持就不显示入口 */ });

accessBtn.addEventListener('click', openAccess);
accessClose.addEventListener('click', closeAccess);
accessOverlay.addEventListener('click', e => { if (e.target === accessOverlay) closeAccess(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !accessOverlay.hidden) closeAccess(); });

function openAccess() {
  accessOverlay.hidden = false;
  loadAccess();
}

function closeAccess() {
  accessOverlay.hidden = true;
}

// 选完目录就多了一条授权，弹窗开着的话顺手刷新
function refreshAccessIfOpen() {
  if (!accessOverlay.hidden) loadAccess();
}

async function loadAccess() {
  accessList.innerHTML = '<p class="hist-empty">加载中…</p>';
  let paths;
  try {
    const res = await fetch('api/user-access');
    const d = await res.json();
    if (!d.success) {
      accessList.innerHTML = '<p class="hist-empty">当前系统不支持查询授权目录</p>';
      console.warn('user-access unavailable:', d.reason || '');
      return;
    }
    paths = d.paths;
  } catch {
    accessList.innerHTML = '<p class="hist-empty">加载失败</p>';
    return;
  }

  if (paths.length === 0) {
    accessList.innerHTML = '<p class="hist-empty">暂无已授权目录，可用路径框左侧的按钮选择目录完成授权</p>';
    return;
  }

  const missing = paths.filter(p => !semCache.has(p));
  for (let i = 0; i < missing.length; i += CONVERT_BATCH) {
    await convertPaths(missing.slice(i, i + CONVERT_BATCH));
  }

  const table = document.createElement('table');
  table.className = 'hist-table acc-table';
  table.innerHTML = '<thead><tr><th>目录</th><th>实际路径</th><th class="col-act">操作</th></tr>'
                  + '</thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');

  for (const p of paths) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="ht-path" title="${esc(semCache.get(p) || p)}">${esc(semCache.get(p) || p)}</td>
      <td class="acc-real" title="${esc(p)}">${esc(p)}</td>
      <td class="ht-action col-act">
        <button class="btn-open" data-p="${esc(p)}">打开目录</button>
        <button class="btn-copy acc-del">删除</button></td>`;
    bindAccessDelete(tr.querySelector('.acc-del'), p, tr, tbody);
    tbody.appendChild(tr);
  }

  accessList.innerHTML = '';
  accessList.appendChild(table);
}

// 打开文件管理器并定位到目标目录。openFileManager 不需要 api-scope，但只有宿主
// 环境（isWeb）里才有：按钮一律渲染，由 body.has-sdk 控制显隐——渲染时机可能早于
// SDK 落定（?path= 自动开算），用 CSS 兜住就不必关心先后。
async function openDir(path, btn) {
  if (!_sdk) return;
  try {
    await _sdk.openFileManager(path);
  } catch (e) {
    console.warn('openFileManager failed:', e);
    btn.textContent = '打开失败';
    setTimeout(() => { btn.textContent = '打开目录'; }, 1500);
  }
}

// 各表格的「打开目录」都走事件委托：目标路径写在 data-p 上（结果/历史是文件的
// 父目录，已授权目录就是目录本身），避免每行各挂一个监听器
function delegateOpenDir(container) {
  container.addEventListener('click', e => {
    const btn = e.target.closest('.btn-open');
    if (btn) openDir(btn.dataset.p, btn);
  });
}
delegateOpenDir(accessList);
delegateOpenDir(historyList);

// 删除授权不可撤销（只能重新选一次目录），故要二次确认；3 秒无操作自动复位
function bindAccessDelete(btn, path, tr, tbody) {
  btn.addEventListener('click', async () => {
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      btn.textContent = '确认删除';
      btn._t = setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = '删除'; }, 3000);
      return;
    }
    clearTimeout(btn._t);
    btn.disabled = true;
    let ok = false;
    try {
      const res = await fetch('api/user-access?path=' + encodeURIComponent(path), { method: 'DELETE' });
      ok = (await res.json()).success;
    } catch { /* 下面统一按失败处理 */ }
    if (!ok) {
      btn.disabled = false;
      btn.dataset.confirm = '';
      btn.textContent = '删除失败';
      setTimeout(() => { btn.textContent = '删除'; }, 1500);
      return;
    }
    tr.remove();
    if (!tbody.querySelector('tr')) loadAccess();
  });
}

// ── History ──────────────────────────────────────────────────
let _hPage = 1;
let _hQuery = '';
let _hDup = false;

historyBtn.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) closeHistory(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !historyOverlay.hidden) closeHistory(); });

historySearch.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  doHistorySearch();
});
historySearchBtn.addEventListener('click', doHistorySearch);

function setDupActive(on) {
  _hDup = on;
  historyDupBtn.classList.toggle('btn-primary', on);
  historyDupBtn.classList.toggle('btn-ghost', !on);
}

// 相同文件：切换按哈希值分组视图，仅展示出现 >1 次的哈希组
historyDupBtn.addEventListener('click', () => {
  setDupActive(!_hDup);
  _hPage = 1;
  loadHistory();
});

function doHistorySearch() {
  _hQuery = historySearch.value.trim();
  _hPage  = 1;
  loadHistory();
}

function openHistory() {
  historySearch.value = '';
  _hQuery = '';
  _hPage  = 1;
  setDupActive(false);
  historyOverlay.hidden = false;
  loadHistory();
}

function closeHistory() {
  historyOverlay.hidden = true;
}

async function loadHistory() {
  historyList.innerHTML = '<p class="hist-empty">加载中…</p>';
  historyPager.innerHTML = '';
  const params = new URLSearchParams({ page: _hPage });
  if (_hQuery) params.set('q', _hQuery);
  if (_hDup) params.set('dup', '1');
  try {
    const res  = await fetch('api/history?' + params);
    const data = await res.json();
    if (!data.success) { historyList.innerHTML = `<p class="hist-empty">${esc(data.error)}</p>`; return; }
    if (_hDup) renderDupGroups(data.entries);
    else renderHistoryList(data.entries);
    renderPager(data.page, data.pages);
  } catch {
    historyList.innerHTML = '<p class="hist-empty">加载失败</p>';
  }
}

function renderHistoryList(entries) {
  if (entries.length === 0) {
    historyList.innerHTML = '<p class="hist-empty">暂无历史记录</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'hist-table';
  table.innerHTML = `
    <thead><tr>
      <th>文件</th><th>算法</th><th>哈希值</th><th>耗时</th><th>时间</th><th>操作</th>
    </tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const entry of entries) {
    const tr = document.createElement('tr');
    const name = baseName(entry.path);
    // 哈希值原样输出，截断交给 CSS（.ht-hash code 做溢出省略），复制到的仍是完整值
    tr.innerHTML = `
      <td class="ht-path ht-copy" title="${esc(entry.path)}">${esc(name)}</td>
      <td class="ht-algo">${fmtAlgo(entry.algo)}</td>
      <td class="ht-hash ht-copy" title="${esc(entry.hash || '')}"><code>${esc(entry.hash || '—')}</code></td>
      <td class="ht-time">${fmtDuration(entry.elapsed_ms)}</td>
      <td class="ht-time">${esc(entry.created_at)}</td>
      <td class="ht-action">
        <button class="btn-open" data-p="${esc(dirName(entry.path))}">打开目录</button>
        <button class="btn-copy hist-del">删除</button></td>
    `;
    bindCopyCell(tr.querySelector('.ht-path'), entry.path);
    if (entry.hash) bindCopyCell(tr.querySelector('.ht-hash'), entry.hash);
    tr.querySelector('.hist-del').addEventListener('click', async () => {
      try { await fetch(`api/history?id=${entry.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
      tr.remove();
      if (!tbody.querySelector('tr')) {
        if (_hPage > 1) _hPage--;  // 删空当前页后回退一页，避免停在不存在的空页
        loadHistory();
      }
    });
    tbody.appendChild(tr);
  }

  historyList.innerHTML = '';
  historyList.appendChild(table);
}

// 相同文件分组视图：后端按 hash 排序返回，连续相同 hash 聚为一组
function renderDupGroups(entries) {
  if (entries.length === 0) {
    historyList.innerHTML = '<p class="hist-empty">没有相同哈希值的文件</p>';
    return;
  }
  // 按 hash 聚合（顺序即组顺序）
  const groups = [];
  let cur = null;
  for (const e of entries) {
    if (!cur || cur.hash !== e.hash) {
      cur = { hash: e.hash, files: [] };
      groups.push(cur);
    }
    cur.files.push(e);
  }

  historyList.innerHTML = '';
  for (const g of groups) {
    const block = document.createElement('div');
    block.className = 'dup-group';
    const head = document.createElement('div');
    head.className = 'dup-head ht-copy';
    head.title = g.hash;
    head.innerHTML = `<code>${esc(g.hash)}</code> <span class="dup-count">${g.files.length} 个文件</span>`;
    bindCopyCell(head, g.hash);
    block.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'dup-list';
    for (const e of g.files) {
      const name = baseName(e.path);
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="dup-path ht-copy" title="${esc(e.path)}">${esc(name)}</span>
        <span class="dup-algo">${fmtAlgo(e.algo)}</span>
        <span class="dup-time">${esc(e.created_at)}</span>
        <button class="btn-open" data-p="${esc(dirName(e.path))}">打开目录</button>`;
      bindCopyCell(li.querySelector('.dup-path'), e.path);
      list.appendChild(li);
    }
    block.appendChild(list);
    historyList.appendChild(block);
  }
}

function renderPager(page, pages) {
  if (pages <= 1) { historyPager.innerHTML = ''; return; }
  historyPager.innerHTML = `
    <button class="pg-btn" id="pg-prev" ${page === 1 ? 'disabled' : ''}>&#8249;</button>
    <span class="pg-info">第 ${page} / ${pages} 页</span>
    <button class="pg-btn" id="pg-next" ${page === pages ? 'disabled' : ''}>&#8250;</button>
  `;
  if (page > 1)     historyPager.querySelector('#pg-prev').addEventListener('click', () => { _hPage = page - 1; loadHistory(); });
  if (page < pages) historyPager.querySelector('#pg-next').addEventListener('click', () => { _hPage = page + 1; loadHistory(); });
}


// ── State ────────────────────────────────────────────────────
function mergeResults(newResults) {
  for (const r of newResults) {
    if (!state.has(r.file)) state.set(r.file, new Map());
    state.get(r.file).set(r.algo, r);
  }
}

function flattenState() {
  const rows = [];
  for (const file of [...state.keys()].sort()) {
    const algoMap = state.get(file);
    for (const algo of ALGO_ORDER) {
      if (algoMap.has(algo)) rows.push(algoMap.get(algo));
    }
  }
  return rows;
}

// ── Render ───────────────────────────────────────────────────
// 结果是流式到达的，整表重绘会让每轮轮询的开销都是 O(总行数)。改为增量插入：
// renderedRows 与 resultsBody.children 严格一一对应且同序，新行二分定位后插到
// 对应位置，单轮开销只与该轮新增的条数有关。校验值变化才整表重绘。
let renderedRows = [];
let renderedExpected = '';                       // 当前 DOM 所依据的校验值
let counts = { ok: 0, fail: 0, err: 0 };

// 行序：先按文件路径（与 flattenState 的默认字符串排序一致），再按算法固定次序
function rowCmp(a, b) {
  if (a.file < b.file) return -1;
  if (a.file > b.file) return 1;
  return ALGO_ORDER.indexOf(a.algo) - ALGO_ORDER.indexOf(b.algo);
}

// 行归属的统计桶；无校验值且非错误时不计入任何桶
function bucketOf(r, expected) {
  if (!r.hash && r.error) return 'err';
  if (!expected) return null;
  return String(r.hash).toLowerCase() === expected ? 'ok' : 'fail';
}

function buildRowHTML(r, expected, bucket) {
  const hasError = bucket === 'err';
  const cls = (!expected || hasError) ? '' : ` class="${bucket === 'ok' ? 'row-ok' : 'row-fail'}"`;

  const hashCell = hasError
    ? `<td class="col-hash hash-error" title="${esc(r.error)}"><span class="err-icon">⚠</span> ${esc(r.error)}</td>`
    : `<td class="col-hash"><code>${esc(r.hash)}</code></td>`;

  let statusCell;
  if (!expected) {
    statusCell = '<td class="col-status" style="display:none"></td>';
  } else if (hasError) {
    statusCell = '<td class="col-status"><span class="badge badge-err">错误</span></td>';
  } else {
    statusCell = bucket === 'ok'
      ? '<td class="col-status"><span class="badge badge-ok">✓ 匹配</span></td>'
      : '<td class="col-status"><span class="badge badge-fail">✗ 不匹配</span></td>';
  }

  // 出错的行没有哈希可复制，但仍然可以去目录里看看文件出了什么问题
  const openBtn = `<button class="btn-open" data-p="${esc(dirName(r.file))}">打开目录</button>`;
  const copyCell = hasError
    ? `<td class="col-action">${openBtn}</td>`
    : `<td class="col-action">${openBtn}<button class="btn-copy" data-v="${esc(r.hash)}">复制</button></td>`;

  return `<tr${cls}>`
    + `<td class="col-file" title="${esc(semCache.get(r.file) || r.file)}">${esc(baseName(r.file))}</td>`
    + `<td class="col-algo">${fmtAlgo(r.algo)}</td>`
    + hashCell
    + `<td class="col-time">${fmtDuration(r.elapsed_ms)}</td>`
    + statusCell + copyCell
    + '</tr>';
}

const _rowTpl = document.createElement('template');
function rowElement(html) {
  _rowTpl.innerHTML = html;
  return _rowTpl.content.firstElementChild;
}

// 二分定位后插入单行；同 (file, algo) 重算则替换并回退旧的计数
function insertRow(r, expected) {
  let lo = 0, hi = renderedRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowCmp(renderedRows[mid], r) < 0) lo = mid + 1; else hi = mid;
  }
  const bucket = bucketOf(r, expected);
  const tr = rowElement(buildRowHTML(r, expected, bucket));
  if (lo < renderedRows.length && rowCmp(renderedRows[lo], r) === 0) {
    const old = bucketOf(renderedRows[lo], expected);
    if (old) counts[old]--;
    resultsBody.children[lo].replaceWith(tr);
    renderedRows[lo] = r;
  } else {
    resultsBody.insertBefore(tr, resultsBody.children[lo] || null);
    renderedRows.splice(lo, 0, r);
  }
  if (bucket) counts[bucket]++;
}

// 增量渲染一批新到的结果
function renderNewRows(entries) {
  const expected = expectedInput.value.trim().toLowerCase();
  if (expected !== renderedExpected) { renderFromState(); return; }  // 校验值变了：整表重绘

  const batch = entries.filter(r => ALGO_ORDER.includes(r.algo)).sort(rowCmp);
  if (batch.length === 0) return;

  const last = renderedRows[renderedRows.length - 1];
  if (last && rowCmp(batch[0], last) <= 0) {
    for (const r of batch) insertRow(r, expected);   // 有乱序，逐行定位
  } else {
    // 整批都排在已渲染内容之后（并行完成顺序大体有序，这是常见情况）：
    // 拼成一个字符串一次性解析，省掉逐行的 DOM 解析
    const html = [];
    for (const r of batch) {
      const bucket = bucketOf(r, expected);
      if (bucket) counts[bucket]++;
      html.push(buildRowHTML(r, expected, bucket));
      renderedRows.push(r);
    }
    resultsBody.insertAdjacentHTML('beforeend', html.join(''));
  }

  thStatus.style.display = expected ? '' : 'none';
  queueConvert(batch.map(r => r.file));
  updateSummary();
  resultsEl.hidden = false;
}

// 整表重绘：校验值变化、清空、以及首次进入增量渲染前的兜底
function renderFromState() {
  const rows = flattenState();
  renderedExpected = expectedInput.value.trim().toLowerCase();
  renderedRows = rows;
  counts = { ok: 0, fail: 0, err: 0 };

  if (rows.length === 0) {
    resultsBody.innerHTML = '';
    resultsEl.hidden = true;
    return;
  }

  thStatus.style.display = renderedExpected ? '' : 'none';
  const html = [];
  for (const r of rows) {
    const bucket = bucketOf(r, renderedExpected);
    if (bucket) counts[bucket]++;
    html.push(buildRowHTML(r, renderedExpected, bucket));
  }
  resultsBody.innerHTML = html.join('');  // 一次解析，替代逐行 appendChild

  queueConvert(rows.map(r => r.file));
  updateSummary();
  resultsEl.hidden = false;
}

function updateSummary() {
  const n = renderedRows.length;
  if (renderedExpected) {
    const errPart = counts.err ? `，${counts.err} 错误` : '';
    summaryEl.textContent = `${state.size} 个文件，${n} 项：${counts.ok} 匹配，${counts.fail} 不匹配${errPart}`;
    summaryEl.className = 'summary ' + (counts.fail > 0 ? 'summary-fail' : 'summary-ok');
  } else {
    summaryEl.textContent = `${state.size} 个文件，${n} 项结果`;
    summaryEl.className = 'summary';
  }
}

// 复制按钮用事件委托，避免每行各挂一个监听器（整表重绘时还要全部重挂）
resultsBody.addEventListener('click', e => {
  const btn = e.target.closest('.btn-copy');
  if (btn) copyText(btn.dataset.v, btn);
});
delegateOpenDir(resultsBody);

// ── Helpers ──────────────────────────────────────────────────
function bindCopyCell(cell, fullText) {
  cell.addEventListener('click', () => {
    const done = () => {
      cell.classList.add('ht-copied');
      setTimeout(() => cell.classList.remove('ht-copied'), 1000);
      showModalToast();
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(fullText).then(done).catch(() => fallbackCopy(fullText, { textContent: '', disabled: false }, done));
    } else {
      fallbackCopy(fullText, { textContent: '', disabled: false }, done);
    }
  });
}

function showModalToast() {
  const toast = $('modal-toast');
  clearTimeout(toast._showTimer);
  clearTimeout(toast._timer);
  const show = () => {
    toast.hidden = false;
    toast._timer = setTimeout(() => { toast.hidden = true; }, 1500);
  };
  if (!toast.hidden) {
    toast.hidden = true;
    toast._showTimer = setTimeout(show, 60);
  } else {
    show();
  }
}

function fmtAlgo(a) {
  return a === 'md5' ? 'MD5' : a.replace(/^sha(\d+)$/, 'SHA-$1').toUpperCase();
}

// 取路径的末段作为文件名；取前段作为所在目录（根目录下的文件回 /）
const baseName = p => p.split('/').pop() || p;
const dirName  = p => p.slice(0, p.lastIndexOf('/')) || '/';

// 毫秒 → 人类可读，目标是一眼看出实际花了多久：
// 秒以下直接给毫秒（小文件原先一律显示 0.00s，等于没有信息），
// 分钟以上拆成 m/s（原先 341951ms 显示 5.7m，读者还得自己换算成 5 分 42 秒）
function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1)    return '<1ms';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const total = Math.round(ms / 1000);
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  const pad = v => String(v).padStart(2, '0');
  return h ? `${h}h${pad(m)}m${pad(s)}s` : `${m}m${pad(s)}s`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyText(text, btn) {
  const done = () => {
    btn.textContent = '已复制'; btn.disabled = true;
    setTimeout(() => { btn.textContent = '复制'; btn.disabled = false; }, 1500);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, btn, done));
  } else {
    fallbackCopy(text, btn, done);
  }
}

function fallbackCopy(text, btn, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); done(); } catch { btn.textContent = '复制失败'; }
  document.body.removeChild(ta);
}

// ── Auto-run ─────────────────────────────────────────────────
// 由文件管理器"用 HashFile 打开"带 ?path= 进入时自动开算
if (_initPath) { showSemantic(); run(); }

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
function clearError()   { errorBox.hidden = true; }
function setLoading(v)  {
  loadingEl.hidden = !v;
  submitBtn.disabled = v;
  abortBtn.hidden = !v;
  if (v) loadingText.textContent = '计算中，请稍候…';
}
