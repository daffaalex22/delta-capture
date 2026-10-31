/* DeltaCapture
 * Captures the DeltaMath student problem-log card (student name, skill, date,
 * solve time, result icon, problem, explanation and "Your Solution" section)
 * as a high-res (3x) raster PNG. Adds two buttons left of the pagination "Prev" button:
 *   [Copy]  -> image to clipboard
 *   [PNG]   -> image downloaded with an auto-generated filename
 *
 * Runs entirely in the browser (content script). Nothing is transmitted,
 * stored, or collected. Attaches to https://www.deltamath.com/app/teacher/student-logs*
 * (Manifest V3; the renderer is the bundled SnapDOM build in vendor/snapdom.js,
 * exposed globally as window.snapdom in the content-script world.)
 */
(() => {
  'use strict';

  const PNG_BTN_ID = 'deltacapture-png';
  const COPY_BTN_ID = 'deltacapture-copy';
  const ROUTE_PREFIX = '/app/teacher/student-logs';
  const RESULT_RE = /solved in\s+[\d,]+\s*(second|minute|sec|min|hr|hour)/i;

  // Exact selectors taken from the real page (stable DeltaMath classes).
  const SEL_CARD = 'problem-page#problem_page .paper-shadow, problem-page .paper-shadow';
  const SEL_HEADER_INFO = '.problem-header > div';
  const SEL_RESULT_ICON = '.problem-header-symbol .fa, .problem-header-symbol i, .problem-header-symbol svg, .problem-header-symbol span';
  const SEL_SOL_LABEL = '.yoursolution-label';

  /** Output pixels per CSS pixel. 3x = comfortable on 4K screens and print/PDF.
   *  Must be set via `width` (absolute output size) — `scale` interacts with the
   *  device pixel ratio and can normalize the export back to 1:1 CSS size. */
  const EXPORT_SCALE = 3;
  const MONTHS = (m) =>
    ({ jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'Jun',
       jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' }[m] || null);

  const ICON_DOWNLOAD =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 2v8.2M4.6 7.2 8 10.6l3.4-3.4"/><path d="M2.2 13.8h11.6"/></svg>';
  const ICON_COPY =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/>' +
    '<path d="M10.5 5.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5"/></svg>';

  // ------------------------------------------------------------- utilities

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  /** Shortest element whose text contains re — finds the innermost wrapper,
   *  regardless of how the header text is nested (Angular custom tags, <br>s,
   *  one-block headers, etc.). */
  function findShortest(re) {
    let best = null;
    let bestLen = Infinity;
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (t && re.test(t) && t.length < bestLen) {
        best = el;
        bestLen = t.length;
      }
    }
    return best;
  }

  /** The card's "Your Solution" label — exact class first. */
  function findSolutionLabel() {
    return document.querySelector('yoursolution .yoursolution-label, .yoursolution-label') ||
           findShortest(/^your solution/);
  }

  /** Parse "rgb(a)" color strings into {r,g,b,a}. */
  function parseRgba(str) {
    const m = (str || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  const bgIsWhite = (cs) => {
    const c = parseRgba(cs.backgroundColor);
    return !!c && c.a >= 0.9 && c.r >= 250 && c.g >= 250 && c.b >= 250;
  };
  const isRed = (c) => !!c && c.r >= 150 && c.r > c.g + 50 && c.r > c.b + 50;
  const isGreen = (c) => !!c && c.g >= 110 && c.g > c.r + 30 && c.g > c.b + 30;

  function toast(msg, ok = true) {
    const t = document.createElement('div');
    t.className = 'deltacapture-toast' + (ok ? '' : ' deltacapture-toast--error');
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(() => {
      t.classList.add('deltacapture-toast--out');
      setTimeout(() => t.remove(), 260);
    }, 2100);
  }

  // ------------------------------------------------------------ card finder

  /** Exact: DeltaMath renders the whole card in this stable structure. */
  function findCardExact() {
    return document.querySelector('problem-page#problem_page .paper-shadow') ||
           document.querySelector('problem-page .paper-shadow');
  }

  /** Smallest card-like ancestor of the "Solved in ..." line. */
  function findCardHeuristic() {
    const marker = findShortest(RESULT_RE);
    if (!marker) return null;
    const solLeaf = findSolutionLabel();

    let fallback = null;      // white + decorated
    let fallbackAny = null;   // white only (less strict, last resort)
    for (let a = marker.parentElement; a && a !== document.body; a = a.parentElement) {
      const rect = a.getBoundingClientRect();
      if (rect.width < 280 || rect.height < 180) continue;
      if (rect.width > innerWidth * 0.95 || rect.height > innerHeight * 1.4) break;

      const cs = getComputedStyle(a);
      if (!bgIsWhite(cs)) continue;

      if (!fallbackAny) fallbackAny = a;
      const decorated =
        parseFloat(cs.borderRadius) >= 2 ||
        cs.boxShadow !== 'none' ||
        parseFloat(cs.borderTopWidth) > 0 ||
        parseFloat(cs.borderBottomWidth) > 0;
      if (!decorated) continue;

      if (!fallback) fallback = a;
      if (solLeaf && !a.contains(solLeaf)) continue;
      return a; // deepest decorated white ancestor holding header + solution
    }
    return fallback || fallbackAny;
  }

  function findCard() {
    return findCardExact() || findCardHeuristic();
  }

  // -------------------------------------------------------------- metadata

  /** WRONG / CORRECT / null.
   *  Exact: DeltaMath puts a Font Awesome icon in .problem-header-symbol
   *  (fa-check = correct, fa-times = wrong). Fallbacks: color sniffing. */
  function detectResult(card) {
    try {
      const icon = card.querySelector(SEL_RESULT_ICON);
      if (icon) {
        const c = (typeof icon.className === 'string' ? icon.className : (icon.className && icon.className.baseVal) || '').toLowerCase();
        if (/\bfa-(times|close|remove|ban)\b|fa-times-circle|fa-xmark/.test(c)) return 'WRONG';
        if (/\bfa-(check|done|ok)\b|fa-check-circle/.test(c)) return 'CORRECT';
      }
      for (const el of card.querySelectorAll('[class]')) {
        const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
        const t = cls.toLowerCase().replace(/[^a-z]+/g, ' ');
        if (/(^| )(wrong|incorrect|failed?)( |$)/.test(t)) return 'WRONG';
        if (/(^| )(correct|success|passed?)( |$)/.test(t)) return 'CORRECT';
      }
      for (const el of card.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24 || r.width > 220 || r.height > 220) continue;
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
          const inner = el.querySelector('path, polygon, circle, rect, use') || el;
          const cs = getComputedStyle(inner);
          const col = parseRgba(cs.fill !== 'none' && cs.fill ? cs.fill : cs.stroke);
          if (isRed(col)) return 'WRONG';
          if (isGreen(col)) return 'CORRECT';
        } else {
          const txt = el.firstElementChild ? '' : (el.textContent || '').trim();
          if (txt) {
            const colored = parseRgba(getComputedStyle(el).color);
            const check = colored && (/^[✗✖✕x×]{1,2}$/i.test(txt) || /^[✓✔√]{1,2}$/.test(txt));
            if (check) {
              if (isRed(colored)) return 'WRONG';
              if (isGreen(colored)) return 'CORRECT';
            }
          } else {
            // big solid block that looks like an icon (e.g. stacked red bars)
            const block = parseRgba(getComputedStyle(el).backgroundColor);
            if (block && Math.abs(r.width - r.height) < Math.max(r.width, r.height) * 0.6) {
              if (isRed(block)) return 'WRONG';
              if (isGreen(block)) return 'CORRECT';
            }
          }
        }
      }
      for (const img of card.querySelectorAll('img')) {
        const src = (img.currentSrc || img.src || '').toLowerCase();
        if (/(wrong|incorrect|cross)/.test(src)) return 'WRONG';
        if (/(correct|green|success)/.test(src)) return 'CORRECT';
      }
    } catch (err) {
      // best-effort only: a filename without the result token is fine
    }
    return null;
  }

  function sanitize(s, max = 48) {
    s = (s || '').replace(/[^A-Za-z0-9 ()-]+/g, '').replace(/[()-]+/g, '').trim().replace(/\s+/g, '');
    return s.slice(0, max);
  }

  /** "Oct 31, 1:08:29 PM" -> "Oct31_0108pm"; falls back to now(). */
  function datePart(txt) {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    if (txt) {
      const m = txt.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})/i);
      const t = txt.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
      if (m) {
        const mon = MONTHS(m[1].slice(0, 3).toLowerCase());
        const day = String(+m[2]);
        let time = '';
        if (t) {
          let hh = +t[1] % 12;
          if ((t[3] || '').toLowerCase() === 'pm') hh += 12;
          time = `${pad(hh)}${t[2]}`;
        }
        if (mon) return `${mon}${day}${time ? '_' + time : ''}`;
      }
    }
    const time12 = () => {
      let h = now.getHours() % 12;
      if (h === 0) h = 12;
      return `${pad(h)}${pad(now.getMinutes())}`;
    };
    return `${pad(now.getMonth() + 1)}${pad(now.getDate())}_${time12()}`;
  }

  /** Header lines of the card: student, skill, date, "Solved in …". */
  function headerLines(card) {
    const info = card.querySelector(SEL_HEADER_INFO) || card;
    return (info.innerText || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Auto filename from the card header: name, skill, date, result. */
  function buildFilename(card) {
    const lines = headerLines(card);
    const dateLine = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(lines[2] || '') ? lines[2] : null;

    const parts = [
      'DeltaMath',
      sanitize(lines[0]) || 'student',
      sanitize(lines[1]),
      datePart(dateLine),
      detectResult(card),
    ].filter(Boolean);
    return parts.join('_') + '.png';
  }

  // ------------------------------------------------------------- capture

  /** Render the card to a TRUE raster PNG:
   *  capture -> explicit-size canvas -> canvas.toBlob('image/png').
   *  (SnapDOM's plain toBlob() defaults to its SVG artifact on the default
   *  engine, which produces an XML file — never use it blindly.) */
  async function captureCard(card) {
    if (!window.snapdom || typeof window.snapdom.toCanvas !== 'function') {
      throw new Error('SnapDOM renderer not available');
    }
    const rect = card.getBoundingClientRect();
    const cssW = Math.max(50, Math.round(rect.width));
    const cssH = Math.max(50, Math.round(rect.height));
    const targetW = Math.min(cssW * EXPORT_SCALE, 8000);
    const targetH = Math.max(1, Math.round(targetW * cssH / cssW));

    const raster = await window.snapdom.toCanvas(card, {
      width: targetW, // absolute output size wins over scale/dpr semantics
      backgroundColor: '#ffffff',
      embedFonts: 'auto',
    });

    let out = raster;
    if (raster.width !== targetW || Math.abs(raster.height - targetH) > Math.max(2, targetH * 0.01)) {
      // Belt & braces: normalize onto our own canvas if the exporter deviated.
      out = document.createElement('canvas');
      out.width = targetW;
      out.height = targetH;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(raster, 0, 0, out.width, out.height);
    }

    const blob = await new Promise((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
    return blob;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 8000);
  }

  // ------------------------------------------------------------- buttons

  function buildButton(id, label, icon, prevBtn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = `${prevBtn.className || ''} deltacapture-btn`.trim();
    b.innerHTML = `${icon}<span class="deltacapture-label">${label}</span>`;
    b.disabled = false;
    b.title = id === PNG_BTN_ID
      ? 'Download this problem card as a high-res (3x) PNG'
      : 'Copy this problem card as an image to the clipboard';
    return b;
  }

  /** "◀ Prev" -> "Prev" (strips common arrow glyphs). */
  const ARROW_PREFIX = /^[\u25c0\u2b05\u2190\u2039\u203a<>\-\u2014]+\s*/u;
  const stripArrows = (t) => (t || '').trim().replace(ARROW_PREFIX, '');

  function findPrevButton() {
    // Real controls first (fast path).
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (/^prev(ious)?$/i.test(stripArrows(el.textContent))) return el;
    }
    // Any element whose whole text is the label (DeltaMath may use clickable divs);
    // promote to the outermost pure-label wrapper so we insert beside, not inside.
    for (const el of document.querySelectorAll('div, span, li')) {
      if (!/^prev(ious)?$/i.test(stripArrows(el.textContent))) continue;
      let top = el;
      while (top.parentElement &&
             stripArrows(top.parentElement.textContent) === stripArrows(el.textContent)) {
        top = top.parentElement;
      }
      let ctrl = top;
      for (let up = top.parentElement; up && up !== document.body; up = up.parentElement) {
        if (up.tagName === 'BUTTON' || up.tagName === 'A' ||
            (up.getAttribute && up.getAttribute('role') === 'button')) { ctrl = up; break; }
        if ((up.textContent || '').includes('Next')) break; // reached the row
      }
      return ctrl;
    }
    // Last resort: accessibility attributes.
    return document.querySelector('[aria-label*="Prev" i], [title*="Prev" i]');
  }

  function removeButtons() {
    for (const id of [PNG_BTN_ID, COPY_BTN_ID]) {
      const b = document.getElementById(id);
      if (b) b.remove();
    }
  }

  function ensureButtons(prevBtn) {
    removeButtons();
    const png = buildButton(PNG_BTN_ID, 'PNG', ICON_DOWNLOAD, prevBtn);
    const copy = buildButton(COPY_BTN_ID, 'Copy', ICON_COPY, prevBtn);
    png.addEventListener('click', onDownload);
    copy.addEventListener('click', onCopy);
    prevBtn.before(png);   // visual order ends up: [Copy] [PNG] [◀ Prev] ...
    prevBtn.before(copy);
  }

  // ------------------------------------------------------------ actions

  function setBusy(busy) {
    for (const id of [PNG_BTN_ID, COPY_BTN_ID]) {
      const b = document.getElementById(id);
      if (b) b.classList.toggle('deltacapture-busy', busy);
    }
  }

  async function onDownload() {
    const card = findCard();
    if (!card) return toast('No problem card found', false);
    setBusy(true);
    try {
      const blob = await captureCard(card);
      downloadBlob(blob, buildFilename(card));
      toast('PNG saved');
    } catch (err) {
      console.error('[DeltaCapture] capture failed:', err);
      toast('Capture failed — see console (F12)', false);
    } finally {
      setBusy(false);
    }
  }

  function onCopy() {
    const card = findCard();
    if (!card) return toast('No problem card found', false);
    setBusy(true);
    // Hand the clipboard a *promise* for the blob: the user-activation window
    // stays open while SnapDOM renders the card asynchronously.
    let blobPromise;
    try {
      blobPromise = captureCard(card);
      const item = new ClipboardItem({ 'image/png': blobPromise });
      navigator.clipboard.write([item]).then(() => {
        toast('Copied to clipboard');
      }).catch((err) => {
        console.error('[DeltaCapture] clipboard write failed:', err);
        // Clipboard blocked or promise rejected -> fall back to a download.
        blobPromise.then((b) => {
          downloadBlob(b, buildFilename(card));
          toast('Clipboard blocked — PNG saved instead', true);
        }).catch((err2) => {
          console.error('[DeltaCapture] capture failed:', err2);
          toast('Capture failed — see console (F12)', false);
        });
      });
      blobPromise.catch(() => {}); // never leave an unhandled rejection
    } catch (err) {
      console.error('[DeltaCapture] clipboard unavailable:', err);
      blobPromise.then((b) => {
        downloadBlob(b, buildFilename(card));
        toast('Saved as PNG instead', true);
      }).catch(() => toast('Capture failed — see console (F12)', false));
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------- wiring

  let lastCard = null;
  let announced = '';

  /** Log a state change once (until the state changes again). */
  function diag(key, msg) {
    if (announced === key) return;
    announced = key;
    console.info('[DeltaCapture]', msg);
  }

  function sync() {
    if (!location.pathname.startsWith(ROUTE_PREFIX)) {
      lastCard = null;
      removeButtons();
      return;
    }
    // Fast path: buttons present and previously found card still looks valid.
    if (document.getElementById(PNG_BTN_ID) && lastCard && lastCard.isConnected &&
        RESULT_RE.test(lastCard.textContent || '')) {
      return;
    }
    const card = findCard();
    lastCard = card;
    if (!card) {
      removeButtons();
      diag('no-card', 'waiting for a problem card…');
      return;
    }
    const prev = findPrevButton();
    if (prev) {
      ensureButtons(prev);
      diag('ok', 'buttons injected beside "Prev"');
    } else {
      diag('no-prev', 'problem card found, but no "Prev" control detected — buttons skipped');
    }
  }

  const schedule = debounce(sync, 150);

  function start() {
    console.info('[DeltaCapture] ready on', location.href);
    try {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: false,
      });
    } catch (err) {
      console.error('[DeltaCapture] observer failed:', err);
    }
    sync();
  }

  start();
})();
