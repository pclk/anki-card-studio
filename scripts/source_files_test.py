"""The helper reads the original files the Studio attaches: a PDF excerpt keeps its original file and page numbers,
and slides / Word files give their text to load_source()."""
import os
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ANKI_OUT_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.join(ROOT, "skill", "anki", "scripts"))
import anki_helper as h  # noqa: E402

try:
    import pymupdf
except ImportError:  # the skill always runs with pymupdf; CI installs it
    pymupdf = None
DIR = tempfile.mkdtemp()
NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'


def pptx(path, slides, notes=None):
    with zipfile.ZipFile(path, "w") as z:
        for i, lines in enumerate(slides, 1):
            body = "".join(f"<a:p><a:r><a:t>{t}</a:t></a:r></a:p>" for t in lines)
            z.writestr(f"ppt/slides/slide{i}.xml", f'<p:sld {NS}><p:cSld><p:spTree><p:sp><p:txBody>{body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
        for i, t in (notes or {}).items():
            z.writestr(f"ppt/slides/_rels/slide{i}.xml.rels", f'<Relationships><Relationship Target="../notesSlides/notesSlide{i}.xml"/></Relationships>')
            z.writestr(f"ppt/notesSlides/notesSlide{i}.xml", f'<p:notes {NS}><a:p><a:r><a:t>{t}</a:t></a:r></a:p><a:p><a:r><a:t>{i}</a:t></a:r></a:p></p:notes>')


class SourceFiles(unittest.TestCase):
    @unittest.skipIf(pymupdf is None, "pymupdf not installed")
    def test_pdf_excerpt_keeps_original_pages(self):
        doc = pymupdf.open()
        for n in (12, 13, 15):
            doc.new_page().insert_text((72, 72), f"Original page {n}: a class is a blueprint number {n}.")
        doc.set_metadata({"keywords": "acs-pages=Lecture%2001.pdf:12,13,15"})
        p = os.path.join(DIR, "Lecture 01_p12-13_15.pdf")
        doc.save(p)
        self.assertEqual(h.page_map(p), ("Lecture 01.pdf", [12, 13, 15]))
        self.assertEqual(h.orig_page(p, 3), ("Lecture 01.pdf", 15))
        d = h.Deck("D")
        self.assertEqual(d.load_source(p), {"Lecture 01.pdf": 3})
        self.assertEqual(sorted(d.source_pages["Lecture 01.pdf"]), [12, 13, 15])
        self.assertIn("blueprint number 15", d.source_pages["Lecture 01.pdf"][15])
        # an ordinary PDF keeps its own numbering
        plain = pymupdf.open(); plain.new_page().insert_text((72, 72), "plain")
        q = os.path.join(DIR, "plain.pdf"); plain.save(q)
        self.assertIsNone(h.page_map(q))
        self.assertEqual(h.orig_page(q, 1), ("plain.pdf", 1))

    def test_pptx_text_per_slide_with_notes(self):
        p = os.path.join(DIR, "L02.pptx")
        pptx(p, [["Title slide"], ["Inheritance", "A subclass extends a superclass"]], notes={2: "Mention super()"})
        d = h.Deck("D")
        self.assertEqual(d.load_source(p), {"L02.pptx": 2})
        self.assertIn("A subclass extends a superclass", d.source_pages["L02.pptx"][2])
        self.assertIn("Speaker notes: Mention super()", d.source_pages["L02.pptx"][2])
        self.assertNotIn("Speaker notes: Mention super() 2", d.source_pages["L02.pptx"][2])   # the slide-number field is dropped

    def test_docx_text(self):
        p = os.path.join(DIR, "notes.docx")
        W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("word/document.xml", f'<w:document {W}><w:body><w:p><w:r><w:t>Encapsulation hides state.</w:t></w:r></w:p></w:body></w:document>')
        d = h.Deck("D")
        self.assertEqual(d.load_source(p), {"notes.docx": 1})
        self.assertIn("Encapsulation hides state.", d.source_pages["notes.docx"][1])


if __name__ == "__main__":
    unittest.main()
