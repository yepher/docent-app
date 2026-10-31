// Drives the built Electron app against the fake model server. It checks the real main process,
// preload bridge, database, PDF parsing and interface, but no real model behavior.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'docent-e2e-'));
const doc = join(work, 'zebras.md');
writeFileSync(doc, 'Zebras graze at dawn on the open plain.\n');

const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, 'profile')}`],
  cwd: root,
  env: { ...process.env, DOCENT_LLAMA_BIN: join(root, 'tests/fake-llama-server.mjs') },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => {
    console.error('Page error:', err);
    process.exitCode = 1;
  });
  await page.setViewportSize({ width: 1180, height: 760 });

  await page.getByPlaceholder('New set name').fill('Wildlife');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /Wildlife/ }).waitFor();

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, doc);
  await page.getByRole('button', { name: 'Add files' }).click();
  await page.getByText('1 file').waitFor();
  await page.getByText('Answering from: Wildlife').waitFor();

  await page.getByLabel('Speak replies').uncheck();
  await page.getByPlaceholder('Ask something').fill('When do zebras graze?');
  await page.getByRole('button', { name: 'Send' }).click();

  const cite = page.locator('.message.assistant .cite');
  await cite.first().waitFor();
  const answer = await page.locator('.message.assistant .text').innerText();
  assert.match(answer, /in your documents/);
  assert.doesNotMatch(answer, /\[9\]/, 'invented citation should be removed');

  await cite.first().click();
  await page.getByText('Zebras graze at dawn').first().waitFor();
  await page.getByText('When do zebras graze?').waitFor();
  // A trial click fails if anything, such as the source panel, covers the button.
  await page.getByPlaceholder('Ask something').fill('next question');
  await page.getByRole('button', { name: 'Send' }).click({ trial: true, timeout: 5000 });
  await page.screenshot({ path: process.argv[2] ?? join(work, 'app.png') });

  // Pronunciation: select a word in the answer, save a respelling, see it listed.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByPlaceholder('Ask something').fill('');
  await page.locator('.message.assistant .text').first().evaluate((el) => {
    const node = el.firstChild;
    const start = node.textContent.indexOf('answer');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'answer'.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Set pronunciation' }).click();
  await page.getByPlaceholder('Spell it how it sounds').fill('an sir');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Pronunciations (1)').click();
  await page.getByText('sounds like an sir').waitFor();

  // Speech on: the second sentence must wait for the first one's audio to play.
  await page.getByLabel('Speak replies').check();
  await page.getByPlaceholder('Ask something').fill('When do zebras graze again?');
  await page.getByRole('button', { name: 'Send' }).click();
  const paced = page.locator('.message.assistant .text').last();
  await paced.getByText('The answer is in your documents').waitFor();
  assert.doesNotMatch(await paced.innerText(), /ignored/, 'second sentence should wait for its speech');
  await paced.getByText('An invented source is ignored').waitFor();
  await page.getByRole('button', { name: 'Send' }).waitFor();
  await page.getByPlaceholder('Ask something').fill('');
  await page.getByLabel('Speak replies').uncheck();

  // Unticking the only set must take documents out of the answer path.
  await page.getByLabel('Use Wildlife').click();
  await page.getByText('General chat').waitFor();
  console.log('E2E passed');
} finally {
  await app.close();
}
