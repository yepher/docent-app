#!/usr/bin/env node
// A stand-in for llama-server, used only by tests and UI work. It accepts the same command line
// and speaks the same HTTP routes, but contains no model: embeddings are word hashes and every
// answer is canned. Passing against this proves the app's plumbing, not real model behavior.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port'));
const apiKey = process.env.LLAMA_API_KEY;
const DIM = 64;
let sentProtocolFault = false;

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
  if (String(messages[0]?.content).startsWith('Answer again using only the supplied source evidence.')) {
    // Plumbing fixture only; real-model evaluations test semantic review separately.
    const content = messages.find((m) => m.role === 'user').content;
    if (process.env.DOCENT_TEST_REFERENCE_ONLY) {
      const source = JSON.parse(content).sources[0];
      if (process.env.DOCENT_TEST_REFERENCE_ONLY === 'always') return `[${source.n}]`;
      return 'Maya recommended adapter support to connect the existing equipment [1].';
    }
    return Array.isArray(content) ? 'The image shows a labeled diagram [1].' : 'The answer is in your documents [1]. An invented source is ignored.';
  }
  if (process.env.DOCENT_TEST_FORMAT_STREAM) return '**Overview** of the layers [1].\n\n**Encoder** uses **N = 6** layers, **self-attention**, and a **feed-forward network** [2].\n\n**Decoder** uses **masked attention**, **cross-attention**, and its own **feed-forward network** [1, 2].';
  const content = messages.at(-1)?.content;
  const last = Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(content ?? '');
  if (process.env.DOCENT_TEST_REFERENCE_ONLY) return last.match(/^\[\d+\] .+ \(document ID \d+\)$/m)?.[0] ?? '[1]';
  if (Array.isArray(content) && content.some((p) => p.type === 'image_url')) return 'The image shows a labeled diagram [1].';
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
  if (req.url === '/v1/rerank') {
    if (process.env.DOCENT_TEST_RERANK_LOG) appendFileSync(process.env.DOCENT_TEST_RERANK_LOG, JSON.stringify(body) + '\n');
    const control = process.env.DOCENT_TEST_RERANK_CONTROL ? JSON.parse(readFileSync(process.env.DOCENT_TEST_RERANK_CONTROL, 'utf8')) : {};
    if (control.delayMs) await new Promise((r) => setTimeout(r, control.delayMs));
    if (control.fail) return res.writeHead(503).end('{}');
    const results = body.documents.map((_, index) => ({ index, relevance_score: control.reverse ? (index + 1) / (body.documents.length + 1) : 1 - index / (body.documents.length + 1) })).sort((a, b) => b.relevance_score - a.relevance_score);
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
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
    if (process.env.DOCENT_TEST_PROTOCOL_FAULT && body.tools?.length) {
      const previousCalls = body.messages.filter((m) => m.tool_calls?.length).length;
      const id = Number(JSON.stringify(body.messages).match(/document ID (\d+)/)?.[1] ?? 1);
      const name = previousCalls ? 'read_document' : 'search_documents';
      const args = previousCalls ? { documentId: id, offset: 0, limit: 2 } : { query: 'thread' };
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `fake-${previousCalls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    let reply = answer(body.messages);
    if (process.env.DOCENT_TEST_PROTOCOL_FAULT && !sentProtocolFault) {
      sentProtocolFault = true;
      reply = '<tool_call>\n<function=read_document>\n<parameter=documentId>1</parameter>\n</function>\n</tool_call>';
    }
    for (const word of reply.split(process.env.DOCENT_TEST_PROTOCOL_FAULT || process.env.DOCENT_TEST_FORMAT_STREAM ? /(?<=.)/ : /(?<= )/)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end('{}');
}).listen(port, '127.0.0.1');
