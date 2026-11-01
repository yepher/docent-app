#!/usr/bin/env node
// A stand-in for llama-server, used only by tests and UI work. It accepts the same command line
// and speaks the same HTTP routes, but contains no model: embeddings are word hashes and every
// answer is canned. Passing against this proves the app's plumbing, not real model behavior.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port'));
const apiKey = process.env.LLAMA_API_KEY;
const DIM = 64;

function embed(text) {
  const v = new Array(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 7;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  return v;
}

const answer = (messages) => {
  const last = String(messages.at(-1)?.content ?? '');
  if (last.includes('Topic passages:')) return 'Name: Sample subject\nSummary: These passages share a sample subject.';
  const hasSources = /^\[1\] /m.test(last);
  return hasSources ? 'The answer is in your documents [1]. An invented source is ignored [9].' : 'Hello from the fake model.';
};

createServer(async (req, res) => {
  if (req.url === '/health') return res.writeHead(200).end('{"status":"ok"}');
  if (req.headers.authorization !== `Bearer ${apiKey}`) return res.writeHead(401).end('{"error":"unauthorized"}');
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}');

  if (req.url === '/v1/embeddings') {
    const data = body.input.map((text, index) => ({ index, embedding: embed(text) }));
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
  }
  if (req.url === '/tts') {
    if (process.env.DOCENT_TEST_TTS_LOG) appendFileSync(process.env.DOCENT_TEST_TTS_LOG, JSON.stringify(body.input) + '\n');
    res.writeHead(200, { 'content-type': 'audio/pcm;rate=24000;encoding=float;bits=32' });
    const audio = Buffer.alloc(24000 * 4);
    if (!body.stream) return res.end(audio);
    // Chunk sizes deliberately end mid-sample, as a real network can.
    for (let at = 0; at < audio.length; at += 30001) {
      res.write(audio.subarray(at, at + 30001));
      await new Promise((r) => setTimeout(r, 5));
    }
    return res.end();
  }
  if (req.url === '/v1/chat/completions') {
    if (process.env.DOCENT_TEST_CHAT_LOG) appendFileSync(process.env.DOCENT_TEST_CHAT_LOG, JSON.stringify(body.messages) + '\n');
    if (!body.stream) {
      const content = 'What does the report say?';
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { content } }] }),
      );
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const word of answer(body.messages).split(/(?<= )/)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end('{}');
}).listen(port, '127.0.0.1');
