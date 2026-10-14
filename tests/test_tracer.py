import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tracer import trace  # noqa: E402


def run(code):
    return json.loads(trace(code))


class TracerTests(unittest.TestCase):
    def test_records_each_line(self):
        r = run("a = 1\nb = a + 1\n")
        self.assertIsNone(r["error"])
        self.assertEqual([s["line"] for s in r["steps"] if s["event"] == "line"], [1, 2])

    def test_linked_list_pointers(self):
        r = run("class N:\n  def __init__(s, v):\n    s.val = v\n    s.next = None\n"
                "a = N(1)\nb = N(2)\na.next = b\n")
        last = r["steps"][-1]
        glob = dict(last["frames"][0]["vars"])
        a = last["heap"][glob["a"][1]]
        self.assertEqual(a["cls"], "N")
        self.assertEqual(dict(a["attrs"])["next"], glob["b"])

    def test_runtime_error_reports_line(self):
        r = run("x = None\nx.next\n")
        self.assertEqual(r["error"]["type"], "AttributeError")
        self.assertEqual(r["error"]["line"], 2)

    def test_syntax_error(self):
        r = run("x = [1,\n")
        self.assertEqual(r["error"]["type"], "SyntaxError")
        self.assertEqual(r["steps"], [])

    def test_infinite_loop_is_cut_off(self):
        r = run("while True:\n  pass\n")
        self.assertTrue(r["truncated"])

    def test_stdout_is_captured_per_step(self):
        r = run("print('hi')\nx = 1\n")
        self.assertEqual(r["stdout"], "hi\n")
        self.assertEqual(r["steps"][-1]["stdout"], "hi\n")

    def test_function_frames_and_return_value(self):
        r = run("def f(n):\n  return n * 2\ny = f(3)\n")
        returns = [s for s in r["steps"] if s["event"] == "return" and len(s["frames"]) == 2]
        self.assertEqual(returns[0]["frames"][1]["returning"], ["prim", "6"])


if __name__ == "__main__":
    unittest.main()
