"""The skill's code_line_chars check in validate(): the same cases as scripts/code-width.test.ts (the Studio's checker)."""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ANKI_OUT_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.join(ROOT, "skill", "anki", "scripts"))
import anki_helper as h  # noqa: E402

h._L2M = False
with open(os.path.join(ROOT, "scripts", "fixtures", "code-width.json"), encoding="utf-8") as f:
    CASES = json.load(f)


def width_warnings(deck):
    return [p for p in deck.validate(verbose=False) if "code line(s) longer" in p]


class CodeWidth(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES:
            with self.subTest(c["name"]):
                self.assertEqual(max([len(x) for x in h._code_lines(c["card"])] or [0]), c["longest"])
                d = h.Deck("T")
                card = dict(c["card"], id="c001", why="w " * 50, tags=[])
                d.cards.append(card)
                self.assertEqual(len(width_warnings(d)), 1 if c["flag"] else 0)

    def test_default_and_configurable(self):
        self.assertEqual(h.CHECK_DEFAULTS["code_line_chars"], 27)
        d = h.Deck("T")
        d.add_basic("Q", h.code("public ColoredCircle(Circle c,\n  String colour) {", "java"), why="w " * 50)
        (w,) = width_warnings(d)
        self.assertTrue(w.startswith("warn") and "longest 30" in w, w)
        d.configure_checks({"code_line_chars": 0})
        self.assertEqual(width_warnings(d), [])


if __name__ == "__main__":
    unittest.main()
