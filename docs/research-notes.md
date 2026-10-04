# Research notes: анонимный транспорт ChatGPT

Записи разведки, проведённой на хосте. Цель — понять, как веб-интерфейс ChatGPT обменивается сообщениями без логина, и построить поверх него прокси.

## 1. Доступ без аккаунта

Cloudflare закрывает всё голыми запросами:

```bash
curl https://chatgpt.com/backend-api/models
# HTTP/2 403, cf-mitigated: challenge, <html>Just a moment...</html>
```

JS-challenge проходит только настоящий браузер. Способы проверялись поочерёдно:

| Способ | Результат |
|---|---|
| `curl` + любые заголовки | 403, `cf-mitigated: challenge` |
| Chrome `--headless=new --dump-dom` | остаётся на странице челленджа |
| Playwright `chromium.launch()` headless | остаётся на челлендже (`Just a moment...`) |
| Playwright + CDP к системному Chrome, ephemeral профиль | остаётся на челлендже |
| Playwright + CDP, **персистентный `--user-data-dir`** | **проходит** за ~2-15 с |

Ключевое — постоянный профиль: после первого прохождения в нём остаются `cf_clearance`, `__cf_bm`, `oai-did`. Повторные запуски проходят челлендж почти мгновенно.

```bash
google-chrome --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 \
  --user-data-dir=/var/lib/chatgpt-chrome-profile
```

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ userAgent: DESKTOP_CHROME_UA });
const page = await ctx.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
// ждать исчезновения _cf_chl_opt / "Just a moment"
```

Получив сессию, проверили анонимный доступ:

```bash
GET /api/auth/session      → 200, объект без пользователя (пустая сессия)
GET /backend-api/models    → 200, список моделей (slug: "gpt-5-5", title "GPT-5.5")
GET /backend-api/conversations?limit=3 → 200, {"items":[],"total":0}
```

То есть **сервер отвечает анониму**, ограничение только в челлендже.

## 2. Как UI отправляет сообщение

Первый сюрприз: после ввода текста и нажатия Enter в сеть уходила только телеметрия (`/unauth-mweb/events/*`, `/backend-api/sentinel/*`). Оказалось, Enter на мобильном композере не отправляет, нужна кнопка.

Перехват полного обмена дал такую цепочку:

```
1. POST /unauth-mweb/sentinel/chat-requirements/prepare
      → {"persona":"chatgpt-noauth","prepare_token":"gAAAA..."}

2. POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0
      Content-Type: application/x-www-form-urlencoded;charset=UTF-8
      body: conversationRetryOwner={"mode":"anonymous","sessionEpoch":null}
            &conversationState={"messages":[],"parentMessageId":"client-created-root","userMessageCount":0}
            &clientContextualInfo={...}
            &timezone=UTC&timezoneOffsetMinutes=0
      → {"conduit_token":"eyJ...","prepare_cadence_enabled":true}

3. POST /unauth-mweb/sentinel/chat-requirements/finalize
      → {"persona":"chatgpt-noauth","token":"gAAAA..."}

4. POST /backend-api/sentinel/req
      body: {"p":"gAAAAA...","id":"<uuid>","flow":"conversation"}
      → {"persona":"chatgpt-noauth","token":"gAAAA..."}

5. POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>
      Content-Type: application/x-www-form-urlencoded
      body: conversationState={...}
            &messageMetadata={}
            &oai-session-id=<uuid>
            &imageAttachments=[]
            &pendingImageUploads=[]
            &prompt=<urlencode>
            &chatRequirementsToken=<token из шага 3/4>
      → Content-Type: text/vnd.openai.web-mobile-partial+html
      тело: <template data-web-mobile-dpu-frame="...">...</template> ...
```

Важные наблюдения:

- transport не JSON. Запрос — form-urlencoded, ответ — поток HTML-шаблонов (DPU, declarative partial updates). Поэтому «просто POST JSON в `/backend-api/conversation`» здесь не работает.
- `operationId` в query — UUID, генерируется клиентом.
- `chatRequirementsToken` — это `token` из `chat-requirements/finalize`, не `prepare_token`.
- conversation_id приходит в теле ответа (`data-conversation-id`, `data-canonical-path=/uc/<uuid>`) — клиент получает его **после** отправки, а не до.
- `conduit_token` из шага 2 — JWT с `conduit_location` (видно адрес внутреннего conduit-сервиса, например `10.x.x.x:8305`) и `exp` через ~60 секунд.

## 3. Ответ модели

Ответ приходит тем же HTTP-ответом на шаге 5, дробится на DPU-фреймы, а браузер применяет их к DOM. В DOM текст оказывается в блоке после `ChatGPT said:`:

```
New chat
...
You said:
<промпт>
ChatGPT said:
<ответ>
ChatGPT is AI and can make mistakes.
We use cookies
...
```

Отсюда два следствия для прокси:

1. **Читать ответ можно из DOM**, не разбирая DPU-формат.
2. **Стриминг** получается опросом `innerText` с диффом.

Реализация — `driver.js`: режем `document.body.innerText` по последнему `ChatGPT said:` (оборотов в DOM несколько при многоходовке) и усекаем по футеру (`ChatGPT is AI and can make mistakes`, `We use cookies`).

## 4. Подводные камни UI

В порядке обнаружения:

- **Enter не отправляет.** Нужно нажать `button[aria-label*="Send" i]`.
- **Cookie-баннер** (`[data-octane-static-cookie-consent]`) перекрывает композер и перехватывает клики. Удаляется из DOM.
- **Окно входа** (`#mobile-auth-dialog`, `dialog[data-bottom-sheet]`) открывается после нескольких анонимных оборотов и полностью блокирует UI. Закрывается Escape + удалением из DOM, дальше можно продолжать.
- **React-композер игнорирует** `page.fill()` и direct `.value =`. Нужно setter из `HTMLTextAreaElement.prototype` + dispatch `input`.
- **`page.click()` на кнопке Send** ломается о любой оверлей. Помогает `element.evaluate(b => b.click())`.
- **Обычный `.click()` на композер** тоже перехватывается — кликаем по координатам (`page.mouse.click(cx, cy)`).

## 5. Реверс JS-бандлов

Бандлы на `chatgpt.com` сильно минифицированы и динамически подгружаются. Найти код отправки сообщения в raw-форме не удалось (имена вида `a-DfS2hghU.js`, всё через `octane-shell-shared-piTOd1ep.js`).

Из найденного (файл `conversation-prepare-client-CeYjj5_e.js`):

```js
let Y = new URLSearchParams({
  ...f ? { conversationRetryOwner: JSON.stringify(f) } : {},
  conversationState: oe(e),
  ...h ? { workOrigin: h.origin, workModel: h.model, ... } : {},
  clientContextualInfo: re().clientContextualInfo,
  ...ie()
});
let Z = new URL(ne(U()), window.location.href);
f && Z.searchParams.set(`lightweight_authenticated`, f.mode === `authenticated` ? `1` : `0`);
let se = {
  body: Y,
  credentials: `same-origin`,
  headers: {
    "X-Web-Mobile-Conversation-Renderer": `octane`,
    "x-oai-turn-trace-id": H,
    "x-web-mobile-prepare-state": B,
    "x-web-mobile-prepare-reason": a,
    ...V ? { "x-conduit-token": V } : {},
    ...s(), ...d(), ...t()
  },
  method: `POST`,
  signal: G.signal
};
```

Видно, что заголовки собираются из нескольких функций (`s()`, `d()`, `t()`), а аутентифицированный режим отличается лишь `lightweight_authenticated=1`. Сервис-воркеры не регистрируются (`navigator.serviceWorker.getRegistrations()` пусто), запросы идут со страницы.

## 6. Итог

Реализованный прокси использует **браузерный путь** (надёжнее, не требует повторения обфусцированной логики сборки заголовков), а не прямой HTTP-путь, хотя цепочка эндпоинтов полностью описана и может быть реализована отдельно.

Проверено:

- обычные и стриминговые ответы;
- системные промпты (`[system] ...` в начале промпта);
- многоходовки (запоминает имя в пределах разговора);
- серии из 4+ запросов подряд после исправления `mobile-auth-dialog`;
- внешний доступ через проброшенный порт.
