"""The helper reads a prompt's blocks by id from the saved prompt file, so the AI never retypes them."""
import json
import os
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAT = tempfile.mkdtemp()
os.environ["ANKI_MATERIAL_DIR"] = MAT
os.environ.setdefault("ANKI_OUT_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.join(ROOT, "skill", "anki", "scripts"))
import anki_helper as h  # noqa: E402

CARDS = {"format": "anki-studio/v1", "deck": "D", "existing_ids": ["c001", "c002", "c009"],
         "cards": [{"id": "c001", "type": "basic", "front": "Q", "back": "A", "feedback": "shorter"}], "media": []}
SOURCE = "[L01.pdf p.1]\nIntro text.\n[L01.pdf p.2]\nA class is a blueprint for objects.\n"


def write(name, text, age=0):
    p = os.path.join(MAT, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    t = time.time() - age
    os.utime(p, (t, t))
    return p


class BlockById(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        body = json.dumps(CARDS, indent=1)
        write("anki_prompt_r-0a1b2c3d.txt", "Use the anki skill...\n\n<<<REVISE_CARDS id=r-0a1b2c3d\n" + body + "\nREVISE_CARDS>>>\n")
        write("anki_prompt_s-11112222.txt", "Make cards.\n## Source material\n<<<SOURCE id=s-11112222\n" + SOURCE + "SOURCE>>>")
        # an older prompt with another id must never be picked up
        write("old_prompt.txt", "<<<SOURCE id=s-99998888\n[Old.pdf p.1]\nstale\nSOURCE>>>", age=3600)

    def test_deck_load_by_id(self):
        d = h.Deck.load("r-0a1b2c3d")
        self.assertEqual([c["id"] for c in d.cards], ["c001"])
        self.assertEqual(d.feedback, {"c001": "shorter"})
        self.assertEqual(d._n, 9)                      # existing_ids came through: new ids continue after c009

    def test_load_source_by_id(self):
        d = h.Deck("D")
        self.assertEqual(d.load_source("s-11112222"), {"L01.pdf": 2})
        self.assertIn("blueprint", d.source_pages["L01.pdf"][2])
        self.assertNotIn("Old.pdf", d.source_pages)

    def test_unknown_id_says_not_to_retype(self):
        with self.assertRaises(FileNotFoundError) as e:
            h.Deck.load("r-ffffffff")
        self.assertIn("Don't retype", str(e.exception))
        with self.assertRaises(FileNotFoundError):
            h.Deck("D").load_source("s-ffffffff")

    def test_pasted_text_with_an_id_header_still_loads(self):
        d = h.Deck.load("<<<REVISE_CARDS id=r-0a1b2c3d\n" + json.dumps(CARDS) + "\nREVISE_CARDS>>>")
        self.assertEqual(len(d.cards), 1)

    def test_newest_file_wins_for_the_same_id(self):
        newer = dict(CARDS, cards=[dict(CARDS["cards"][0], back="B")])
        p = write("anki_prompt_r-0a1b2c3d (1).txt", "<<<REVISE_CARDS id=r-0a1b2c3d\n" + json.dumps(newer) + "\nREVISE_CARDS>>>")
        try:
            self.assertEqual(h.Deck.load("r-0a1b2c3d").cards[0]["back"], "B")
        finally:
            os.remove(p)


if __name__ == "__main__":
    unittest.main()
