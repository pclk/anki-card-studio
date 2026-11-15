# Anki Card Studio

Turn lecture notes, PDFs and slides into **descriptive, image-rich Anki cards** with Claude (via the `anki` skill) or any other AI (copy and paste only, no API keys), then review every card yourself before it reaches Anki.

| File | What it is |
|---|---|
| `anki_card_studio.html` | The website. A single file you open in any browser. It has the helper script built in. |
| `acs.py` | Optional local server (Python standard library only). It keeps every project, source and setting in one real folder, shared by every copy of the .html. It also fetches web pages for the Sources step. |
| `anki_helper.py` | The Python toolkit the AI uses in its code sandbox (also downloadable from the website). |
| `anki-skill.zip` | The `anki` Claude skill: `anki/SKILL.md` (card rules, workflow, batch planning) and `anki/scripts/` (`anki_helper.py`, `extract.py`, `make_prompts.py`). You can also download it from the website, which has all four files built in. |
| `src/studio.html`, `build.py` | Source for the website. Run `python3 build.py` after editing either source file to rebuild the HTML. |

## Claude skill (recommended)

The `anki` skill holds the card-writing rules, the workflow and the helper script, so the prompt the site generates is short.

- **Claude Code:** unzip `anki-skill.zip` into `~/.claude/skills/`. The skill writes a `build_deck.py` that imports the helper and runs it with `uv run --with pymupdf --with pillow --with matplotlib`. The bundle goes to `./anki_out/`, or to `$ANKI_OUT_DIR` if that's set.
- **Claude app:** upload the zip as a skill. Code execution must be on.

In the **Prompt** tab, choose *Claude with the anki skill*. The **Revise** tab has the same choice under *Prompt style*. Choose *Another AI* to get the original full, self-contained prompts, which work with any chatbot with or without code execution.

When you change the skill files, also update the copies built into the HTML: `<script id="skillSrc">`, `helperSrc`, `extractSrc` and `promptsSrc`. Otherwise the site's downloads go stale.

## Data folder (acs.py)

Without the server, the Studio saves in the browser. That data is tied to that browser *and* to where the page was opened from, so each copy of the .html has its own data. With the server, everything lives in one folder:

```
uv run acs.py            # or: python3 acs.py     -> opens http://127.0.0.1:8765
```

- **Folder:**
  - macOS: `~/Library/Application Support/AnkiCardStudio`
  - Linux: `~/.local/share/AnkiCardStudio`
  - Windows: `%APPDATA%\AnkiCardStudio`
  - Choose another with `--data DIR`.
- **Inside it:**
  - `settings.json`
  - `projects.json`
  - `projects/<id>/project.json`: cards, sub-projects, queue. Older versions are kept in `history/`, at most one every 10 minutes, the last 30.
  - `projects/<id>/media/`: card images
  - `projects/<id>/sources/`: original files plus extracted text
  - `apps/`
  - `trash/`: deleted projects are moved here, never erased
- **Several versions of the Studio:** put each `.html` in `apps/` (or next to `acs.py`). `http://127.0.0.1:8765/` lists them, and they all read and write the same folder. All of them are plain JSON, so an older or newer version can be patched by hand if formats ever diverge.
- **Open it through the server** (`http://127.0.0.1:8765/…`). A double-clicked `.html` (`file://`) can only use the folder if you start the server with `--allow-file-pages`. This is off by default because websites can fake a `file://` origin.
- **Sidebar → Storage** shows the folder and has **Open folder**. **Copy browser projects** copies projects you made before the server, from the same page/origin. To bring data across origins, use **Export all** on the old page, then **Import** on the new one.
- If the server stops while the Studio is open, you get a warning on the next save. Start it again and keep working.

## Sync between windows and versions

You can keep the same project open in several windows, tabs or Studio versions.
- **Revision check:** every save carries a revision number, and a save based on an older revision is refused. This is enforced by the server, or by the browser database in browser-only mode.
- **Merging:** the refused window then merges its edits with what is stored, card by card and field by field.
  - Edits to different cards or fields merge silently.
  - Review times from both windows add up.
  - The prompt queue keeps the furthest progress of each prompt.
  - Each window keeps its own current card, scope and prompt form.
- **Real clashes** open **Choose what to keep**: the same field changed differently in both places, or a card deleted in one and edited in the other. You see both versions side by side and pick per item, or all at once. Saving pauses until you apply.
- **Picking up changes:** other windows pull saved changes when they regain focus, every 15 s, and right away between tabs of the same origin. Sidebar → Storage shows the sync status, and ⟳ checks now.
- **Project list:** it merges by project, so a project created in one window appears in the others, and a deleted one doesn't come back.


## Projects, sub-projects and sources

- **Sidebar tree:** project › sub-projects, sorted alphanumerically (L2 before L10). Click ▾/▸ to collapse a branch (remembered), or type in **Filter** to show only matching sub-decks and the path to them.
- A sub-project *is* a sub-deck (`CS2030S::L01 Overview`) *and* one prompt in the batch queue. Selecting a project or sub-project scopes Sources, Prompt, Review and Export to it, and the line under the tabs shows the current scope. A project shows the cards and sources of all its sub-projects. Sub-projects are created automatically for every sub-deck you import and every prompt in a queue, and renaming one renames its deck.
- **1 · Sources:** drop PDF, PPTX (including speaker notes), DOCX, TXT, MD or HTML. You can also add a web page link (needs the server) or paste text.
  - The text is extracted page by page in the browser. Repeated headers and footers, page numbers and slide builds are dropped, and pages with figures are marked.
  - Tick "each file in its own sub-project" to make one sub-project per lecture. The owner drop-down moves a source to another sub-project.
- **Single prompt** with "Include stored source text": the prompt carries the scope's source text, so you attach nothing. In a sub-project, it targets that sub-deck.

## Batch mode: many prompts from one large source

Use this when a single chat would skim, e.g. 40 lecture PDFs where you want one chat per lecture.

1. **Prompt tab → Batch · many prompts.** Pick how to split (per file, by topic, or every N pages). The deck name becomes the parent deck, and each prompt gets a sub-deck.
   - **Fastest:** if each lecture is a sub-project with its own sources, **Build queue from sub-projects** makes one prompt per sub-project, with no planning AI.
   - **Planning from stored sources** (the default once you have sources): the planning prompt carries only an *outline* (the first line of every page). The AI answers with a small plan of page ranges, and the Studio pastes the right pages into each prompt when you copy it.
2. **1a · Planning prompt (files attached instead).** Paste it into Claude (with the skill and code execution) and attach all the material. Claude runs `extract.py`, which turns PDF/PPTX/DOCX into compact page-marked text and drops headers, footers, page numbers and slide builds. Claude then writes a small plan, and `make_prompts.py` combines plan and text into `anki_prompts.json`. The lecture text never goes through Claude's output, so even 40 lectures stay cheap. The script also reports any pages no prompt covers.
   - **One prompt per file needs no AI:** `uv run extract.py *.pdf -o extract.json`, then `uv run make_prompts.py extract.json --per-file --deck-root CS2030S -o anki_prompts.json`.
   - Without the skill ("Another AI"), the planner has to type all the material into the JSON. That works, but it's expensive.
3. **1b · Prompt queue.** Drop `anki_prompts.json`, then press **N** (or *Copy next prompt*) and paste into a **new chat**. Repeat. Each prompt is self-contained: it carries your card settings, its sub-deck, a card-id prefix, and the source text with `[file p.N]` markers.
4. **Drop the finished bundles** onto the queue in any order and any number at once. Each is matched to its prompt by sub-deck, imported and ticked off.

## Other features

- **Projects.** Projects and sub-projects live in the sidebar tree (see above). Opening a saved project file creates a new project.
- **Anti-spoiler order.** The AI writes cards grouped by topic and also records a study order (`deck.set_order`) in which no card gives away the next one.
  - In Review, switch between *as written* and *interleaved* (key **O**).
  - In Export, choose which order Anki uses for new cards.
- **Source picture in each card.** Cards carry `refs` (file, page and a verbatim quote).
  - **In the preview**, under *Source:*: for a PDF source, a picture of the page region around the quote with the quote highlighted. For slides, docs, web pages and notes, the quoted passage with the quote marked.
  - **In the .apkg** (Export → "Add the source picture / passage to each card's Source"), the same is added to the Source field, with the pictures as Anki media. The card text itself isn't changed.
  - This needs the source in the Sources step.
- **Snipping figures:** the image dialog opens this project's PDF sources automatically, and jumps to the page a "material" placeholder names.
- **Review.**
  - The preview opens on the back, in night mode, at full height.
  - Cloze notes show every deletion at once: blue `[...]` or `[hint]` on the front, blue answers on the back.
  - Default keys:
    - **Q** exclude & next · **W** request-change menu · **D** approve & next · **R** reset (the buttons are in the same order: Exclude, Request change, Approve). If you never changed the old defaults (Q approve, D exclude), they switch over automatically.
    - **⌘ Cmd** (tapped on its own) or **→** next · **←** previous · **Tab** flip
    - **C** copy the card as text for asking an AI (the preview flashes) · **E** switch between Preview and Edit in a narrow window · **O** switch order · **I** add image · **\\** sidebar
  - **The W menu** appears when you release W. Press **W** again to type your own feedback, **F** for "I don't understand this card" and move to the next card, or **S** for "Something is broken…" and move to the next card. Esc cancels.
  - All the keys and the W-menu options can be changed in **Settings** (sidebar). Settings can be exported and imported as JSON.
  - A timer records how long you spend on each card, pausing after 90 s without activity. The list shows the total, the average per card and an estimate of the time left.
  - The list keeps the current card in its centre. Cards you edited by hand get a **field-edited** tag, and the Field-edited filter finds them.
  - Field editors have HTML syntax highlighting, and cloze markers are shown in red. The HTML is **indented**: block elements (div, p, lists, tables) on their own lines, nested two spaces, short ones kept on one line; `<pre>`/`<code>` are never touched. Indenting is display-only until you edit a field; leaving a field you typed in re-indents it, and Enter keeps the current indentation.
  - **Code** in `<pre><code class="language-java">…</code></pre>` is syntax-highlighted in the preview, in light and night mode. In the .apkg the highlighting is built into the HTML, so Anki needs nothing extra. The **`</>`** toolbar button wraps the selection in a code block (asks for the language and escapes `<` and `&`).
  - **Maths:** LaTeX in `\( … \)` / `\[ … \]`, or `$…$` / `$$…$$`, is rendered with KaTeX in the preview and natively by Anki (MathJax). `$` maths is converted to Anki's delimiters on import and export (money such as "$5" is left alone). A cloze can sit inside a formula (`$x = {{c1::\frac{1}{2}}}$`): the gap shows inside the formula. LaTeX's own `}}` are spaced so they can't end a cloze early. The **∑** toolbar button inserts the delimiters.
  - Two more box styles: **method** (blue, for worked steps) and **check** (green, for verifying an answer).
  - **Layout follows the space you actually have** (with or without the sidebar):
    - **1320 px and wider:** three columns: card list, editor, preview.
    - **700–1320 px** (e.g. split screen): card list plus one column where edit and preview share a **Preview | Edit** toggle.
    - **Phone (under 700 px):** the card fills the screen under a slim top bar; a strip on the card shows ‹ position › and its status. Everything else is below the card: the request-change box (type what should change → **Request change ›**; empty → **Next ›**; ✎ opens the change menu), Front/Back, night mode, "Why this card", **☰ Cards** (the card list as a drawer) and the editor.
    - **Swipe the card:** right = approve, left = exclude — diagonal swipes count too. That half of the screen lights up green or red as you drag, and stars burst when you let go; **Undo** appears for 4 seconds. A short swipe snaps back, a steep one scrolls the card, a tap flips it. *Settings → Swiping* sets how far and how diagonal a swipe may be, and turns the effects off.
  - **Why this card:** cards from the skill carry an extensive explanation, shown under the preview: **Tests** (what the card checks and what a full answer needs), **Why it matters** (where it comes up and what goes wrong without it), **Common mistake**, and **Connects to** (prerequisites and related cards). **✎ Edit** changes it (HTML). **Put on card** adds it to the end of that card's Extra as a collapsible "Why this card" section; the Export tab's **Add "Why this card" to every card** does it for all cards (cards where you chose otherwise keep your choice).
  - The W menu's options can also be tapped.
- **Sidebar** (☰ at the top right): the project switcher, save or open a project file, export or import **all app data** (every project plus your settings, as one .zip), settings, and light/dark mode.

## Workflow

1. **Prompt tab.** Pick the AI (Claude + skill, or another AI), describe what to cover, and choose card types (Basic / Cloze), detail level and image sources. Click **Copy prompt**. In *Another AI* mode, also get **⬇ anki_helper.py**.
2. **Chat.** Attach your material (PDF, .docx, .pptx, screenshots) and paste the prompt. In *Another AI* mode, also attach `anki_helper.py` if the AI has code execution.
   Claude reads the material, crops figures straight from your PDF, draws diagrams, writes the cards, validates them and saves **`anki_bundle.json`**. That file holds the cards and all images.
3. **Import tab.** Drop `anki_bundle.json` onto the page. You can also paste Claude's reply text; the `<<<ANKI_CARDS … ANKI_CARDS>>>` blocks are found automatically, and several blocks are combined.
4. **Review tab.** Go through the cards one at a time:
   - The live preview uses the exact Anki template. <kbd>Space</kbd> flips the card. Cloze notes show each `c1`/`c2` card separately.
   - You can edit any field (HTML) using the toolbar: bold, lists, styled boxes, answer block, cloze, image.
   - <kbd>Q</kbd> excludes the card. <kbd>W</kbd> opens the request-change menu. <kbd>D</kbd> approves and jumps to the next unreviewed card. <kbd>R</kbd> resets it. On a phone, swipe right to approve and left to exclude. <kbd>⌘</kbd> / <kbd>→</kbd> next, <kbd>←</kbd> previous, <kbd>Tab</kbd> flip. You can change every key in Settings.
   - **Images:** paste a screenshot (Ctrl/⌘+V) into any field, or click 🖼. In the crop dialog you can open your PDF, go to a page, drag a box around the figure and click Insert. You can also paste from the clipboard, load an image URL or search Wikimedia Commons there.
   - **"✂ Snip needed"** means Claude asked you to grab a figure from your material. The dialog shows its hint and opens the PDF at the page it mentions.
5. **Revise tab.** Click **Build revision prompt** and paste it into the same Claude chat. It contains every card marked "Request change", with its current content (including your own edits) and your comment. Then drop Claude's `anki_revision.json` (or paste the reply). Revised cards come back as unreviewed, marked "revised", and the previous version stays viewable. Cards marked "I don't understand this card" also get a step-by-step explanation: in the reply if there are one or two, otherwise in `anki_explanations.md`. Repeat as often as you like.
6. **Export tab.** **Build .apkg** produces a ready-to-import deck with the images bundled. Double-click it, or use *File → Import* in Anki.

Your work autosaves in the browser (IndexedDB). Use **💾 Save project** to keep a portable copy or move it to another computer, and **📂 Open** to load it again.

## What the helper gives Claude

`help()` prints the full API. In short:

- **Reading material:** `list_uploads()`, `find_upload()`, `pdf_info()`, `pdf_text()`, `pdf_find()`, `pdf_figures()`, `render_page_preview()`, `office_images()`
- **Images:** `deck.pdf_figure()` (an embedded figure plus its labels), `deck.crop_pdf()` (any region), `deck.add_image_file()` (an uploaded screenshot plus crop), `deck.office_image()`, `deck.figure()` (any matplotlib figure), `deck.flowchart()`, `deck.concept_map()`, `deck.timeline()`, `deck.labeled_image()` (leader-line labels, or numbered "identify the structure" labels with an answer key), `deck.web_image()` (Wikimedia), `deck.material()` (asks you to snip it)
- **Cards:** `deck.add_basic()`, `deck.add_cloze()`, `deck.update()`, `deck.delete()`, plus HTML helpers `answer()`, `box(kind, …)`, `img()`, `bullets()`, `table()`, `cloze()`
- **HTML helpers for technical content:** `code(text, lang)` for highlighted code blocks, `tex(expr, display=False)` for maths (`$…$` in card text works too; `fix_math()` converts it). `validate()` checks every formula for syntax errors and unknown commands. `preview_png()` renders maths offline (MathML), and diagram labels accept `$…$` (matplotlib mathtext). `deck.graph()` lays out any node/edge diagram (feedback edges dashed and routed around the boxes), `deck.table_image()` renders a table as a picture.
- **Checking against the source:** `deck.load_source(pdf_or_text)` lets `validate()` confirm every ref quote really appears on the page it names (and says which page it is actually on if not).
- **Validation:** `deck.validate()` returns a list of `ERROR …` / `warn …` lines. It checks:
  - one question per card: numbered sub-questions or "1 → A; 2 → C" answers are errors (tag `multi-ok` for a genuine whole-set task such as ordering); a missing or thin `why=` (under ~45 words) is a warning. `rationale(tests=, matters=, mistake=, connects=)` builds the why.
  - images: every matplotlib figure is measured as it's drawn, and overlapping text, text cutting across boxes and overlapping boxes are errors; every new image must have been on a `contact_sheet()` or `preview_png()` before validate passes (the skill then has to open and look at those sheets)
  - card text: empty, nested or unbalanced cloze; long prose fronts; raw `<` or `&`; tags outside the allowed set; unbalanced HTML; inline colours and backgrounds (they break night mode); code blocks without a language; unbalanced maths delimiters
  - images: unregistered or misspelt `src` (with a "did you mean"), URLs or data: URIs in `src`, generated images that don't decode, malformed Wikimedia names, unverified web images, missing glyphs in diagrams
  - refs and order: missing file, short quotes, quotes not found in the source, and an incomplete or spoiling study order
  - `deck.check_web_images()` tests that every web image actually downloads.
- **Previews:** `deck.contact_sheet()` (thumbnails of every image on one sheet), `deck.preview_html()` / `deck.preview_png()` (cards rendered with the real note CSS, light or night).
- **Study order:** `deck.suggest_order()` builds an order in which no card gives away the next few. `deck.check_order()` lists the spoilers left in any order. Cards can have a `name=` and `prereq=`, and `set_order` accepts names.
- **Explanations:** for "I don't understand this card" requests, `deck.explain(id, markdown)` records a step-by-step explanation. `deck.save_explanations()` writes them to `anki_explanations.md` when there are too many for a chat reply.
- **Output:** `deck.save()` writes `anki_bundle.json` and prints where it went. `Deck.load(...)` followed by `deck.save(revision=True)` writes a revision. `print(deck.summary(issues))` gives the final reply, and nothing else is said:

  ```
  Deck generated: CS2030S::L01-intro
  Total cards: 42
  Number of Basic cards: 30
  Number of Cloze cards: 12
  Number of Images: 9
  Unexpected and unresolvable issues: None
  ```

Images are shrunk to at most 1400 px and recompressed (PNG for diagrams, JPEG for photos), so decks stay small.

## Note types in the .apkg

- **AutoAnki Basic** has the fields Front, Back, Extra and Source.
- **AutoAnki Cloze** has the fields Text, Extra and Source.

Both include the styled boxes (`aa-key`, `aa-why`, `aa-example`, `aa-mnemonic`, `aa-warning`, `aa-compare`, `aa-clinical`, `aa-note`, `aa-method`, `aa-check`), code-block and syntax-highlighting styles, and support night mode. Cards should never set their own colours: the note type handles light and dark.

Every card has a stable ID. Importing a re-exported deck updates the existing notes instead of duplicating them.

## Requirements and limits

- **Internet connection.** The page loads libraries from cdnjs: sql.js to build the .apkg, JSZip, pdf.js (PDF text, snipping, source pictures), highlight.js and KaTeX.
- **Claude code execution.** Generated diagrams and automatic PDF cropping need it. Without it, choose "No code tool" in the prompt tab: Claude then writes the JSON directly, with Wikimedia links and "snip" placeholders that you fill in on the site.
- **Web images.** Claude can only *name* web images; the website downloads them. Wikimedia Commons links are resolved through its API, and a file name that doesn't exist shows up as "download failed". Use **Provide… → Search Wikimedia Commons** to pick a replacement in a few clicks.
- **Tested:** the helper with PyMuPDF and matplotlib. The site in Chromium, end to end: import → review → PDF snip → revision → export. The exported .apkg imports cleanly into Anki 25.02 (correct sub-deck, cloze cards expanded, no missing media, re-import does not duplicate).
