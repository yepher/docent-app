// macOS gets a private, branded runtime. Never patch the installed Electron.app or a running copy.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export function developmentElectron() {
  const electron = require("electron");
  if (process.platform !== "darwin") return electron;
  const source = resolve(dirname(electron), "../..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plistBytes = readFileSync(join(source, "Contents/Info.plist"));
  const icon = join(root, "build/icon.icns");
  const fingerprint = createHash("sha256")
    .update("docent-development-runtime-v3")
    .update(plistBytes)
    .update(pkg.version)
    .update(readFileSync(icon))
    .digest("hex")
    .slice(0, 20);
  const cache = join(root, "node_modules/.cache/docent-runtime");
  const target = join(cache, fingerprint);
  // Keep the binary name: Electron uses it to recognize an unpackaged development app.
  const executable = join(target, "Docent.app/Contents/MacOS/Electron");
  if (existsSync(join(target, "ready")) && existsSync(executable))
    return executable;
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(cache, ".preparing-"));
  try {
    const bundle = join(staging, "Docent.app");
    cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
    const plist = join(bundle, "Contents/Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleDisplayName: "Docent",
      CFBundleName: "Docent",
      CFBundleExecutable: "Electron",
      CFBundleIdentifier: "com.yepher.docent.development",
      CFBundleShortVersionString: pkg.version,
      CFBundleVersion: pkg.version,
      CFBundleIconFile: "docent.icns",
      NSMicrophoneUsageDescription:
        "Docent uses the microphone for voice questions. Audio is processed on this computer.",
    }))
      execFileSync("/usr/bin/plutil", [
        "-replace",
        key,
        "-string",
        value,
        plist,
      ]);
    cpSync(icon, join(bundle, "Contents/Resources/docent.icns"));
    // The npm runtime may omit resource seals. Sign the private copy and its nested code locally.
    // Retain helper entitlements; no developer signing identity is required.
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--preserve-metadata=entitlements,flags,runtime",
        bundle,
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", bundle],
      { stdio: "pipe" },
    );
    writeFileSync(join(staging, "ready"), fingerprint);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (!existsSync(join(target, "ready"))) throw error;
    }
    return executable;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// electron-vite owns hot reload, its child process and shutdown handling.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.env.ELECTRON_EXEC_PATH =
    process.env.ELECTRON_EXEC_PATH || developmentElectron();
  const vitePackagePath = require.resolve("electron-vite/package.json");
  const vitePackage = JSON.parse(readFileSync(vitePackagePath, "utf8"));
  process.argv.splice(2, 0, "dev");
  await import(
    pathToFileURL(
      join(dirname(vitePackagePath), vitePackage.bin["electron-vite"]),
    ).href
  );
}
