# Docent

A desktop voice and chat agent that runs entirely on your computer. Point it at your files, group them into document sets, and ask questions. Answers come from the sets you select and cite where each fact was found.

It runs [LFM3-Omni-2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B) through [llama.cpp](https://github.com/ggml-org/llama.cpp). Your documents, questions and voice stay on your machine.

## Install

Download the build for your platform from [Releases](https://github.com/yepher/docent-app/releases): `.dmg` for macOS, `.exe` for Windows, `.AppImage` or `.deb` for Linux. The app updates itself from new releases, except the `.deb`, which you update by installing the newer package.

On first run it downloads about 1.7 GB of models and verifies them. You need about 2 GB of free disk space and, as a guide, 8 GB of memory.

## Using it

1. Create a document set in the sidebar and add files or folders.
2. Tick the sets each question should use. With none ticked, it is a general chat.
3. Type, or press **Speak**, talk, and press **Stop**.
4. Press a numbered citation to see the source. PDFs open at the cited page; other files show the passage.

With **Speak replies** on, each sentence appears as it is spoken.

To correct how a word is said, select it in an answer and choose **Set pronunciation**. Spell it how it sounds, press **Preview** to hear it, then **Save**. It applies to all future speech, and changes only the voice, not the written answer. Manage saved words under **Pronunciations** in the sidebar.

Press a file in a set to open it in its default app or show it in Finder, File Explorer or your file manager. Scripts and programs can only be shown in their folder, so opening one never runs it.

Supported files: PDF, DOCX, Markdown, plain text, HTML, CSV, JSON, YAML and common source code. PDFs need a text layer; scanned pages are not read. Files stay where they are, and **Rescan** picks up changes.

Questions about a whole set, such as "what do people ask for most?", are answered differently. Questions about what people most often request, complain about or report as problems are answered differently. The app finds every sentence of that kind, counts the documents they appear in by topic, and quotes people directly. It does not name a single top item, because that would need each one read and tallied.

Open a set and press **Topic map** to see its subjects in 3D. Each dot is a passage, and nearby dots mean similar things. Hover a dot to read it, or click it to keep it open. Hover a topic to see its summary, typical passages and what it connects to. Two topics are connected when documents discuss both, or when passages sit between them by meaning. The local model writes topic names and summaries in the background, so they appear a little after the map.

Embedded HTML and front matter in Markdown are ignored. JSON and XML files over 1 MB are treated as data exports and are not read.

If nothing relevant is found, the app says so instead of guessing. If the model answers without citing, the app shows a warning and the passages it was given.

## Network use

The app connects to the internet for two things: downloading models from Hugging Face on first run, and checking GitHub Releases for updates. There is no telemetry. The model servers listen only on `127.0.0.1` and need a key generated at each launch.

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
