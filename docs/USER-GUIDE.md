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
- **Or let Claude download it.** Under *How will Claude get the skill?* on the Prompt tab, choose *Claude downloads it from this Studio each time*. Every skill prompt (single, batch planning and parts, revisions, global revisions, image fixes) then starts with a short *Get the anki skill first* section: Claude downloads `<this site>/skill/anki.zip` into its working folder (`anki-skill/anki/SKILL.md`) and follows it, so it always uses the version your Studio expects and nothing needs installing. The single files are at `/skill/SKILL.md`, `/skill/anki_helper.py`, `/skill/extract.py` and `/skill/make_prompts.py`. These addresses are public (an AI's sandbox can't sign in) and serve only the skill, never your data. The local companion (`acs.py`) serves the same addresses on this computer, so Claude Code running here can use them too (a chat in the Claude app can't reach your computer). Claude needs network access to this site: Claude Code has it; in the Claude app, the code sandbox's network settings must allow it. If Claude can't reach the site it uses an installed copy, or stops and asks you to attach the skill. Jobs on the Mac bridge already bring the skill with them, so their prompts leave the download step out. The installed option works as before.

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
- **Source picture in each card.** Cards carry `refs` to the exact section they were made from: file, page, the verbatim text that led to the card, and for PDFs a `box` around that section (paragraph, figure, table or slide region, as page fractions; the skill's `section_box()` finds it).
  - **In the preview**, under *Source:*: for a PDF source, a picture of exactly that section with the quote highlighted (without a box: the region around the quote). For slides, docs, web pages and notes, where no picture is possible, the quoted passage with the quote marked. A card made from your request rather than the material quotes your request (`"file": "prompt"`).
  - The Checker's **PDF source reference without the section** (`ref_section`, warn) flags PDF refs without a box; a global revision with the **Sources** rules adds them.
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
    - **Phone (under 700 px):** the card fills the screen under a slim top bar; a strip on the card shows ‹ position ›, its status and **✎**, which jumps to the editor. The card is part of the page, so scrolling anywhere scrolls everything. Everything else is below the card: the request-change box (type what should change → **Request change ›**; empty → **Next ›**; ✎ opens the change menu), Front/Back, night mode, the hidden notes, **☰ Cards** (the card list as a drawer) and the editor.
    - **Swipe the card:** right = approve, left = exclude — diagonal swipes count too. That half of the screen lights up green or red as you drag, and stars burst when you let go; **Undo** appears for 4 seconds. A short swipe snaps back, a steep one scrolls the card, a tap flips it. *Settings → Swiping* sets how far and how diagonal a swipe may be, and turns the effects off.
  - **Hidden notes** (the card's `why` field), shown under the preview. What goes in them is set on the Prompt page (**Hidden notes**, e.g. "a mnemonic and the exam question it prepares for"); left empty, they explain why the card was made: **Tests** (what the card checks and what a full answer needs), **Why it matters** (where it comes up and what goes wrong without it), **Common mistake**, and **Connects to** (prerequisites and related cards). Revisions and global revisions keep to the same setting. **✎ Edit** changes them (HTML). **Put on card** adds them to the end of that card's Extra as a collapsible "Notes" section; the Export tab's **Add the hidden notes to every card** does it for all cards (cards where you chose otherwise keep your choice).
  - The W menu's options can also be tapped.
- **Sidebar** (☰ at the top right): the project switcher, save or open a project file, export or import **all app data** (every project plus your settings, as one .zip), settings, and light/dark mode.

## Workflow

1. **Checker tab** (optional). Set how strict the card-quality checks are: each check is *error*, *warn* or *off*, and the limits are numbers (minimum hidden-notes words, maximum front length, cloze numbers per note, …). **What it looks for** under each check says exactly how it decides. The settings are kept for all projects. Claude gets the changed ones in every prompt (`deck.configure_checks(...)`), and Analytics, Review, Revise and Export use the same settings.
2. **Prompt tab.** Pick the AI (Claude + skill, or another AI), describe what to cover, and choose card types (Basic / Cloze), detail level and image sources. Click **Copy prompt**. In *Another AI* mode, also get **⬇ anki_helper.py**.
3. **Chat.** Attach your material (PDF, .docx, .pptx, screenshots) and paste the prompt. In *Another AI* mode, also attach `anki_helper.py` if the AI has code execution, or choose *The AI downloads anki_helper.py from this Studio* (online version or `acs.py`; the AI needs network access to this site).
   Claude reads the material, crops figures straight from your PDF, draws diagrams, writes the cards, validates them and saves **`anki_bundle.json`**. That file holds the cards and all images.
4. **Bring the cards back** (on the Prompt tab, under the prompt). Drop `anki_bundle.json` there. You can also paste Claude's reply text; the `<<<ANKI_CARDS … ANKI_CARDS>>>` blocks are found automatically, and several blocks are combined. Multi-prompt results can also go into the queue's own drop zone.
5. **Analytics tab** (can be hidden in *Settings → Tabs*). The deck's makeup: cards, basic/cloze, approved, images, how many pass every check. Then a row per check with how many cards fail it (tap a check's name for what it looks for; **Show cards** opens just those cards in Review), length histograms against your limits, and a table per sub-deck.
6. **Review tab.** Go through the cards one at a time:
   - The live preview uses the exact Anki template. <kbd>Space</kbd> flips the card. Cloze notes show each `c1`/`c2` card separately.
   - You can edit any field (HTML) using the toolbar: bold, lists, styled boxes, answer block, cloze, image.
   - <kbd>Q</kbd> excludes the card. <kbd>W</kbd> opens the request-change menu. <kbd>D</kbd> approves and jumps to the next unreviewed card. <kbd>R</kbd> resets it. On a phone, swipe right to approve and left to exclude. <kbd>⌘</kbd> / <kbd>→</kbd> next, <kbd>←</kbd> previous, <kbd>Tab</kbd> flip. You can change every key in Settings.
   - **Images:** paste a screenshot (Ctrl/⌘+V) into any field, or click 🖼. In the crop dialog you can open your PDF, go to a page, drag a box around the figure and click Insert. You can also paste from the clipboard, load an image URL or search Wikimedia Commons there.
   - **Checker:** under the card's status, the checks this card fails (with your settings). It updates as you edit.
   - **"✂ Snip needed"** means Claude asked you to grab a figure from your material. The dialog shows its hint and opens the PDF at the page it mentions.
7. **Revise tab.** Click **Build revision prompt** and paste it into the same Claude chat. It contains every card marked "Request change", with its current content (including your own edits) and your comment. Then drop Claude's `anki_revision.json` (or paste the reply). Revised cards come back as unreviewed, marked "revised", and the previous version stays viewable. Cards marked "I don't understand this card" also get a step-by-step explanation: in the reply if there are one or two, otherwise in `anki_explanations.md`. Repeat as often as you like.
   - **▶ Run on Mac (the Mac bridge).** Instead of copying a prompt into a chat, send it to your Mac: Claude Code or Codex runs it there - with whatever account that CLI is signed in to (your subscription if you signed in with it; an API key bills the API) - and the Studio imports the result by itself. Set up once in **Settings → Mac bridge**: *Add a device* (its token is shown once) and download **acs-bridge.mjs**. Copy the command it shows and paste it into Terminal **without pressing Enter**:

     ```
     pbpaste | node ~/Downloads/acs-bridge.mjs setup --server <this site's address> && node ~/Downloads/acs-bridge.mjs install
     ```

     Then click **Copy token** and press Enter. `setup` reads the token from the clipboard (so it never lands in your shell history) and pairs; `install` copies the script to `~/.acs-bridge/acs-bridge.mjs` and runs it in the background as a macOS LaunchAgent: it starts at login, restarts if it crashes, and logs to `~/.acs-bridge/bridge.log`. Later: `node ~/.acs-bridge/acs-bridge.mjs status` (account, agents, whether it runs), `… logs -f` (follow the log), `… uninstall` (stop it; the pairing is kept), and `install` again after updating the script, Node, `claude` or `codex`. `node acs-bridge.mjs` alone runs it in the terminal instead. If the device is removed in the Studio, the background bridge stops for good instead of retrying.

     **What it runs with**: under *Run with* pick Claude Code or Codex and, for each, the **model** (e.g. `opus`, `sonnet` or a full model name; Codex: e.g. `gpt-6-astra`), the **thinking effort** (Claude Code: low … max; Codex: minimal … max) and a **time limit per run** (never more than the bridge's own 60 minutes). Claude Code also takes a **fallback model** (used when the model is overloaded) and a **max spend per run** (only applies when Claude Code uses an API key). Empty means the CLI's own default. Each job keeps the options it was sent with (the Jobs list shows them); the server and the bridge both check them, and a job asking for anything else fails.

     The button then appears next to Copy for single prompts, the batch queue (*Run all on Mac*), revisions, the formatting pass and image fixes; the 🖥 pill (bottom left) shows the jobs, their live log, Cancel and Import. A queue prompt (batch or global revision) whose job fails or is cancelled goes back to *to do*, so *Run all on Mac* sends it again; a result that couldn't be downloaded is fetched again by itself a few times. The token only lets the bridge pick up your jobs and send results back - it can't read your projects (a job holds only the files the Studio sent with it; an Assistant job holds the project you asked about) - and *Remove* in Settings cuts it off at once (so do disabling the account and *sign out everywhere*). Each job runs in its own folder under `~/.acs-bridge/jobs` with a fixed instruction; Claude Code runs with `--permission-mode dontAsk`, a fixed tool list and no MCP servers, Codex in its `workspace-write` sandbox (no network unless your Codex config allows it). A job still runs code (the skill is Python), so pair only with an account you trust. Online version only.
   - **Sources go as the original files.** With *Send the stored sources* ticked, **Copy prompt** puts the prompt on the clipboard *and* downloads the original files (PDF, slides, Word) - attach them in the same message, so Claude can read, render and crop them itself. In a batch queue each prompt downloads only its own pages of a PDF (e.g. `L01_p12-30.pdf`); the page map is inside the file, so cards still cite `L01.pdf p.12`. Slide decks and Word files go whole, with the prompt naming the part's slides. Pasted text and web pages have no file and stay in the prompt as text. **⬇** next to a prompt downloads its files again. Image-fix prompts also attach the source pages the cards point at.
   - **Image review**: in Review, **🖼 Images** (under the card list; on a phone, the 🖼 button above the card) shows every image one at a time with its caption and the cards that use it. **Approve** (<kbd>D</kbd>, swipe →) or mark it **Broken** (<kbd>Q</kbd>, swipe ←), optionally saying what's wrong. Verdicts sync with the project; filter Review by *Broken images* to see the affected cards. Broken images are listed at the top of Revise: **Build image-fix prompt**, send it to Claude, and drop the `anki_revision.json` it returns under *Apply Claude's revision*. Claude gives each replacement a new filename; the changed cards go back to *Unreviewed* and the new images wait for review. A picture replaced under the same filename is reviewed again too.
   - **Global revision** (top of Revise) changes cards across the deck without reviewing them again, including cards you already approved: for when you are halfway through a deck and want something changed everywhere.
     **1 · What to change.** Write an **instruction** ("Rewrite the Java code in Kotlin", "Shorten answers and move the rest into the hidden notes"), choose whether Claude may change content or only how cards are written, and whether it may split or delete cards. And/or tick **Checker rules** whose findings to fix, or click a preset: **Formatting** (outside references, unshown code, code as plain text, code without a language, code lines too wide for a phone, unshown maths, maths as plain text, maths inside code), **Others** (missing or short hidden notes, fronts and answers over the length limits, too many cloze numbers, several questions on one card, source references without a page, without their section or with a short quote), **Everything**, or the smaller **Code**, **Maths**, **Length** and **Sources**. Each rule shows its Checker setting, and rules the Checker has switched off are skipped. **＋ Save as preset** keeps the ticked rules, the instruction and the filter under a name of your own (✕ deletes it); all of it is kept with your settings. With rules and no instruction it is the old checker fix (or a formatting pass).
     **2 · Which cards.** *Which cards* picks by the rules (*Flagged by the picked rules*, *Flagged with an error*, *Flagged + every approved card*, or every card; with no rules, every card) and *Status* by review status. Then the **filter**: add conditions, each set to **Allow** or **Deny**. A card goes in when it matches *all* (or *any*) of the Allow conditions and none of the Deny ones; with no Allow conditions every card passes. Conditions cover the Checker (flagged by a check, any check, an error, a skipped check), code (a code block, its language, no language, inline code, lines of code, longest line), maths (any, display, in the question), layout (images and how many, an image in the question, tables, lists, a box kind, the one-line answer, Extra, links), the card (type, cloze numbers and hints, question and answer length, question marks), hidden notes (present, length, on the card), review (status, edited, revised, waiting for a re-check, your feedback, review time, left as is last time), metadata (tag, sub-deck, card ids, with `L03-*` for a prefix), source (any ref, file name, page, section box) and text (contains, or a regex, in any field, the question, the answer, the hidden notes, the source or the HTML). Each condition shows how many cards it matches on its own; one with a missing value or a bad regex is ignored and marked *incomplete*. **Show them in Review** opens the Review filter *Global revision filter* with the cards it picks.
     Then **Build queue**. Each prompt remembers its instruction and rules, so you can build one queue, change the setup and add more. The instruction may not fit every card the filter picked: Claude then leaves that card exactly as it was and says why (`"not_applicable"`, `deck.not_applicable(id, reason)` with the helper). The result lists those reasons, the card gets a *left as is* badge in Review, and *The last global revision left it as is* is a filter condition. Deletes only count when the prompt allowed them. It works like the multi-prompt queue: **Copy next prompt** (or <kbd>N</kbd>) per batch, then drop each `anki_revision.json` into the queue (any order; each is matched to its prompt and ticked off). When the rules are all formatting, the prompt is a **formatting pass**: Claude changes only how cards are written, never what they test, and never splits them. Otherwise Claude fixes only what the checks found and may split a bundled card: the new parts arrive as *Unreviewed* right after the original. Cards keep their status; approved cards that Claude changed get a **Re-check** with a before/after diff, which includes the hidden notes and shows the instruction (Review → filter *Re-check*). A reply dropped on the queue may only change cards waiting in one of its prompts (and add the parts of a card it split): anything else in it is left out and listed. With **▶ Run all on Mac**, prompts that may change content get the cards' source pages attached so Claude can fill in pages, quotes and sections.
   - **Checks skipped by AI.** When a check is genuinely wrong for one card (a code line holding a URL that can't be broken, a problem statement the question needs in full), Claude can skip that check on that card instead of distorting it, with a reason: the card stores `"skipped_checks": {"code_line_chars": "…"}` (`deck.skip(id, check, reason)` with the helper). A skipped check no longer flags that card anywhere (Review, Global revision, Analytics, Export, and `validate()`). In Review the card's Checker list shows each skip, its reason and what the check would say; **Undo skip** applies the check again. The Review filter *Checks skipped by AI* lists every card with a skip. In a global revision that fixes Checker rules, Claude may answer a flagged card with a skip instead of a change; an approved card then gets a **Re-check** whose diff shows the skip. Only the per-card checks can be skipped, and only with a reason.
8. **Export tab.** It starts with the Checker's verdict on the cards about to be exported. **Build .apkg** produces a ready-to-import deck with the images bundled. Double-click it, or use *File → Import* in Anki.

**Assistant (✦ tab).** Ask Claude anything about the project in your own words: "Which cards in L03 test the same thing?", "Find approved cards whose code isn't Java and convert them", "Tag every card about recursion", "Which sub-deck has the most Checker errors, and why?". Choose the whole project or the selected sub-deck. Optionally attach the source files, include the card images (`acs.mjs images`, `extract-images`; edited cards keep them), and include your other projects - read-only: Claude can search and compare them (`--all-projects`, `project:NAME`) but changes only this one.
- **▶ Run on Mac** (Settings → Mac bridge) sends the project with the job, as files: `acs_project.json` (every card with its fields, status, sub-deck, tags, hidden notes, sources and your feedback, what the Checker found, and facts about its make-up such as code blocks and their languages, maths, images, tables, lengths), `acs_sources.json` (the text of the sources, page by page) and `acs.mjs`, a command-line tool that lists, filters and searches them. Its query language combines terms (all must match), `or`, `not` / `-` and `( )`: words, "phrases" and `/regex/` in any text or in one part (`q:`, `a:`, `notes:`, `source:`, `html:`), `status:`, `type:`, `deck:`, `tag:`, `id:` (with `*`), `lang:`, `box:`, `ref:`, `check:` (a Checker rule, `any`, `error`, `warn`), `skipped:`, `has:` (a fact) and measures like `a_words>80` or `code_width>27`. Nothing leaves your Mac except the answer and the proposed changes, and the device token still can't read your projects.
- The answer appears on the tab. With **Claude may edit cards and propose changes** ticked, it can also change cards (with the anki skill) and propose actions: statuses, tags, moving cards to a sub-deck, feedback, hidden notes on the card, queueing a global revision, a Checker setting, the hidden-notes setting, an Anki package of some cards (downloaded when you apply it, with the Export tab's options), a new project with copies of some cards (or moving them there), and deleting one of your other projects. **Nothing changes until you click Apply** (or Discard) - unless you tick *…and apply them as soon as they arrive*. Deleting a project always asks you to type its name, also then. Applied card edits keep each card's status, and approved cards that changed wait for a **Re-check**. Each result is applied once, even with several windows open.
- **📋 Copy for a chat** (no bridge) copies the prompt and downloads the three files to attach. Drop the chat's `anki_revision.json` / `anki_actions.json` on the tab to look at them and apply them the same way.
- An older bridge (before version 3) runs the questions but can't send back proposed actions: download `acs-bridge.mjs` again and run `install`.

**Offline (online version).** No connection? Keep working: the status line shows *📡 Offline - saved on this device*, and your edits go to your account by themselves when the connection is back (changed on another device meanwhile? Both are merged, and you're asked only when the same thing was changed in both places). The installed app also opens offline, with every project you opened on that device before. Projects you never opened there, sources (PDFs), the Mac bridge and deleting a project wait for the connection. **Sign out** removes the offline copies from that device.

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

## User management (online version, admins)

*Settings → Users → Open user management* lists every account with its projects, storage use and last activity, plus usernames that are allowed but haven't signed in yet. Add a GitHub username at the top. For each account:
- **Role:** user or admin (admins can open user management). Admins set in `ACS_ADMIN_GITHUB` can't be changed here.
- **Status:** active, **read-only** (they can look around, but nothing is saved), or **disabled** (they see a "disabled" screen; their data is kept).
- **Storage limit** in MB, with current use. Saves that would go over it are refused.
- **Sign out everywhere** ends all their sessions; **Remove sign-in access** takes them off the list.
- **Projects:** edit a project's JSON (their open windows pick the change up), rename, download, delete or restore, see **History** (saved copies) and put an older version back, and list or delete its images and source files.
- **Settings:** view or edit their settings as JSON, or reset them.
- **Danger zone:** delete all their data, or delete it and forget the account.

## Requirements and limits

- **Internet connection.** The page loads libraries from cdnjs: sql.js to build the .apkg, JSZip, pdf.js (PDF text, snipping, source pictures), highlight.js and KaTeX.
- **Claude code execution.** Generated diagrams and automatic PDF cropping need it. Without it, choose "No code tool" in the prompt tab: Claude then writes the JSON directly, with Wikimedia links and "snip" placeholders that you fill in on the site.
- **Web images.** Claude can only *name* web images; the website downloads them. Wikimedia Commons links are resolved through its API, and a file name that doesn't exist shows up as "download failed". Use **Provide… → Search Wikimedia Commons** to pick a replacement in a few clicks.
- **Tested:** the helper with PyMuPDF and matplotlib. The site in Chromium, end to end: import → review → PDF snip → revision → export. The exported .apkg imports cleanly into Anki 25.02 (correct sub-deck, cloze cards expanded, no missing media, re-import does not duplicate).
