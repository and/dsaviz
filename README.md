# dsaviz

**See your code run, line by line.** Python today; JavaScript is planned. Step through a program and watch variables, objects and pointers change, drawn as boxes and arrows.

**Live:** https://and.github.io/dsaviz/

It's like [Python Tutor](https://pythontutor.com), but everything runs **in your browser**. Python is executed by [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly), so there's no backend to host, nothing to keep alive, and your code never leaves your machine. The site is just static files on GitHub Pages.

## What it's good for

- **Linked lists**: objects keep their place while you step, so you can watch a single `.next` arrow move when a link is rewired.
- **Recursion**: every call gets its own frame on the stack, with its return value.
- **Trees, lists, dicts, aliasing**: see when two names point at the same object.

## Using it

Everything is on one page: code on the left, the drawing on the right.

1. Pick an example or type your own code. The drawing updates a moment after you stop typing (Ctrl/⌘ + Enter re-runs straight away). If you're mid-edit and the code doesn't parse, the last working drawing stays up and the bad line is marked.
2. Step with **Next / Prev**, the slider, or the ← → keys. The editor highlights the line that just ran and the one that runs next.
   - The box above the drawing says, in plain English, what the last line did ("`Node 'x'.next` now points to `Node 'b'` (was Node 'y')").
   - Whatever changed is coral: the pointer that moved, values that changed, and name tags that moved. A dashed grey line shows where a pointer used to go.
   - **Clearer arrows** (on by default) sends each arrow to the nearest side of its target, so a pointer back to an earlier node, as in a reversed list, enters that node from the right or arcs over the row instead of doubling back underneath. Turn it off to have every arrow enter from the left, like Python Tutor.
   - **Labels** (the default) shows variables as name tags on the box they point to, so only links between objects are drawn as arrows. **Arrows** draws every variable as an arrow, like Python Tutor.
3. Click a variable's name, in its frame or on its name tag, to give it its own colours: a **line** colour for its arrow and name tag, and a **border** colour around the variable and the box it points to. Colours are saved per program in your browser (with your last code), so they're still there after a refresh, and they follow the program while you edit it.
4. Drag any box to rearrange the drawing. Moved boxes stay put while you step and while you edit; **Reset layout** puts them back.
5. **Copy link** puts your code in the URL, so you can share or bookmark it. Your code never leaves your browser.

The first visit downloads Python (about 10 MB). After that, the browser caches it.

## How it works

```
your code ──▶ tracer.py (runs inside Pyodide)
               │  sys.settrace records a snapshot at every line:
               │  the call stack + every object reachable from it
               ▼
            JSON trace ──▶ app.js draws frames, objects and arrows for the chosen step
```

- `tracer.py` has no browser dependencies, so it runs and is tested under normal CPython too.
- Object positions are worked out once for the whole run, so boxes don't jump between steps. An object sits to the right of the first object that ever pointed at it, which makes linked lists read as horizontal chains.
- Objects that nothing points to any more disappear, just like garbage collection.

## Limits

- Stops after 1,000 steps (so infinite loops end with a warning instead of hanging the tab).
- Standard library only; no `input()`.
- Long lists and dicts show their first 50 items.

## Developing

No build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To work offline, install Pyodide locally and point the page at it:

```sh
npm install pyodide
ln -s node_modules/pyodide _pyodide
# open http://localhost:8000/?pyodide=/_pyodide/
```

When you change `app.js`, `style.css`, `examples.js` or `tracer.py`, bump the `?v=` number on their links in `index.html` (all three use the same number). That number is also the app version shown in the footer, and `app.js` uses it to fetch `tracer.py`. GitHub Pages and browsers cache these files for a while, and without a new number a visitor can get the new page with old code.

Run the tracer tests:

```sh
python3 -m unittest discover -s tests
```

## Credits

Inspired by Philip Guo's [Python Tutor](https://pythontutor.com). Python in the browser by [Pyodide](https://pyodide.org).

See [WISHLIST.md](WISHLIST.md) for what's planned next.

MIT licence.
