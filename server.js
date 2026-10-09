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
  // Склеиваем system/user/assistant/tool в один текстовый промпт для веб-интерфейса.
  const parts = [];
  for (const m of messages || []) {
    const role = m.role || 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((c) => c && (c.type === 'text' || c.type === 'input_text' || typeof c === 'string'))
        .map((c) => (typeof c === 'string' ? c : (c.text || '')))
        .join('\n');
    }
    if (role === 'tool') {
      const name = m.name || 'tool';
      if (text) parts.push(`[tool ${name} result] ${text}`);
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length && !text) {
      const calls = m.tool_calls.map((t) => {
        const fn = t.function || {};
        return `${fn.name || t.name}(${fn.arguments || '{}'})`;
      }).join('; ');
      parts.push(`[assistant] (called tools: ${calls})`);
      continue;
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

// ---------- homemade tools ----------

function buildToolsPrompt(tools) {
  const defs = (tools || [])
    .filter((t) => t && (t.type === 'function' || t.function) && (t.function || {}).name)
    .map((t) => {
      const fn = t.function || {};
      return `- ${fn.name}: ${fn.description || 'no description'}\n  parameters JSON schema: ${JSON.stringify(fn.parameters || { type: 'object', properties: {} })}`;
    });
  if (!defs.length) return '';
  return [
    '[system] You have access to the following tools. When the user request needs one,',
    'call it by emitting EXACTLY one fenced block like this and nothing else outside it.',
    'The opening fence must be exactly ```toolcall (three backticks + the word toolcall).',
    'Bare JSON without the fence is NOT a valid call.',
    '',
    '```toolcall',
    '{"name": "<tool-name>", "arguments": {<args as JSON object>}}',
    '```',
    '',
    'Rules: output ONLY the fenced block when calling a tool (no prose before/after).',
    'If no tool is needed, answer normally in plain text without any fenced block.',
    'Available tools:',
    ...defs,
  ].join('\n');
}

function parseToolCalls(text, tools) {
  const names = new Set(
    (tools || [])
      .filter((t) => t && (t.type === 'function' || t.function))
      .map((t) => (t.function || {}).name)
      .filter(Boolean),
  );
  const found = [];
  const re = /```toolcall\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.name === 'string' && names.has(obj.name)) {
        found.push({
          id: 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'function',
          function: {
            name: obj.name,
            arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments || {}),
          },
        });
      }
    } catch {}
  }
  if (!found.length) {
    // fallback: bare JSON {"name": ..., "arguments": {...}} anywhere in text
    const re2 = /\{\s*"name"\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    let m2;
    while ((m2 = re2.exec(text || '')) !== null) {
      if (names.has(m2[1])) {
        try {
          JSON.parse(m2[2]);
          found.push({
            id: 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
            type: 'function',
            function: { name: m2[1], arguments: m2[2] },
          });
        } catch {}
      }
    }
  }
  return found;
}

function completionObjectWithTools(id, model, content, toolCalls) {
  const msg = { role: 'assistant', content: content || null };
  if (toolCalls && toolCalls.length) msg.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: toolCalls && toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
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
      // Браузер мог быть перезапущен (recycle/таймер). Ждём подъёма CDP и
      // повторяем запрос — клиент не должен видеть 502 при плановом рестарте.
      try {
        await this.waitForBrowser(60);
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

  // waitForBrowser: ждёт, пока CDP-эндпоинт снова начнёт отвечать.
  async waitForBrowser(maxSec) {
    const deadline = Date.now() + maxSec * 1000;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(CDP + '/json/version');
        if (resp.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('browser did not come up in ' + maxSec + 's');
  }

  async runJob(job) {
    const { prompt, onDelta } = job;
    await this.driver.warmupOnce();
    const full = await this.driver.ask(prompt, onDelta, { timeout: REQUEST_TIMEOUT, idleMs: COMPLETION_IDLE_MS });
    return full;
  }
}

// withTimeout: ограничивает любой промис. Playwright не всегда обрывает
// мёртвый CDP-сокет при падении Chrome — без обёртки запрос виснет навсегда.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// withDeadline: гонка промиса с绝对ным таймаутом, после которого двигателю
// ставится признак «браузер умер», чтобы pump пошёл в переподключение.
async function withDeadline(promise, ms, label) {
  return withTimeout(promise, ms, label);
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

  // homemade tools: описываем тулсы системной инструкцией, вызовы парсим из ответа
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const toolChoice = payload.tool_choice;
  const wantTools = tools.length > 0 && toolChoice !== 'none';
  const toolsPrompt = wantTools ? buildToolsPrompt(tools) : '';

  let prompt = flattenMessages(messages);
  if (toolsPrompt) prompt = toolsPrompt + '\n\n' + prompt;

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
      let acc = '';
      await engine.submit({
        prompt,
        onDelta: (delta) => {
          acc += delta;
          if (closed || wantTools) return; // при тулсах дельты копим, решение — в конце
          writeSSE(completionChunk(id, model, { content: delta }, null));
        },
      });
      if (!closed) {
        if (wantTools) {
          const calls = parseToolCalls(acc, tools);
          if (calls.length) {
            writeSSE(completionChunk(id, model, { tool_calls: calls }, null));
            writeSSE(completionChunk(id, model, {}, 'tool_calls'));
          } else {
            writeSSE(completionChunk(id, model, { content: acc }, null));
            writeSSE(completionChunk(id, model, {}, 'stop'));
          }
        } else {
          writeSSE(completionChunk(id, model, {}, 'stop'));
        }
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
    if (wantTools) {
      const calls = parseToolCalls(full, tools);
      if (calls.length) {
        // убираем служебный fenced-блок из видимого контента (с кавычками и без)
        const clean = full
          .replace(/```toolcall\s*[\s\S]*?```/g, '')
          .replace(/^\s*toolcall\s*(\{[\s\S]*\})\s*$/m, '')
          .trim();
        sendJSON(res, 200, completionObjectWithTools(id, model, clean || null, calls));
        return;
      }
    }
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
