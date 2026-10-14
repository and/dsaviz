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
  // "labels": variables appear as name tags on the box they point to (fewer arrows).
  // "arrows": every variable draws an arrow, like Python Tutor.
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
  function setMode(m) {
    pointerMode = m;
    try { localStorage.setItem("dsaviz-pointers", m); } catch (_) {}
    $("mode-labels").classList.toggle("on", m === "labels");
    $("mode-arrows").classList.toggle("on", m === "arrows");
    $("mode-labels").setAttribute("aria-pressed", String(m === "labels"));
    $("mode-arrows").setAttribute("aria-pressed", String(m === "arrows"));
    if (result) render({});
  }
  $("mode-labels").addEventListener("click", () => setMode("labels"));
  $("mode-arrows").addEventListener("click", () => setMode("arrows"));
  setMode(pointerMode);
  hideDefsBox.addEventListener("change", () => { if (result) { layout = null; render({}); } });
  window.addEventListener("resize", () => { if (result) drawArrows(); });

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
    if (opts.frame && pointerMode === "labels" && heap[id]) {
      return `<span class="chip${opts.changed ? " changed" : ""}">→ ${esc(shortName(heap, id))}</span>`;
    }
    return `<span class="ptr${opts.frame ? " fptr" : ""}" data-ref="${id}"${opts.changed ? ' data-changed="1"' : ""}${wasAttr}><span class="dot"></span></span>`;
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
      ? `<div class="tags">${tags.map((t) => `<span class="ptag${t.local ? " local" : ""}${t.changed ? " changed" : ""}" title="variable in ${esc(t.frame)}">${esc(t.name)}</span>`).join("")}</div>`
      : "";
    return `<div class="obj" data-id="${id}">${tagHTML}<div class="obj-head">${esc(head)}</div>${body}</div>`;
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
          const target = varNameFor(prev, d.after[1]);   // an existing object, already known by another name
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
    const tags = new Map();   // object id -> [{name, frame, local, changed}]
    const lastFrame = step.frames.length - 1;
    $("frames").innerHTML = step.frames.map((f, fi) => {
      const rows = f.vars.filter(([, v]) => !(v[0] === "ref" && isHidden(heap, v[1]))).map(([name, v]) => {
        const key = varKey(f, name), ch = diff.changed.has(key);
        if (labels && v[0] === "ref" && heap[v[1]]) {
          if (!tags.has(v[1])) tags.set(v[1], []);
          tags.get(v[1]).push({ name, frame: f.name, local: fi === lastFrame && fi > 0, changed: ch });
        }
        return `<div class="vrow${ch ? " changed" : ""}"><span class="vname">${esc(name)}</span>${valueHTML(v, heap, { frame: true, changed: ch, was: ch ? diff.old.get(key) : null })}</div>`;
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
    const marker = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`;
    let ghosts = "", normal = "", hot = "";
    // Arrows leave the dot heading right. They enter a box from the left when it
    // is to the right; a box that is above or below (and not to the right) is
    // entered from its bottom or top edge instead, so the arrow doesn't loop.
    const curve = (from, toEl) => {
      const a = from.getBoundingClientRect(), b = toEl.getBoundingClientRect();
      const sx = a.left + a.width / 2 - box.left, sy = a.top + a.height / 2 - box.top;
      const L = b.left - box.left, T = b.top - box.top, R = b.right - box.left, B = b.bottom - box.top;
      let d;
      if (L >= sx + 12) {
        const tx = L - 1, ty = T + 12, dx = Math.max(40, (tx - sx) / 2);
        d = `M${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
      } else if (B < sy - 8 || T > sy + 8) {
        const up = B < sy;
        const tx = Math.min(R - 14, Math.max(L + 14, (L + R) / 2)), ty = up ? B + 1 : T - 1;
        const dy = Math.max(30, Math.abs(ty - sy) / 2);
        d = `M${sx} ${sy} C ${sx + 40} ${sy}, ${tx} ${up ? ty + dy : ty - dy}, ${tx} ${ty}`;
      } else {
        const tx = L - 1, ty = T + 12;
        d = `M${sx} ${sy} C ${sx + 60} ${sy}, ${tx - 60} ${ty}, ${tx} ${ty}`;
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
      if (ptr.dataset.changed) {
        hot += `<circle cx="${p.sx}" cy="${p.sy}" r="3.5" fill="var(--hot)"/><path d="${p.d}" fill="none" stroke="var(--hot)" stroke-width="2.6" marker-end="url(#head-hot)"/>`;
      } else {
        normal += `<circle cx="${p.sx}" cy="${p.sy}" r="3" fill="var(--arrow)"/><path d="${p.d}" fill="none" stroke="var(--arrow)" stroke-width="1.5" marker-end="url(#head)"/>`;
      }
    });
    svg.innerHTML = `<defs>${marker("head", "var(--arrow)")}${marker("head-hot", "var(--hot)")}${marker("head-ghost", "var(--ghost)")}</defs>${ghosts}${normal}${hot}`;
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
      const tagEl = drag.el.querySelector(".tags");
      const y = Math.max(tagEl ? tagEl.offsetHeight + 4 : 0, drag.y + e.clientY - drag.py);
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
