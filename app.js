(() => {
  "use strict";

  const PYODIDE_VERSION = "314.0.7";
  const params = new URLSearchParams(location.search);
  const INDEX_URL = params.get("pyodide") || `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;
  const RERUN_DELAY_MS = 600;   // wait this long after typing stops before re-running

  const $ = (id) => document.getElementById(id);
  const editor = $("editor"), examplesSel = $("examples"), hideDefsBox = $("hide-defs");

  let traceFn = null;
  let result = null;           // last successful trace
  let stepIndex = 0;
  let layout = null;           // { pos: Map(id -> {r, c}), key: Map(id -> stable key) }
  let codeError = null;        // syntax error in the code as typed now (old drawing stays up)
  let ranCode = null;          // the code `result` came from
  // Boxes the user dragged, keyed by creation order ("3rd object made"), not by
  // memory id, so a moved box stays put when the code is edited and re-run.
  const moved = new Map();     // key -> {x, y}

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
  } else if (examples.length) {
    editor.value = examples[0].code;
    examplesSel.value = "0";
  }
  $("viz").hidden = true;
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
      const src = await (await fetch("tracer.py")).text();
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
    layout = null;
    stepIndex = sameShape ? Math.min(oldIndex, r.steps.length - 1) : 0;
    $("slider").max = String(r.steps.length - 1);
    $("placeholder").hidden = true;
    $("viz").hidden = false;
    render({ scroll: !keepStep });
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
  hideDefsBox.addEventListener("change", () => { if (result) { layout = null; render({}); } });
  window.addEventListener("resize", () => { if (result) drawArrows(); });

  // ---------- values ----------
  function isHidden(heap, id) {
    if (!hideDefsBox.checked) return false;
    const o = heap[id];
    return o && (o.type === "function" || o.type === "class" || o.type === "module");
  }

  function valueHTML(v, heap) {
    if (v[0] === "prim") return `<span class="val">${esc(v[1])}</span>`;
    const id = v[1];
    if (isHidden(heap, id)) {
      const o = heap[id];
      return `<span class="val muted">${o.type === "class" ? "class" : "function"} ${esc(o.name)}</span>`;
    }
    return `<span class="ptr" data-ref="${id}"><span class="dot"></span></span>`;
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

  function objectHTML(id, o, heap) {
    let head = "", body = "";
    if (o.type === "instance") {
      head = o.cls;
      body = o.attrs.length
        ? `<table>${o.attrs.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${valueHTML(v, heap)}</td></tr>`).join("")}</table>`
        : `<div class="plain muted">no attributes</div>`;
    } else if (o.type === "dict") {
      head = "dict";
      const rows = o.items.map(([k, v]) => `<tr><td class="k">${valueHTML(k, heap)}</td><td>${valueHTML(v, heap)}</td></tr>`).join("");
      body = o.items.length ? `<table>${rows}</table>` : `<div class="plain muted">empty</div>`;
      if (o.more) body += `<div class="plain muted">+${o.more} more</div>`;
    } else if (o.items) {
      head = o.type;
      const showIdx = o.type === "list" || o.type === "tuple";
      const cells = o.items.map((v, i) =>
        `<div class="cell">${showIdx ? `<span class="idx">${i}</span>` : ""}<span class="v">${valueHTML(v, heap)}</span></div>`).join("");
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
    return `<div class="obj" data-id="${id}"><div class="obj-head">${esc(head)}</div>${body}</div>`;
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
    const isLast = stepIndex === result.steps.length - 1;
    const heap = step.heap;

    paintEditor();
    if (scroll) scrollLineIntoView(step.line);
    $("slider").value = String(stepIndex);
    $("step-label").textContent = `Step ${stepIndex + 1} of ${result.steps.length}${isLast ? (result.error ? " · error" : result.truncated ? "" : " · finished") : ""}`;
    $("first").disabled = $("prev").disabled = stepIndex === 0;
    $("next").disabled = $("last").disabled = isLast;
    $("stdout").textContent = step.stdout;

    if (codeError) showBanner("error", errText(codeError) + ". Showing the last version that ran.");
    else if (isLast && result.error) showBanner("error", errText(result.error));
    else if (isLast && result.truncated) showBanner("warn", `Stopped after ${result.steps.length} steps. Is there an infinite loop?`);
    else showBanner(null);

    // frames
    $("frames").innerHTML = step.frames.map((f, i) => {
      const rows = f.vars.filter(([, v]) => !(v[0] === "ref" && isHidden(heap, v[1])))
        .map(([name, v]) => `<div class="vrow"><span class="vname">${esc(name)}</span>${valueHTML(v, heap)}</div>`).join("");
      const ret = f.returning ? `<div class="vrow ret"><span class="vname">return value</span>${valueHTML(f.returning, heap)}</div>` : "";
      return `<div class="frame${i === step.frames.length - 1 ? " active" : ""}"><div class="frame-name">${esc(f.name)}</div>${rows || ret ? rows + ret : '<div class="vrow muted">nothing to show yet</div>'}</div>`;
    }).join("");

    // objects
    if (!layout) computeLayout();
    const visible = Object.keys(heap).filter((id) => heap[id] && !isHidden(heap, id) && layout.pos.has(id));
    const heapEl = $("heap");
    heapEl.innerHTML = visible.map((id) => objectHTML(id, heap[id], heap)).join("");

    const GAP_X = 46, GAP_Y = 26;
    const usedRows = new Map(), usedCols = new Map();
    const els = new Map();
    heapEl.querySelectorAll(".obj").forEach((el) => {
      const id = el.dataset.id, p = layout.pos.get(id);
      els.set(id, el);
      usedRows.set(p.r, Math.max(usedRows.get(p.r) || 0, el.offsetHeight));
      usedCols.set(p.c, Math.max(usedCols.get(p.c) || 0, el.offsetWidth));
    });
    const offsets = (m, gap) => {
      const keys = [...m.keys()].sort((a, b) => a - b);
      const out = new Map(); let acc = 0;
      keys.forEach((k) => { out.set(k, acc); acc += m.get(k) + gap; });
      return [out, Math.max(0, acc - gap)];
    };
    const [rowY, totalH] = offsets(usedRows, GAP_Y);
    const [colX, totalW] = offsets(usedCols, GAP_X);
    let maxW = totalW, maxH = totalH;
    els.forEach((el, id) => {
      const p = layout.pos.get(id), m = moved.get(layout.key.get(id));
      const x = m ? m.x : colX.get(p.c), y = m ? m.y : rowY.get(p.r);
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
    let paths = `<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="var(--arrow)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`;
    viz.querySelectorAll(".ptr[data-ref]").forEach((ptr) => {
      const target = viz.querySelector(`.obj[data-id="${ptr.dataset.ref}"]`);
      if (!target) return;
      const a = ptr.getBoundingClientRect(), b = target.getBoundingClientRect();
      const sx = a.left + a.width / 2 - box.left, sy = a.top + a.height / 2 - box.top;
      const tx = b.left - box.left - 1, ty = b.top - box.top + 12;
      const dx = Math.max(40, Math.abs(tx - sx) / 2);
      paths += `<circle cx="${sx}" cy="${sy}" r="3" fill="var(--arrow)"/>`;
      paths += `<path d="M${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}" fill="none" stroke="var(--arrow)" stroke-width="1.5" marker-end="url(#head)"/>`;
    });
    svg.innerHTML = paths;
  }

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
      drag = { el, key: layout.key.get(el.dataset.id), px: e.clientX, py: e.clientY, x: el.offsetLeft, y: el.offsetTop };
      el.classList.add("dragging");
      el.setPointerCapture(e.pointerId);
    });
    heapEl.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.max(0, drag.x + e.clientX - drag.px);
      const y = Math.max(0, drag.y + e.clientY - drag.py);
      drag.el.style.left = x + "px";
      drag.el.style.top = y + "px";
      moved.set(drag.key, { x, y });
      heapEl.style.width = Math.max(heapEl.offsetWidth, x + drag.el.offsetWidth) + "px";
      heapEl.style.height = Math.max(heapEl.offsetHeight, y + drag.el.offsetHeight) + "px";
      $("reset-layout").disabled = false;
      drawArrows();
    });
    const end = () => {
      if (!drag) return;
      drag.el.classList.remove("dragging");
      drag = null;
    };
    heapEl.addEventListener("pointerup", end);
    heapEl.addEventListener("pointercancel", end);
    $("reset-layout").addEventListener("click", () => { moved.clear(); if (result) render({}); });
  })();

  boot();
})();
