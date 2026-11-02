# Docent

A desktop voice and chat agent that runs entirely on your computer. Point it at your files, group them into document sets, and ask questions. Answers come from the sets you select and cite where each fact was found.

It runs [LFM3-Omni-2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B) through [llama.cpp](https://github.com/ggml-org/llama.cpp). Your documents, questions and voice stay on your machine.

## Install

Download the build for your platform from [Releases](https://github.com/yepher/docent-app/releases): `.dmg` for macOS, `.exe` for Windows, `.AppImage` or `.deb` for Linux. The app updates itself from new releases, except the `.deb`, which you update by installing the newer package.

On first run it downloads about 2.3 GB of models and verifies them. Allow at least 3 GB of free disk space for the models and, as a guide, 8 GB of memory. Your document library needs additional space.

## Using it

1. Create a document set in the sidebar and add files or folders.
2. Tick the sets each question should use. Choose **General chat** explicitly for answers without document evidence. Empty or failed document sets never implicitly select general chat.
3. Type, or press **Speak**, talk, and press **Stop**.
4. Press a numbered citation to see the source. PDFs open at the cited page; other files show the passage.

Speech is off by default. Click the small **Read aloud** speaker button beside an answer's Save and Copy actions to hear that answer, including answers in saved conversations. Click it again to stop. Playback uses the local voice model and saved pronunciations, omits citation markers, and does not regenerate or change the answer. With **Speak replies** on, text streams immediately and evidence appears as soon as generation finishes, independently of playback.

You can also drag files or folders into Docent's main panel, or choose **File → Import Documents…** / **Import Folder…**. On macOS, drop them onto the packaged **Docent.app** Dock icon, including when the app is closed. The import chooser lets you select an existing document set or create a new one; nothing is added until you click **Import**. Folder imports include supported documents in subfolders, and originals stay in place. Local models must be running to index the import. Dock imports require the packaged app's document registration; the development bundle does not register file associations.

The **Help** menu links to the Docent GitHub project and releases. **Report an Issue…** opens GitHub's new-issue page in your browser for you to write and submit a report. Opening these links requires an internet connection.

To correct how a word is said, select it in an answer and choose **Set pronunciation**. Spell it how it sounds, press **Preview** to hear it, then **Save**. It applies to all future speech, and changes only the voice, not the written answer. In the sidebar's **Pronunciations** list, use **Edit** to revise a saved pronunciation and **Test** to hear either the saved pronunciation or your unsaved edit. **Cancel** keeps the saved value.

Press a file in a set to open it in its default app or show it in Finder, File Explorer or your file manager. Scripts and programs can only be shown in their folder, so opening one never runs it.

Supported files: PDF, PNG, JPEG, DOCX, Markdown, plain text, HTML, CSV, JSON, YAML and common source code. Scanned PDF pages and images are read with bundled English OCR, entirely offline. Originals stay where they are; a copy and indexed passages are stored in the local library. **Rescan** picks up changes. Unavailable sources and failed refreshes retain the last successful version and show a warning.

### Better passage selection

Document questions use keyword and embedding search to find candidates, then a local **Qwen3-Reranker-0.6B** model checks which passages best answer the actual question. It reranks up to 30 distinct candidates before choosing the final eight passages. Strong passages from the same document can both be selected; citations retain their original source and version. Reranking stays within the selected sets and documents. It cannot recover passages that the first search missed, and relevance scores are not answer-confidence estimates.

Open **Search quality** in the sidebar to enable or disable enhanced retrieval. Existing installations continue working offline with their current models; use **Download relevance model (639 MB)** once to add reranking. New installations include it in the initial model download. Disabling it unloads the extra model to save memory and time. Identical scoring requests are cached in memory; changing document content or the question produces a new request. If scoring fails or takes more than 20 seconds, the answer uses standard hybrid search and shows a warning. **Stop** also cancels retrieval.

The separate **Search library** field remains a fast, model-free keyword search. Bibliography extraction, request counting, and other analysis tools keep their dedicated workflows; reranking applies when the assistant searches for passages.

### Questions about images and PDF pages

Open a PDF with **Read offline**, navigate to a page, and click **Ask about this page**. Type a question about its diagram, chart, table, or layout. The local model sees the actual page image together with its extracted text. Imported PNG/JPEG files have **Ask about this image**; selecting a single image document also supplies its pixels automatically.

Use the small **Attach image** button beside Send, or paste a screenshot into the question field. Up to three images/pages can accompany a question. Attachments stay visible for follow-up questions; remove them with × or start a **New chat**. Changing attachments or the attached page starts fresh conversation context. Attachments supplement the selected library sources; they also work without a selected document set. Answers cite the image/page, and saved conversations keep attached images offline, including in library backups.

The agent can also call the built-in `inspect_document_page` tool to view a PDF page or image within the selected documents. Rendering runs on demand in a worker, with a bounded cache keyed by original version and page. It does not analyze every image in the library in advance. Library search uses extracted text and filenames, not visual similarity. Shared JavaScript tools retain their existing read-only text permissions.

Vision uses the existing local model and needs no additional model download. Images are resized to at most 1,600 pixels on the longer side for inference; the full image original remains available in the evidence viewer. Tiny text, handwriting, dense tables, and precise chart values can be misread. Paste a closer crop when needed and check the cited original. Old visual citations report when an imported document has changed instead of silently showing a different version.

For feature-request summaries, Docent detects explicit request sentences, asks the local model to propose specific feature labels and literal matching phrases from up to 80 examples, then counts distinct matching documents across the detected requests. It shows those matching rules and exact quotations. These are heuristic historical counts, not votes or unique people, and do not establish whether a feature is still missing. Vague endorsements are excluded. Import a forum export's `topics/` folder to avoid counting generated reports and export scripts as source documents.

For questions such as **Who has requested thread support?**, supported Discourse Markdown exports use a direct attribution step. Docent checks up to 40 matching saved forum documents, keeps each author with their own post, excludes quoted replies, and shows up to 12 distinct display names with exact supporting excerpts. Short endorsements are included only in a matching feature-request topic. These are conservative examples, not an exhaustive list or a count of unique people; indirect requests and other export formats may be missed. No reindex or additional model is needed when the originals are already saved.

The assistant separates tool research from final answering. Its final step receives collected evidence with tools explicitly disabled. Unexpected tool syntax is withheld from both text and speech and triggers one recovery attempt; if recovery fails, the app reports the failure with the available sources. The built-in document reader supports bounded passage pagination, including re-reading evidence without losing its citation number.

Follow-up questions retain the previous answer's cited passages, re-read from the current library only when their source versions and selection still match. Citation numbers are remapped for each answer. Referential follow-ups search those documents first; tools can broaden the search when needed. Source windows keep the matched passage's location and label neighboring context, removing exact overlap without assuming any particular document format. Document drafts are held until citation numbers and substantive direct quotations have been checked; a broken reference or quotation gets one repair attempt. These are source-integrity checks, not proof that the model interpreted a passage correctly. The current small model can still confuse a status statement with an opinion or assign a statement to the wrong speaker.

Streaming bold text and citation links use distinct rendering identities so updating one fragment cannot duplicate earlier phrases on screen.

An answer containing only citation markers or known source headers gets one retry before it is displayed or spoken, unless the question explicitly asks for sources. If the retry still cannot produce an answer, Docent explains the failure and keeps the passages available. Known filenames, page/line labels and document IDs are excluded from factual-number warnings; a matching number used as an actual quantity is still checked.

The assistant has bounded read-only tools to list documents, read passages, and count literal phrase matches within the selected scope. **Tools** adds bundled and shareable JavaScript tools that run offline in an isolated interpreter with access only to the selected documents. Tools cannot access the network, shell, filesystem, or document instructions as commands. Imported tools start disabled and must pass their included tests before installation.

Use **Tools → Repositories** to add a public GitHub tool collection, review packages, and explicitly check updates. Versions are pinned and retained for rollback. **Import package**, **Make a local copy**, **Test examples**, and **Export package** support sharing without uploading your library. Tool runs retain their inputs, exact version, coverage, and evidence. See [the tool package specification and sharing guide](docs/tool-packages.md).

For bibliography questions in small selections (up to 20 documents), Docent extracts recognized numbered reference lists directly from indexed passages. Each entry links to its supporting passages, with the paper's reference numbering kept separate from the app's citation links. Other bibliography formats use normal retrieval.

Open a set and press **Topic map** to see its subjects in 3D. Each dot is a passage, and nearby dots mean similar things. Hover a dot to read it, or click it to keep it open. Hover a topic to see its summary, typical passages and what it connects to. Two topics are connected when documents discuss both, or when passages sit between them by meaning. Maps are built on demand in a worker; topic naming yields to active questions.

Embedded HTML and front matter in Markdown are ignored. JSON and XML files over 1 MB are treated as data exports and are not read.

If nothing relevant is found, the app says so instead of guessing. If the model answers without citing, the app shows a warning and the passages it was given.

## Offline library workflow

- **Search library** searches filenames and passage text without either model. Filter by set, filename, or indexing date.
- Conversations and saved answers are stored on this computer. **Conversations** searches past questions and answers. **Export** includes source passages and version hashes.
- Each question uses the current set and document selection. Changing sources or answer mode starts a fresh conversation on the next question, so earlier answers cannot steer retrieval toward the old sources. The previous conversation stays saved with its original scope. Follow-ups within the same selection keep their context.
- The evidence pane shows the full passage used, indexing date, and version. PDFs support zoom and selectable text. Older answers keep their quoted passage even after a document changes.
- **Library backup & recovery** exports the SQLite library, including original file copies, passages, conversations, and pronunciations. Models are not included. Restore retains a safety backup of the current library in the app data folder.
- Model startup errors never hide the library. Retry models from the setup/recovery banner while continuing to use search and saved conversations.
- Failed and skipped imports are reported per set. Removing a document excludes it from future rescans; adding that file explicitly includes it again.

Disk requirements grow with your library: original files are copied into the database. Backups contain private document content and should be stored accordingly. OCR is English-only and automatic on pages without a text layer; complex tables, handwritten pages and mixed text/image pages still need checking.

Citation links and exact quotes help inspect evidence; they do not independently prove a model's interpretation. Compare important claims against the displayed passages.

## Network use

The app connects to the internet for model downloads from Hugging Face (initial setup or the optional relevance model), update checks when you choose **Check for updates (online)**, and tool-repository operations you explicitly request. It does not automatically download the relevance model when upgrading an existing installation. There is no telemetry. Documents and questions stay on your computer. The model servers listen only on `127.0.0.1` and need a key generated at each launch.

## Licenses

The app is MIT licensed. llama.cpp is MIT licensed and ships with the app.

The models are downloaded separately and keep their own licenses. nomic-embed-text and [Qwen3-Reranker-0.6B](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) are Apache-2.0. **LFM3-Omni-2B uses the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/main/LICENSE), which does not license commercial use by organizations with $10M or more in annual revenue.** The MIT license on this code does not change that.

## Development

Requires Node 22.13 or newer.

```sh
npm install
npm run fetch:llama    # pinned llama-server for this machine
npm run dev
npm test
```

On macOS, `npm run dev` creates and reuses a locally signed **Docent.app** runtime in `node_modules/.cache/docent-runtime`, so the menu bar and Dock show Docent's name and icon. It leaves the installed Electron dependency and existing library location unchanged. The cache refreshes when Electron, the app version or icon changes. Restart a running development session with `npm run dev` to pick up the native branding. Standard electron-vite development arguments still work.

To work on the interface without models, use the fake server. It has no model and returns canned text:

```sh
DOCENT_LLAMA_BIN="$PWD/tests/fake-llama-server.mjs" npm run dev
```

### How it works

| Part | Where |
| --- | --- |
| Starts separate local servers for the LLM, embeddings and reranking | `src/main/sidecar.ts` |
| Parses and chunks files | `src/main/ingest/` |
| SQLite storage and FTS5 keyword search | `src/main/store.ts` |
| Hybrid keyword/vector search, then passage reranking | `src/main/retrieval.ts`, `src/main/reranker.ts` |
| Agent loop, prompts and the search tool | `src/main/agent.ts` |
| Topics, keywords and the t-SNE layout | `src/main/topics.ts` |
| Validates citations, prepares speech | `src/main/citations.ts` |
| Pinned model files | `src/main/models.ts` |
| Pinned llama.cpp build | `scripts/fetch-llama.mjs` |

## Releasing

Edit `.github/release-notes.md` and commit your changes first. Then run:

```sh
npm run release                  # 0.1.0 -> 0.1.1 (patch bump by default)
npm run release -- 0.2.0         # explicit version; a leading v is also accepted
npm run release -- --dry-run     # preview the next version without changing or publishing anything
npm run release -- 1.0.0 --dry-run
```

You can also invoke `node scripts/release.mjs [version] [--dry-run]` directly. Versions must be stable `major.minor.patch` values higher than the current version. The example `0.1.0` → `0.1.1` increments the patch component; use an explicit `0.2.0` for a minor release.

The script requires a clean Git checkout on a branch and an `origin` remote you can push to. It checks for existing tags and remote commits, runs typecheck, tests, and build, updates both `package.json` and `package-lock.json`, commits the version change, creates an annotated `vX.Y.Z` tag, and pushes that branch and tag together with an atomic push. It does not force-push or push unrelated tags. Dry runs skip checks that run commands or access the network, so they are safe while preparing uncommitted work.

That tag triggers `.github/workflows/release.yml`, which builds each platform into a draft release and publishes it once all of them succeed. The local command reports when the release is queued; watch **Actions → Release** for completion. Release text comes from the committed `.github/release-notes.md`. GitHub repository release/signing credentials stay in Actions; the local script only needs Git push access.

If validation fails, versions are unchanged. If a later commit, tag, or push fails, the script keeps the local work and prints recovery guidance. Pushing requires server support for atomic updates. Check the remote after a failed push before retrying. Once the local commit and tag exist, retry the push rather than bumping another version: `git push --atomic --no-follow-tags origin HEAD vX.Y.Z`.

macOS only applies updates to signed apps, so macOS auto-update needs an Apple Developer ID. Add these repository secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without them the macOS build is unsigned, and users must update by hand. Unsigned Windows builds update normally but show a SmartScreen warning on first install.

To move to a new llama.cpp build, update `BUILD` and the hashes in `scripts/fetch-llama.mjs`.

## Evaluation

`npm test` includes offline durability, stable citations, backup recovery, document scope, request counting, local OCR, visual source/cache isolation, and reranking validation, cancellation, caching and fallback. `npm run test:e2e` uses disposable profiles and fake model servers, including native app identity and menu actions, image import, PDF page selection, screenshot paste, reopening image citations after a reload, and reranker ordering, scope, failures and persisted settings.

To run an opt-in comparison against installed models:

```sh
DOCENT_REAL_MODEL_EVAL=1 npm test -- tests/model-eval.test.ts
```

The real-model suite includes a labeled diagram vision check. Set `DOCENT_VISION_SCREENSHOT` to the installer screenshot fixture (the Docent 0.1.0 window) to check small UI text, and `DOCENT_ATTENTION_PDF` to the *Attention Is All You Need* PDF for research-reference checks. Use `-t vision` with Vitest to run only the vision checks.

Set `DOCENT_MODEL_DIR` to the model directory outside the default macOS location. This small smoke test is not a full answer-quality benchmark. The corpus analysis intentionally exposes its grouping rules; inspect those rules before treating the counts as research results.

To compare hybrid retrieval with reranking using the actual local embedding and relevance models:

```sh
DOCENT_REAL_RERANK_EVAL=1 DOCENT_RERANKER_MODEL_DIR="/path/to/models" npm test -- tests/reranker-eval.test.ts
```

The relevance model directory defaults to `vendor/models`; the embedding directory uses `DOCENT_MODEL_DIR` as above. The suite starts the bundled runtime and checks 12 synthetic questions against 36 short passages, reporting first-result accuracy, reciprocal rank and latency. In the initial macOS arm64 run, first-result accuracy improved from 7/12 to 10/12 and mean reciprocal rank from 0.748 to 0.875, with about 1.3 seconds for enhanced retrieval. One question ranked worse. This is a small regression fixture, not a benchmark of the full document library or generated answer quality; longer passages and slower machines can take more time.

`tests/answer-stream.test.ts` reproduces the leaked XML tool-call failure, including fragmented streaming, speech, bounded recovery and document pagination. `tests/answer-quality-e2e.mjs` exercises that failure and attributed forum answers through Electron. To replay the reported forum question against a **disposable SQLite backup** of an indexed library, set `DOCENT_FORUM_EVAL_SNAPSHOT=/path/to/copy.db` and run `npm test -- tests/forum-eval.test.ts`. Never point this evaluation at the live library: its database and tool manager may create evaluation records.
