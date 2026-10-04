const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const COMPOSER = '#mobile-composer-prompt, #prompt-textarea, textarea';

const FOOTER_MARKERS = [
  'ChatGPT is AI and can make mistakes',
  'ChatGPT is AI and can make mistakes, and can misinterpret things.',
  'We use cookies',
];

// сколько тело должно быть стабильным, чтобы считать оборот завершённым
const COMPLETION_IDLE_MS = 3200;

function extractAnswer(bodyText) {
  // отрезаем футер (cookie/дисклеймер) — ищем самый ранний из его маркеров
  const footerIdx = FOOTER_MARKERS
    .map((m) => bodyText.indexOf(m))
    .filter((i) => i !== -1)
    .sort((a, b) => a - b)[0];
  const region = footerIdx === undefined ? bodyText : bodyText.slice(0, footerIdx);
  // нас интересует последний оборот "ChatGPT said:", а не первый
  const idx = region.lastIndexOf('ChatGPT said:');
  if (idx === -1) return '';
  return region.slice(idx + 'ChatGPT said:'.length).trim();
}

class ChatGPTDriver {
  constructor() {
    this.page = null;
    this.ctx = null;
    this.warmed = false;
  }

  async attach(browser) {
    this.ctx = await browser.newContext({ userAgent: UA });
    this.page = await this.ctx.newPage();
  }

  // dismissAuthDialog: после нескольких анонимных оборотов ChatGPT открывает
  // лист входа (#mobile-auth-dialog), который перехватывает все клики.
  async dismissAuthDialog() {
    try {
      const present = await this.page.evaluate(() =>
        !!document.querySelector('#mobile-auth-dialog[open], dialog[data-bottom-sheet][open]'));
      if (!present) return false;
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(300);
      await this.page.evaluate(() => {
        document.querySelectorAll('#mobile-auth-dialog, dialog[data-bottom-sheet]').forEach((d) => {
          if (d && d.open) { try { d.close(); } catch {} d.removeAttribute('open'); }
          d.remove();
        });
      });
      await this.page.waitForTimeout(300);
      return true;
    } catch { return false; }
  }

  // dismiss cookie banner if present (it intercepts clicks)
  async dismissCookieBanner() {
    try {
      const btn = await this.page.$('button[data-octane-cookie-banner-accept], button:has-text("Accept all")');
      if (btn) { await btn.click({ timeout: 3000 }); await this.page.waitForTimeout(500); }
    } catch {}
    try {
      await this.page.evaluate(() => {
        const el = document.querySelector('[data-octane-static-cookie-consent]');
        if (el) el.remove();
        document.querySelectorAll('button').forEach(b => {
          if (/Accept all/i.test(b.innerText)) b.click();
        });
      });
      await this.page.waitForTimeout(300);
    } catch {}
  }

  async warmup() {
    await this.page.goto('https://chatgpt.com/', { timeout: 90000, waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 40; i++) {
      const html = await this.page.content();
      if (!html.includes('_cf_chl_opt') && !html.includes('Just a moment')) break;
      await this.page.waitForTimeout(1500);
    }
    await this.dismissCookieBanner();
    await this.page.waitForSelector(COMPOSER, { timeout: 60000 });
  }

  // warmupOnce: one-time warmup. Subsequent calls only re-check state.
  async warmupOnce() {
    if (this.warmed) {
      // page might have navigated away / lost composer
      const ok = await this.page.evaluate(() => {
        const el = document.querySelector('#mobile-composer-prompt, #prompt-textarea, textarea');
        return !!el;
      }).catch(() => false);
      if (ok) return;
      this.warmed = false;
    }
    await this.warmup();
    this.warmed = true;
  }

  // ask(): type prompt, send, stream deltas via onDelta(textDelta, fullText).
  // Resolves with full answer text. Throws on timeout.
  async ask(prompt, onDelta, opts = {}) {
    const timeout = opts.timeout || 120000;
    const idleMs = opts.idleMs || COMPLETION_IDLE_MS;
    const pollMs = 400;
    const stableTarget = Math.max(2, Math.ceil(idleMs / pollMs));
    const t0 = Date.now();

    await this.page.waitForSelector(COMPOSER, { timeout: 30000 });
    await this.dismissAuthDialog();
    await this.dismissCookieBanner();
    // focus by coordinate to avoid intercepting overlays
    const box = await this.page.evaluate(() => {
      const el = document.querySelector('#mobile-composer-prompt, #prompt-textarea, textarea');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (box) await this.page.mouse.click(box.x, box.y);
    await this.page.waitForTimeout(400);
    await this.page.evaluate((p) => {
      const el = document.querySelector('#mobile-composer-prompt, #prompt-textarea, textarea');
      if (!el) return;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, p);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
    await this.page.waitForTimeout(300);

    const sendBtn = await this.page.$('button[aria-label*="Send" i]');
    if (!sendBtn) throw new Error('send button not found');
    // click via JS dispatch: оверлеи не мешают, клик идёт в сам узел
    await sendBtn.evaluate((b) => b.click());

    let lastLen = 0;
    let full = '';
    let stableTicks = 0;
    while (true) {
      if (Date.now() - t0 > timeout) throw new Error('chatgpt timeout');
      const body = await this.page.evaluate(() => document.body.innerText);
      full = extractAnswer(body);
      if (full.length > lastLen) {
        onDelta(full.slice(lastLen), full);
        lastLen = full.length;
        stableTicks = 0;
      } else {
        stableTicks++;
      }
      if (full.length > 0 && stableTicks >= stableTarget) break;
      await this.page.waitForTimeout(pollMs);
    }
    return full;
  }

  async close() {
    if (this.ctx) await this.ctx.close();
  }
}

module.exports = { ChatGPTDriver, extractAnswer, COMPOSER, FOOTER_MARKERS, COMPLETION_IDLE_MS };

// self-test: node driver.js
if (require.main === module) {
  (async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const d = new ChatGPTDriver();
    await d.attach(browser);
    await d.warmup();
    console.log('warm ok');
    const out = await d.ask('Say exactly: STREAMING-WORKS', (delta) => {
      console.log('DELTA:', JSON.stringify(delta));
    });
    console.log('FINAL:', JSON.stringify(out));
    await d.close();
  })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}
