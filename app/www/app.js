'use strict';

const $ = id => document.getElementById(id);

// 路径需在 setupInputClear() 之前写入，否则清除按钮会被判为空值而隐藏；
// 自动计算则延到文件末尾（此处 run() 依赖的 const 尚在 TDZ 中）
const _initPath = new URLSearchParams(window.location.search).get('path');
if (_initPath) $('path').value = _initPath;

const pathInput      = $('path');
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
  const path = pathInput.value.trim();
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
      continue;  // 长任务轮询次数多，容忍偶发网络抖动，连续 3 次失败才放弃
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
  btn.addEventListener('click', () => { input.value = ''; input.focus(); sync(); onClear && onClear(); });
  sync();
}
setupInputClear(pathInput);                                  // 路径
setupInputClear(expectedInput, () => { if (state.size > 0) renderFromState(); });  // 校验值：清空后重新渲染
setupInputClear(historySearch, () => doHistorySearch());     // 历史搜索：清空即重新搜索

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
    const hshort = hashShort(entry.hash);
    tr.innerHTML = `
      <td class="ht-path ht-copy" title="${esc(entry.path)}">${esc(name)}</td>
      <td class="ht-algo">${fmtAlgo(entry.algo)}</td>
      <td class="ht-hash ht-copy" title="${esc(entry.hash || '')}"><code>${esc(hshort)}</code></td>
      <td class="ht-time">${fmtDuration(entry.elapsed_ms)}</td>
      <td class="ht-time">${esc(entry.created_at)}</td>
      <td class="ht-action"><button class="btn-copy hist-del">删除</button></td>
    `;
    bindCopyCell(tr.querySelector('.ht-path'), entry.path, name);
    if (entry.hash) bindCopyCell(tr.querySelector('.ht-hash'), entry.hash, hshort);
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
    const hshort = g.hash.slice(0, 16) + '…';
    const head = document.createElement('div');
    head.className = 'dup-head ht-copy';
    head.title = g.hash;
    head.innerHTML = `<code>${esc(hshort)}</code> <span class="dup-count">${g.files.length} 个文件</span>`;
    bindCopyCell(head, g.hash, hshort);
    block.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'dup-list';
    for (const e of g.files) {
      const name = baseName(e.path);
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="dup-path ht-copy" title="${esc(e.path)}">${esc(name)}</span>
        <span class="dup-algo">${fmtAlgo(e.algo)}</span>
        <span class="dup-time">${esc(e.created_at)}</span>`;
      bindCopyCell(li.querySelector('.dup-path'), e.path, name);
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

  const copyCell = hasError
    ? '<td class="col-action"></td>'
    : `<td class="col-action"><button class="btn-copy" data-v="${esc(r.hash)}">复制</button></td>`;

  return `<tr${cls}>`
    + `<td class="col-file" title="${esc(r.file)}">${esc(baseName(r.file))}</td>`
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

// ── Helpers ──────────────────────────────────────────────────
function bindCopyCell(cell, fullText, shortText) {
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

// 取路径的末段作为文件名；哈希截短显示
const baseName = p => p.split('/').pop() || p;
const hashShort = h => h ? h.slice(0, 16) + '…' : '—';

// 毫秒 → 人类可读：分钟为最大单位。<1s 保留两位小数，<60s 一位，否则分钟
function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '—';
  const s = ms / 1000;
  if (s < 1)   return s.toFixed(2) + 's';
  if (s < 60)  return s.toFixed(1) + 's';
  return (s / 60).toFixed(1) + 'm';
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
if (_initPath) run();

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
function clearError()   { errorBox.hidden = true; }
function setLoading(v)  {
  loadingEl.hidden = !v;
  submitBtn.disabled = v;
  abortBtn.hidden = !v;
  if (v) loadingText.textContent = '计算中，请稍候…';
}
