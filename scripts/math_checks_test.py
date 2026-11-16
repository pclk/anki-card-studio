"""The skill's maths checks in validate(): the same cases as scripts/math-checks.test.ts (the Studio's checker)."""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "skill", "anki", "scripts"))
os.environ.setdefault("ANKI_OUT_DIR", tempfile.mkdtemp())
import anki_helper as h  # noqa: E402

h._L2M = False   # no latex2mathml install attempt: formula parsing isn't what these tests are about
with open(os.path.join(ROOT, "scripts", "fixtures", "math-checks.json"), encoding="utf-8") as f:
    CASES = json.load(f)
MATH = ("unshown_math", "math_as_text", "math_in_code")


def keys(card):
    return sorted({k for k, _ in h._math_checks({"tags": [], **card})})


class MathChecks(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES:
            with self.subTest(c["name"]):
                self.assertEqual(keys(c["card"]), sorted(k for k in c["want"] if k in MATH))

    def test_validate_reports_with_configured_levels(self):
        d = h.Deck("T")
        d.add_basic("Using Eq. (3), what is x^2?", "<code>\\sum x</code>", why="w " * 50)
        probs = [p for p in d.validate(verbose=False) if "maths" in p or "cites" in p]
        self.assertEqual(len(probs), 3)
        self.assertTrue(all(p.startswith("warn") for p in probs), probs)
        d.configure_checks({"math_as_text": "error", "math_in_code": "off"})
        probs = [p for p in d.validate(verbose=False) if "maths" in p or "cites" in p]
        self.assertEqual(len(probs), 2)
        self.assertTrue(any(p.startswith("ERROR") and "plain text" in p for p in probs), probs)
        self.assertFalse(any("inside code" in p for p in probs), probs)

    def test_defaults_match_the_studio(self):
        with open(os.path.join(ROOT, "studio", "src", "07-review.js"), encoding="utf-8") as f:
            src = f.read()
        for k in MATH:
            self.assertEqual(h.CHECK_DEFAULTS[k], "warn")
            self.assertIn(f"key: '{k}'", src)


if __name__ == "__main__":
    unittest.main()
