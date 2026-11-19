"""Checks the AI skips on purpose for one card ("skipped_checks": {check: reason}): validate() stops reporting them, every
skip needs a known per-card check and a reason, and they travel in the bundle. The Studio side is tests/skipped-checks.spec.ts."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ANKI_OUT_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.join(ROOT, "skill", "anki", "scripts"))
import anki_helper as h  # noqa: E402

h._L2M = False
WHY = "w " * 50
WIDE = h.code("public ColoredCircle(Circle c,\n  String colour) {", "java")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def probs(deck):
    return deck.validate(verbose=False)


class SkippedChecks(unittest.TestCase):
    def test_a_skip_hides_only_that_check_on_that_card(self):
        d = h.Deck("T")
        a = d.add_basic("Q?", WIDE, why=WHY, skip={"code_line_chars": "the signature is the point of the card"})
        b = d.add_basic("Q2?", WIDE, why=WHY)
        p = probs(d)
        self.assertFalse(any(x.startswith(f"warn {a}:") for x in p), p)
        self.assertTrue(any(x.startswith(f"warn {b}:") and "code line(s) longer" in x for x in p), p)
        self.assertEqual(d.get(a)["skipped_checks"], {"code_line_chars": "the signature is the point of the card"})
        # other checks on the skipping card still run
        d.update(a, why="")
        self.assertTrue(any(x.startswith(f"warn {a}:") and "no why=" in x for x in probs(d)))

    def test_validate_says_how_many_problems_skips_hid(self):
        d = h.Deck("T")
        d.add_basic("Q?", WIDE, why=WHY, skip={"code_line_chars": "kept on purpose"})
        out = io.StringIO()
        with redirect_stdout(out):
            d.validate()
        self.assertIn("1 problem(s) not reported: 1 card(s) skip checks on purpose", out.getvalue())

    def test_every_check_kind_can_be_skipped(self):
        d = h.Deck("T")
        long_front = "Consider " + "a long statement, " * 30 + "what is it?"
        cid = d.add_basic(long_front, "A", ref=("notes.pdf", 0, "short"))
        before = [x for x in probs(d) if x.split(" ", 1)[1].startswith(cid)]
        self.assertTrue(any("no why=" in x for x in before) and any("characters of prose" in x for x in before)
                        and any("ref has no page" in x for x in before) and any("ref quote is short" in x for x in before)
                        and any("has no box" in x for x in before), before)
        for k in ("why", "front_max_chars", "ref_page", "ref_quote_min_chars", "ref_section"):
            d.skip(cid, k, f"test reason for {k}")
        self.assertEqual([x for x in probs(d) if x.split(" ", 1)[1].startswith(cid)], [])
        # short why: its own check, independent of "why"
        d.update(cid, why="too short")
        self.assertTrue(any("why= is only" in x for x in probs(d)))
        d.skip(cid, "why_min_words", "test")
        self.assertFalse(any("why= is only" in x for x in probs(d)))

    def test_skip_and_unskip(self):
        d = h.Deck("T")
        cid = d.add_basic("Q?", WIDE, why=WHY)
        d.skip(cid, "code_line_chars", "  needs   the full   line  ")
        self.assertEqual(d.get(cid)["skipped_checks"], {"code_line_chars": "needs the full line"})
        d.update(cid, skip={"code_language": "pseudo-code"})
        self.assertEqual(set(d.get(cid)["skipped_checks"]), {"code_line_chars", "code_language"})
        d.skip(cid, "code_line_chars", None)
        d.skip(cid, "code_language", None)
        self.assertNotIn("skipped_checks", d.get(cid))
        self.assertTrue(any("code line(s) longer" in x for x in probs(d)))

    def test_bad_skips_are_refused(self):
        d = h.Deck("T")
        with self.assertRaisesRegex(ValueError, "needs a reason"):
            d.add_basic("Q?", "A", why=WHY, skip={"code_line_chars": "  "})
        with self.assertRaisesRegex(ValueError, "can't skip 'unused_images'"):
            d.add_basic("Q?", "A", why=WHY, skip={"unused_images": "x"})
        with self.assertRaisesRegex(ValueError, "can't skip 'nope'"):
            d.add_cloze("{{c1::x}}", why=WHY, skip=[("nope", "x")])
        # a card that arrives with a bad skip (hand-written JSON) is an error, and its checks still run
        d.cards.append({"id": "c099", "type": "basic", "front": "Q?", "back": WIDE, "why": WHY, "tags": [],
                        "skipped_checks": {"code_line_chars": ""}})
        p = probs(d)
        self.assertTrue(any(x.startswith("ERROR c099: skipped_checks:") for x in p), p)
        self.assertTrue(any(x.startswith("warn c099:") and "code line(s) longer" in x for x in p), p)

    def test_skips_travel_in_the_bundle_and_back(self):
        d = h.Deck("T")
        cid = d.add_cloze("{{c1::a}} {{c2::b}} {{c3::c}} {{c4::d}}", why=WHY,
                          skip=[{"check": "cloze_max_deletions", "reason": "the four steps belong together"}])
        with redirect_stdout(io.StringIO()):
            path = d.save()
        card = json.loads(read(path))["cards"][0]
        self.assertEqual(card["skipped_checks"], {"cloze_max_deletions": "the four steps belong together"})
        prompt = os.path.join(h.OUT_DIR, "anki_prompt_skip.txt")
        block = {"format": "anki-studio/v1", "deck": "T", "cards": [dict(card, feedback="Checker fix - ...")]}
        with open(prompt, "w", encoding="utf-8") as f:
            f.write("<<<REVISE_CARDS id=r-0000beef\n" + json.dumps(block) + "\nREVISE_CARDS>>>\n")
        with redirect_stdout(io.StringIO()):
            d2 = h.Deck.load(prompt)
        self.assertEqual(d2.get(cid)["skipped_checks"], {"cloze_max_deletions": "the four steps belong together"})
        self.assertFalse(any("cloze numbers" in x for x in probs(d2)))
        d2.skip(cid, "cloze_max_deletions", None)
        with redirect_stdout(io.StringIO()):
            rev = json.loads(read(d2.save(revision=True)))
        self.assertEqual([c["id"] for c in rev["cards"]], [cid])
        self.assertNotIn("skipped_checks", rev["cards"][0])

    def test_skippable_matches_the_studio(self):
        src = read(os.path.join(ROOT, "studio", "src", "07-review.js"))
        fmt = src.split("const FMT_KEYS = new Set([", 1)[1].split("]", 1)[0]
        fix = src.split("const FIX_KEYS = new Set([", 1)[1].split("]", 1)[0]
        studio = {k.strip(" '") for k in (fmt + "," + fix).split(",")}
        self.assertEqual(studio, set(h.SKIPPABLE))


if __name__ == "__main__":
    unittest.main()
