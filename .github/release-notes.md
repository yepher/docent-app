Docent is a voice and chat assistant that answers from your own documents, with citations. It runs entirely on your computer.

## Install

| Your computer | Download |
| --- | --- |
| Mac with Apple Silicon (M1 or later) | `docent-*-mac-arm64.dmg` |
| Mac with Intel | `docent-*-mac-x64.dmg` |
| Windows | `docent-*-win-x64.exe` |
| Linux | `docent-*-linux-x86_64.AppImage` or the `.deb` |

No developer tools are needed. On first run the app downloads about 1.7 GB of models, so you need about 2 GB of free disk space. As a guide, you also need 8 GB of memory.

**Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**. The app is not yet code signed for Windows.

**Linux AppImage:** make the file executable, then open it. On some distributions you also need to install `libfuse2`.

## Test build

This is an early build. Windows and Linux have not yet been tried on real machines. Please report problems on [GitHub Issues](https://github.com/yepher/docent-app/issues).

LFM3-Omni-2B is downloaded separately under the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/blob/main/LICENSE), which does not license commercial use by organizations with $10M or more in annual revenue.
