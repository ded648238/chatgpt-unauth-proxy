// chatgpt-unauth-proxy
// OpenAI-совместимый HTTP-сервер поверх безлогинового веб-интерфейса ChatGPT.
// Один браузер = одно окно = один разговор за раз; запросы идут через очередь.

const http = require('http');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { ChatGPTDriver } = require('./driver');

const PORT = process.env.PROXY_PORT || 22100;
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '20', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '180', 10) * 1000;
const COMPLETION_IDLE_MS = parseInt(process.env.COMPLETION_IDLE_MS || '3200', 10);

const MODELS = ['chatgpt-5.5', 'gpt-5.5', 'chatgpt', 'gpt-4o', 'gpt-4o-mini', 'gpt-5', 'auto'];

// ---------- API error helpers ----------

function now() { return Math.floor(Date.now() / 1000); }

function completionChunk(id, model, delta, finish) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: now(),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finish || null,
    }],
  };
}

function completionObject(id, model, content) {
  return {
    id,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type) {
  sendJSON(res, status, { error: { message, type: type || 'api_error', code: null } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function flattenMessages(messages) {
  // Склеиваем system/user/assistant в один текстовый промпт для веб-интерфейса.
  const parts = [];
  for (const m of messages || []) {
    const role = m.role || 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((c) => c && (c.type === 'text' || typeof c === 'string'))
        .map((c) => (typeof c === 'string' ? c : c.text))
        .join('\n');
    }
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      parts.push(`[system] ${text}`);
    } else if (role === 'assistant') {
      parts.push(`[assistant] ${text}`);
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

// ---------- browser engine ----------

class Engine {
  constructor() {
    this.driver = null;
    this.queue = [];
    this.active = null;
    this.ready = false;
    this.browser = null;
  }

  async connect() {
    // Каждое подключение — новый контекст; старый надо закрыть.
    try { if (this.driver) await this.driver.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = await chromium.connectOverCDP(CDP);
    this.driver = new ChatGPTDriver();
    await this.driver.attach(this.browser);
    this.driver.warmed = false;
  }

  async start() {
    await this.connect();
    await this.driver.warmup();
    this.driver.warmed = true;
    this.ready = true;
    console.log('[engine] ready');
  }

  async ensureReady() {
    if (this.ready) return;
    console.log('[engine] reconnecting...');
    await this.start();
  }

  submit(job) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE) {
        reject(new Error('queue full'));
        return;
      }
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  async pump() {
    if (this.active || !this.ready) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    try {
      const result = await this.runJob(next.job);
      next.resolve(result);
    } catch (e) {
      // Разовый ретрай после переподключения: сломался браузер/вкладка.
      try {
        this.ready = false;
        await this.connect();
        await this.driver.warmup();
        this.driver.warmed = true;
        this.ready = true;
        const result = await this.runJob(next.job);
        next.resolve(result);
        return;
      } catch (e2) {
        next.reject(e);
      }
    } finally {
      this.active = null;
      this.pump();
    }
  }

  async runJob(job) {
    const { prompt, onDelta } = job;
    await this.driver.warmupOnce();
    const full = await this.driver.ask(prompt, onDelta, { timeout: REQUEST_TIMEOUT, idleMs: COMPLETION_IDLE_MS });
    return full;
  }
}

// ---------- engine singleton ----------

const engine = new Engine();

// ---------- HTTP handlers ----------

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const messages = payload.messages || [];
  const model = payload.model || 'gpt-5.5';
  const stream = payload.stream === true;
  const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

  if (!messages.length) {
    sendError(res, 400, 'messages is required and must not be empty', 'invalid_request_error');
    return;
  }

  const prompt = flattenMessages(messages);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    const writeSSE = (obj) => {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    };

    writeSSE(completionChunk(id, model, { role: 'assistant', content: '' }, null));

    let closed = false;
    req.on('close', () => { closed = true; });

    try {
      await engine.submit({
        prompt,
        onDelta: (delta) => {
          if (closed) return;
          writeSSE(completionChunk(id, model, { content: delta }, null));
        },
      });
      if (!closed) {
        writeSSE(completionChunk(id, model, {}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (e) {
      if (!closed) {
        writeSSE(completionChunk(id, model, { content: '\n\n[error: ' + e.message + ']' }, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
    return;
  }

  // non-streaming
  try {
    const full = await engine.submit({ prompt, onDelta: () => {} });
    sendJSON(res, 200, completionObject(id, model, full));
  } catch (e) {
    sendError(res, 502, 'ChatGPT request failed: ' + e.message, 'upstream_error');
  }
}

async function handleModels(req, res) {
  sendJSON(res, 200, {
    object: 'list',
    data: MODELS.map((id, i) => ({
      id,
      object: 'model',
      created: now() - i,
      owned_by: 'chatgpt-unauth-proxy',
    })),
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if ((path === '/v1/models' || path === '/models') && req.method === 'GET') {
      await handleModels(req, res);
    } else if (path === '/health' || path === '/') {
      sendJSON(res, 200, { status: 'ok', engine_ready: engine.ready, queue: engine.queue.length, active: !!engine.active });
    } else {
      sendError(res, 404, 'Not found: ' + path, 'invalid_request_error');
    }
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, 'Internal error: ' + e.message);
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log('[proxy] listening on :' + PORT);
  try {
    await engine.start();
  } catch (e) {
    console.error('[proxy] engine failed to start:', e.message);
    console.error('       ensure chrome is up:', CDP);
  }
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
