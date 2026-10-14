"""Python execution tracer for dsaviz.

Runs a user's program under sys.settrace and records a snapshot of the
call stack and every reachable object at each line. The result is a plain
JSON-serialisable dict that the browser renders as boxes and arrows.

Runs inside Pyodide in the browser, but has no browser dependencies, so it
also runs (and is tested) under normal CPython.
"""

import io
import json
import sys
import types

USER_FILE = "<dsaviz>"
MAX_STEPS = 1000
MAX_ITEMS = 50       # cap for long lists / dicts shown in one box
MAX_REPR = 60

PRIMITIVES = (int, float, complex, bool, str, bytes, type(None))


class StepLimit(Exception):
    pass


def _short(text):
    text = str(text)
    return text if len(text) <= MAX_REPR else text[: MAX_REPR - 1] + "…"


class Tracer:
    def __init__(self, code):
        self.code = code
        self.steps = []
        self.stdout = io.StringIO()
        self.keepalive = []          # stops ids being reused mid-trace
        self.frame_ids = {}          # frame -> small stable number, so steps can be compared
        self.globals = {"__name__": "__main__", "__builtins__": __builtins__}

    # ---------- encoding ----------
    def encode(self, value, heap):
        if isinstance(value, PRIMITIVES):
            return ["prim", _short(repr(value))]
        oid = id(value)
        if oid not in heap:
            heap[oid] = None            # placeholder: breaks cycles
            heap[oid] = self.encode_object(value, heap)
            self.keepalive.append(value)
        return ["ref", str(oid)]

    def encode_object(self, obj, heap):
        if isinstance(obj, (list, tuple, set, frozenset)):
            items = list(obj)
            more = max(0, len(items) - MAX_ITEMS)
            return {
                "type": type(obj).__name__,
                "items": [self.encode(v, heap) for v in items[:MAX_ITEMS]],
                "more": more,
            }
        if isinstance(obj, dict):
            pairs = list(obj.items())
            more = max(0, len(pairs) - MAX_ITEMS)
            return {
                "type": "dict",
                "items": [[self.encode(k, heap), self.encode(v, heap)]
                          for k, v in pairs[:MAX_ITEMS]],
                "more": more,
            }
        if isinstance(obj, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
            name = getattr(obj, "__qualname__", getattr(obj, "__name__", "function"))
            return {"type": "function", "name": name}
        if isinstance(obj, type):
            return {"type": "class", "name": obj.__name__}
        if isinstance(obj, types.ModuleType):
            return {"type": "module", "name": obj.__name__}
        attrs = getattr(obj, "__dict__", None)
        if isinstance(attrs, dict):
            return {
                "type": "instance",
                "cls": type(obj).__name__,
                "attrs": [[k, self.encode(v, heap)] for k, v in attrs.items()
                          if not k.startswith("__")],
            }
        return {"type": "other", "cls": type(obj).__name__, "repr": _short(repr(obj))}

    # ---------- snapshots ----------
    def user_frames(self, frame):
        frames = []
        while frame is not None:
            if frame.f_code.co_filename == USER_FILE and not self.is_class_body(frame):
                frames.append(frame)
            frame = frame.f_back
        frames.reverse()
        return frames

    @staticmethod
    def is_class_body(frame):
        # Function bodies are compiled with CO_OPTIMIZED; module and class bodies
        # aren't. (Checking f_locals for __module__ misses the class body's very
        # first event, before Python has filled it in.)
        return not (frame.f_code.co_flags & 0x1) and frame.f_code.co_name != "<module>"

    @staticmethod
    def visible(name, value):
        if name.startswith("__") and name.endswith("__"):
            return False
        if isinstance(value, types.ModuleType):
            return False
        return True

    def snapshot(self, frame, event, arg):
        heap = {}
        frames_out = []
        for f in self.user_frames(frame):
            is_module = f.f_code.co_name == "<module>"
            source = f.f_globals if is_module else f.f_locals
            variables = [[name, self.encode(value, heap)]
                         for name, value in list(source.items())
                         if self.visible(name, value)]
            fid = self.frame_ids.setdefault(f, len(self.frame_ids))
            entry = {
                "fid": fid,
                "name": "Global frame" if is_module else f.f_code.co_name,
                "vars": variables,
            }
            if f is frame and event == "return" and not is_module:
                entry["returning"] = self.encode(arg, heap)
            frames_out.append(entry)
        heap_out = {str(k): v for k, v in heap.items()}
        self.steps.append({
            "line": frame.f_lineno,
            "event": event,
            "frames": frames_out,
            "heap": heap_out,
            "stdout": self.stdout.getvalue(),
        })
        if len(self.steps) >= MAX_STEPS:
            raise StepLimit()

    # ---------- trace hooks ----------
    def global_trace(self, frame, event, arg):
        if frame.f_code.co_filename != USER_FILE:
            return None
        if event == "call" and not self.is_class_body(frame) and frame.f_code.co_name != "<module>":
            self.snapshot(frame, "call", arg)
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if self.is_class_body(frame):
            return self.local_trace
        if event in ("line", "return"):
            self.snapshot(frame, event, arg)
        return self.local_trace

    # ---------- run ----------
    def run(self):
        result = {"steps": self.steps, "error": None, "truncated": False}
        try:
            compiled = compile(self.code, USER_FILE, "exec")
        except SyntaxError as e:
            result["error"] = {"type": "SyntaxError", "message": str(e.msg), "line": e.lineno}
            return result

        old_stdout = sys.stdout
        sys.stdout = self.stdout
        sys.settrace(self.global_trace)
        try:
            exec(compiled, self.globals)
        except StepLimit:
            result["truncated"] = True
        except BaseException as e:   # noqa: BLE001 - we report every user error
            line = None
            tb = e.__traceback__
            while tb is not None:
                if tb.tb_frame.f_code.co_filename == USER_FILE:
                    line = tb.tb_lineno
                tb = tb.tb_next
            result["error"] = {"type": type(e).__name__, "message": str(e), "line": line}
        finally:
            sys.settrace(None)
            sys.stdout = old_stdout
        result["stdout"] = self.stdout.getvalue()
        return result


def trace(code):
    """Trace `code` and return the result as a JSON string."""
    return json.dumps(Tracer(code).run())


if __name__ == "__main__" and sys.platform != "emscripten":
    print(trace(sys.stdin.read()))
