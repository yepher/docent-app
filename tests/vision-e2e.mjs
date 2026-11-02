// Real Electron UI, IPC, saved originals and workers; fake inference checks plumbing, not accuracy.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { _electron as electron } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "docent-vision-e2e-"));
const chatLog = join(work, "chat.jsonl");
const canvas = createCanvas(700, 400),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 700, 400);
ctx.fillStyle = "#17646b";
ctx.fillRect(40, 80, 260, 210);
ctx.fillStyle = "#e1ac42";
ctx.fillRect(400, 80, 260, 210);
ctx.fillStyle = "white";
ctx.font = "bold 32px sans-serif";
ctx.fillText("FILTER", 100, 200);
ctx.fillText("PUMP", 465, 200);
const png = canvas.toBuffer("image/png");
const imagePath = join(work, "diagram.png");
writeFileSync(imagePath, png);
const jpegPath = join(work, "diagram.jpeg");
writeFileSync(jpegPath, canvas.toBuffer("image/jpeg"));
const pdfPath = join(work, "manual.pdf");
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
for (const [i, text] of [
  "First page describes the filter.",
  "Second page describes the pump.",
].entries()) {
  const stream = `0.1 0.4 0.7 rg 40 80 220 160 re f BT /F1 16 Tf 40 260 Td (${text}) Tj ET`;
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  );
}
let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((o, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
writeFileSync(pdfPath, pdf);
const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, "profile")}`],
  cwd: root,
  env: {
    ...process.env,
    DOCENT_LLAMA_BIN: join(root, "tests/fake-llama-server.mjs"),
    DOCENT_TEST_CHAT_LOG: chatLog,
  },
});
try {
  const page = await app.firstWindow();
  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /Content Security Policy/i.test(message.text())
    )
      problems.push(message.text());
  });
  await page.setViewportSize({ width: 1250, height: 900 });
  await page.waitForFunction(
    async () => (await window.api.runtime.state()).phase === "ready",
  );
  // Import PNG, JPEG and PDF through the same drop chooser used by the Dock.
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["dragEnter", "dragOver", "drop"])
    await cdp.send("Input.dispatchDragEvent", {
      type,
      x: 700,
      y: 250,
      data: {
        items: [],
        files: [imagePath, jpegPath, pdfPath],
        dragOperationsMask: 1,
      },
    });
  const chooser = page.getByRole("dialog", { name: "Add to Docent" });
  await chooser.getByLabel("Import set name").fill("Visual manuals");
  await chooser.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByText("3 files", { exact: true }).waitFor();
  const [set] = await page.evaluate(() => window.api.sets.list());
  assert.equal(set.failedCount, 0);
  await page.getByRole("button", { name: /Visual manuals/ }).click();
  await page.getByRole("button", { name: "diagram.png", exact: true }).click();
  await page.getByRole("button", { name: "Read offline", exact: true }).click();
  await page.locator(".visual-image img").waitFor();
  await page
    .getByRole("button", { name: "Ask about this image", exact: true })
    .click();
  const ask = async (question) => {
    await page.getByPlaceholder("Ask something").fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator(".message.assistant .cite").last().waitFor();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  };
  await ask("What is on this image?");
  await page.locator(".message.assistant .cite").last().click();
  assert.equal(await page.locator(".visual-image img").count(), 1);
  rmSync(imagePath); // Citations keep working from the saved original.
  await page
    .locator(".source-detail")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.locator(".message.assistant .cite").last().click();
  await page.locator(".visual-image img").waitFor();
  // Navigate a PDF, then attach the page actually displayed (not the original citation's page).
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("button", { name: "manual.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Read offline", exact: true }).click();
  await page.getByText("Page 1 of 2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByText("Page 2 of 2", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Ask about this page", exact: true })
    .click();
  await ask("Explain the second page diagram.");
  const latest = () =>
    readFileSync(chatLog, "utf8").trim().split("\n").map(JSON.parse).at(-1);
  let request = latest();
  assert.ok(
    request
      .at(-1)
      .content.some(
        (p) =>
          p.type === "image_url" &&
          p.image_url.url.startsWith("data:image/png;base64,"),
      ),
  );
  assert.match(
    JSON.stringify(request),
    /Visual source \[1\]: manual.pdf, page 2/,
  );
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Ask about this page", exact: true })
    .click();
  await ask("Explain the first page diagram.");
  request = latest();
  assert.doesNotMatch(
    JSON.stringify(request),
    /Explain the second page diagram/,
    "changing a page resets stale conversation history",
  );
  // Paste an actual File via the browser's paste event without changing the system clipboard.
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByPlaceholder("Ask something").evaluate(
    (input, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([Uint8Array.from(bytes)], "screenshot.png", {
          type: "image/png",
        }),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [...png],
  );
  await page.getByLabel("Remove attachment screenshot.png").waitFor();
  await page.getByLabel("Use Visual manuals").click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Use Visual manuals"]').checked);
  await ask("What does this screenshot show?");
  const source = await page.evaluate(async () => {
    const c = (await window.api.chat.conversations()).find(
      (c) => c.title === "What does this screenshot show?",
    );
    return c?.messages.find((m) => m.role === "assistant")?.citations?.[0];
  });
  assert.ok(source.visual.attachmentId);
  await page.reload();
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^What does this screenshot show/ })
    .click();
  await page.locator(".message.assistant .cite").last().click();
  await page.locator(".visual-image img").waitFor();
  assert.equal(
    await page
      .locator(".visual-image img")
      .evaluate((image) => image.naturalWidth),
    700,
  );
  await page.screenshot({ path: join(work, "vision.png") });
  // File picker and validation also work without a local file path in the renderer.
  await page.getByLabel("Remove attachment screenshot.png").click();
  await page
    .getByLabel("Choose images")
    .setInputFiles({
      name: "photo.jpeg",
      mimeType: "image/jpeg",
      buffer: canvas.toBuffer("image/jpeg"),
    });
  await page.getByLabel("Remove attachment photo.jpeg").waitFor();
  await page
    .getByLabel("Choose images")
    .setInputFiles({
      name: "invalid.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    });
  await page
    .getByRole("alert")
    .filter({ hasText: "Only PNG and JPEG" })
    .waitFor();
  assert.deepEqual(problems, []);
  console.log(
    `Vision Electron E2E passed; screenshot: ${join(work, "vision.png")}`,
  );
} finally {
  await app.close();
}
