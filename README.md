# DeltaCapture

Manifest V3) that adds a one-click capture to DeltaMath's
teacher **Student Data → Problem Logs** page.

It injects two small buttons to the left of the pagination `◀ Prev` button:

| Button | Action |
|--------|--------|
| **Copy** | Copies the whole problem card to the clipboard as an image — paste straight into a doc/email. |
| **PNG** | Downloads the card as a crisp **3× true raster PNG** with an auto-generated filename. |

Everything happens **locally in your browser** — nothing is transmitted, stored, or collected.

## What gets captured

The entire white problem card: student name, skill, date, solve time, the ✓/✗
result icon, the problem + diagram, DeltaMath's explanation, and the
"Your Solution" section. Card bounds only — no page chrome, no shadows,
white background. Output is a genuine raster PNG encoded in-page
(`canvas.toBlob('image/png')`) — safe for all converters (PNG→PDF, etc.).
The render size is set explicitly (`width`), so it's the same on any monitor.

## Filenames

```
DeltaMath_<Student>_<Skill>_<MonDD_time>_<WRONG|CORRECT>.png
```

Example: `DeltaMath_AnindyqZarairsan_IntrotoRatiosLevel1_Oct31_0108pm_WRONG.png`

Derived from the card header at capture time. If the result icon can't be
detected, the token is simply omitted. Unparseable dates fall back to "now".

## Install (unpackaged — free, no account)

1. Download/clone this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Open a student log page:
   `https://www.deltamath.com/app/teacher/student-logs/<id>` —
   the **Copy / PNG** buttons appear left of `◀ Prev`.

The buttons stay put as you page through students with Prev/Next (it's a SPA —
a MutationObserver re-checks after DOM changes and only shows buttons when a
problem card is on screen).

## How it works

- `content.js` finds the card with DeltaMath's own stable classes —
  `problem-page#problem_page .paper-shadow`, result icon
  `.problem-header-symbol .fa` (`fa-check`/`fa-times`), and
  `.yoursolution-label` — with a generic visual fallback (white rounded
  ancestor of the "Solved in …" line) if those classes ever change.
- Rendering is done by [SnapDOM](https://github.com/zumer/snapdom)
  (MIT, bundled in `vendor/snapdom.js`) — a DOM-to-image renderer that embeds
  web fonts, inline SVG, and canvas drawings.
- Download uses a plain `<a download>` and the clipboard uses the async
  Clipboard API with a promise-backed `ClipboardItem` (keeps the user-activation
  window open while the card renders). **No permissions are required** beyond
  the content-script site match.
- If the clipboard write is blocked, the PNG is downloaded instead and a toast
  tells you so.

## Layout changes on DeltaMath's side

The card finder uses generic visual signals (white background, border radius /
box shadow, header + solution text), so minor redesigns shouldn't break it.
If the buttons ever stop appearing: open DevTools (F12) and check for
`[DeltaCapture]` console messages — the likely fix is a one-line tweak to
`findCard()` / `findPrevButton()`.

## Store-ready packaging

```
Compress-Archive -Path manifest.json, content.js, ui.css, vendor, icons `
                 -DestinationPath dist\DeltaCapture-0.1.0.zip
```

Publishing needs a one-time **$5** Chrome Web Store developer fee
([dashboard](https://chrome.google.com/webstore/devconsole)). For review:

- Privacy fields: the extension processes page content **locally only**;
  it collects/transmits nothing.
- Trader status: choose **non-trader** for an unpaid/hobby distribution.
- Note: names and problem content are rendered into the images you capture —
  be mindful of student privacy when sharing screenshots.

## Regenerating icons

```
powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
```

## Project layout

```
manifest.json         # MV3 manifest; content script on deltamath student-logs
content.js            # card detection, button injection, capture + clipboard/download
ui.css                # button glue styles + toasts
vendor/snapdom.js     # SnapDOM 3.7.0 (MIT) bundled build; exposes window.snapdom
icons/                # generated store + toolbar icons
scripts/make-icons.ps1
```
