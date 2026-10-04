# chatgpt-unauth-proxy

OpenAI-совместимый HTTP-API поверх браузерного интерфейса ChatGPT **без аккаунта и логина**. Прокси ведёт headless Chrome, который проходит JS-челлендж Cloudflare и работает с сайтом как анонимный пользователь, а ответы модели отдаёт клиентам в формате `POST /v1/chat/completions` (включая SSE-стриминг).

---

## Как это работает

ChatGPT отдаёт веб-интерфейс анонимам: `/backend-api/models` и `unauth-mweb`-эндпоинты отвечают 200 без сессии, а сообщения можно отправлять прямо со страницы. Прямой доступ к API закрыт Cloudflare (JS-challenge), поэтому прокси использует браузер:

```
клиент ── /v1/chat/completions ──> server.js ──> очередь ──> driver.js
                                                              │
                                              headless Chrome (CDP :9222)
                                              ┌───────────────────────────────┐
                                              │ 1. открыть chatgpt.com        │
                                              │ 2. дождаться прохождения CF    │
                                              │ 3. ввести промпт в композер    │
                                              │ 4. нажать кнопку отправки      │
                                              │ 5. читать ответ из DOM         │
                                              └───────────────────────────────┘
                                                              │
                        SSE-дельты ←──── инкрементальный diff innerText
```

Ключевые детали, без которых не работает:

- **Cloudflare bypass**: `connectOverCDP` к системному Chrome с **персистентным профилем** (`--user-data-dir`) и реальным User-Agent. Обычный `headless=new` с ephemeral-профилем челлендж не проходит (бесконечный "Just a moment..."), а CDP + сохранённый профиль — проходит.
- **Ввод**: текст вписывается через нативный setter `HTMLTextAreaElement.prototype.value` + событие `input`, иначе React-композер его не видит. Отправка — `button[aria-label*="Send"]`, но кликом через `element.evaluate(b => b.click())`, так как оверлеи (cookie-баннер, `mobile-auth-dialog`) перехватывают обычный click.
- **Стриминг**: ответ рендерится в DOM渐进но. Драйвер опрашивает `document.body.innerText` каждые 400 мс, режет регион по последнему `ChatGPT said:` и отдаёт клиенту только прирост текста как SSE-дельту. Завершение оборота определяется по стабилизации текста (`COMPLETION_IDLE_MS`).
- **Очередь**: одно окно браузера = один разговор за раз, поэтому запросы идут через FIFO-очередь (`MAX_QUEUE`).
- **Восстановление**: при ошибке выполнения прокси переподключается к CDP, прогревает страницу и ретраит запрос.

### Транспорт ChatGPT (для справки)

Разведкой выявлена реальная цепочка анонимного обмена, которая пригодится для реализации без браузера:

1. `GET /` — пройти JS-challenge, получить `__cf_bm`, `oai-did`, `cf_clearance`.
2. `GET /unauth-mweb/sentinel/chat-requirements/prepare` → `prepare_token`.
3. `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0` (form-urlencoded, `conversationState`) → `conduit_token`.
4. `POST /unauth-mweb/sentinel/chat-requirements/finalize` → `token` (это и есть `chatRequirementsToken`).
5. `POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>` (form-urlencoded: `prompt`, `chatRequirementsToken`, `conversationState`, `oai-session-id`) → ответ потоком `text/vnd.openai.web-mobile-partial+html` (DPU-фреймы, не plain JSON).

Использованные на практике эндпоинты и payload'ы см. в `docs/research-notes.md`.

---

## Запуск

### Требования

- Linux, Node.js ≥ 18, Google Chrome / Chromium
- apt-пакет `playwright` не нужен; browser-download можно пропустить

### 1. Поставить playwright

```bash
mkdir -p /opt/chatgpt-api-proxy
cp -r . /opt/chatgpt-api-proxy
cd /opt/chatgpt-api-proxy
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright
```

### 2. Запустить Chrome под супервизором

Chrome должен слушать CDP на `127.0.0.1:9222` с постоянным профилем:

```bash
./chrome-supervisor.sh
```

или systemd:

```bash
cp chatgpt-chrome.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chatgpt-chrome
```

Проверить, что CDP отвечает:

```bash
curl http://127.0.0.1:9222/json/version
```

### 3. Запустить прокси

```bash
PROXY_PORT=22050 CDP_URL=http://127.0.0.1:9222 node server.js
```

или systemd:

```bash
cp chatgpt-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chatgpt-proxy
curl http://127.0.0.1:22050/health
```

### 4. Использовать

Прокси реализует подмножество OpenAI API:

```bash
curl http://localhost:22050/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [{"role":"user","content":"Say hello"}],
    "stream": true
  }'
```

Подключение любого OpenAI-совместимого клиента:

```
BASE_URL=http://<host>:22050/v1
API_KEY=<любое значение>
MODEL=gpt-5.5
```

API-ключ не валидируется — это намеренно, прокси открытый. Закрывайте порт фаерволом или ставьте reverse-proxy с auth.

## Эндпоинты

| Метод | Путь | Описание |
|---|---|---|
| POST | `/v1/chat/completions` | чат, `stream: true/false` |
| GET | `/v1/models` | список алиасов моделей |
| GET | `/health` | статус очереди и движка |

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PROXY_PORT` | `22100` | порт HTTP-сервера |
| `CDP_URL` | `http://127.0.0.1:9222` | CDP-эндпоинт Chrome |
| `MAX_QUEUE` | `20` | максимум ожидающих запросов |
| `REQUEST_TIMEOUT` | `180` | таймаут одного запроса, секунды |
| `COMPLETION_IDLE_MS` | `3200` | stabilize-таймер для конца ответа |

## Файлы

- `server.js` — HTTP-сервер, очередь, маппинг в OpenAI-формат
- `driver.js` — браузерный драйвер: прогрев, ввод, отправка, чтение ответа
- `chrome-supervisor.sh` — supervises Chrome, перезапускает при падении
- `chatgpt-chrome.service`, `chatgpt-proxy.service` — systemd-юниты
- `docs/research-notes.md` — как был исследован транспорт ChatGPT

## Ограничения

- Пропускная способность ограничена одним окном браузера (последовательно).
- Качество и доступность зависят от состояния анонимной сессии: иногда сайт открывает окно входа (`mobile-auth-dialog`) — драйвер его закрывает, но при частых запросах возможны отказы.
- `usage` всегда нулевой: реальный подсчёт токенов недоступен.
- Разметка ответа иногда приходит порцией, а не по одному слову — стриминг выглядит «рваным».
