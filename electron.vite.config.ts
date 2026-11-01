import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

/** pdf.js fetches these at runtime, so they go in the renderer's public folder for dev and build alike. */
function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    buildStart() {
      for (const dir of ["cmaps", "iccs", "standard_fonts", "wasm"]) {
        cpSync(
          resolve("node_modules/pdfjs-dist", dir),
          join(resolve("src/renderer/public/pdfjs"), dir),
          { recursive: true },
        );
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "tool-worker",
        writeBundle() {
          cpSync(
            resolve("src/main/tools/worker.mjs"),
            resolve("out/main/tool-worker.mjs"),
          );
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "library-worker": resolve("src/main/library-worker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preloads must be CommonJS.
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: { plugins: [react(), pdfjsAssets()] },
});
