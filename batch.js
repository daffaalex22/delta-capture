/* DeltaCapture — batch.js
 * Runs on the Student Problem Logs list page (/app/teacher/data/logs*).
 *
 * Adds a selection column to <table id="log-table"> and a floating action bar:
 *   [checkbox per row] -> "⤓ PDF (N)" -> for every selected row (in order):
 *        click that row's "View" button (SPA route, no reload),
 *        wait for the problem card, rasterize a 2x canvas,
 *        history.back(), wait for the table, next row.
 * Then assembles all captures into ONE A4 PDF via the bundled jsPDF 2.5
 * (window.jspdf). Cover page + per-card pages + footers + page numbers.
 *
 * 100% in-browser: nothing is uploaded anywhere.
 * v1 scope: selection applies to the rows of the CURRENT page.
 */
(() => {
  'use strict';

  const API = window.__DeltaCaptureApi;
  if (!API || typeof API.rasterizeCard !== 'function') {
    console.warn('[DeltaCapture-batch] core API unavailable — did content.js load first?');
    return;
  }

  const LIST_PATH = '/app/teacher/data/logs';
  const TABLE_SEL = '#log-table';
  const CARD_SEL = 'problem-page#problem_page .paper-shadow, problem-page .paper-shadow';
  const BAR_ID = 'deltacapture-batch-bar';
  const OVERLAY_ID = 'deltacapture-batch-overlay';
  const BATCH_SCALE = 2; // per-card raster scale for PDF pages (print-friendly)

  /* ---------------------------------------------------------------- state */

  const selected = new Set(); // tbody row indices on the current page (0-based)
  let anchorIdx = null;       // last checkbox clicked WITHOUT Shift (range anchor)
  let running = false;
  let aborted = false;
  let lastRowsSignature = ''; // clears the selection if the visible rows change
  let batchRecipe = null;     // view state to re-apply between cards

  /* -------------------------------------------------------------- helpers */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  async function waitFor(fn, timeout, what) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (err) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + (what || 'condition'));
      await sleep(120);
    }
  }

  function toastBatch(msg, ok = true) {
    // Reuse the shared toast styling from ui.css.
    if (typeof API.toast === 'function') return API.toast(msg, ok);
    const t = document.createElement('div');
    t.className = 'deltacapture-toast';
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  /** Text signature of the current visible rows (detects page/filter changes). */
  function rowsSignature() {
    return dataRows()
      .slice(0, 2)
      .map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim())
      .join('|');
  }

  /* ---------------------------------------------------------------- table */

  function onListPage() {
    return location.pathname.startsWith(LIST_PATH);
  }

  function dataRows() {
    return Array.from(document.querySelectorAll(TABLE_SEL + ' tbody tr'));
  }

  const dataRowAt = (i) => dataRows()[i] || null;

  function viewButtonOf(row) {
    for (const td of row.cells) {
      const b = td.querySelector('button');
      if (b && /view/i.test(b.textContent || '')) return b;
    }
    const first = row.querySelector('td button');
    return first || null;
  }

  function ensureHeader() {
    const table = document.querySelector(TABLE_SEL);
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    const headerTr = table.tHead.rows[0];
    if (headerTr.querySelector('th.deltacapture-batch-col')) return;
    const th = document.createElement('th');
    th.className = 'deltacapture-batch-col';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.className = 'deltacapture-batch-checkbox';
    all.title = 'Select all rows on this page';
    all.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const n = dataRows().length;
      if (all.checked) for (let i = 0; i < n; i++) selected.add(i);
      else selected.clear();
      paintRows();
      updateBar();
    });
    th.appendChild(all);
    headerTr.insertBefore(th, headerTr.firstChild);
  }

  /** Shared toggle for checkbox clicks and whole-cell clicks.
   *  For checkbox clicks the DOM has ALREADY flipped cb.checked, so `on`
   *  is the checkbox's resulting state. With Shift held, every row between
   *  the anchor and this one is set to `on` (Sheets/Gmail convention —
   *  Shift+clicking a checked box also un-checks the range). */
  function applyToggle(idx, on, shiftKey) {
    if (idx < 0) return;
    if (shiftKey && anchorIdx !== null && anchorIdx !== idx) {
      const lo = Math.min(anchorIdx, idx);
      const hi = Math.max(anchorIdx, idx);
      for (let i = lo; i <= hi; i++) {
        if (on) selected.add(i);
        else selected.delete(i);
      }
      anchorIdx = null; // range consumed; next plain click re-anchors
    } else {
      if (on) selected.add(idx);
      else selected.delete(idx);
      anchorIdx = idx; // new anchor for the next Shift+click
    }
    paintRows();
    updateBar();
  }

  function ensureRowTd(tr) {
    let td = tr.querySelector('td.deltacapture-batch-col');
    if (!td) {
      td = document.createElement('td');
      td.className = 'deltacapture-batch-col';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'deltacapture-batch-checkbox';
      // The index must be resolved at click time (rows re-render constantly).
      cb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const idx = dataRows().indexOf(tr);
        if (idx < 0) return;
        applyToggle(idx, cb.checked, ev.shiftKey);
      });
      // Whole-cell clicks (padding around the 15px box) count too.
      td.addEventListener('click', (ev) => {
        if (ev.target !== td) return; // the checkbox handles its own event
        ev.stopPropagation();
        const idx = dataRows().indexOf(tr);
        if (idx < 0) return;
        const cb = td.querySelector('input.deltacapture-batch-checkbox');
        if (!cb) return;
        cb.checked = !cb.checked;
        applyToggle(idx, cb.checked, ev.shiftKey);
      });
      td.appendChild(cb);
      tr.insertBefore(td, tr.firstChild);
    }
    const idx = dataRows().indexOf(tr);
    const cb = td.querySelector('input.deltacapture-batch-checkbox');
    if (cb) cb.checked = selected.has(idx);
    tr.classList.toggle('deltacapture-selected', idx >= 0 && selected.has(idx));
  }

  function paintRows() {
    dataRows().forEach((tr) => ensureRowTd(tr));
  }

  function removeBatchUI() {
    const bar = document.getElementById(BAR_ID);
    if (bar) bar.remove();
  }

  /* --------------------------------------------------------- action bar */

  function updateBar() {
    if (!onListPage() || running) return;
    const n = selected.size;
    let bar = document.getElementById(BAR_ID);
    if (!n) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = BAR_ID;
      const label = document.createElement('span');
      label.className = 'deltacapture-batch-label';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'deltacapture-btn-pdf';
      go.title = 'Capture each selected problem (2x) and build a single A4 PDF';
      go.addEventListener('click', () => { if (!running) runBatch(); });
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'deltacapture-btn-clear';
      clr.textContent = 'Clear';
      clr.addEventListener('click', () => {
        selected.clear();
        paintRows();
        updateBar();
      });
      bar.appendChild(label);
      bar.appendChild(go);
      bar.appendChild(clr);
      document.documentElement.appendChild(bar);
    }
    bar.querySelector('.deltacapture-btn-pdf').textContent = `⤓ PDF (${n})`;
  }

  /* ----------------------------------------------------------- overlay */

  function overlay(mode, info) {
    let ov = document.getElementById(OVERLAY_ID);
    if (mode === 'hide') {
      if (ov) ov.remove();
      return;
    }
    if (!ov) {
      ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      ov.innerHTML = '<div class="deltacapture-batch-card"></div>';
      document.documentElement.appendChild(ov);
    }
    const card = ov.querySelector('.deltacapture-batch-card');
    if (!card) return;

    if (mode === 'running') {
      const total = info.total;
      const done = info.done;
      const pct = Math.min(100, Math.round((done / total) * 100));
      card.innerHTML =
        `<div class="deltacapture-batch-title">Capturing ${done} of ${total}</div>` +
        `<div class="deltacapture-batch-sub"></div>` +
        `<div class="deltacapture-batch-track"><div class="deltacapture-batch-fill" ` +
        `style="width:${pct}%"></div></div>` +
        `<button type="button" class="deltacapture-batch-cancel">Cancel</button>`;
      card.querySelector('.deltacapture-batch-sub').textContent = info.label || '';
      card.querySelector('.deltacapture-batch-cancel').addEventListener('click', () => {
        aborted = true;
        const c = card.querySelector('.deltacapture-batch-cancel');
        if (c) { c.disabled = true; c.textContent = 'Stopping after this card…'; }
      });
    } else if (mode === 'saving') {
      card.innerHTML =
        `<div class="deltacapture-batch-title">Assembling PDF…</div>` +
        `<div class="deltacapture-batch-sub">${info && info.label ? info.label : ''}</div>` +
        `<div class="deltacapture-batch-track"><div class="deltacapture-batch-fill deltacapture-batch-ind" style="width:78%"></div></div>`;
    }
  }

  /** Update only the progress bits (without re-rendering the button). */
  function overlayUpdate(done, total, label) {
    const ov = document.getElementById(OVERLAY_ID);
    if (!ov) return;
    const fill = ov.querySelector('.deltacapture-batch-fill');
    const title = ov.querySelector('.deltacapture-batch-title');
    const sub = ov.querySelector('.deltacapture-batch-sub');
    if (title) title.textContent = `Capturing ${done} of ${total}`;
    if (fill) fill.style.width = Math.min(100, Math.round((done / total) * 100)) + '%';
    if (sub) sub.textContent = label || '';
  }

  /* ------------------------------------------------------------- runner */

  async function waitForCard(timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      if (aborted) return null;
      if (!location.pathname.startsWith(LIST_PATH)) {
        const card = document.querySelector(CARD_SEL);
        if (card && card.getBoundingClientRect().height > 100) {
          await sleep(350); // let KaTeX / SVG finish settling
          return card;
        }
      }
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(120);
    }
  }

  /** Fire DOM events the way Angular forms listen for them. */
  function fire(el, type) {
    try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (err) { /* ignore */ }
  }
  function fireKeyUp(el) {
    try {
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', keyCode: 65, which: 65 }));
    } catch (err) { fire(el, 'keyup'); }
  }

  /** Current active pagination page number (ngb-style pagination widget). */
  function activePage() {
    const li = document.querySelector('log-rows ul.pagination li.page-item.active');
    if (!li) return 1;
    const n = parseInt((li.textContent || '').trim(), 10);
    return isNaN(n) ? 1 : n;
  }

  /** Re-apply the view the batch started with: per-page select, header search
   *  filters and the active page. DeltaMath resets all of those when the SPA
   *  route returns, so without this every card after the first would see the
   *  UNfiltered list. */
  async function restoreListState() {
    const r = batchRecipe;
    if (!r) return;

    const sel = document.querySelector('log-rows .assignment-view-tools select.form-control');
    if (sel && String(sel.value) !== String(r.perPage)) {
      sel.value = String(r.perPage);
      fire(sel, 'input');
      fire(sel, 'change');
      await sleep(500);
    }

    const applySearch = async (input, value) => {
      if (!input || input.value === String(value)) return;
      input.value = String(value);
      fire(input, 'input');
      fire(input, 'change');
      fireKeyUp(input);
      await sleep(280);
    };
    await applySearch(document.querySelector(TABLE_SEL + ' input[name="search-name"]'), r.student);
    await applySearch(document.querySelector(TABLE_SEL + ' input[name="search-assignment"]'), r.assignment);

    if (activePage() !== r.page) {
      const lis = [...document.querySelectorAll('log-rows ul.pagination li.page-item')];
      const target = lis.find((li) => {
        const link = li.querySelector('.page-link') || li.querySelector('a') || li.querySelector('button') || li;
        const t = (link.textContent || '').trim();
        return /^\d+$/.test(t) && parseInt(t, 10) === r.page;
      });
      const link = target && (target.querySelector('.page-link') || target.querySelector('a') ||
                              target.querySelector('button') || target);
      if (link) {
        link.click();
        await sleep(650);
      }
    }
  }

  /** history.back() then wait for the list table, and restore the batch's
   *  view state (filters/select/page) before proceeding. */
  async function returnToList(timeoutMs = 16000) {
    history.back();
    try {
      await waitFor(() =>
        location.pathname.startsWith(LIST_PATH) &&
        !!document.querySelector(TABLE_SEL) &&
        dataRows().length > 0, timeoutMs, 'the list table');
      await sleep(250); // let the first render settle
      try {
        await restoreListState();
      } catch (err) {
        console.error('[DeltaCapture-batch] restore failed:', err);
      }
      await waitFor(() =>
        !batchRecipe || rowsSignature() === batchRecipe.rowsSig,
        9000, 'the original filtered rows');
      return true;
    } catch (err) {
      return false;
    }
  }

  function stampFilename() {
    const p = (x) => String(x).padStart(2, '0');
    const d = new Date();
    return `DeltaMath_Batch_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`;
  }

  function buildPdf(pages, meta) {
    const lib = window.jspdf;
    if (!lib || typeof lib.jsPDF !== 'function') throw new Error('jsPDF not loaded');
    const doc = new lib.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const total = pages.length + 1;

    // ---- cover page
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(21);
    doc.setTextColor('#17222e');
    doc.text('DeltaMath - Problem Log Batch', pw / 2, 42, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.setTextColor('#5a6a78');
    doc.text(`${pages.length} problem card${pages.length === 1 ? '' : 's'}`, pw / 2, 54, { align: 'center' });
    doc.text(`Generated ${new Date().toLocaleString()}`, pw / 2, 62, { align: 'center' });

    if (meta.students.size) {
      doc.setFontSize(13);
      doc.setTextColor('#17222e');
      doc.text('Students', pw / 2, 88, { align: 'center' });
      doc.setFontSize(12);
      doc.setTextColor('#313e48');
      doc.text(doc.splitTextToSize([...meta.students].join(', '), pw - 40), pw / 2, 98, { align: 'center' });
    }

    const counts = [];
    if (meta.correctCount) counts.push(`${meta.correctCount} correct`);
    if (meta.wrongCount) counts.push(`${meta.wrongCount} incorrect`);
    if (counts.length) {
      doc.setTextColor('#5a6a78');
      doc.text(counts.join('  ·  '), pw / 2, 126, { align: 'center' });
    }
    if (meta.failures.length) {
      doc.setTextColor('#b03a2e');
      doc.text(doc.splitTextToSize(`Skipped: ${meta.failures.join('; ')}`, pw - 40), pw / 2, 138, { align: 'center' });
    }

    doc.setTextColor('#93a1ad');
    doc.setFontSize(10);
    doc.text('Assembled locally in the browser - nothing was uploaded.', pw / 2, ph - 22, { align: 'center' });

    // ---- one page per card
    pages.forEach((p, i) => {
      doc.addPage();
      const canvas = p.canvas;
      const maxW = pw - 20;
      const maxH = ph - 20;
      const ratio = canvas.width / canvas.height;
      let w = maxW;
      let h = w / ratio;
      if (h > maxH) { h = maxH; w = h * ratio; }
      doc.addImage(canvas, 'PNG', (pw - w) / 2, (ph - h) / 2 - 3, w, h);
      doc.setFontSize(9);
      doc.setTextColor('#93a1ad');
      doc.text(`Page ${i + 2} / ${total}`, pw / 2, ph - 6, { align: 'center' });
    });

    doc.save(meta.filename);
  }

  async function runBatch() {
    if (running || !selected.size) return;
    const indices = [...selected].sort((a, b) => a - b);
    running = true;
    aborted = false;

    const perPageSel = document.querySelector('log-rows .assignment-view-tools select.form-control');
    batchRecipe = {
      perPage: perPageSel ? perPageSel.value : '100',
      student: (document.querySelector(TABLE_SEL + ' input[name="search-name"]') || {}).value || '',
      assignment: (document.querySelector(TABLE_SEL + ' input[name="search-assignment"]') || {}).value || '',
      page: activePage(),
      rowsSig: rowsSignature(),
    };
    const pages = [];
    const failures = [];
    const students = new Set();
    let correctCount = 0;
    let wrongCount = 0;

    overlay('running', { done: 1, total: indices.length, label: 'starting…' });

    try {
      for (let k = 0; k < indices.length; k++) {
        if (aborted) break;
        const rowIndex = indices[k];

        let row = null;
        try {
          row = await waitFor(() => dataRowAt(rowIndex), 9000, 'the selected row');
        } catch (err) { row = null; }
        if (!row) {
          failures.push(`row ${rowIndex + 1}: not on screen`);
          continue;
        }
        const btn = viewButtonOf(row);
        if (!btn) {
          failures.push(`row ${rowIndex + 1}: View button missing`);
          continue;
        }

        overlayUpdate(k + 1, indices.length, 'clicking View…');
        // Click with retry: Angular can re-render the row right around our
        // click, leaving the button detached (click silently no-ops).
        // Re-query a fresh row/button and retry if the route never left.
        let routed = false;
        for (let attempt = 1; attempt <= 3 && !aborted; attempt++) {
          const fresh = attempt === 1 ? row : dataRowAt(rowIndex);
          const vBtn = fresh && viewButtonOf(fresh);
          if (!vBtn) break;
          overlayUpdate(k + 1, indices.length,
            attempt > 1 ? `clicking View (retry ${attempt})…` : 'clicking View…');
          vBtn.click();
          const t0 = Date.now();
          while (Date.now() - t0 < 2600) {
            if (!location.pathname.startsWith(LIST_PATH)) { routed = true; break; }
            await sleep(100);
          }
          if (routed) break;
          await sleep(350); // let a re-render finish, then click fresh nodes
        }
        if (!routed) {
          await returnToList();
          failures.push(`row ${rowIndex + 1}: card never rendered`);
          continue;
        }

        const card = await waitForCard(12000);
        if (!card) {
          await returnToList();
          failures.push(`row ${rowIndex + 1}: card never rendered`);
          continue;
        }

        const lines = API.headerLines(card);
        const sub = `${lines[0] || ''} - ${lines[1] || ''}`.trim();
        overlayUpdate(k + 1, indices.length, sub || `capturing card ${k + 1}…`);

        let canvas = null;
        try {
          canvas = await API.rasterizeCard(card, BATCH_SCALE);
        } catch (err) {
          // First render passes occasionally fail before fonts are cached;
          // SnapDOM caches them after one pass, so an immediate retry clears.
          await sleep(700);
          try {
            canvas = await API.rasterizeCard(card, BATCH_SCALE);
          } catch (err2) {
            await returnToList();
            failures.push(`row ${rowIndex + 1}: capture failed (${err2 && err2.message})`);
            continue;
          }
        }

        pages.push({ canvas, meta: lines });
        if (lines[0]) students.add(lines[0]);
        const res = API.detectResult(card);
        if (res === 'CORRECT') correctCount++;
        else if (res === 'WRONG') wrongCount++;

        if (!aborted && k < indices.length - 1) {
          // No need to go back after the final capture. The restore inside
          // returnToList re-applies per-page/search/page so the filtered
          // view the batch started with is always what we come back to.
          const back = await returnToList();
          if (!back) {
            failures.push(`could not return to the (filtered) list after row ${rowIndex + 1}`);
            break;
          }
        }
      }
    } catch (err) {
      console.error('[DeltaCapture-batch] loop error:', err);
      failures.push('unexpected error: ' + (err && err.message));
    }

    if (!pages.length) {
      overlay('hide');
      running = false;
      selected.clear();
      paintRows();
      updateBar();
      toastBatch(`Batch failed — nothing captured.${failures.length ? ' Details: ' + failures.join('; ') : ''}`, false);
      return;
    }

    overlay('saving', { label: `${pages.length} page${pages.length === 1 ? '' : 's'}` });
    try {
      buildPdf(pages, {
        students,
        correctCount,
        wrongCount,
        failures,
        filename: stampFilename(),
      });
      selected.clear();
      // ONE consolidated outcome message — never two competing toasts.
      let summary;
      if (aborted) {
        summary = `PDF built from ${pages.length} of ${indices.length} selected — stopped by Cancel.`;
      } else if (failures.length) {
        const det = failures.slice(0, 2).join('; ') +
          (failures.length > 2 ? ` …and ${failures.length - 2} more (full list on the PDF cover)` : '');
        summary = `PDF built with ${pages.length} cards; ${failures.length} skipped — ${det}`;
      } else {
        summary = `PDF saved — ${pages.length} card${pages.length === 1 ? '' : 's'} in one document.`;
      }
      toastBatch(summary, !(aborted || failures.length));
    } catch (err) {
      console.error('[DeltaCapture-batch] PDF failed:', err);
      toastBatch('PDF build failed: ' + (err && err.message), false);
    } finally {
      overlay('hide');
      running = false;
      paintRows();
      updateBar();
    }
  }

  /* -------------------------------------------------------------- wiring */

  function syncUI() {
    if (!onListPage()) {
      removeBatchUI();
      return;
    }
    const rows = dataRows();
    if (!rows.length) {
      removeBatchUI();
      return;
    }
    const sig = rowsSignature();
    if (sig !== lastRowsSignature) {
      // The visible rows changed (page/filter/sort) — v1 selection is per page.
      // While a batch is running the restore loop legitimately re-renders the
      // list; never wipe the in-flight selection there.
      if (lastRowsSignature && selected.size && !running) {
        selected.clear();
      }
      lastRowsSignature = sig;
    }
    ensureHeader();
    rows.forEach((tr) => ensureRowTd(tr));
    const all = document.querySelector('th.deltacapture-batch-col input');
    if (all) all.checked = selected.size > 0 && selected.size === rows.length;
    updateBar();
  }

  const schedule = debounce(syncUI, 150);

  function start() {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
    });
    syncUI();
  }

  start();
})();
