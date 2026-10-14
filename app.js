(() => {
  "use strict";

  // The app version is the ?v= number on this script's <script> tag in
  // index.html, so there is one place to bump it. It's also used to fetch
  // tracer.py without a stale cached copy, and shown in the footer.
  const APP_VERSION = (() => {
    try { return new URL(document.currentScript.src).searchParams.get("v") || "dev"; } catch (_) { return "dev"; }
  })();
  const PYODIDE_VERSION = "314.0.7";
  const params = new URLSearchParams(location.search);
  const INDEX_URL = params.get("pyodide") || `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;
  const RERUN_DELAY_MS = 600;   // wait this long after typing stops before re-running

  const $ = (id) => document.getElementById(id);
  const editor = $("editor"), examplesSel = $("examples"), hideDefsBox = $("hide-defs");

  let traceFn = null;
  let restoreStep = true;
  let result = null;           // last successful trace
  let stepIndex = 0;
  let layout = null;           // { pos: Map(id -> {r, c}), key: Map(id -> stable key) }
  let codeError = null;        // syntax error in the code as typed now (old drawing stays up)
  let ranCode = null;          // the code `result` came from
  // Boxes the user dragged, keyed by creation order ("3rd object made"), not by
  // memory id, so a moved box stays put when the code is edited and re-run.
  const moved = new Map();     // key -> {x, y}
  // "labels": variables appear as name tags on the box they point to (fewer arrows).
  // "arrows": every variable draws an arrow, like Python Tutor.
  // Per-variable colours chosen by the user, saved per program (keyed by a hash
  // of the code) in this browser, so they survive a refresh.
  //   colors["zipper_lists|tail"] = { line: "#1c7ed6", border: "#d6336c" }
  let colors = {};
  let colorsKey = null;
  const COLOR_PREFIX = "dsaviz-colors:", COLOR_INDEX = "dsaviz-colors-index", MAX_SAVED = 60;
  const codeKey = (code) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  };
  function loadColors(key) {
    try { return JSON.parse(localStorage.getItem(COLOR_PREFIX + key) || "null"); } catch (_) { return null; }
  }
  function saveColors() {
    if (!colorsKey) return;
    try {
      const empty = Object.keys(colors).length === 0;
      if (empty) localStorage.removeItem(COLOR_PREFIX + colorsKey);
      else localStorage.setItem(COLOR_PREFIX + colorsKey, JSON.stringify(colors));
      // keep a short most-recently-used list so old programs don't pile up forever
      let idx = [];
      try { idx = JSON.parse(localStorage.getItem(COLOR_INDEX) || "[]"); } catch (_) {}
      idx = idx.filter((k) => k !== colorsKey);
      if (!empty) idx.unshift(colorsKey);
      idx.slice(MAX_SAVED).forEach((k) => localStorage.removeItem(COLOR_PREFIX + k));
      localStorage.setItem(COLOR_INDEX, JSON.stringify(idx.slice(0, MAX_SAVED)));
    } catch (_) {}
  }
  // Called whenever a new version of the code runs. Editing a program carries its
  // colours along; switching to a program that has its own saved colours loads them.
  function useColorsFor(code, { carry }) {
    const key = codeKey(code);
    if (key === colorsKey) return;
    const saved = loadColors(key);
    if (saved) colors = saved;
    else if (!carry) colors = {};
    colorsKey = key;
    if (!saved && Object.keys(colors).length) saveColors();
  }
  const colorFor = (frameName, name) => colors[`${frameName}|${name}`] || null;

  let arrowStyle = "smart";
  try { arrowStyle = localStorage.getItem("dsaviz-arrows") || "smart"; } catch (_) {}
  let pointerMode = "labels";
  try { pointerMode = localStorage.getItem("dsaviz-pointers") || "labels"; } catch (_) {}

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const b64encode = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

  // ---------- editor ----------
  const LINE_H = 21, PAD = 12;   // must match --lh / --pad in style.css

  function lineCount() { return editor.value.split("\n").length; }

  function paintEditor() {
    const n = lineCount();
    const step = result && !$("viz").hidden ? result.steps[stepIndex] : null;
    const prev = step && stepIndex > 0 ? result.steps[stepIndex - 1] : null;
    const isLast = result && stepIndex === result.steps.length - 1;
    const errLine = codeError ? codeError.line : (isLast && result.error ? result.error.line : null);
    const cls = (i) => {
      if (i === errLine) return "error";
      if (step && i === step.line) return "next";
      if (prev && i === prev.line) return "prev";
      return "";
    };
    let g = "", h = "";
    for (let i = 1; i <= n; i++) {
      const c = cls(i);
      const mark = c === "next" || c === "prev" ? "➜" : c === "error" ? "✕" : "";
      g += `<div class="gl ${c}"><span class="mark">${mark}</span><span class="num">${i}</span></div>`;
      if (c) h += `<div class="hl-line ${c}" style="top:${PAD + (i - 1) * LINE_H}px"></div>`;
    }
    $("gutter").innerHTML = `<div class="gutter-inner">${g}</div>`;
    $("hl").innerHTML = h;
    syncScroll();
  }

  function syncScroll() {
    const gi = $("gutter").firstElementChild;
    if (gi) gi.style.transform = `translateY(${-editor.scrollTop}px)`;
    $("hl").style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
  }
  editor.addEventListener("scroll", syncScroll);

  function scrollLineIntoView(line) {
    const top = PAD + (line - 1) * LINE_H;
    const view = editor.clientHeight;
    if (top < editor.scrollTop + LINE_H || top > editor.scrollTop + view - 3 * LINE_H) {
      editor.scrollTop = Math.max(0, top - view / 3);
    }
  }

  let rerunTimer = null;
  editor.addEventListener("input", () => {
    examplesSel.value = "custom";
    paintEditor();
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => run({ keepStep: true }), RERUN_DELAY_MS);
  });
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = editor;
      editor.value = value.slice(0, a) + "  " + value.slice(b);
      editor.selectionStart = editor.selectionEnd = a + 2;
      editor.dispatchEvent(new Event("input"));
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      clearTimeout(rerunTimer);
      run({ keepStep: true });
    }
  });

  // ---------- examples & share links ----------
  const examples = window.DSAVIZ_EXAMPLES || [];
  examples.forEach((ex, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = ex.name;
    examplesSel.appendChild(o);
  });
  const custom = document.createElement("option");
  custom.value = "custom"; custom.textContent = "Your code";
  examplesSel.appendChild(custom);
  examplesSel.addEventListener("change", () => {
    if (examplesSel.value === "custom") return;
    editor.value = examples[Number(examplesSel.value)].code;
    editor.scrollTop = 0;
    moved.clear();
    useColorsFor(editor.value, { carry: false });
    run({ keepStep: false });
  });

  $("share").addEventListener("click", (e) => {
    const url = `${location.origin}${location.pathname}#code=${b64encode(editor.value)}`;
    history.replaceState(null, "", url);
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    const btn = e.target, old = btn.textContent;
    btn.textContent = "Link copied";
    setTimeout(() => { btn.textContent = old; }, 1500);
  });

  const hashMatch = location.hash.match(/code=([^&]+)/);
  if (hashMatch) {
    try { editor.value = b64decode(hashMatch[1]); examplesSel.value = "custom"; }
    catch (_) { editor.value = examples[0].code; examplesSel.value = "0"; }
  } else {
    let last = null;
    try { last = localStorage.getItem("dsaviz-last-code"); } catch (_) {}
    const i = last == null ? 0 : examples.findIndex((ex) => ex.code === last);
    if (last != null && i < 0) { editor.value = last; examplesSel.value = "custom"; }
    else if (examples.length) { editor.value = examples[Math.max(0, i)].code; examplesSel.value = String(Math.max(0, i)); }
  }
  useColorsFor(editor.value, { carry: false });
  $("viz").hidden = true;
  $("app-version").textContent = `dsaviz v${APP_VERSION}`;
  paintEditor();

  // ---------- Pyodide ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  async function boot() {
    try {
      await loadScript(INDEX_URL + "pyodide.js");
      const pyodide = await window.loadPyodide({ indexURL: INDEX_URL });
      const src = await (await fetch(`tracer.py?v=${APP_VERSION}`)).text();
      const ns = pyodide.globals.get("dict")();
      ns.set("__name__", "dsaviz_tracer");
      pyodide.runPython(src, { globals: ns });
      traceFn = ns.get("trace");
      run({ keepStep: false });
    } catch (err) {
      $("placeholder").innerHTML = `Python failed to load.<br><span class="muted">${esc(err.message || err)}</span>`;
    }
  }

  // ---------- run ----------
  function showBanner(kind, text) {
    const b = $("banner");
    if (!kind) { b.hidden = true; return; }
    b.hidden = false; b.className = "banner " + kind; b.textContent = text;
  }
  const errText = (e) => `${e.type}: ${e.message}${e.line ? ` (line ${e.line})` : ""}`;

  function run({ keepStep }) {
    if (!traceFn) return;
    const code = editor.value;
    if (code === ranCode && result) return;
    let r;
    try {
      r = JSON.parse(traceFn(code));
    } catch (err) {
      showBanner("error", "Tracer error: " + err.message);
      return;
    }
    if (!r.steps.length) {
      // Usually a syntax error while typing: keep the last drawing, flag the line.
      codeError = r.error;
      if (!result) {
        $("placeholder").hidden = false;
        $("placeholder").innerHTML = r.error ? esc(errText(r.error)) : "Write some code and it will be drawn here.";
      }
      showBanner(r.error ? "error" : null, r.error ? errText(r.error) + (result ? ". Showing the last version that ran." : "") : "");
      paintEditor();
      return;
    }
    codeError = null;
    const sameShape = result && keepStep;
    const oldIndex = stepIndex;
    result = r;
    ranCode = code;
    useColorsFor(code, { carry: true });
    try { localStorage.setItem("dsaviz-last-code", code); } catch (_) {}
    layout = null;
    stepIndex = sameShape ? Math.min(oldIndex, r.steps.length - 1) : 0;
    // First run after the page loads: go back to the step you were on before a
    // refresh, if it's the same code. (Just a number in localStorage, so cheap.)
    if (restoreStep) {
      restoreStep = false;
      try {
        const saved = JSON.parse(localStorage.getItem("dsaviz-last-step") || "null");
        if (saved && saved.code === codeKey(code)) stepIndex = Math.min(Math.max(0, saved.step | 0), r.steps.length - 1);
      } catch (_) {}
    }
    $("slider").max = String(r.steps.length - 1);
    $("placeholder").hidden = true;
    $("viz").hidden = false;
    render({ scroll: !keepStep || stepIndex > 0 });
    reserveCaptionHeight();
  }

  // ---------- stepping ----------
  function go(i) {
    if (!result) return;
    stepIndex = Math.max(0, Math.min(result.steps.length - 1, i));
    render({ scroll: true });
  }
  $("first").addEventListener("click", () => go(0));
  $("prev").addEventListener("click", () => go(stepIndex - 1));
  $("next").addEventListener("click", () => go(stepIndex + 1));
  $("last").addEventListener("click", () => go(Infinity));
  $("slider").addEventListener("input", (e) => go(Number(e.target.value)));
  document.addEventListener("keydown", (e) => {
    if (e.target === editor || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight") { e.preventDefault(); go(stepIndex + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(stepIndex - 1); }
  });
  function setMode(m) {
    pointerMode = m;
    try { localStorage.setItem("dsaviz-pointers", m); } catch (_) {}
    $("mode-labels").classList.toggle("on", m === "labels");
    $("mode-arrows").classList.toggle("on", m === "arrows");
    $("mode-labels").setAttribute("aria-pressed", String(m === "labels"));
    $("mode-arrows").setAttribute("aria-pressed", String(m === "arrows"));
    if (result) render({});
  }
  const smartBox = $("smart-arrows");
  smartBox.checked = arrowStyle === "smart";
  smartBox.addEventListener("change", () => {
    arrowStyle = smartBox.checked ? "smart" : "classic";
    try { localStorage.setItem("dsaviz-arrows", arrowStyle); } catch (_) {}
    if (result) drawArrows();
  });
  $("mode-labels").addEventListener("click", () => setMode("labels"));
  $("mode-arrows").addEventListener("click", () => setMode("arrows"));
  setMode(pointerMode);
  hideDefsBox.addEventListener("change", () => { if (result) { layout = null; render({}); } });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (result) drawArrows();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { reserveCaptionHeight(); keepFloatOnScreen(); }, 150);
  });

  // ---------- caption box: steady height, and floating ----------
  // The explanation can be 1 to several lines. To stop the drawing below it from
  // jumping as you step, every step's caption is measured once per run (off
  // screen, at the box's current width) and the box keeps the tallest height.
  function reserveCaptionHeight() {
    const box = $("changes");
    if (!result || $("changes-box").classList.contains("floating")) { box.style.minHeight = ""; return; }
    const m = document.createElement("div");
    m.className = "changes changes-measure";
    m.style.width = box.clientWidth + "px";
    document.body.appendChild(m);
    let tallest = 0;
    for (let i = 0; i < result.steps.length; i++) {
      const prev = i > 0 ? result.steps[i - 1] : null, cur = result.steps[i];
      m.innerHTML = captionHTML(prev, cur, diffSteps(prev, cur));
      tallest = Math.max(tallest, m.offsetHeight);
    }
    m.remove();
    box.style.minHeight = tallest + "px";
  }

  const FLOAT_KEY = "dsaviz-caption-float";
  function floatState() { try { return JSON.parse(localStorage.getItem(FLOAT_KEY) || "null"); } catch (_) { return null; } }
  function saveFloat(st) { try { localStorage.setItem(FLOAT_KEY, JSON.stringify(st)); } catch (_) {} }
  function keepFloatOnScreen() {
    const b = $("changes-box");
    if (!b.classList.contains("floating")) return;
    const w = b.offsetWidth, h = b.offsetHeight;
    const x = Math.min(Math.max(0, b.offsetLeft), Math.max(0, window.innerWidth - w));
    const y = Math.min(Math.max(0, b.offsetTop), Math.max(0, window.innerHeight - Math.min(h, 60)));
    b.style.left = x + "px"; b.style.top = y + "px";
  }
  function setFloating(on, st) {
    const b = $("changes-box");
    b.classList.toggle("floating", on);
    $("float-btn").textContent = on ? "Dock ⤓" : "Float ⧉";
    $("float-btn").title = on ? "Put this panel back above the drawing" : "Float this panel so you can move it anywhere";
    if (on) {
      const r = b.getBoundingClientRect();
      const s = st || { x: Math.max(8, window.innerWidth - 400), y: Math.max(8, r.top), w: 380, h: null };
      b.style.left = s.x + "px"; b.style.top = s.y + "px"; b.style.width = (s.w || 380) + "px";
      b.style.height = s.h ? s.h + "px" : "";
      keepFloatOnScreen();
      saveFloat({ on: true, x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: s.h || null });
    } else {
      b.style.left = b.style.top = b.style.width = b.style.height = "";
      const old = floatState();
      saveFloat({ ...(old || {}), on: false });
    }
    reserveCaptionHeight();
    if (result) drawArrows();
  }
  $("float-btn").addEventListener("click", () => {
    const on = !$("changes-box").classList.contains("floating");
    const old = floatState();
    setFloating(on, on && old && old.x != null ? old : null);
  });
  (function enableFloatDrag() {
    const b = $("changes-box"), head = $("changes-head");
    let d = null;
    head.addEventListener("pointerdown", (e) => {
      if (!b.classList.contains("floating") || e.target.closest("button")) return;
      e.preventDefault();
      d = { px: e.clientX, py: e.clientY, x: b.offsetLeft, y: b.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", (e) => {
      if (!d) return;
      b.style.left = d.x + e.clientX - d.px + "px";
      b.style.top = d.y + e.clientY - d.py + "px";
      keepFloatOnScreen();
    });
    const end = () => {
      if (!d) return;
      d = null;
      saveFloat({ on: true, x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.style.height ? b.offsetHeight : null });
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
    // remember a resize from the corner handle
    if (window.ResizeObserver) {
      let t = null;
      new ResizeObserver(() => {
        if (!b.classList.contains("floating")) return;
        clearTimeout(t);
        t = setTimeout(() => saveFloat({ on: true, x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight }), 200);
      }).observe(b);
    }
    const st = floatState();
    if (st && st.on) setFloating(true, st);
  })();

  // ---------- values ----------
  function isHidden(heap, id) {
    if (!hideDefsBox.checked) return false;
    const o = heap[id];
    return o && (o.type === "function" || o.type === "class" || o.type === "module");
  }

  // A short, human name for an object, used in labels and captions: Node 'x', list[3], dict.
  // Lists and dicts read better by the variable that holds them ("nums[3]").
  function varNameFor(step, id) {
    if (!step) return null;
    for (let i = step.frames.length - 1; i >= 0; i--) {
      const hit = step.frames[i].vars.find(([, v]) => v[0] === "ref" && v[1] === id);
      if (hit) return hit[0];
    }
    return null;
  }

  function shortName(heap, id, step) {
    const o = heap && heap[id];
    if (!o) return "an object";
    if (o.type === "instance") {
      for (const k of ["val", "value", "data", "name", "key"]) {
        const a = o.attrs.find(([n]) => n === k);
        if (a && a[1][0] === "prim") return `${o.cls} ${a[1][1]}`;
      }
      return o.cls;
    }
    if (o.type === "function" || o.type === "class" || o.type === "module") return `${o.type} ${o.name}`;
    if (o.items) return varNameFor(step, id) || pathName(heap, id, step, 0) || `${o.type} of ${o.items.length + (o.more || 0)}`;
    return o.cls || "object";
  }

  // An unnamed list inside a named one reads as "grid[0]".
  function pathName(heap, id, step, depth) {
    if (depth > 3) return null;
    for (const [pid, p] of Object.entries(heap)) {
      if (!p || pid === id) continue;
      let slot = null;
      if (p.type === "instance") { const a = p.attrs.find(([, v]) => v[0] === "ref" && v[1] === id); if (a) slot = "." + a[0]; }
      else if (p.type === "dict") { const a = p.items.find(([, v]) => v[0] === "ref" && v[1] === id); if (a) slot = `[${a[0][1]}]`; }
      else if (p.items) { const i = p.items.findIndex((v) => v[0] === "ref" && v[1] === id); if (i >= 0) slot = `[${i}]`; }
      if (slot === null) continue;
      const base = varNameFor(step, pid) || (p.type === "instance" ? shortName(heap, pid, step) : pathName(heap, pid, step, depth + 1));
      if (base) return base + slot;
    }
    return null;
  }

  function describe(v, heap, step) {
    if (!v) return "nothing";
    return v[0] === "prim" ? v[1] : shortName(heap, v[1], step);
  }

  // opts: { changed: bool, was: old encoded value, frame: bool }
  function valueHTML(v, heap, opts = {}) {
    const was = opts.was && opts.was[0] === "ref" && !(v[0] === "ref" && v[1] === opts.was[1]) ? opts.was[1] : null;
    const wasAttr = was ? ` data-was="${was}"` : "";
    if (v[0] === "prim") {
      return `<span class="val">${esc(v[1])}</span>${was ? `<span class="anchor"${wasAttr}></span>` : ""}`;
    }
    const id = v[1];
    if (isHidden(heap, id)) {
      const o = heap[id];
      return `<span class="val muted">${o.type === "class" ? "class" : "function"} ${esc(o.name)}</span>`;
    }
    const line = opts.color && opts.color.line;
    if (opts.frame && pointerMode === "labels" && heap[id]) {
      return `<span class="chip${opts.changed ? " changed" : ""}"${line ? ` style="color:${line}"` : ""}>→ ${esc(shortName(heap, id))}</span>`;
    }
    return `<span class="ptr${opts.frame ? " fptr" : ""}" data-ref="${id}"${opts.changed ? ' data-changed="1"' : ""}${line ? ` data-color="${line}"` : ""}${wasAttr}><span class="dot"${line ? ` style="background:${line}"` : ""}></span></span>`;
  }

  function childRefs(o) {
    const out = [];
    const add = (v) => { if (v && v[0] === "ref") out.push(v[1]); };
    if (!o) return out;
    if (o.type === "instance") o.attrs.forEach(([, v]) => add(v));
    else if (o.type === "dict") o.items.forEach(([k, v]) => { add(k); add(v); });
    else if (o.items) o.items.forEach(add);
    return out;
  }

  // Each pointer-holding slot gets a stable key so two steps can be compared.
  const fieldKey = (id, o, i, k) => o.type === "instance" ? `${id}|.${k}` : o.type === "dict" ? `${id}|{${k}}` : `${id}|[${i}]`;
  const varKey = (f, name) => `${f.fid}|${name}`;

  function objectHTML(id, o, heap, diff, tags) {
    const cell = (key, v) => {
      const ch = diff && diff.changed.has(key);
      return { cls: ch ? " changed" : "", html: valueHTML(v, heap, { changed: ch, was: ch ? diff.old.get(key) : null }) };
    };
    let head = "", body = "";
    if (o.type === "instance") {
      head = o.cls;
      body = o.attrs.length
        ? `<table>${o.attrs.map(([k, v]) => { const c = cell(fieldKey(id, o, 0, k), v); return `<tr><td class="k">${esc(k)}</td><td class="v${c.cls}">${c.html}</td></tr>`; }).join("")}</table>`
        : `<div class="plain muted">no attributes</div>`;
    } else if (o.type === "dict") {
      head = "dict";
      const rows = o.items.map(([k, v]) => {
        const c = cell(fieldKey(id, o, 0, k[0] === "prim" ? k[1] : "?"), v);
        return `<tr><td class="k">${valueHTML(k, heap)}</td><td class="v${c.cls}">${c.html}</td></tr>`;
      }).join("");
      body = o.items.length ? `<table>${rows}</table>` : `<div class="plain muted">empty</div>`;
      if (o.more) body += `<div class="plain muted">+${o.more} more</div>`;
    } else if (o.items) {
      head = o.type;
      const showIdx = o.type === "list" || o.type === "tuple";
      const cells = o.items.map((v, i) => {
        const c = cell(fieldKey(id, o, i), v);
        return `<div class="cell${c.cls}">${showIdx ? `<span class="idx">${i}</span>` : ""}<span class="v">${c.html}</span></div>`;
      }).join("");
      body = o.items.length ? `<div class="cells">${cells}${o.more ? `<div class="cell"><span class="v muted">+${o.more}</span></div>` : ""}</div>`
                            : `<div class="cells muted">empty</div>`;
    } else if (o.type === "function") {
      head = "function"; body = `<div class="plain">${esc(o.name)}(…)</div>`;
    } else if (o.type === "class") {
      head = "class"; body = `<div class="plain">${esc(o.name)}</div>`;
    } else if (o.type === "module") {
      head = "module"; body = `<div class="plain">${esc(o.name)}</div>`;
    } else {
      head = o.cls || "object"; body = `<div class="plain">${esc(o.repr || "")}</div>`;
    }
    const tagHTML = tags && tags.length
      ? `<div class="tags">${tags.map((t) => `<span class="ptag${t.local ? " local" : ""}${t.changed ? " changed" : ""}" data-frame="${esc(t.frame)}" data-var="${esc(t.name)}" title="${t.name === "return" ? "return value" : `variable in ${esc(t.frame)}, click to colour it`}"${tagStyle(t)}>${esc(t.name)}</span>`).join("")}</div>`
      : "";
    return `<div class="obj" data-id="${id}">${tagHTML}<div class="obj-head">${esc(head)}</div>${body}</div>`;
  }

  function tagStyle(t) {
    const c = t.color;
    if (!c) return "";
    const parts = [];
    if (t.changed && c.line) parts.push(`background:${c.line}`, `border-color:${c.line}`, "color:#fff");
    else if (c.line) parts.push(`color:${c.line}`, `border-color:${c.line}`);
    if (c.border) parts.push(`box-shadow:0 0 0 2px ${c.border}`);
    return parts.length ? ` style="${parts.join(";")}"` : "";
  }

  // ---------- what changed between two steps ----------
  function flatten(step) {
    const slots = new Map();
    step.frames.forEach((f) => f.vars.forEach(([name, v]) => slots.set("v:" + varKey(f, name), v)));
    for (const [id, o] of Object.entries(step.heap)) {
      if (!o) continue;
      if (o.type === "instance") o.attrs.forEach(([k, v]) => slots.set("f:" + fieldKey(id, o, 0, k), v));
      else if (o.type === "dict") o.items.forEach(([k, v]) => { if (k[0] === "prim") slots.set("f:" + fieldKey(id, o, 0, k[1]), v); });
      else if (o.items) o.items.forEach((v, i) => slots.set("f:" + fieldKey(id, o, i), v));
    }
    return slots;
  }
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

  function diffSteps(prev, cur) {
    const changed = new Set(), old = new Map(), list = [];
    if (!prev) return { changed, old, list };
    const a = flatten(prev), b = flatten(cur);
    for (const [k, v] of b) {
      const before = a.get(k);
      if (same(before, v)) continue;
      // a variable that only exists because a function was just called isn't a "change"
      if (k.startsWith("v:")) {
        const fid = Number(k.slice(2).split("|")[0]);
        if (!prev.frames.some((f) => f.fid === fid)) continue;
      } else {
        const id = k.slice(2).split("|")[0];
        if (!prev.heap[id]) continue;   // brand-new object, nothing to compare with
      }
      const key = k.slice(2);
      changed.add(key);
      if (before) old.set(key, before);
      list.push({ key, kind: k[0], before, after: v });
    }
    return { changed, old, list };
  }

  function captionHTML(prev, cur, diff) {
    if (!prev) return `<div class="ran">Start of the program.</div><div class="none">Press <b>Next</b> or → to run the first line.</div>`;
    const code = (ranCode || "").split("\n");
    const ranLine = prev.line;
    const src = (code[ranLine - 1] || "").trim();
    const out = [];
    const c = (s) => `<code>${esc(s)}</code>`;
    const ph = prev.heap, h = cur.heap;

    const prevIds = new Set(prev.frames.map((f) => f.fid)), curIds = new Set(cur.frames.map((f) => f.fid));
    const finished = prev.frames.filter((f) => !curIds.has(f.fid));
    const started = cur.frames.filter((f) => !prevIds.has(f.fid));
    finished.forEach((f) => out.push(`${c(f.name)} finished${f.returning ? ` and returned ${c(describe(f.returning, ph, prev))}` : ""}; its frame is gone.`));
    started.forEach((f) => {
      const args = f.vars.map(([n, v]) => `${n}=${describe(v, h, cur)}`).join(", ");
      out.push(`Called ${c(`${f.name}(${args})`)}. It gets its own frame.`);
    });
    if (cur.event === "return" && cur.frames.length > 1) {
      const f = cur.frames[cur.frames.length - 1];
      out.push(`${c(f.name)} is about to return ${c(describe(f.returning, h, cur))}.`);
    }

    for (const d of diff.list) {
      if (d.after && d.after[0] === "ref" && isHidden(h, d.after[1])) {
        const o = h[d.after[1]];
        if (!d.before && d.kind === "v") out.push(`Defined ${o.type} ${c(o.name)}.`);
        continue;
      }
      let name;
      if (d.kind === "v") name = d.key.split("|").slice(1).join("|");
      else {
        const [id, slot] = [d.key.split("|")[0], d.key.split("|").slice(1).join("|")];
        const base = shortName(h, id, cur);
        name = slot.startsWith(".") ? `${base}${slot}` : slot.startsWith("[") ? `${base}${slot}` : `${base}[${slot.slice(1, -1)}]`;
      }
      const isRef = (v) => v && v[0] === "ref";
      if (!d.before) {
        if (isRef(d.after)) {
          const o = h[d.after[1]];
          const what = o && o.items ? `a new ${o.type} of ${o.items.length + (o.more || 0)}` : describe(d.after, h, cur);
          // An existing collection already known by another name (aliasing). Only
          // look in frames that still exist, so a just-finished __init__'s `self`
          // doesn't count, and only for lists/dicts, which is where aliasing surprises.
          const live = { frames: prev.frames.filter((f) => cur.frames.some((g) => g.fid === f.fid) && f.vars.some(([n]) => n !== name)) };
          const target = o && o.items ? varNameFor(live, d.after[1]) : null;
          out.push(d.kind === "v"
            ? `New variable ${c(name)} points to ${target && target !== name ? c(target) + (o && o.items ? ` (the same ${o.type}, not a copy)` : "") : c(what)}.`
            : `${c(name)} now points to ${c(target || describe(d.after, h, cur))}.`);
        } else {
          out.push(`Set ${c(name + " = " + describe(d.after, h, cur))}.`);
        }
      } else if (isRef(d.after) || isRef(d.before)) {
        const was = isRef(d.before) ? describe(d.before, ph, prev) : d.before[1];
        out.push(isRef(d.after)
          ? `${c(name)} now points to ${c(describe(d.after, h, cur))} <span class="was">(was ${esc(was)})</span>.`
          : `${c(name)} is now ${c(d.after[1])} <span class="was">(was ${esc(was)})</span>.`);
      } else {
        out.push(`${c(name)} changed from ${c(d.before[1])} to ${c(d.after[1])}.`);
      }
    }

    for (const [id, o] of Object.entries(ph)) {
      if (!o || h[id] || (o.type !== "instance" && !o.items) || isHidden(ph, id)) continue;
      if (finished.length) continue;   // locals going away when a function returns isn't a surprise
      out.push(`<span class="lost">${c(shortName(ph, id, prev))} is lost: nothing points to it any more.</span>`);
    }
    if (cur.stdout.length > prev.stdout.length) out.push(`Printed ${c(cur.stdout.slice(prev.stdout.length).replace(/\n$/, ""))}.`);

    const MAX = 6;
    const shown = out.slice(0, MAX).map((s) => `<li>${s}</li>`).join("");
    const more = out.length > MAX ? `<li class="muted">…and ${out.length - MAX} more</li>` : "";
    return `<div class="ran">Ran line ${ranLine}: ${c(src)}</div>` +
      (out.length ? `<ul>${shown}${more}</ul>` : `<div class="none">No values changed. Python checked a condition or moved to the next line.</div>`);
  }

  // ---------- layout ----------
  // Every object gets one grid cell (row, column) for the whole run, so nothing
  // jumps around while you step. Positions come from a pre-pass over all steps:
  // an object's "parent" is the first object that ever pointed at it. Each
  // parent's first child sits to its right on the same row, so linked lists
  // read as horizontal chains; extra children (tree branches) start new rows.
  function computeLayout() {
    const types = new Map(), order = [], parent = new Map(), kids = new Map();
    const hidden = (id) => {
      const t = types.get(id);
      return hideDefsBox.checked && (t === "function" || t === "class" || t === "module");
    };
    for (const step of result.steps) {
      for (const [id, o] of Object.entries(step.heap)) {
        if (!o) continue;
        if (!types.has(id)) { types.set(id, o.type); order.push(id); }
      }
    }
    for (const step of result.steps) {
      for (const [id, o] of Object.entries(step.heap)) {
        if (!o || hidden(id)) continue;
        for (const ch of childRefs(o)) {
          if (ch === id || parent.has(ch) || hidden(ch) || !types.has(ch)) continue;
          parent.set(ch, id);
          if (!kids.has(id)) kids.set(id, []);
          kids.get(id).push(ch);
        }
      }
    }
    const pos = new Map(), taken = new Set();
    let rows = 0;
    const place = (id, r, c) => { pos.set(id, { r, c }); taken.add(r + "," + c); rows = Math.max(rows, r + 1); };
    function visit(id) {
      const here = pos.get(id);
      (kids.get(id) || []).forEach((ch, i) => {
        if (pos.has(ch)) return;
        if (i === 0 && !taken.has(here.r + "," + (here.c + 1))) place(ch, here.r, here.c + 1);
        else place(ch, rows, here.c + 1);
        visit(ch);
      });
    }
    const start = (id) => { if (!pos.has(id) && !hidden(id)) { place(id, rows, 0); visit(id); } };
    order.filter((id) => !parent.has(id)).forEach(start);
    order.forEach(start);   // anything left over sits on a cycle
    const key = new Map(order.map((id, i) => [id, "o" + i]));
    layout = { pos, key };
  }

  // ---------- render ----------
  function render({ scroll }) {
    const step = result.steps[stepIndex];
    const prev = stepIndex > 0 ? result.steps[stepIndex - 1] : null;
    const isLast = stepIndex === result.steps.length - 1;
    const heap = step.heap;
    const diff = diffSteps(prev, step);
    const labels = pointerMode === "labels";

    paintEditor();
    if (scroll) scrollLineIntoView(step.line);
    $("slider").value = String(stepIndex);
    try { localStorage.setItem("dsaviz-last-step", JSON.stringify({ code: codeKey(ranCode || ""), step: stepIndex })); } catch (_) {}
    $("step-label").textContent = `Step ${stepIndex + 1} of ${result.steps.length}${isLast ? (result.error ? " · error" : result.truncated ? "" : " · finished") : ""}`;
    $("first").disabled = $("prev").disabled = stepIndex === 0;
    $("next").disabled = $("last").disabled = isLast;
    $("stdout").textContent = step.stdout;
    $("changes").innerHTML = captionHTML(prev, step, diff);

    if (codeError) showBanner("error", errText(codeError) + ". Showing the last version that ran.");
    else if (isLast && result.error) showBanner("error", errText(result.error));
    else if (isLast && result.truncated) showBanner("warn", `Stopped after ${result.steps.length} steps. Is there an infinite loop?`);
    else showBanner(null);

    // frames
    const tags = new Map();   // object id -> [{name, frame, local, changed, color}]
    const boxBorder = new Map();   // object id -> border colour from a variable pointing at it
    const lastFrame = step.frames.length - 1;
    $("frames").innerHTML = step.frames.map((f, fi) => {
      const rows = f.vars.filter(([, v]) => !(v[0] === "ref" && isHidden(heap, v[1]))).map(([name, v]) => {
        const key = varKey(f, name), ch = diff.changed.has(key);
        if (labels && v[0] === "ref" && heap[v[1]]) {
          if (!tags.has(v[1])) tags.set(v[1], []);
          tags.get(v[1]).push({ name, frame: f.name, local: fi === lastFrame && fi > 0, changed: ch, color: colorFor(f.name, name) });
        }
        const col = colorFor(f.name, name);
        if (col && col.border && v[0] === "ref" && heap[v[1]] && !boxBorder.has(v[1])) boxBorder.set(v[1], col.border);
        const rowStyle = col && col.border ? ` style="box-shadow: inset 0 0 0 2px ${col.border}"` : "";
        const swatch = col && (col.line || col.border) ? `<span class="swatch" style="background:${col.line || "transparent"};border-color:${col.border || col.line}"></span>` : "";
        return `<div class="vrow${ch ? " changed" : ""}"${rowStyle}><button class="vname" data-frame="${esc(f.name)}" data-var="${esc(name)}" title="Choose colours for ${esc(name)}">${swatch}${esc(name)}</button>${valueHTML(v, heap, { frame: true, changed: ch, was: ch ? diff.old.get(key) : null, color: col })}</div>`;
      }).join("");
      let ret = "";
      if (f.returning) {
        if (labels && f.returning[0] === "ref" && heap[f.returning[1]]) {
          if (!tags.has(f.returning[1])) tags.set(f.returning[1], []);
          tags.get(f.returning[1]).push({ name: "return", frame: f.name, local: true, changed: true });
        }
        ret = `<div class="vrow ret"><span class="vname">return value</span>${valueHTML(f.returning, heap, { frame: true, changed: true })}</div>`;
      }
      return `<div class="frame${fi === lastFrame ? " active" : ""}"><div class="frame-name">${esc(f.name)}</div>${rows || ret ? rows + ret : '<div class="vrow muted">nothing to show yet</div>'}</div>`;
    }).join("");

    // objects
    if (!layout) computeLayout();
    const visible = Object.keys(heap).filter((id) => heap[id] && !isHidden(heap, id) && layout.pos.has(id));
    const heapEl = $("heap");
    heapEl.innerHTML = visible.map((id) => objectHTML(id, heap[id], heap, diff, tags.get(id))).join("");
    boxBorder.forEach((c, id) => {
      const el = heapEl.querySelector(`.obj[data-id="${id}"]`);
      if (el) { el.style.borderColor = c; el.style.boxShadow = `0 0 0 2px ${c}`; }
    });

    const GAP_X = 46, GAP_Y = 26;
    const rowBox = new Map(), rowTag = new Map(), usedCols = new Map();
    const els = new Map();
    heapEl.querySelectorAll(".obj").forEach((el) => {
      const id = el.dataset.id, p = layout.pos.get(id);
      const t = el.querySelector(".tags");
      els.set(id, el);
      rowBox.set(p.r, Math.max(rowBox.get(p.r) || 0, el.offsetHeight));
      rowTag.set(p.r, Math.max(rowTag.get(p.r) || 0, t ? t.offsetHeight + 4 : 0));
      usedCols.set(p.c, Math.max(usedCols.get(p.c) || 0, el.offsetWidth));
    });
    const rowH = new Map([...rowBox].map(([r, h]) => [r, h + rowTag.get(r)]));
    const offsets = (m, gap) => {
      const keys = [...m.keys()].sort((a, b) => a - b);
      const out = new Map(); let acc = 0;
      keys.forEach((k) => { out.set(k, acc); acc += m.get(k) + gap; });
      return [out, Math.max(0, acc - gap)];
    };
    const [rowY, totalH] = offsets(rowH, GAP_Y);
    const [colX, totalW] = offsets(usedCols, GAP_X);
    let maxW = totalW, maxH = totalH;
    els.forEach((el, id) => {
      const p = layout.pos.get(id), m = moved.get(layout.key.get(id));
      const x = m ? m.x : colX.get(p.c), y = m ? m.y : rowY.get(p.r) + rowTag.get(p.r);
      el.style.left = x + "px";
      el.style.top = y + "px";
      maxW = Math.max(maxW, x + el.offsetWidth);
      maxH = Math.max(maxH, y + el.offsetHeight);
    });
    heapEl.style.width = maxW + "px";
    heapEl.style.height = maxH + "px";
    $("reset-layout").disabled = moved.size === 0;

    drawArrows();
  }

  function drawArrows() {
    const viz = $("viz"), svg = $("arrows");
    const box = viz.getBoundingClientRect();
    svg.setAttribute("width", viz.scrollWidth);
    svg.setAttribute("height", viz.scrollHeight);
    // A solid triangle, sized in screen pixels (not scaled by line thickness), so a
    // thick highlighted arrow gets the same tidy head as a thin one.
    const marker = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="9.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path d="M0.5 1 L9.5 5 L0.5 9 Z" fill="${color}"/></marker>`;
    let ghosts = "", normal = "", colored = "", hot = "";
    const customMarkers = new Map();
    // Arrows always leave the dot heading right.
    // "smart" routing picks the side of the target box that keeps the arrow clear:
    //   - box to the right: enter its left edge;
    //   - box further left, above or below: swing round and enter its RIGHT edge,
    //     so the arrow doesn't double back underneath the boxes;
    //   - box directly above or below (columns overlap): enter its top or bottom edge;
    //   - box to the left on the same row (or the node itself): arc over the top.
    // "classic" always enters the left edge, like Python Tutor.
    const curve = (from, toEl) => {
      const a = from.getBoundingClientRect(), b = toEl.getBoundingClientRect();
      const sx = a.left + a.width / 2 - box.left, sy = a.top + a.height / 2 - box.top;
      const L = b.left - box.left, T = b.top - box.top, R = b.right - box.left, B = b.bottom - box.top;
      // Every arrow ends with a short straight run into the box, so the arrowhead
      // points the same way as the line it sits on, however sharp the curve.
      const HEAD = 9;
      const leftEntry = () => {
        const tx = L - 1, ty = T + 12, dx = Math.max(40, Math.abs(tx - sx) / 2);
        return `M${sx} ${sy} C ${sx + dx} ${sy}, ${tx - HEAD - dx} ${ty}, ${tx - HEAD} ${ty} L ${tx} ${ty}`;
      };
      let d;
      if (arrowStyle === "classic" || L >= sx + 12) {
        d = leftEntry();
      } else if (B < sy - 8 || T > sy + 8) {
        if (R + 16 < sx) {
          const tx = R + 1, ty = Math.min(B - 12, Math.max(T + 12, sy));
          const out = Math.max(36, Math.min(80, Math.abs(ty - sy) / 2));
          d = `M${sx} ${sy} C ${sx + out} ${sy}, ${tx + HEAD + out} ${ty}, ${tx + HEAD} ${ty} L ${tx} ${ty}`;
        } else {
          const up = B < sy;
          const tx = Math.min(R - 14, Math.max(L + 14, (L + R) / 2)), ty = up ? B + 1 : T - 1;
          const dy = Math.max(30, Math.abs(ty - sy) / 2);
          const ey = up ? ty + HEAD : ty - HEAD;
          d = `M${sx} ${sy} C ${sx + 40} ${sy}, ${tx} ${up ? ey + dy : ey - dy}, ${tx} ${ey} L ${tx} ${ty}`;
        }
      } else {
        // Arc over the row, clearing any name tags, and land near the box's
        // right end (tags sit on the left).
        const tags = toEl.querySelector(".tags");
        const tagH = tags ? tags.offsetHeight + 4 : 0;
        const tx = Math.max(L + 14, R - 16), ty = T - 1;
        const lift = Math.max(2, Math.min(T - tagH, sy) - 34);
        d = `M${sx} ${sy} C ${sx + 50} ${lift}, ${tx} ${lift}, ${tx} ${ty - HEAD} L ${tx} ${ty}`;
      }
      return { sx, sy, d };
    };
    viz.querySelectorAll("[data-was]").forEach((el) => {
      const target = viz.querySelector(`.obj[data-id="${el.dataset.was}"]`);
      if (!target) return;
      const p = curve(el, target);
      ghosts += `<path d="${p.d}" fill="none" stroke="var(--ghost)" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#head-ghost)"/>`;
    });
    viz.querySelectorAll(".ptr[data-ref]").forEach((ptr) => {
      const target = viz.querySelector(`.obj[data-id="${ptr.dataset.ref}"]`);
      if (!target) return;
      const p = curve(ptr, target);
      const col = ptr.dataset.color;
      if (col) {
        const mid = "head-" + col.replace(/[^a-z0-9]/gi, "");
        if (!customMarkers.has(mid)) customMarkers.set(mid, marker(mid, col));
        const w = ptr.dataset.changed ? 2.8 : 2;
        const seg = `<circle cx="${p.sx}" cy="${p.sy}" r="3.5" fill="${col}"/><path d="${p.d}" fill="none" stroke="${col}" stroke-width="${w}" marker-end="url(#${mid})"/>`;
        if (ptr.dataset.changed) hot += seg; else colored += seg;
      } else if (ptr.dataset.changed) {
        hot += `<circle cx="${p.sx}" cy="${p.sy}" r="3.5" fill="var(--hot)"/><path d="${p.d}" fill="none" stroke="var(--hot)" stroke-width="2.6" marker-end="url(#head-hot)"/>`;
      } else {
        normal += `<circle cx="${p.sx}" cy="${p.sy}" r="3" fill="var(--arrow)"/><path d="${p.d}" fill="none" stroke="var(--arrow)" stroke-width="1.5" marker-end="url(#head)"/>`;
      }
    });
    svg.innerHTML = `<defs>${marker("head", "var(--arrow)")}${marker("head-hot", "var(--hot)")}${marker("head-ghost", "var(--ghost)")}${[...customMarkers.values()].join("")}</defs>${ghosts}${normal}${colored}${hot}`;
  }

  // ---------- colour picker ----------
  // Click a variable's name (in a frame, or its name tag on a box) to give it a
  // line colour (its arrow and name tag) and a border colour (around the
  // variable and the box it points to).
  const SWATCHES = ["#d6336c", "#e8590c", "#e0a100", "#2f9e44", "#0c8599", "#1c7ed6", "#7048e8", "#495057"];
  const pop = $("color-pop");
  let popTarget = null;   // "frame|name"

  function swatchRow(kind, current) {
    const btns = SWATCHES.map((c) => `<button class="sw${current === c ? " on" : ""}" data-kind="${kind}" data-c="${c}" style="background:${c}" aria-label="${kind} colour ${c}"></button>`).join("");
    const custom = `<label class="sw custom" title="Any colour"><input type="color" data-kind="${kind}" value="${current || "#1c7ed6"}"></label>`;
    const none = `<button class="sw none${!current ? " on" : ""}" data-kind="${kind}" data-c="" aria-label="No ${kind} colour" title="None">×</button>`;
    return btns + custom + none;
  }
  function openPicker(frameName, name, anchor) {
    popTarget = `${frameName}|${name}`;
    const c = colors[popTarget] || {};
    pop.innerHTML = `<div class="pop-title"><code>${esc(name)}</code> <span class="muted">in ${esc(frameName)}</span></div>
      <div class="pop-label">Line <span class="muted">(arrow and name tag)</span></div><div class="pop-row">${swatchRow("line", c.line)}</div>
      <div class="pop-label">Border <span class="muted">(around the variable and its box)</span></div><div class="pop-row">${swatchRow("border", c.border)}</div>
      <div class="pop-foot"><span class="muted">Saved for this code in this browser.</span><button class="pop-reset">Reset</button></div>`;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hgt = pop.offsetHeight;
    let left = r.left + window.scrollX, top = r.bottom + window.scrollY + 6;
    left = Math.max(8, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 8));
    if (r.bottom + hgt + 12 > window.innerHeight) top = r.top + window.scrollY - hgt - 6;
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }
  function closePicker() { pop.hidden = true; popTarget = null; }
  function setColor(kind, value) {
    if (!popTarget) return;
    const c = { ...(colors[popTarget] || {}) };
    if (value) c[kind] = value; else delete c[kind];
    if (c.line || c.border) colors[popTarget] = c; else delete colors[popTarget];
    saveColors();
    pop.querySelectorAll(`.sw[data-kind="${kind}"]`).forEach((b) => b.classList.toggle("on", b.dataset.c === (value || "")));
    if (result) render({});
  }
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("button.sw");
    if (b) setColor(b.dataset.kind, b.dataset.c);
    if (e.target.closest(".pop-reset") && popTarget) { delete colors[popTarget]; saveColors(); if (result) render({}); closePicker(); }
  });
  pop.addEventListener("input", (e) => { if (e.target.type === "color") setColor(e.target.dataset.kind, e.target.value); });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("[data-var]")) closePicker();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) closePicker(); });
  $("frames").addEventListener("click", (e) => {
    const b = e.target.closest(".vname[data-var]");
    if (b) openPicker(b.dataset.frame, b.dataset.var, b);
  });
  // Name tags live inside draggable boxes, so a tap on a tag is detected in the
  // drag handler below (a press and release that didn't move).

  // ---------- dragging ----------
  // Boxes can be dragged anywhere in the drawing area. A dragged box keeps its
  // spot for every step, and across edits; "Reset layout" puts everything back.
  (function enableDragging() {
    const heapEl = $("heap");
    let drag = null;
    heapEl.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".obj");
      if (!el || e.button !== 0 || !layout) return;
      e.preventDefault();
      drag = { el, key: layout.key.get(el.dataset.id), px: e.clientX, py: e.clientY, x: el.offsetLeft, y: el.offsetTop,
               tag: e.target.closest(".ptag[data-var]"), movedPx: 0 };
      el.classList.add("dragging");
      el.setPointerCapture(e.pointerId);
    });
    heapEl.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.movedPx = Math.max(drag.movedPx, Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py));
      if (drag.movedPx < 4) return;
      const x = Math.max(0, drag.x + e.clientX - drag.px);
      const tagEl = drag.el.querySelector(".tags");
      const y = Math.max(tagEl ? tagEl.offsetHeight + 4 : 0, drag.y + e.clientY - drag.py);
      drag.el.style.left = x + "px";
      drag.el.style.top = y + "px";
      moved.set(drag.key, { x, y });
      drag.didMove = true;
      heapEl.style.width = Math.max(heapEl.offsetWidth, x + drag.el.offsetWidth) + "px";
      heapEl.style.height = Math.max(heapEl.offsetHeight, y + drag.el.offsetHeight) + "px";
      $("reset-layout").disabled = false;
      drawArrows();
    });
    const end = (e) => {
      if (!drag) return;
      drag.el.classList.remove("dragging");
      const tag = drag.tag, tapped = !drag.didMove && e.type === "pointerup";
      drag = null;
      if (tapped && tag && tag.dataset.var !== "return") openPicker(tag.dataset.frame, tag.dataset.var, tag);
    };
    heapEl.addEventListener("pointerup", end);
    heapEl.addEventListener("pointercancel", end);
    $("reset-layout").addEventListener("click", () => { moved.clear(); if (result) render({}); });
  })();

  boot();
})();
