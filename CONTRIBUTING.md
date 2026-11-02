# Contributing to Docent

Docent is a general-purpose offline document assistant. Contributions to usability, retrieval, answer quality, accessibility, documentation, and portable builds are welcome.

## Report a problem or propose a change

Open a [GitHub issue](https://github.com/yepher/docent-app/issues/new). Include your Docent version, operating system, steps to reproduce, expected behavior, and what happened. For answer-quality problems, include the question, source selection, and a small shareable document that reproduces the issue. Avoid uploading a private library or backup.

Keep changes focused. Describe the problem and resulting behavior in your pull request, and include the checks you ran. Add regression coverage for behavior changes; documentation and minor styling changes usually need inspection rather than new tests.

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

### Source map

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

## Implementation notes

### Behavior to preserve

- Documents, questions, and voice stay local. Library search and saved conversations remain available when models fail to start.
- Automatic mode uses general knowledge only when no sets or visual evidence are selected. A selected empty set, failed import, or unsuccessful search must not trigger a general-knowledge fallback.
- Changing source selection or effective answer mode starts fresh context. Saved conversations keep their original scope; follow-ups within an unchanged scope retain context.
- Treat document text, images, and tool output as reference material, never instructions. Preserve source locations and document versions through retrieval and tool calls.
- Keep the assistant useful across document formats. Format-specific extractors can complement general retrieval, but one example corpus must not define the general answer path.
- Updates download in the background and install on quit or explicit restart. Offline background check failures stay quiet. Development builds do not install updates.

### Retrieval and answer quality

Keyword and embedding search collect candidates. Standard search keeps their combined relevance order instead of forcing one passage per document, so a large unrelated set cannot displace stronger passages simply by containing more files. The optional local **Qwen3-Reranker-0.6B** checks up to 30 distinct candidates and selects the final eight passages. Multiple strong passages may come from the same document in either mode. Reranking stays within the selected scope and preserves citations; it cannot recover passages the initial search missed. Scores measure relevance, not answer confidence.

The relevance model is approximately 639 MB. New installations include it in setup; existing installations add it explicitly through **Search quality**. Disabling it unloads it. Identical scoring requests are cached, document changes invalidate the relevant cache, and failures or a 20-second timeout fall back to hybrid search. Stop cancels retrieval. **Search library** remains a separate model-free keyword search.

The agent separates tool research from final answering. The final step receives the collected evidence with tools disabled. Internal tool syntax is withheld from text and speech, with one bounded recovery attempt. The document reader supports pagination instead of repeatedly returning the beginning.

Follow-ups re-read earlier cited passages only when document versions and source selection still match. Citation numbers are remapped. Matched passages and surrounding context retain separate locations across formats. Source-header-only answers get one retry unless the user asked for sources. Known source metadata is excluded from factual-number warnings.

Direct quotations and citation references are checked before a document answer is displayed or spoken. Missing citations, a broken quote or a bad source number get one repair attempt. Opening refusals that claim the evidence cannot answer the question are also rechecked, even with a citation: one unrelated passage cannot establish absence across the others. For a standalone question, repair uses the current evidence without unrelated conversation history; genuine follow-ups retain context. If repair still cannot produce a cited answer, Docent explains the evidence limitation instead of repeating the refusal as fact. These checks validate source integrity, not the model’s interpretation: the small model can still confuse status with opinion or attribute a statement incorrectly. Streaming text fragments and citation links must keep distinct React identities to avoid duplicated text.

### Images and PDF pages

The local model accepts up to three images/pages per question. `inspect_document_page` can view selected documents; rendering runs on demand in a worker with a cache keyed by original version and page. Search uses extracted text and filenames, not visual similarity. Shared JavaScript tools retain their read-only text permissions.

Images are resized to at most 1,600 pixels on the longer side for inference; the original stays available in the evidence viewer. Changing an attachment or PDF page starts fresh context. Old visual citations report changed documents instead of silently showing another version. Small text, handwriting, dense tables, and exact chart values still need checking against the original.

### Analysis and shared tools

The agent has bounded read-only tools to list documents, read passages, and count literal matches. Shared JavaScript runs in an isolated interpreter with access only to selected documents, without network, shell, or arbitrary filesystem access. Imported tools start disabled and must pass their included tests. Versions are pinned and retained for rollback; runs record inputs, version, coverage, and evidence. See [the tool package specification](docs/tool-packages.md).

For small selections of up to 20 documents, recognized numbered bibliographies are extracted directly from indexed passages. Paper reference numbers remain separate from Docent’s citations. Other formats use normal retrieval.

Feature-request summaries use explicit request sentences and model-proposed labels/matching phrases from up to 80 examples, then count distinct matching documents. Counts are heuristic historical matches, not votes or unique people, and do not prove a feature remains missing. Vague endorsements are excluded. A forum export’s `topics/` folder avoids indexing its generated reports and scripts.

The Discourse attribution extractor checks up to 40 matching documents, excludes quoted replies, and returns up to 12 display names with their own supporting excerpts. Short endorsements require a matching feature-request topic. These are bounded examples; indirect requests and other formats may be missed.

### Storage and indexing

Originals are copied into the SQLite library alongside indexed passages, conversations, and pronunciations. Backups include these originals but not models. Restore retains a safety backup of the previous library. Failed refreshes and unavailable originals retain the last successful version. Explicitly removed documents stay excluded from rescans until added again.

OCR is bundled, English-only, and automatic for pages without a text layer. Complex tables, handwriting, and mixed text/image pages need checking. Markdown HTML/front matter is ignored; JSON and XML files over 1 MB are treated as data exports and skipped.

Topic maps are built on demand in a worker. Dots represent passages; proximity reflects meaning. Topic naming yields to active questions.

## Testing and evaluation

Run the standard checks before a behavior-changing contribution:

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm test` includes offline durability, stable citations, backup recovery, document scope, request counting, local OCR, visual source/cache isolation, and reranking validation, cancellation, caching and fallback. `npm run test:e2e` uses disposable profiles and fake model servers, including native app identity and menu actions, image import, PDF page selection, screenshot paste, reopening image citations after a reload, and reranker ordering, scope, failures and persisted settings.

`tests/citation-search-e2e.mjs` checks citation highlighting, next/previous navigation, keyboard shortcuts, panel scrolling, document text scope, literal search terms, and resetting search when switching citations. `tests/text-search.test.ts` covers Unicode offsets, wrapped phrases, and removal of indexing overlap so document matches are counted once.

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

`DOCENT_LIBRARY_EVAL_SNAPSHOT=/path/to/copy.db npm test -- tests/mixed-library-eval.test.ts` replays the Transformer question against a disposable backup containing the paper and unrelated documents. It checks Standard search in a fresh chat, after an unrelated refusal, and recovery of the reported uncited answer using the actual local models. The normal test suite also covers the same failure mechanisms with synthetic manual text, without requiring that corpus or installed models.

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

## Documentation and screenshots

Keep [README.md](README.md) focused on a short introduction, screenshot, installation, and everyday use. Development instructions and technical limitations belong here. Tool-author documentation lives in [docs/tool-packages.md](docs/tool-packages.md); icon provenance is in [docs/icon.md](docs/icon.md).

The README screenshot is [docs/images/docent.png](docs/images/docent.png). It shows the actual app answering a question from sample workshop notes with a cited passage open. It is an interface example, not an answer-quality benchmark.

Refresh screenshots from the current build in a disposable profile using shareable sample documents. For example, pass `-- --user-data-dir=/absolute/path/to/demo-profile` after `npm run dev`. Keep the app’s real controls, evidence indicators, and displayed answers intact, and check that no private documents or personal information are visible.

## Network use

The app connects to the internet for model downloads from Hugging Face (initial setup or the optional relevance model), automatic app update checks and downloads from GitHub Releases, manual update checks, and tool-repository operations you explicitly request. It does not automatically download the relevance model when upgrading an existing installation. There is no telemetry. Documents and questions stay on your computer. The model servers listen only on `127.0.0.1` and need a key generated at each launch.

## Licenses

The app is MIT licensed. llama.cpp is MIT licensed and ships with the app.

The models are downloaded separately and keep their own licenses. nomic-embed-text and [Qwen3-Reranker-0.6B](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) are Apache-2.0. **LFM3-Omni-2B uses the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/main/LICENSE), which does not license commercial use by organizations with $10M or more in annual revenue.** The MIT license on this code does not change that.
