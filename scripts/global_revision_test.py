"""Global revision on the helper side: deck.not_applicable() leaves a card as it was and says why in the revision, and refs
carry the exact section a card was made from (section_box(), the ref_section check, a malformed box is an error). The
Studio side is tests/global-revision.spec.ts."""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ANKI_OUT_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.join(ROOT, "skill", "anki", "scripts"))
import anki_helper as h  # noqa: E402

try:
    import pymupdf
except ImportError:
    pymupdf = None

h._L2M = False
WHY = "w " * 50


def revision_bundle():
    d = h.Deck("T")
    for q in ("What is a stack?", "What is a queue?", "What is a heap?"):
        d.add_basic(q, "A", why=WHY)
    path = os.path.join(os.environ["ANKI_OUT_DIR"], "rv.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"format": h.FORMAT, "deck": "T", "existing_ids": [c["id"] for c in d.cards],
                   "cards": [{**c, "feedback": "Global revision - add an example"} for c in d.cards]}, f)
    return path


class NotApplicable(unittest.TestCase):
    def test_saved_with_its_reason_and_no_changes(self):
        d = h.Deck.load(revision_bundle())
        a, b, c = [x["id"] for x in d.cards]
        d.update(a, back="A, e.g. a call stack")
        d.update(b, back="changed, then found not to fit")
        d.not_applicable(b, "  already has   an example ")
        d.delete(c)
        out = d.to_dict(False, revision=True)["cards"]
        self.assertEqual([x["id"] for x in out if "front" in x], [a])
        self.assertIn({"id": b, "not_applicable": "already has an example"}, out)
        self.assertIn({"id": c, "delete": True}, out)

    def test_needs_a_reason_and_a_card(self):
        d = h.Deck.load(revision_bundle())
        with self.assertRaises(ValueError):
            d.not_applicable(d.cards[0]["id"], " ")
        with self.assertRaises(KeyError):
            d.not_applicable("nope", "x")


class SourceSections(unittest.TestCase):
    def probs(self, ref):
        d = h.Deck("T")
        cid = d.add_basic("What does TCP guarantee?", "In-order delivery.", why=WHY, ref=ref)
        return [x for x in d.validate(verbose=False) if cid in x]

    def test_a_pdf_ref_without_a_box_is_flagged(self):
        self.assertTrue(any("has no box" in x for x in self.probs(("net.pdf", 3, "TCP guarantees in-order, reliable delivery"))))
        self.assertFalse(any("has no box" in x for x in self.probs(("net.pdf", 3, "TCP guarantees in-order, reliable delivery", (0.1, 0.2, 0.9, 0.4)))))
        # only PDFs can be screenshotted: other sources are cited by their quote
        self.assertFalse(any("has no box" in x for x in self.probs(("https://example.org/tcp", 0, "TCP guarantees in-order, reliable delivery"))))

    def test_a_malformed_box_is_an_error(self):
        for box in [(0.5, 0.2, 0.4, 0.3), (0, 0, 1.5, 1), (0.1, 0.1, 0.1, 0.1)]:
            self.assertTrue(any(x.startswith("ERROR") and "ref box" in x for x in self.probs(("net.pdf", 3, "TCP guarantees in-order, reliable delivery", box))), box)

    def test_the_check_can_be_turned_off(self):
        d = h.Deck("T")
        d.configure_checks({"ref_section": "off"})
        d.add_basic("Q?", "A", why=WHY, ref=("net.pdf", 3, "TCP guarantees in-order, reliable delivery"))
        self.assertFalse(any("has no box" in x for x in d.validate(verbose=False)))

    def test_checking_a_quote_does_not_break_the_next_cards(self):
        # validate() once rebound its check-level helper to the list of pages a quote is on: every card after the first
        # checked quote then crashed with "'list' object is not callable"
        d = h.Deck("T")
        d.source_pages["net.pdf"] = {3: "TCP guarantees in-order, reliable delivery of bytes."}
        box = (0.1, 0.1, 0.9, 0.3)
        a = d.add_basic("Q1?", "A", why=WHY, ref=("net.pdf", 3, "this quote is not on that page at all", box))
        b = d.add_basic("Q2?", "A", why="too short", ref=("net.pdf", 3, "TCP guarantees in-order, reliable delivery", box))
        p = d.validate(verbose=False)
        self.assertTrue(any(x.startswith("ERROR") and a in x and "ref quote not found" in x for x in p), p)
        self.assertTrue(any(b in x and "why= is only" in x for x in p), p)

    @unittest.skipIf(pymupdf is None, "pymupdf not installed")
    def test_section_box_is_the_block_around_the_quote(self):
        doc = pymupdf.open()
        p = doc.new_page(width=600, height=800)
        p.insert_textbox(pymupdf.Rect(50, 100, 550, 160), "Header block that is not the section.", fontsize=11)
        p.insert_textbox(pymupdf.Rect(50, 400, 550, 480), "TCP guarantees in-order, reliable delivery of a byte stream. "
                         "It retransmits lost segments.", fontsize=11)
        path = os.path.join(os.environ["ANKI_OUT_DIR"], "net.pdf")
        doc.save(path)
        x0, y0, x1, y1 = h.section_box(path, 1, "reliable delivery of a byte stream")
        self.assertTrue(0.35 < y0 < 0.5 and 0.5 < y1 < 0.62 and x0 < 0.1, (x0, y0, x1, y1))
        self.assertIsNone(h.section_box(path, 1, "words that are nowhere on this page"))


if __name__ == "__main__":
    unittest.main()
