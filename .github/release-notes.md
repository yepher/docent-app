Docent is a voice and chat assistant that answers from your own documents, with citations. It runs entirely on your computer.

## App menus

- Docent menus include document and folder imports, standard editing and window controls, and About Docent.
- Help opens the GitHub project, releases, or a new issue form in your browser.
- The macOS development launcher now uses Docent's name and icon in the menu bar and Dock.

## Better document search

- A local relevance model reranks the best keyword and embedding matches before the assistant answers. It stays within your selected sources and preserves citations.
- Open **Search quality** in the sidebar to enable or disable enhanced retrieval. Existing installations can add the 639 MB model once; your current models keep working offline until then.
- New installations include the relevance model in setup. Scoring failures fall back to standard search, and Stop cancels retrieval.

## Answer reliability

- Retries responses that contain only source headers or citation markers, with a clear fallback if the model still cannot answer. Source metadata no longer produces spurious factual-number warnings.
- Fixes repeated bold text around citation links while an answer streams.
- Follow-ups retain version-checked source passages and remap citation numbers. Matched passages and surrounding context keep separate locations across document formats.
- Checks direct quotations against their cited passages before display or speech, with one repair attempt for a broken quote or source number. These checks do not guarantee correct interpretation by the model.
- Prevents internal tool-call syntax from appearing or being spoken as an answer. Final answers use a separate evidence context, with one bounded recovery attempt if the model emits control syntax.
- Reads later document passages with explicit pagination instead of repeatedly returning the beginning.
- Questions such as “Who has requested thread support?” can extract attributed requests and endorsements from saved Discourse posts, with author names, exact excerpts and citations. Results are bounded examples, with quoted replies excluded.

## Visual document questions

- Open an offline PDF, navigate to a page, and choose **Ask about this page** to ask about diagrams, charts, tables, or layout.
- Import PNG/JPEG images, attach images beside Send, or paste a screenshot into the question. Up to three images/pages can accompany a question and its follow-ups.
- Answers link to image/page evidence. Pasted images stay available in saved conversations and library backups.
- Uses the existing local model, with no extra model download. Pages are prepared on demand. Check small labels and exact chart values against the original; a closer crop can help.

## Install

| Your computer | Download |
| --- | --- |
| Mac with Apple Silicon (M1 or later) | `docent-*-mac-arm64.dmg` |
| Mac with Intel | `docent-*-mac-x64.dmg` |
| Windows | `docent-*-win-x64.exe` |
| Linux | `docent-*-linux-x86_64.AppImage` or the `.deb` |

No developer tools are needed. On first run the app downloads about 2.3 GB of models, so allow at least 3 GB of free disk space plus space for your documents. As a guide, you also need 8 GB of memory.

**Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**. The app is not yet code signed for Windows.

**Linux AppImage:** make the file executable, then open it. On some distributions you also need to install `libfuse2`.

## Test build

This is an early build. Windows and Linux have not yet been tried on real machines. Please report problems on [GitHub Issues](https://github.com/yepher/docent-app/issues).

LFM3-Omni-2B is downloaded separately under the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/main/LICENSE), which does not license commercial use by organizations with $10M or more in annual revenue.
