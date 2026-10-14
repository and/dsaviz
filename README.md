# dsaviz

**See your code run, line by line.** Python today; JavaScript is planned. Step through a program and watch variables, objects and pointers change, drawn as boxes and arrows.

**Live:** https://and.github.io/dsaviz/

It's like [Python Tutor](https://pythontutor.com), but everything runs **in your browser**. Python is executed by [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly), so there's no backend to host, nothing to keep alive, and your code never leaves your machine. The site is just static files on GitHub Pages.

## What it's good for

- **Linked lists**: objects keep their place while you step, so you can watch a single `.next` arrow move when a link is rewired.
- **Recursion**: every call gets its own frame on the stack, with its return value.
- **Trees, lists, dicts, aliasing**: see when two names point at the same object.

## Using it

1. Pick an example or paste your own code.
2. Click **Visualize** (or press Ctrl/⌘ + Enter).
3. Step with **Next / Prev**, the slider, or the ← → keys.
4. **Copy link** puts your code in the URL, so you can share or bookmark it. Nothing is stored anywhere.

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

Run the tracer tests:

```sh
python3 -m unittest discover -s tests
```

## Credits

Inspired by Philip Guo's [Python Tutor](https://pythontutor.com). Python in the browser by [Pyodide](https://pyodide.org).

MIT licence.
