# Docent

A desktop voice and chat agent that runs entirely on your computer. Point it at your files, group them into document sets, and ask questions. Answers come from the sets you select and cite where each fact was found.

It runs [LFM3-Omni-2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B) through [llama.cpp](https://github.com/ggml-org/llama.cpp). Your documents, questions and voice stay on your machine.

## Install

Download the build for your platform from [Releases](https://github.com/yepher/docent-app/releases): `.dmg` for macOS, `.exe` for Windows, `.AppImage` or `.deb` for Linux. The app updates itself from new releases, except the `.deb`, which you update by installing the newer package.

On first run it downloads about 1.7 GB of models and verifies them. You need about 2 GB of free disk space and, as a guide, 8 GB of memory.

## Using it

1. Create a document set in the sidebar and add files or folders.
2. Tick the sets each question should use. Choose **General chat** explicitly for answers without document evidence. Empty or failed document sets never implicitly select general chat.
3. Type, or press **Speak**, talk, and press **Stop**.
4. Press a numbered citation to see the source. PDFs open at the cited page; other files show the passage.

Speech is off by default. With **Speak replies** on, text streams immediately and evidence appears as soon as generation finishes, independently of playback.

To correct how a word is said, select it in an answer and choose **Set pronunciation**. Spell it how it sounds, press **Preview** to hear it, then **Save**. It applies to all future speech, and changes only the voice, not the written answer. In the sidebar's **Pronunciations** list, use **Edit** to revise a saved pronunciation and **Test** to hear either the saved pronunciation or your unsaved edit. **Cancel** keeps the saved value.

Press a file in a set to open it in its default app or show it in Finder, File Explorer or your file manager. Scripts and programs can only be shown in their folder, so opening one never runs it.

Supported files: PDF, DOCX, Markdown, plain text, HTML, CSV, JSON, YAML and common source code. Scanned PDF pages are read with bundled English OCR, entirely offline. Originals stay where they are; a copy and indexed passages are stored in the local library. **Rescan** picks up changes. Unavailable sources and failed refreshes retain the last successful version and show a warning.

For feature-request summaries, Docent detects explicit request sentences, asks the local model to propose specific feature labels and literal matching phrases from up to 80 examples, then counts distinct matching documents across the detected requests. It shows those matching rules and exact quotations. These are heuristic historical counts, not votes or unique people, and do not establish whether a feature is still missing. Vague endorsements are excluded. Import a forum export's `topics/` folder to avoid counting generated reports and export scripts as source documents.

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

The app connects to the internet for two things: downloading models from Hugging Face on first run, and checking GitHub Releases when you choose **Check for updates (online)**. Update checks do not run automatically. There is no telemetry. The model servers listen only on `127.0.0.1` and need a key generated at each launch.

## Licenses

The app is MIT licensed. llama.cpp is MIT licensed and ships with the app.

The models are downloaded separately and keep their own licenses. nomic-embed-text is Apache-2.0. **LFM3-Omni-2B uses the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/main/LICENSE), which does not license commercial use by organizations with $10M or more in annual revenue.** The MIT license on this code does not change that.

## Development

Requires Node 22.13 or newer.

```sh
npm install
npm run fetch:llama    # pinned llama-server for this machine
npm run dev
npm test
```

To work on the interface without models, use the fake server. It has no model and returns canned text:

```sh
DOCENT_LLAMA_BIN="$PWD/tests/fake-llama-server.mjs" npm run dev
```

### How it works

| Part | Where |
| --- | --- |
| Starts `llama-server` for the LLM and for embeddings | `src/main/sidecar.ts` |
| Parses and chunks files | `src/main/ingest/` |
| SQLite storage and FTS5 keyword search | `src/main/store.ts` |
| Hybrid keyword and vector search | `src/main/retrieval.ts` |
| Agent loop, prompts and the search tool | `src/main/agent.ts` |
| Topics, keywords and the t-SNE layout | `src/main/topics.ts` |
| Validates citations, prepares speech | `src/main/citations.ts` |
| Pinned model files | `src/main/models.ts` |
| Pinned llama.cpp build | `scripts/fetch-llama.mjs` |

## Releasing

1. Bump `version` in `package.json`.
2. Tag and push: `git tag v0.2.0 && git push --tags`.

`.github/workflows/release.yml` builds each platform into a draft release and publishes it once all of them succeed. Edit `.github/release-notes.md` first; it becomes the release text.

macOS only applies updates to signed apps, so macOS auto-update needs an Apple Developer ID. Add these repository secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without them the macOS build is unsigned, and users must update by hand. Unsigned Windows builds update normally but show a SmartScreen warning on first install.

To move to a new llama.cpp build, update `BUILD` and the hashes in `scripts/fetch-llama.mjs`.

## Evaluation

`npm test` includes offline durability, stable citations, backup recovery, document scope, request counting and a scanned-PDF OCR fixture. `npm run test:e2e` uses a disposable profile and fake model servers.

To run an opt-in comparison against installed models:

```sh
DOCENT_REAL_MODEL_EVAL=1 npm test -- tests/model-eval.test.ts
```

Set `DOCENT_MODEL_DIR` to the model directory outside the default macOS location. This small smoke test is not a full answer-quality benchmark. The corpus analysis intentionally exposes its grouping rules; inspect those rules before treating the counts as research results.
