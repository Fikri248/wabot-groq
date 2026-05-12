# Wabot Groq

WhatsApp RAG chatbot for a CSV-based product catalog. The bot connects to WhatsApp through `whatsapp-web.js`, reads product data from local datasets, routes common shopping intents deterministically, and can use Groq as a fallback language model over retrieved context.

The current implementation is oriented toward Indonesian customer support for a product store, with product listing, category browsing, price sorting, discount listing, recommendations, keyword replies, and paginated WhatsApp responses.

## Features

- WhatsApp bot connection using `whatsapp-web.js` and `LocalAuth`.
- Express server with a small browser dashboard.
- CSV product dataset loading from `data/`.
- RAG-style retrieval using local TF-IDF-like scoring in `lib/rag.js`.
- Deterministic intent routing for common store queries.
- Product list pagination per WhatsApp chat.
- Continuation commands such as `lanjut`, `next`, and `lihat produk selanjutnya`.
- Product sorting by cheapest, most expensive, largest discount, and smallest discount.
- Category browsing for store product groups.
- Brand browsing for known brands found in the dataset.
- Recommendation and function-based product search.
- Store-scope safety filters for unrelated, math, coding, and admin-style commands.
- Optional Groq fallback response generation when deterministic routing does not answer.
- Local keyword response management through `knowledge.json`.
- Behavior configuration through `config/behavior.json`.

## Tech Stack

- Node.js
- Express
- whatsapp-web.js
- Groq SDK
- qrcode-terminal
- dotenv
- Browser dashboard using static HTML, CSS, and JavaScript
- Local CSV and JSON files for data/configuration

## Architecture Overview

High-level message flow:

```text
WhatsApp message
  -> whatsapp-web.js client
  -> duplicate/self/status/private-chat guards
  -> continuation command check
  -> keyword response check
  -> deterministic intent router
  -> local dataset and product formatter
  -> optional RAG context retrieval
  -> optional Groq fallback
  -> WhatsApp reply
```

The main runtime file is `server-v2.js`.

Important modules:

- `server-v2.js`: Express server, WhatsApp client, intent routing, formatting, pagination, API endpoints.
- `lib/dataset.js`: loads CSV/JSON datasets, transforms CSV rows into semantic documents, extracts product catalog data.
- `lib/rag.js`: local RAG-style tokenizer, index builder, similarity retrieval, debug metadata.
- `public/index.html`: dashboard UI.
- `public/app.js`: dashboard API calls for bot control, QR display, and keyword management.
- `config/behavior.json`: language, system prompt, fallback phrase, and reply style.
- `knowledge.json`: manual keyword-response mappings.
- `data/shopee.csv`: current product dataset.

## Project Structure

```text
wabot-groq/
  config/
    behavior.json
  data/
    shopee.csv
  lib/
    dataset.js
    rag.js
  public/
    index.html
    app.js
  .env
  .gitignore
  knowledge.json
  package.json
  package-lock.json
  server-v2.js

Runtime/generated locally:
  .wwebjs_auth/
  .wwebjs_cache/
  server-*.log
  server-*.err
```

Runtime folders and logs are intentionally ignored by `.gitignore`.

## Installation

Requirements:

- Node.js
- npm
- A WhatsApp account that can link a device
- Groq API key if you want AI fallback responses

Install dependencies:

```bash
npm install
```

## Environment Setup

Create a `.env` file in the project root.

Minimum useful setup:

```env
GROQ_API_KEY=your_groq_api_key_here
```

Supported environment variables in the current code:

```env
PORT=3001
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.1-8b-instant
GROQ_MAX_TOKENS=200
RAG_TOP_K=3
RAG_SCORE_THRESHOLD=0.03
PRODUCT_PAGE_SIZE=5
AUTO_START_BOT=true
```

Notes:

- `PORT` defaults to `3001`.
- `PRODUCT_PAGE_SIZE` defaults to `5`.
- `AUTO_START_BOT=false` starts only the web server and dashboard, without automatically starting WhatsApp.
- If `GROQ_API_KEY` is missing, deterministic store responses still work, but Groq fallback generation cannot run.

## Running the Project

Production-style start:

```bash
npm start
```

Development start with nodemon:

```bash
npm run dev
```

Available scripts from `package.json`:

```json
{
  "start": "node server-v2.js",
  "dev": "nodemon server-v2.js"
}
```

Open the dashboard:

```text
http://localhost:3001
```

## WhatsApp Bot Setup

1. Start the server with `npm start`.
2. Open `http://localhost:3001`.
3. Click `Mulai Bot` if the bot is offline.
4. Scan the QR code using WhatsApp:
   - WhatsApp mobile app
   - Linked Devices
   - Link a Device
5. After authentication, the dashboard should show `Bot Connected`.

The WhatsApp session is stored under:

```text
.wwebjs_auth/
```

This folder contains sensitive browser/session data. Do not commit it.

## CSV Dataset Format

Datasets are loaded from the `data/` directory at startup. The current dataset is:

```text
data/shopee.csv
```

The CSV loader is permissive. It looks for:

- product name: first non-URL, non-numeric meaningful text column
- price: first numeric-looking value after the product name
- discount: a value like `-6%`
- product URL: Shopee URL if present

Example shape from the current CSV:

```csv
"contents href","_image_yazkc_11 src","whitespace-normal","font-medium 2","h-4"
"https://shopee.co.id/...","https://down-id.img.susercontent.com/...","Racun Tikus PETROKUM ...","7.750","-6%"
```

`lib/dataset.js` transforms rows into semantic documents like:

```text
Produk: Product name
Jenis data: produk
Status: tersedia dalam dataset produk
Kategori: Media tanam
Harga: Rp 7.750
Diskon: -6%
Brand: NETAFARM
Sumber marketplace: Shopee
```

The loader also creates a summary document named `ringkasan-produk` containing category counts, brand names, and sample products.

## API Endpoints

### Bot control

```http
GET /api/bot/status
```

Example response:

```json
{
  "isReady": true,
  "isCleaning": false,
  "isInitializing": false,
  "hasQRCode": false
}
```

```http
POST /api/bot/start
```

Starts the WhatsApp client if it is not already running.

```http
POST /api/bot/stop
```

Stops the WhatsApp client.

```http
GET /api/bot/qr
```

Returns the current QR string when WhatsApp is waiting for authentication.

### Dataset

```http
GET /api/datasets
GET /api/datasets/:name
POST /api/datasets
```

`POST /api/datasets` accepts:

```json
{
  "name": "dataset-name",
  "data": {
    "documents": []
  }
}
```

The endpoint saves JSON datasets into `data/<name>.json`.

### Knowledge keywords

```http
GET /api/knowledge/keywords
POST /api/knowledge/keyword
DELETE /api/knowledge/keyword/:keyword
```

`POST /api/knowledge/keyword` accepts:

```json
{
  "keyword": "halo",
  "response": "Halo, ada yang bisa kami bantu?"
}
```

Keyword responses are stored in `knowledge.json`.

### Behavior config

```http
GET /api/behavior
POST /api/behavior
```

Behavior settings are stored in `config/behavior.json`.

## Intent System

The deterministic router in `server-v2.js` detects these main intents:

- `greeting`
- `store_info`
- `product_list`
- `product_search`
- `price`
- `category`
- `brand`
- `recommendation`
- `function_based_search`
- `discount`
- `expensive_products`
- `cheap_products`
- `unsupported_admin_command`
- `unrelated_query`
- `math_or_calculation`

### Safety layer

Before normal routing, the bot checks for:

- admin/product-management commands, such as `tambah`, `hapus`, `edit`, `ubah`, `delete`, `remove`, `insert`, `update`
- coding/programming requests
- general non-store questions
- math/calculation queries

Unsupported management commands return:

```text
Maaf, pengelolaan produk tidak tersedia melalui chat WhatsApp.
```

Unrelated or math/coding/general questions return:

```text
Maaf, saya hanya dapat membantu terkait produk dan kategori toko.
```

### Product and category logic

Category detection is keyword-based. Current categories include:

- Alat pertanian
- Media tanam
- Nutrisi hidroponik
- Pupuk tanaman
- Pestisida dan pengendalian hama
- Produk pertanian lain

Brand detection currently recognizes names such as:

- NETAFARM
- PETROKUM
- GAVIOTA
- ASENA
- REDINET
- TANI JAYA
- EM4

### Price and discount logic

Supported sorted product queries include:

- `produk termurah`
- `barang murah`
- `produk termahal`
- `barang paling mahal`
- `harga tertinggi`
- `produk premium`
- `diskon terbesar`
- `diskon terkecil`
- `produk promo`

Price sorting parses digits from formatted price strings such as `Rp 7.750`.

Discount sorting parses percentage values such as `-6%`.

## RAG Retrieval Flow

The project uses a local RAG-style retriever, not an external vector database.

Flow:

```text
Dataset documents
  -> normalize text
  -> tokenize
  -> expand aliases
  -> build TF-IDF-like vectors
  -> score query against documents
  -> filter by threshold
  -> pass top contexts to Groq if needed
```

Relevant implementation details:

- Stopwords are removed in `lib/rag.js`.
- Product-list, store-info, and greeting intent hints adjust document scores.
- The index is cached using a simple signature of document sources and text lengths.
- Default retrieval threshold is `0.03`.
- Default top K is `3`.

## Deterministic vs Groq Responses

Most store/product flows are answered deterministically by `buildIntentResponse()`.

Deterministic responses are used for:

- product lists
- categories
- brands
- recommendations
- price and discount sorting
- safety fallbacks
- unsupported admin commands

Groq is only used after context retrieval when deterministic routing does not produce a response. The prompt instructs Groq to answer only from supplied context and use the configured fallback if context is missing or irrelevant.

## Pagination System

Pagination state is stored in memory:

```text
Map<chatId, paginationState>
```

State includes:

- mode/intent
- page
- page size
- product list
- label/context
- discount display flag
- sorting mode
- updated timestamp

Default TTL:

```text
15 minutes
```

Supported continuation commands:

```text
lihat produk selanjutnya
produk selanjutnya
selanjutnya
lanjut
next
berikutnya
```

If more products exist, responses include:

```text
Menampilkan 1-5 dari 70 produk.
Ketik "lihat produk selanjutnya" untuk lanjut.
```

On the last page:

```text
Itu semua produk yang tersedia untuk pencarian ini.
```

Pagination is reset when a new non-paginated intent is handled, a keyword match is used, the state expires, or the final page has been sent.

## Example WhatsApp Queries

Product list:

```text
daftar produk
produk apa aja
katalog produk
```

Sorted by price:

```text
produk termurah
barang murah
produk termahal
harga tertinggi
produk premium
```

Discounts:

```text
produk promo
diskon terbesar
diskon terkecil
```

Categories:

```text
kategori produk
media tanam
pupuk tanaman
pestisida
hidroponik
alat semprot
```

Recommendations:

```text
rekomendasi produk
produk untuk pemula
produk untuk membasmi hama
produk untuk hidroponik
```

Continuation:

```text
lihat produk selanjutnya
lanjut
next
```

Out-of-scope examples that should not trigger product retrieval:

```text
hitung 18 * 9
buat codingan CV
cara membuat website
siapa presiden Indonesia
hapus produk media tanam
tambah produk pestisida
```

## Dashboard

The dashboard is served from `public/` at the root URL.

It supports:

- viewing bot connection status
- starting the bot
- stopping the bot
- displaying the WhatsApp QR code
- creating, editing, and deleting keyword responses

Important note: the dashboard currently has no login/authentication layer. Run it only in a trusted local environment or behind your own access control.

## Security Notes

Do not commit these files or folders:

```text
.env
.env.*
.wwebjs_auth/
.wwebjs_cache/
*.log
*.err
server-*.log
server-*.err
node_modules/
```

The current `.gitignore` includes these protections.

Sensitive areas:

- `.env` contains `GROQ_API_KEY`.
- `.wwebjs_auth/` contains WhatsApp session/browser profile data.
- `.wwebjs_cache/` contains generated WhatsApp Web cache files.
- Logs can contain message bodies, chat IDs, QR events, prompt previews, stack traces, and local paths.
- `public/app.js` renders QR images through `https://api.qrserver.com`; this sends the QR string to that external service for image generation.
- API routes and dashboard actions are not authenticated.

Recommended operational practice:

- Keep the server local or behind a private network.
- Rotate secrets if `.env` is exposed.
- Delete `.wwebjs_auth/` only when intentionally resetting the WhatsApp session.
- Avoid committing logs or session folders.

## Troubleshooting

### Port already in use / EADDRINUSE

The server defaults to port `3001`.

Options:

```bash
PORT=3002 npm start
```

Or stop the process currently using port `3001`.

### QR code does not appear

Check:

- server is running
- dashboard is open at the correct port
- `/api/bot/status` returns `hasQRCode: true`
- browser console/network tab for failed QR requests
- terminal output for QR text from `qrcode-terminal`

### WhatsApp auth reset

If the session becomes invalid or stuck, stop the bot and remove the local WhatsApp session folder:

```text
.wwebjs_auth/
```

Then start the bot again and scan a new QR code. This deletes the local session, so do it only when you intend to relink WhatsApp.

### Missing GROQ_API_KEY

If `GROQ_API_KEY` is missing, the app logs:

```text
GROQ_API_KEY belum diatur.
```

Deterministic catalog responses can still work, but Groq fallback generation will not.

### CSV loading issues

Check:

- file exists under `data/`
- file extension is `.csv`
- CSV has at least a header row and one data row
- product name column contains non-URL, non-numeric text
- price column contains numeric-looking values

The loader prints dataset load messages when the server starts.

### Bot not responding

Check:

- dashboard status is `Bot Connected`
- WhatsApp session is authenticated
- messages are sent from personal chats, not status or unsupported chat types
- the message is not from the bot itself
- logs do not show initialization or browser profile errors

### Pagination issues

Pagination is in memory. It resets when:

- the server restarts
- 15 minutes pass without continuation
- the user sends a new non-continuation query
- the final page is sent

If `lanjut` returns no active list, send a fresh query such as `daftar produk`.

## Runtime Behavior Notes

- `DatasetManager` loads datasets once at startup.
- `RAGEngine` caches its index until its document signature changes.
- The WhatsApp client uses `LocalAuth({ clientId: 'whatsapp-bot' })`.
- Auto-start is enabled unless `AUTO_START_BOT=false`.
- Duplicate WhatsApp events are filtered by message ID for 5 minutes.
- The bot ignores messages sent by itself.
- The bot only handles personal chats ending in `@c.us` or `@lid`.
- The bot sends a typing indicator when possible.

## Known Limitations

- Knowledge is local-file based; there is no database server.
- CSV and JSON datasets are loaded from disk, mostly at startup.
- No vector database or embedding model is used.
- RAG relevance is lexical and alias-based, so semantic matching is limited.
- Intent classification depends on regexes and curated keyword lists.
- Pagination state is lost on restart.
- WhatsApp connectivity depends on the local browser session and `whatsapp-web.js`.
- The dashboard has no authentication.
- There is no built-in deployment, Docker, or process manager configuration.
- There are no automated tests in `package.json`.
