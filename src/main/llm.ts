export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export type ChatDelta = { type: 'text'; text: string } | { type: 'tool_calls'; calls: ToolCall[] };

export interface SpeechChunk {
  samples: ArrayBuffer;
  sampleRate: number;
}

/** Small enough to start quickly, large enough not to flood IPC with tiny messages (0.2 s at 24 kHz). */
const MIN_CHUNK_BYTES = 19200;

export interface Llm {
  chat(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncIterable<ChatDelta>;
  transcribe(wav: ArrayBuffer, signal?: AbortSignal): Promise<string>;
  /** Yields speech as it is generated. Each chunk holds whole float32 samples. */
  speak(text: string, signal?: AbortSignal): AsyncIterable<SpeechChunk>;
}

export interface Embedder {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
}

async function post(endpoint: Endpoint, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(endpoint.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function* sseEvents(res: Response): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
}

export class LlamaServerLlm implements Llm {
  constructor(private endpoint: Endpoint) {}

  async *chat(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncGenerator<ChatDelta> {
    const res = await post(
      this.endpoint,
      '/v1/chat/completions',
      {
        messages,
        stream: true,
        temperature: 0, // Liquid recommends greedy decoding for text output.
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      },
      signal,
    );
    const calls: ToolCall[] = [];
    for await (const event of sseEvents(res)) {
      const delta = event.choices?.[0]?.delta;
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const part of delta?.tool_calls ?? []) {
        const index: number = part.index ?? 0;
        const call = (calls[index] ??= {
          id: part.id ?? `call_${index}`,
          type: 'function',
          function: { name: '', arguments: '' },
        });
        if (part.id) call.id = part.id;
        call.function.name += part.function?.name ?? '';
        call.function.arguments += part.function?.arguments ?? '';
      }
    }
    if (calls.length > 0) yield { type: 'tool_calls', calls };
  }

  async transcribe(wav: ArrayBuffer, signal?: AbortSignal): Promise<string> {
    const res = await post(
      this.endpoint,
      '/v1/chat/completions',
      {
        messages: [
          { role: 'system', content: 'Perform ASR in English.' },
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } }],
          },
        ],
        temperature: 0,
      },
      signal,
    );
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content?.trim() ?? '';
  }

  async *speak(text: string, signal?: AbortSignal): AsyncGenerator<SpeechChunk> {
    const res = await post(
      this.endpoint,
      '/tts',
      { input: text, voice: 'female', lang: 'en', response_format: 'pcm', stream: true },
      signal,
    );
    const rate = res.headers.get('content-type')?.match(/rate=(\d+)/)?.[1];
    const sampleRate = rate ? Number(rate) : 24000;
    const take = (bytes: Buffer): SpeechChunk => ({
      samples: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      sampleRate,
    });
    // Network chunks can end mid-sample, so any partial sample waits for the next one.
    let held: Buffer = Buffer.alloc(0);
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      held = Buffer.concat([held, part]);
      if (held.length < MIN_CHUNK_BYTES) continue;
      const usable = held.length - (held.length % 4);
      yield take(held.subarray(0, usable));
      held = held.subarray(usable);
    }
    const usable = held.length - (held.length % 4);
    if (usable > 0) yield take(held.subarray(0, usable));
  }
}

/** nomic-embed-text retrieves well only when each input carries its task prefix. */
export class LlamaServerEmbedder implements Embedder {
  constructor(private endpoint: Endpoint) {}

  embedDocuments(texts: string[]) {
    return this.embed(texts.map((t) => `search_document: ${t}`));
  }

  async embedQuery(text: string) {
    const [vector] = await this.embed([`search_query: ${text}`]);
    if (!vector) throw new Error('Embedding server returned nothing');
    return vector;
  }

  private async embed(input: string[]): Promise<Float32Array[]> {
    const res = await post(this.endpoint, '/v1/embeddings', { input }, AbortSignal.timeout(60_000));
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
  }
}
