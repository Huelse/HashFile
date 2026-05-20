'use strict';

const $ = id => document.getElementById(id);

const _initPath = new URLSearchParams(window.location.search).get('path');
if (_initPath) {
  $('path').value = _initPath;
  setTimeout(run, 200);
}

const pathInput     = $('path');
const recursiveChk  = $('recursive');
const expectedInput = $('expected');
const timeoutSel    = $('timeout-sel');
const submitBtn     = $('submit');
const abortBtn      = $('abort-btn');
const clearBtn      = $('clear-btn');
const verifyGroup   = $('verify-group');
const loadingEl     = $('loading');
const errorBox      = $('error-box');
const resultsEl     = $('results');
const resultsBody   = $('results-body');
const summaryEl     = $('summary');
const thStatus      = $('th-status');

const ALGO_ORDER = ['sha256', 'md5', 'sha1', 'sha512'];

// Accumulated results: Map<filePath, Map<algo, resultEntry>>
const state = new Map();

// Active fetch controller (for abort)
let activeController = null;
let timedOut = false;

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
abortBtn.addEventListener('click', () => {
  if (activeController) activeController.abort();
});

// ── Submit ──────────────────────────────────────────────────
submitBtn.addEventListener('click', run);
pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

async function run() {
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

  const timeoutSec = parseInt(timeoutSel.value, 10);
  params.set('timeout', timeoutSel.value);  // 0 = unlimited
  activeController = new AbortController();
  timedOut = false;
  let timer = null;
  if (timeoutSec > 0) {
    timer = setTimeout(() => { timedOut = true; activeController.abort(); }, timeoutSec * 1000);
  }

  setLoading(true);
  clearError();

  try {
    const res = await fetch('/api/hash?' + params, { signal: activeController.signal });
    const data = await res.json();
    if (!data.success) { showError(data.error || '计算失败'); return; }
    mergeResults(data.results);
    renderFromState();
  } catch (e) {
    if (e.name === 'AbortError') {
      showError(timedOut ? `计算超时（${timeoutSec} 秒），可调大超时时间后重试` : '已中止计算');
    } else {
      showError('网络请求失败：' + e.message);
    }
  } finally {
    if (timer) clearTimeout(timer);
    activeController = null;
    setLoading(false);
  }
}

// ── Clear ───────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  state.clear();
  resultsEl.hidden = true;
  clearError();
});

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
function setLoading(v)  { loadingEl.hidden = !v; submitBtn.disabled = v; abortBtn.hidden = !v; }
