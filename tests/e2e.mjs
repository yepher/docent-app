// Drives the built Electron app against the fake model server. It checks the real main process,
// preload bridge, database, PDF parsing and interface, but no real model behavior.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'docent-e2e-'));
const chatLog = join(work, 'model-requests.jsonl');
const ttsLog = join(work, 'speech-requests.jsonl');
const modelRequests = () => readFileSync(chatLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const doc = join(work, 'zebras.md');
writeFileSync(doc, 'Zebras graze at dawn on the open plain.\n');
const pdf = join(work, 'attention.pdf');
writeFileSync(pdf, tinyPdf(['Attention research is referenced on the first page.', 'Other research is referenced on the second page.']));
const problems = [];
const forum = join(work, 'forum');
mkdirSync(forum);
const subjects = ['fillet chamfer edge rounding', 'export stl mesh printing', 'pencil ipad stylus sketching', 'license billing subscription'];
for (let i = 0; i < 24; i++) {
  writeFileSync(join(forum, `post-${i}.md`), `<p>${subjects[i % 4]} ${subjects[(i + 1) % 4]} note ${i}.</p>\n\n<p>${subjects[i % 4]} again.</p>\n`);
}

/** Builds a real, minimal PDF with one line of text per page. */
function tinyPdf(pages) {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';
    objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const app = await electron.launch({
  args: [root, `--user-data-dir=${join(work, 'profile')}`],
  cwd: root,
  env: { ...process.env, DOCENT_LLAMA_BIN: join(root, 'tests/fake-llama-server.mjs'), DOCENT_TEST_CHAT_LOG: chatLog, DOCENT_TEST_TTS_LOG: ttsLog },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => {
    console.error('Page error:', err);
    process.exitCode = 1;
  });
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || /Content Security Policy|fake worker|Warning: .*(font|wasm|fetch|CMap)/i.test(text)) {
      console.error('Console:', text);
      problems.push(text);
    }
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

  // Exercise the real preload/IPC path while keeping the user's system clipboard untouched.
  await app.evaluate(({ clipboard }) => {
    globalThis.copiedTexts = [];
    globalThis.failClipboard = false;
    clipboard.writeText = (text) => {
      if (globalThis.failClipboard) throw new Error('Simulated clipboard failure');
      globalThis.copiedTexts.push(text);
    };
  });
  const answerActions = page.locator('.message.assistant .actions').first();
  await answerActions.getByRole('button', { name: 'Copy', exact: true }).click();
  await answerActions.getByRole('button', { name: 'Copied!', exact: true }).waitFor();
  const copiedAnswer = await app.evaluate(() => globalThis.copiedTexts.at(-1));
  assert.equal(copiedAnswer, 'The answer is in your documents [1]. An invented source is ignored.');
  await page.getByRole('button', { name: 'Copy with sources', exact: true }).click();
  await page.locator('.scope-options').getByRole('button', { name: 'Copied!', exact: true }).waitFor();
  const copiedSources = await app.evaluate(() => globalThis.copiedTexts.at(-1));
  assert.ok(copiedSources.includes('Question: When do zebras graze?'));
  assert.ok(copiedSources.includes(`Answer: ${copiedAnswer}`));
  assert.match(copiedSources, /\[1\] zebras\.md, line 1\nZebras graze at dawn on the open plain\./);
  assert.match(copiedSources, /Version: [a-f0-9]{64}/);
  // Copy failures are visible, leave the answer intact, and can be retried.
  await answerActions.getByRole('button', { name: 'Copy', exact: true }).waitFor();
  await app.evaluate(() => { globalThis.failClipboard = true; });
  await answerActions.getByRole('button', { name: 'Copy', exact: true }).click();
  await answerActions.getByRole('alert').filter({ hasText: 'Could not copy' }).waitFor();
  assert.equal(await page.locator('.message.assistant .text').innerText(), answer);
  assert.equal(await app.evaluate(() => globalThis.copiedTexts.length), 2);
  await app.evaluate(() => { globalThis.failClipboard = false; });
  await answerActions.getByRole('button', { name: 'Copy', exact: true }).click();
  await answerActions.getByRole('button', { name: 'Copied!', exact: true }).waitFor();
  assert.equal(await answerActions.getByRole('alert').count(), 0);

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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Pronunciations (1)').click();
  await page.getByText('sounds like an sir').waitFor();
  const pronunciationList = page.locator('.pronunciations');
  await page.getByRole('button', { name: 'Test pronunciation for answer', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.pronunciations [role="status"]'));
  assert.equal(JSON.parse(readFileSync(ttsLog, 'utf8').trim().split('\n').at(-1)), 'an sir', 'Test speaks the saved pronunciation');
  await page.getByRole('button', { name: 'Edit pronunciation for answer', exact: true }).click();
  await page.getByLabel('Pronunciation for answer', {exact:true}).fill('ann ser');
  await page.screenshot({path: join(work,'pronunciation-edit.png')});
  await page.getByRole('button', { name: 'Test pronunciation for answer', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.pronunciations [role="status"]'));
  assert.equal(JSON.parse(readFileSync(ttsLog, 'utf8').trim().split('\n').at(-1)), 'ann ser', 'Test speaks the unsaved edit');
  assert.equal((await page.evaluate(() => window.api.pronunciations.list()))[0].spoken, 'an sir', 'testing does not save a draft');
  await pronunciationList.getByRole('button', {name:'Cancel',exact:true}).click();
  await page.getByText('sounds like an sir').waitFor();
  await page.getByRole('button', { name: 'Edit pronunciation for answer', exact: true }).click();
  await page.getByLabel('Pronunciation for answer', {exact:true}).fill('ann ser');
  await pronunciationList.getByRole('button', {name:'Save',exact:true}).click();
  await page.getByText('sounds like ann ser').waitFor();
  assert.equal((await page.evaluate(() => window.api.pronunciations.list()))[0].spoken, 'ann ser', 'Save updates the existing pronunciation');
  await page.screenshot({path: process.argv[5] ?? join(work,'pronunciations.png')});

  // Read an existing answer on demand, even with automatic speech off.
  const originalAnswer = await page.locator('.message.assistant .text').first().innerText();
  const chatsBeforeReading = modelRequests().length;
  const speechBeforeReading = readFileSync(ttsLog, 'utf8').trim().split('\n').length;
  const readButton = page.getByRole('button', { name: 'Read aloud', exact: true }).first();
  await readButton.click();
  await page.getByText('Reading aloud…', { exact: true }).waitFor();
  await page.screenshot({path: process.argv[6] ?? join(work, 'read-aloud.png')});
  await page.getByRole('button', { name: 'Stop reading', exact: true }).click();
  await readButton.waitFor();
  assert.equal(await page.locator('.read-status').count(), 0);
  assert.equal(await page.locator('.message.assistant .text').first().innerText(), originalAnswer);
  assert.equal(modelRequests().length, chatsBeforeReading, 'reading never regenerates the answer');
  const spokenAnswer = readFileSync(ttsLog, 'utf8').trim().split('\n').slice(speechBeforeReading).map(JSON.parse).join(' ');
  assert.match(spokenAnswer, /ann ser/, 'reading uses the saved pronunciation');
  assert.doesNotMatch(spokenAnswer, /\[\d|\*\*/, 'citation markers and markdown are not spoken');
  // Finishing buffered audio resets the button without requiring Stop.
  await readButton.click();
  await page.getByRole('button', { name: 'Stop reading', exact: true }).waitFor();
  await readButton.waitFor();
  assert.equal(await page.locator('.read-status').count(), 0);

  // Speech on: the second sentence must wait for the first one's audio to play.
  await page.getByLabel('Speak replies').check();
  await page.getByPlaceholder('Ask something').fill('When do zebras graze again?');
  await page.getByRole('button', { name: 'Send' }).click();
  const paced = page.locator('.message.assistant .text').last();
  await paced.getByText('The answer is in your documents').waitFor();
  // Text is now independent of speech playback.
  await paced.getByText('An invented source is ignored').waitFor();
  await page.getByRole('button', { name: 'Send' }).waitFor();
  await page.getByPlaceholder('Ask something').fill('');
  await page.getByLabel('Speak replies').uncheck();

  // Unticking the only set must take documents out of the answer path.
  assert.ok(modelRequests().some((messages) => messages.some((m) => m.role === 'assistant') && messages.at(-1).content.includes('When do zebras graze again?')), 'unchanged sources preserve conversational history');
  await page.getByLabel('Use Wildlife').click();
  await page.getByText('Select document sets to ask a question').waitFor();
  await page.getByText('Sources changed.', { exact: false }).waitFor();

  // A PDF citation shows the page itself: real pixels, on the right page, with paging.
  await page.getByPlaceholder('New set name').fill('Papers');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /Papers/ }).waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, process.env.E2E_PDF ?? pdf);
  await page.getByRole('button', { name: 'Add files' }).click();
  await page.getByText('Answering from: Papers').waitFor();
  await page.locator('.set-row').filter({hasText:'Papers'}).getByText('1 file').waitFor();
  await page.getByPlaceholder('Ask something').fill('What other research is referenced');
  await page.getByRole('button', { name: 'Send' }).click();
  const pdfCite = page.locator('.message.assistant').last().locator('.cite').first();
  await pdfCite.waitFor();
  const paperRequest = modelRequests().findLast((messages) => messages.at(-1).content.includes('Question: What other research is referenced'));
  assert.ok(paperRequest, 'the exact reported question reaches the model');
  assert.equal(paperRequest.filter((m) => m.role === 'user').length, 1, 'changing sources clears previous user history');
  assert.equal(paperRequest.filter((m) => m.role === 'assistant').length, 0, 'changing sources clears previous answers');
  assert.doesNotMatch(JSON.stringify(paperRequest), /zebra/i, 'neither retrieval nor history retains the deselected collection');
  assert.equal(await page.locator('.message.user').count(), 1, 'the new scope starts its own conversation');
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const saved = await page.evaluate(() => window.api.chat.conversations());
  const wildlifeChat = saved.find((c) => c.title === 'When do zebras graze?');
  const paperChat = saved.find((c) => c.title === 'What other research is referenced');
  assert.ok(wildlifeChat && paperChat && wildlifeChat.id !== paperChat.id, 'both conversations remain saved separately');
  assert.notDeepEqual(wildlifeChat.setIds, paperChat.setIds, 'each saved conversation retains its actual source selection');
  await pdfCite.click();
  await page.getByText(/^Page \d+ of \d+$/).waitFor();
  const label = await page.getByText(/^Page \d+ of \d+$/).innerText();
  const inkOf = () =>
    page.locator('.pdf-frame canvas').evaluate((canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 128) ink++;
      return ink;
    });
  await page.waitForFunction(() => {
    const c = document.querySelector('.pdf-frame canvas');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 128) return true;
    return false;
  });
  assert.ok((await inkOf()) > 50, 'the PDF page should be drawn');
  await page.screenshot({ path: process.argv[3] ?? join(work, 'pdf.png') });
  const [, current, total] = label.match(/Page (\d+) of (\d+)/).map(Number);
  const step = current < total ? 'Next page' : 'Previous page';
  await page.getByRole('button', { name: step }).click();
  await page.getByText(`Page ${step === 'Next page' ? current + 1 : current - 1} of ${total}`).waitFor();
  assert.ok(await page.locator('.source-detail blockquote').count() > 0, 'the saved evidence stays visible alongside the PDF');
  assert.deepEqual(problems, [], 'PDF rendering should load everything it needs');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Topic map: a folder large enough to group, hover a topic, see what it connects to.
  await page.getByPlaceholder('New set name').fill('Forum');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /Forum/ }).waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, forum);
  await page.getByRole('button', { name: 'Add folder' }).click();
  await page.getByText(/^24 files$/).waitFor();
  // Long file names must not push the set's buttons out of the sidebar.
  writeFileSync(join(forum, `${'a-very-long-thread-title-'.repeat(8)}.md`), '<p>note</p>\n');
  await page.getByRole('button', { name: 'Rescan' }).click();
  await page.getByText(/^25 files$/).waitFor();
  const sidebar = await page.locator('.sidebar').boundingBox();
  const inside = async (name) => {
    const button = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(button.x + button.width <= sidebar.x + sidebar.width, `${name} should fit in the sidebar`);
  };
  for (const name of ['Add files', 'Rescan', 'Topic map', 'Delete']) await inside(name);
  assert.ok(await page.getByPlaceholder('New set name').isVisible(), 'a long file list should not hide the form');

  // The sidebar drags wider, keeps long-list buttons inside, and remembers its width.
  const handle = await page.getByRole('separator', { name: 'Resize sidebar' }).boundingBox();
  await page.mouse.move(handle.x + 3, 300);
  await page.mouse.down();
  await page.mouse.move(handle.x + 123, 300, { steps: 4 });
  await page.waitForFunction((width) => Math.abs(Number(document.querySelector('.sidebar-handle').getAttribute('aria-valuenow')) - width) < 4, sidebar.width + 120);
  await page.mouse.up();
  const widened = await page.locator('.sidebar').boundingBox();
  assert.ok(Math.abs(widened.width - sidebar.width - 120) < 4, `sidebar should widen, got ${widened.width}`);
  assert.equal(await page.evaluate(() => localStorage.getItem('docent.sidebarWidth')), String(Math.round(widened.width)));
  await page.getByRole('separator', { name: 'Resize sidebar' }).dblclick();

  // Clicking a document offers opening it or showing it in the file manager.
  await app.evaluate(({ shell }) => {
    globalThis.calls = [];
    shell.openPath = async (path) => (globalThis.calls.push(['open', path]), '');
    shell.showItemInFolder = (path) => void globalThis.calls.push(['reveal', path]);
  });
  const reveal = { darwin: 'Show in Finder', win32: 'Show in File Explorer' }[process.platform] ?? 'Show in folder';
  const row = page.locator('.docs li').filter({ hasText: 'post-3.md' });
  await row.getByRole('button', { name: 'post-3.md', exact: true }).click();
  await row.getByRole('button', { name: 'Open', exact: true }).click();
  await row.getByRole('button', { name: reveal }).click();
  await page.waitForTimeout(200);
  const expected = join(forum, 'post-3.md');
  assert.deepEqual(await app.evaluate(() => globalThis.calls), [['open', expected], ['reveal', expected]]);
  rmSync(expected);
  await row.getByRole('button', { name: 'Open', exact: true }).click();
  await row.getByRole('alert').waitFor();
  await page.getByRole('button', { name: 'Rescan' }).click();
  await page.getByText(/25 files, 1 failed/).waitFor();
  // A script must never be offered to the default app, which would run it.
  writeFileSync(join(forum, 'run-me.sh'), 'echo hello\n');
  await page.getByRole('button', { name: 'Rescan' }).click();
  await page.getByText(/26 files, 1 failed/).waitFor();
  const script = page.locator('.docs li').filter({ hasText: 'run-me.sh' });
  await script.getByRole('button', { name: 'run-me.sh', exact: true }).click();
  await script.getByRole('button', { name: reveal }).waitFor();
  assert.equal(await script.getByRole('button', { name: 'Open', exact: true }).count(), 0);
  await page.screenshot({ path: join(work, 'sidebar.png') });

  await page.getByRole('button', { name: 'Topic map' }).click();
  const canvas = page.locator('.topic-stage canvas');
  await canvas.waitFor({ timeout: 30000 });
  await page.getByRole('heading', { name: 'Topics' }).waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  const box = await canvas.boundingBox();
  let found = false;
  for (let y = 12; y < box.height && !found; y += 24) {
    for (let x = 12; x < box.width && !found; x += 24) {
      await page.mouse.move(box.x + x, box.y + y);
      found = (await page.getByRole('heading', { name: 'Connected topics' }).count()) > 0;
    }
  }
  assert.ok(found, 'hovering the map should show a topic and its connections');
  await page.getByText('These passages share a sample subject.').first().waitFor({ timeout: 15000 });
  await page.getByRole('heading', { name: 'Typical passages' }).waitFor();
  assert.equal(await page.locator('.topic-panel h3').innerText(), 'Sample subject');

  // A dot shows what its passage says, not just the file it came from.
  let tip = false;
  for (let y = 12; y < box.height && !tip; y += 8) {
    for (let x = 12; x < box.width && !tip; x += 8) {
      await page.mouse.move(box.x + x, box.y + y);
      tip = (await page.locator('.topic-tip').count()) > 0;
    }
  }
  assert.ok(tip, 'hovering a dot should show its passage');
  const said = await page.locator('.topic-tip p').innerText();
  assert.ok(said.trim() && !/\.md\b/.test(said), `a dot should show its passage, not a file name: ${said}`);
  assert.match(await page.locator('.topic-tip small').innerText(), /\.md, line \d+/);
  await page.mouse.down();
  await page.mouse.up();
  await page.getByRole('heading', { name: 'Selected passage' }).waitFor();
  await page.getByRole('button', { name: 'Clear' }).click();
  // Connection lines and labels use the light text color on the dark background.
  await page.waitForFunction(() => {
    const c = document.querySelector('.topic-stage canvas');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200 && data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) return true;
    }
    return false;
  });
  await page.screenshot({ path: process.argv[4] ?? join(work, 'topics.png') });
  const box2 = await canvas.boundingBox();
  await page.mouse.move(box2.x + 40, box2.y + 40);
  await page.mouse.down();
  await page.mouse.move(box2.x + 140, box2.y + 90);
  await page.mouse.up();
  await page.getByRole('button', { name: 'All topics' }).click();
  await page.getByRole('heading', { name: 'Topics' }).waitFor();
  await page.getByRole('button', { name: 'Close map' }).click();
  await page.getByPlaceholder('Ask something').waitFor();
  assert.deepEqual(problems, [], 'the topic map should run without errors');
  // Saved chats survive a renderer restart, and search works while models are unavailable.
  await page.reload();
  await page.getByText('Pronunciations (1)').click();
  await page.getByText('sounds like ann ser').waitFor();
  await page.getByRole('button',{name:'Conversations',exact:true}).click();
  await page.getByRole('button',{name:/^What other research is referenced/}).click();
  await page.locator('.message.assistant .cite').first().waitFor();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).first().click();
  await page.getByRole('button', { name: 'Stop reading', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Stop reading', exact: true }).count(), 0, 'leaving a conversation stops reading');
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button',{name:/^What other research is referenced/}).click();
  const savedText = await page.locator('.message.assistant .text').first().innerText();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:readAloud');
    ipcMain.handle('chat:readAloud', () => { throw new Error('The voice model is not ready.'); });
  });
  await page.getByRole('button', { name: 'Read aloud', exact: true }).first().click();
  await page.getByRole('alert').filter({ hasText: 'The voice model is not ready' }).waitFor();
  assert.equal(await page.locator('.message.assistant .text').first().innerText(), savedText, 'voice failure leaves the saved answer intact');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('runtime:state',{phase:'failed',message:'Simulated model outage'}));
  await page.getByText('Library search and saved conversations are available.').waitFor();
  await page.getByRole('button',{name:'Search library',exact:true}).click();
  await page.getByRole('textbox',{name:'Search library',exact:true}).fill('zebras');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.locator('.search-result').filter({hasText:'zebras.md'}).click();
  await page.locator('.source-detail blockquote').filter({hasText:'Zebras graze at dawn'}).waitFor();
  console.log('E2E passed');
} catch(error) {
  const page=await app.firstWindow();
  console.error('UI failure state:',await page.locator('body').innerText());
  console.error('Test profile:',await app.evaluate(({app})=>app.getPath('userData')));
  await page.screenshot({path:join(work,'failure.png')});
  throw error;
} finally {
  await app.close();
}
