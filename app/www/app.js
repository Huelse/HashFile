'use strict';

const $ = id => document.getElementById(id);

const _initPath = new URLSearchParams(window.location.search).get('path');
if (_initPath) {
  $('path').value = _initPath;
  setTimeout(run, 200);
}

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
const historyPager   = $('history-pager');
const verifyGroup    = $('verify-group');
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

const ALGO_ORDER = ['sha256', 'md5', 'sha1', 'sha512'];

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

// ── Recursive → hide verify ─────────────────────────────────
recursiveChk.addEventListener('change', () => {
  verifyGroup.hidden = recursiveChk.checked;
  if (recursiveChk.checked) expectedInput.value = '';
  if (state.size > 0) renderFromState();
});

// ── Expected input → live re-verify ─────────────────────────
expectedInput.addEventListener('input', () => {
  if (state.size > 0) renderFromState();
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

    const d = await pollTask(data.task, activeController.signal);
    if (d.status === 'error') { showError(d.error || '计算失败'); return; }
    if (d.results && d.results.length) {
      mergeResults(d.results);
      renderFromState();
    }
    if (d.status === 'cancelled') {
      showError(d.results && d.results.length ? '已中止计算，已完成部分的结果已保留' : '已中止计算');
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

async function pollTask(id, signal) {
  let delay = 1000;
  let failures = 0;
  while (true) {
    await sleep(delay);
    let d;
    try {
      const res = await fetch('api/hash/status?id=' + id, { signal });
      d = await res.json();
      failures = 0;
    } catch (e) {
      if (e.name === 'AbortError' || ++failures >= 3) throw e;
      continue;  // 长任务轮询次数多，容忍偶发网络抖动，连续 3 次失败才放弃
    }
    if (!d.success) return { status: 'error', error: d.error || '查询任务状态失败' };
    if (d.status !== 'running') return d;
    if (d.total > 1) loadingText.textContent = `计算中（${d.done}/${d.total}），请稍候…`;
    delay = Math.min(delay + 500, 3000);  // 缓步退避，长任务减少无谓轮询
  }
}

// ── Clear ───────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  state.clear();
  resultsEl.hidden = true;
  clearError();
});

// ── History ──────────────────────────────────────────────────
let _hPage = 1;
let _hQuery = '';

historyBtn.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', e => { if (e.target === historyOverlay) closeHistory(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !historyOverlay.hidden) closeHistory(); });

historySearch.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  doHistorySearch();
});
historySearchBtn.addEventListener('click', doHistorySearch);

function doHistorySearch() {
  _hQuery = historySearch.value.trim();
  _hPage  = 1;
  loadHistory();
}

function openHistory() {
  historySearch.value = '';
  _hQuery = '';
  _hPage  = 1;
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
  try {
    const res  = await fetch('api/history?' + params);
    const data = await res.json();
    if (!data.success) { historyList.innerHTML = `<p class="hist-empty">${esc(data.error)}</p>`; return; }
    renderHistoryList(data.entries, data.total);
    renderPager(data.page, data.pages);
  } catch {
    historyList.innerHTML = '<p class="hist-empty">加载失败</p>';
  }
}

function renderHistoryList(entries, total) {
  if (entries.length === 0) {
    historyList.innerHTML = '<p class="hist-empty">暂无历史记录</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'hist-table';
  table.innerHTML = `
    <thead><tr>
      <th>文件</th><th>算法</th><th>哈希值</th><th>时间</th><th>操作</th>
    </tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const entry of entries) {
    const tr = document.createElement('tr');
    const baseName = entry.path.split('/').pop() || entry.path;
    const hashShort = entry.hash ? entry.hash.slice(0, 16) + '…' : '—';
    tr.innerHTML = `
      <td class="ht-path ht-copy" title="${esc(entry.path)}">${esc(baseName)}</td>
      <td class="ht-algo">${fmtAlgo(entry.algo)}</td>
      <td class="ht-hash ht-copy" title="${esc(entry.hash || '')}"><code>${esc(hashShort)}</code></td>
      <td class="ht-time">${esc(entry.created_at)}</td>
      <td class="ht-action"><button class="btn-copy hist-del">删除</button></td>
    `;
    bindCopyCell(tr.querySelector('.ht-path'), entry.path, baseName);
    if (entry.hash) bindCopyCell(tr.querySelector('.ht-hash'), entry.hash, hashShort);
    tr.querySelector('.hist-del').addEventListener('click', async () => {
      try { await fetch(`api/history?id=${entry.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
      tr.remove();
      if (!tbody.querySelector('tr')) loadHistory();
    });
    tbody.appendChild(tr);
  }

  historyList.innerHTML = '';
  historyList.appendChild(table);
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
function renderFromState() {
  const rows = flattenState();
  if (rows.length === 0) { resultsEl.hidden = true; return; }

  const expected = expectedInput.value.trim();
  const verifyMode = expected.length > 0 && !recursiveChk.checked;

  thStatus.style.display = verifyMode ? '' : 'none';
  resultsBody.innerHTML = '';

  let ok = 0, fail = 0, errCount = 0;

  for (const r of rows) {
    const tr = document.createElement('tr');
    const hasError = !r.hash && r.error;

    if (hasError) {
      errCount++;
    } else if (verifyMode) {
      const matched = r.hash === expected;
      tr.className = matched ? 'row-ok' : 'row-fail';
      matched ? ok++ : fail++;
    }

    const baseName = r.file.split('/').pop() || r.file;

    const hashCell = hasError
      ? `<td class="col-hash hash-error" title="${esc(r.error)}"><span class="err-icon">⚠</span> ${esc(r.error)}</td>`
      : `<td class="col-hash"><code>${esc(r.hash)}</code></td>`;

    let statusCell;
    if (!verifyMode) {
      statusCell = '<td class="col-status" style="display:none"></td>';
    } else if (hasError) {
      statusCell = '<td class="col-status"><span class="badge badge-err">错误</span></td>';
    } else {
      statusCell = r.hash === expected
        ? '<td class="col-status"><span class="badge badge-ok">✓ 匹配</span></td>'
        : '<td class="col-status"><span class="badge badge-fail">✗ 不匹配</span></td>';
    }

    const copyCell = hasError
      ? '<td class="col-action"></td>'
      : `<td class="col-action"><button class="btn-copy" data-v="${esc(r.hash)}">复制</button></td>`;

    tr.innerHTML = `
      <td class="col-file" title="${esc(r.file)}">${esc(baseName)}</td>
      <td class="col-algo">${fmtAlgo(r.algo)}</td>
      ${hashCell}${statusCell}${copyCell}
    `;
    resultsBody.appendChild(tr);
  }

  if (verifyMode) {
    const errPart = errCount ? `，${errCount} 错误` : '';
    summaryEl.textContent = `${state.size} 个文件，${rows.length} 项：${ok} 匹配，${fail} 不匹配${errPart}`;
    summaryEl.className = 'summary ' + (fail > 0 ? 'summary-fail' : 'summary-ok');
  } else {
    summaryEl.textContent = `${state.size} 个文件，${rows.length} 项结果`;
    summaryEl.className = 'summary';
  }

  resultsBody.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn.dataset.v, btn));
  });

  resultsEl.hidden = false;
}

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

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
function clearError()   { errorBox.hidden = true; }
function setLoading(v)  {
  loadingEl.hidden = !v;
  submitBtn.disabled = v;
  abortBtn.hidden = !v;
  if (v) loadingText.textContent = '计算中，请稍候…';
}
