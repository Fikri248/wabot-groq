require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

let client = null;
let qrCodeData = null;
let isReady = false;
let isCleaning = false;
let isInitializing = false;
const handledMessageIds = new Set();
const paginationStates = new Map();
const PAGINATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PAGE_SIZE = Number(process.env.PRODUCT_PAGE_SIZE || 5);
const STORE_SCOPE_FALLBACK_RESPONSE =
  'Maaf, saya hanya dapat membantu terkait produk dan kategori toko.';
const MANAGEMENT_UNSUPPORTED_RESPONSE =
  'Maaf, pengelolaan produk tidak tersedia melalui chat WhatsApp.';

const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');

if (!fs.existsSync(knowledgeFile)) {
  fs.writeFileSync(
    knowledgeFile,
    JSON.stringify({ keywords: {}, responses: {} }, null, 2)
  );
}

function loadKnowledge() {
  try {
    const data = fs.readFileSync(knowledgeFile, 'utf8');
    const parsed = JSON.parse(data);

    return {
      keywords: parsed.keywords || {},
      responses: parsed.responses || {}
    };
  } catch (error) {
    console.error('Error loading knowledge:', error);
    return { keywords: {}, responses: {} };
  }
}

function saveKnowledge(data) {
  try {
    fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
    ragEngine.clearCache();
    return true;
  } catch (error) {
    console.error('Error saving knowledge:', error);
    return false;
  }
}

function loadBehavior() {
  try {
    if (!fs.existsSync(behaviorFile)) return null;
    const content = fs.readFileSync(behaviorFile, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading behavior config:', error.message);
    return null;
  }
}

function saveBehavior(obj) {
  try {
    fs.mkdirSync(path.dirname(behaviorFile), { recursive: true });
    fs.writeFileSync(behaviorFile, JSON.stringify(obj, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving behavior config:', error.message);
    return false;
  }
}

function getDefaultBehavior() {
  return {
    system_instructions:
      'Jawab hanya berdasarkan konteks yang diberikan. Jika tidak ada jawaban, tampilkan fallback.',
    fallback_response: 'Mohon maaf, untuk item itu belum ada di toko kami.',
    max_sentences: 2,
    language: 'id'
  };
}

function normalizeForMatch(value) {
  if (!value) return '';

  return value
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStoreNameFromBehavior(behavior) {
  const instructions = behavior && behavior.system_instructions;
  if (!instructions) return '';

  const match = instructions.match(/toko\s+([a-z0-9 .&'-]+?)\s+(?:yang|dan|dengan|hanya|untuk|$)/i);
  return match ? match[1].trim() : '';
}

function buildBehaviorContextDocuments(behavior) {
  const activeBehavior = behavior || getDefaultBehavior();
  const storeName = extractStoreNameFromBehavior(activeBehavior);

  if (!storeName) return [];

  return [
    {
      source: 'config/behavior.json',
      text: [
        `Nama toko: ${storeName}`,
        'Jenis data: konfigurasi perilaku bot',
        `Sapaan: Halo, ada yang bisa saya bantu terkait produk ${storeName}?`,
        'Pertanyaan umum: nama toko, toko apa, halo, hai, salam'
      ].join('\n')
    }
  ];
}

function findKnowledgeResponse(message, knowledge) {
  const normalizedMessage = normalizeForMatch(message);
  const responses = knowledge.responses || {};
  const keywords = knowledge.keywords || {};

  for (const [keyword, response] of Object.entries(responses)) {
    const normalizedKeyword = normalizeForMatch(keyword);
    if (normalizedKeyword && normalizedKeyword === normalizedMessage) {
      return { response, matchType: 'exact_response_key', keyword };
    }
  }

  for (const [keyword, response] of Object.entries(responses)) {
    const normalizedKeyword = normalizeForMatch(keyword);
    if (
      normalizedKeyword &&
      normalizedKeyword.length > 2 &&
      normalizedMessage.includes(normalizedKeyword)
    ) {
      return { response, matchType: 'partial_response_key', keyword };
    }
  }

  for (const [groupName, value] of Object.entries(keywords)) {
    const keywordList = Array.isArray(value)
      ? value
      : Array.isArray(value && value.keywords)
        ? value.keywords
        : typeof value === 'string'
          ? [value]
          : [];

    const matchedKeyword = keywordList.find((item) => {
      const normalizedKeyword = normalizeForMatch(item);
      return (
        normalizedKeyword &&
        (normalizedMessage === normalizedKeyword ||
          normalizedMessage.includes(normalizedKeyword))
      );
    });

    if (!matchedKeyword) continue;

    if (typeof value === 'object' && value && typeof value.response === 'string') {
      return {
        response: value.response,
        matchType: 'keywords_inline_response',
        keyword: matchedKeyword
      };
    }

    if (responses[groupName]) {
      return {
        response: responses[groupName],
        matchType: 'keywords_group_response',
        keyword: matchedKeyword
      };
    }
  }

  return null;
}

function logRetrievalDebug(ragDebug, contextItems) {
  if (!ragDebug) return;

  console.log(
    `[DEBUG:RAG] normalizedQuery=${JSON.stringify(ragDebug.normalizedQuery)} documents=${ragDebug.documentCount} threshold=${ragDebug.threshold}`
  );
  console.log(`[DEBUG:RAG] queryTokens=${JSON.stringify(ragDebug.queryTokens)}`);
  console.log(
    `[DEBUG:RAG] topCandidates=${JSON.stringify(ragDebug.topCandidates)}`
  );
  console.log(
    `[DEBUG:RAG] returnedContexts=${JSON.stringify(
      contextItems.map((item) => ({
        source: item.source,
        score: Number(item.score.toFixed(4)),
        preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 180)
      }))
    )}`
  );

  if (ragDebug.fallbackReason) {
    console.log(`[DEBUG:RAG] fallbackReason=${ragDebug.fallbackReason}`);
  }
}

function classifyProductCategory(productName) {
  const normalizedName = normalizeForMatch(productName);

  if (/\b(keranjang|pot pupuk|tempat pupuk|sprayer|semprot|jaring|paranet|alat|net)\b/.test(normalizedName)) {
    return 'Alat pertanian';
  }

  if (/\b(media tanam|sekam|perlite|cocopeat|pasir|tanah)\b/.test(normalizedName)) {
    return 'Media tanam';
  }

  if (/\b(ab mix|nutrisi|hidroponik|em4)\b/.test(normalizedName)) {
    return 'Nutrisi hidroponik';
  }

  if (/\b(pupuk|booster|npk|gaviota|kapur|dolomit|dolomite)\b/.test(normalizedName)) {
    return 'Pupuk tanaman';
  }

  if (/\b(racun|hama|rodentisida|insektisida|fungisida|pestisida)\b/.test(normalizedName)) {
    return 'Pestisida dan pengendalian hama';
  }

  return 'Produk pertanian lain';
}

function summarizeProductCategories(products) {
  const counts = new Map();

  products.forEach((product) => {
    const category = classifyProductCategory(product.name);
    counts.set(category, (counts.get(category) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => `${category} (${count})`);
}

function truncateProductName(name, maxLength = 62) {
  if (!name) return '';
  const cleanName = name.replace(/\s+/g, ' ').trim();
  if (cleanName.length <= maxLength) return cleanName;

  const cutAt = cleanName.lastIndexOf(' ', maxLength - 1);
  const end = cutAt > 35 ? cutAt : maxLength - 1;
  return `${cleanName.slice(0, end).trim()}...`;
}

function getCategorySummary(products) {
  const counts = new Map();

  products.forEach((product) => {
    const category = product.category || classifyProductCategory(product.name);
    counts.set(category, (counts.get(category) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
}

function formatProductListResponse(products, limit = 10) {
  if (!products || products.length === 0) return null;

  const pagination = buildPaginationResult({
    mode: 'product_list',
    products,
    label: 'Berikut produk yang tersedia:'
  });

  return pagination.response;
}

function formatPaginatedProducts(state) {
  if (!state || !Array.isArray(state.products) || state.products.length === 0) {
    return null;
  }

  const page = Math.max(Number(state.page || 1), 1);
  const pageSize = Math.max(Number(state.pageSize || DEFAULT_PAGE_SIZE), 1);
  const total = state.products.length;
  const startIndex = (page - 1) * pageSize;
  const pageItems = state.products.slice(startIndex, startIndex + pageSize);

  if (pageItems.length === 0) {
    return {
      response: 'Itu semua produk yang tersedia untuk pencarian ini.',
      hasMore: false,
      start: total,
      end: total,
      total
    };
  }

  const lines = [state.label || 'Berikut produk yang tersedia:'];

  pageItems.forEach((product, index) => {
    const productNumber = startIndex + index + 1;
    const price = product.price ? ` - ${product.price}` : '';
    const discount = state.includeDiscount && product.discount
      ? ` (${product.discount})`
      : '';
    lines.push(
      `${productNumber}. ${truncateProductName(product.name)}${price}${discount}`
    );
  });

  const end = startIndex + pageItems.length;
  const hasMore = end < total;
  lines.push('');
  lines.push(`Menampilkan ${startIndex + 1}-${end} dari ${total} produk.`);

  if (hasMore) {
    lines.push('Ketik "lihat produk selanjutnya" untuk lanjut.');
  } else {
    lines.push('Itu semua produk yang tersedia untuk pencarian ini.');
  }

  return {
    response: lines.join('\n'),
    hasMore,
    start: startIndex + 1,
    end,
    total
  };
}

function buildPaginationState({
  mode,
  products,
  label,
  includeDiscount = false,
  page = 1,
  sortingMode = null
}) {
  return {
    mode,
    intent: mode,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    products,
    label,
    includeDiscount,
    sortingMode,
    updatedAt: Date.now()
  };
}

function buildPaginationResult(options) {
  const state = buildPaginationState(options);
  const page = formatPaginatedProducts(state);

  return {
    state: page && page.hasMore ? state : null,
    response: page ? page.response : null
  };
}

function isContinuationCommand(message) {
  const normalizedMessage = normalizeForMatch(message);

  return /^(lihat produk selanjutnya|produk selanjutnya|selanjutnya|lanjut|next|berikutnya)$/.test(normalizedMessage);
}

function getPaginationState(chatId) {
  const state = paginationStates.get(chatId);
  if (!state) return null;

  if (Date.now() - state.updatedAt > PAGINATION_TTL_MS) {
    paginationStates.delete(chatId);
    console.log(`[DEBUG:PAGINATION] reset chatId=${chatId} reason=expired`);
    return null;
  }

  return state;
}

function setPaginationState(chatId, state) {
  paginationStates.set(chatId, state);
  console.log(
    `[DEBUG:PAGINATION] create chatId=${chatId} mode=${state.mode} sortingMode=${state.sortingMode || 'none'} page=${state.page} pageSize=${state.pageSize} total=${state.products.length} label=${JSON.stringify(state.label)}`
  );
}

function clearPaginationState(chatId, reason) {
  if (!paginationStates.has(chatId)) return;
  paginationStates.delete(chatId);
  console.log(`[DEBUG:PAGINATION] reset chatId=${chatId} reason=${reason}`);
}

function renderNextPaginationPage(chatId) {
  const state = getPaginationState(chatId);

  if (!state) {
    return {
      response:
        'Belum ada daftar produk yang sedang dibuka. Ketik "daftar produk" untuk melihat katalog.',
      handled: true
    };
  }

  state.page += 1;
  state.updatedAt = Date.now();
  const page = formatPaginatedProducts(state);

  if (!page || page.start > page.total) {
    clearPaginationState(chatId, 'pagination_complete');
    return {
      response: 'Itu semua produk yang tersedia untuk pencarian ini.',
      handled: true
    };
  }

  if (!page.hasMore) {
    clearPaginationState(chatId, 'last_page_sent');
  } else {
    paginationStates.set(chatId, state);
  }

  console.log(
    `[DEBUG:PAGINATION] continuation chatId=${chatId} mode=${state.mode} sortingMode=${state.sortingMode || 'none'} page=${state.page} total=${page.total} range=${page.start}-${page.end}`
  );

  return {
    response: page.response,
    handled: true
  };
}

function contextHasProductSummary(contextItems) {
  return contextItems.some((item) =>
    /ringkasan-produk|produk tersedia|katalog produk/i.test(
      `${item.source}\n${item.text}`
    )
  );
}

const CHAT_STOPWORDS = new Set([
  'ada',
  'jual',
  'cari',
  'produk',
  'barang',
  'item',
  'harga',
  'harganya',
  'berapa',
  'untuk',
  'yang',
  'apa',
  'aja',
  'saja',
  'dong',
  'min',
  'admin',
  'produkny',
  'produknya',
  'toko',
  'ini',
  'di',
  'cv',
  'netafarm'
]);

const KNOWN_BRANDS = [
  'netafarm',
  'petrokum',
  'gaviota',
  'asena',
  'redinet',
  'tani jaya',
  'em4'
];

const ADMIN_COMMAND_START_RE = /^(tambah|hapus|edit|ubah|update|delete|remove|insert)\b/;
const ADMIN_MANAGEMENT_RE = /\b(tambah|hapus|edit|ubah|delete|remove|insert|update)\b/;
const UNSUPPORTED_TECH_RE = /\b(buat|generate|coding|koding|kodingan|script|skrip|program|programming|pemrograman|website|aplikasi|app|cv|resume|html|css|javascript|python|java|php|sql|source code)\b/;
const GENERAL_TOPIC_RE = /\b(presiden|cuaca|bitcoin|crypto|kripto|game|main game|sepak bola|politik|berita|siapa|kapan|dimana|mengapa|kenapa|sejarah|ibukota|ibu kota)\b/;
const MATH_QUERY_RE = /\b(hitung|berapa hasil|jumlahkan|kurangi|kali|bagi|tambah)\b.*\d|\d+\s*(?:x|\*|\/|\+|-)\s*\d+|\b\d+\s+(?:kali|dibagi|ditambah|dikurangi)\s+\d+\b/;
const PRODUCT_CONTEXT_RE = /\b(produk|barang|item|katalog|daftar|list|menu|toko|store|jual|jualan|tersedia|stok|stock|ready|harga|harganya|murah|mahal|termurah|termahal|diskon|promo|biaya|price|brand|kategori|pupuk|media tanam|hidroponik|nutrisi|pestisida|hama|sprayer|alat|benih|tanaman|netafarm)\b/;
const SHOPPING_ACTION_RE = /\b(cari|lihat|cek|mau|butuh|rekomendasi|rekomendasikan|ada|jual|beli|pesan|tampilkan|daftar|list|katalog|menu|apa aja|apa saja)\b/;
const PRICE_KEYWORD_RE = /\b(harga|harganya|murah|termurah|mahal|termahal|diskon|promo|biaya|price|premium|tertinggi|terendah)\b/;
const EXPENSIVE_QUERY_RE = /\b(produk|barang|item|harga)\b.*\b(termahal|paling mahal|mahal|tertinggi|premium)\b|\b(termahal|paling mahal|harga tertinggi|produk premium|barang termahal)\b/;
const CHEAP_QUERY_RE = /\b(produk|barang|item|harga)\b.*\b(termurah|paling murah|murah|terendah)\b|\b(termurah|paling murah|harga terendah|barang murah|produk murah)\b/;

function classifySafetyIntent(message) {
  const normalizedMessage = normalizeForMatch(message);
  const rawMessage = message ? message.toString().toLowerCase() : '';

  if (!normalizedMessage) {
    return { intent: 'unrelated_query', reason: 'empty_query' };
  }

  if (ADMIN_COMMAND_START_RE.test(normalizedMessage)) {
    return {
      intent: 'unsupported_admin_command',
      reason: 'admin_command_prefix'
    };
  }

  if (
    ADMIN_MANAGEMENT_RE.test(normalizedMessage) &&
    /\b(produk|barang|item|kategori|brand|stok|harga)\b/.test(normalizedMessage)
  ) {
    return {
      intent: 'unsupported_admin_command',
      reason: 'admin_management_terms'
    };
  }

  if (
    MATH_QUERY_RE.test(normalizedMessage) ||
    /\d+\s*(?:x|\*|\/|\+|-)\s*\d+/.test(rawMessage)
  ) {
    return { intent: 'math_or_calculation', reason: 'math_pattern' };
  }

  if (UNSUPPORTED_TECH_RE.test(normalizedMessage)) {
    return { intent: 'unrelated_query', reason: 'unsupported_tech_topic' };
  }

  if (
    GENERAL_TOPIC_RE.test(normalizedMessage) &&
    !PRODUCT_CONTEXT_RE.test(normalizedMessage)
  ) {
    return { intent: 'unrelated_query', reason: 'general_topic' };
  }

  return null;
}

function getPriceIntentConfidence(message) {
  const normalizedMessage = normalizeForMatch(message);
  const hasPriceKeyword = PRICE_KEYWORD_RE.test(normalizedMessage);
  const hasProductContext = PRODUCT_CONTEXT_RE.test(normalizedMessage);
  const hasShoppingAction = SHOPPING_ACTION_RE.test(normalizedMessage);
  const brandMatch = KNOWN_BRANDS.some((brand) =>
    normalizedMessage.includes(normalizeForMatch(brand))
  );
  const categoryTarget = Boolean(getCategoryTarget(message));
  const productTerms = tokenizeCustomerQuery(message);
  let confidence = 0;

  if (hasPriceKeyword) confidence += 0.45;
  if (hasProductContext) confidence += 0.25;
  if (hasShoppingAction) confidence += 0.15;
  if (brandMatch || categoryTarget) confidence += 0.2;
  if (productTerms.length > 0) confidence += 0.1;

  return {
    confidence: Number(Math.min(confidence, 1).toFixed(2)),
    hasPriceKeyword,
    hasProductContext,
    hasShoppingAction,
    brandMatch,
    categoryTarget,
    productTerms
  };
}

function hasShoppingContext(message) {
  const normalizedMessage = normalizeForMatch(message);
  if (!normalizedMessage) return false;

  return PRODUCT_CONTEXT_RE.test(normalizedMessage) ||
    SHOPPING_ACTION_RE.test(normalizedMessage) ||
    Boolean(getCategoryTarget(message)) ||
    KNOWN_BRANDS.some((brand) => normalizedMessage.includes(normalizeForMatch(brand)));
}

function tokenizeCustomerQuery(message) {
  const normalized = normalizeForMatch(message);
  if (!normalized) return [];

  return normalized
    .split(/\s+/)
    .flatMap((token) => {
      const variants = [token];
      for (const suffix of ['nya', 'lah', 'kah']) {
        if (token.endsWith(suffix) && token.length > suffix.length + 2) {
          variants.push(token.slice(0, -suffix.length));
        }
      }
      return variants;
    })
    .filter((token) => token.length > 1 && !CHAT_STOPWORDS.has(token));
}

function getNeedTerms(normalizedMessage) {
  const terms = [];

  if (/\b(membasmi|basmi|tikus|curut|hama|anti hama|pestisida)\b/.test(normalizedMessage)) {
    terms.push('racun', 'tikus', 'hama', 'rodentisida', 'anti hama');
  }

  if (/\b(jamur|fungisida|anti jamur)\b/.test(normalizedMessage)) {
    terms.push('fungisida', 'jamur', 'antracol');
  }

  if (/\b(hidroponik|ab mix|nutrisi)\b/.test(normalizedMessage)) {
    terms.push('hidroponik', 'ab mix', 'nutrisi', 'sayuran');
  }

  if (/\bperlite\b/.test(normalizedMessage)) {
    terms.push('perlite');
  } else if (/\bsekam\b/.test(normalizedMessage)) {
    terms.push('sekam');
  } else if (/\bpasir\b/.test(normalizedMessage)) {
    terms.push('pasir');
  } else if (/\b(cocopeat|tanah)\b/.test(normalizedMessage)) {
    terms.push('cocopeat', 'tanah');
  } else if (/\b(media tanam|tanam)\b/.test(normalizedMessage)) {
    terms.push('media tanam', 'perlite', 'sekam', 'pasir', 'tanah');
  }

  if (/\b(tanaman sayur|sayur)\b/.test(normalizedMessage)) {
    terms.push('pupuk', 'vegetatif', 'booster', 'ab mix', 'sayuran');
  } else if (/\b(pertumbuhan|tumbuh|pupuk|vegetatif|booster|pemula|nutrisi tanaman)\b/.test(normalizedMessage)) {
    terms.push('pupuk', 'nutrisi', 'vegetatif', 'booster', 'ab mix', 'em4', 'media tanam');
  }

  if (/\b(semprot|sprayer|alat semprot)\b/.test(normalizedMessage)) {
    terms.push('sprayer', 'semprot');
  }

  return terms;
}

function getSearchTerms(message) {
  const normalizedMessage = normalizeForMatch(message);
  const terms = new Set([
    ...tokenizeCustomerQuery(message),
    ...getNeedTerms(normalizedMessage)
  ]);

  KNOWN_BRANDS.forEach((brand) => {
    if (normalizedMessage.includes(brand)) {
      terms.add(brand);
    }
  });

  return Array.from(terms).filter(Boolean);
}

function productSearchText(product) {
  return normalizeForMatch(
    [
      product.name,
      product.price,
      product.discount,
      product.brand,
      product.category,
      product.source
    ].filter(Boolean).join(' ')
  );
}

function scoreProduct(product, terms) {
  if (!terms || terms.length === 0) return 0;

  const productText = productSearchText(product);
  let score = 0;

  terms.forEach((term) => {
    const normalizedTerm = normalizeForMatch(term);
    if (!normalizedTerm) return;

    const exactWord = new RegExp(`\\b${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (exactWord.test(productText)) {
      score += normalizedTerm.includes(' ') ? 5 : 3;
      return;
    }

    if (productText.includes(normalizedTerm)) {
      score += 1;
    }
  });

  return score;
}

function getProductPenalty(product, normalizedMessage = '') {
  const text = productSearchText(product);
  let penalty = 0;

  if (/\b(pertumbuhan|tumbuh|nutrisi|pupuk|tanaman)\b/.test(normalizedMessage)) {
    if (/\b(keranjang|pot pupuk|tempat pupuk|sprayer|semprot|jaring|paranet|net)\b/.test(text)) {
      penalty += 6;
    }

    if (/\b(pupuk|nutrisi|ab mix|hidroponik|media tanam|vegetatif|booster|em4)\b/.test(text)) {
      penalty -= 3;
    }
  }

  if (/\b(hama|tikus|jamur|pestisida|pembasmi|anti)\b/.test(normalizedMessage)) {
    if (/\b(racun|tikus|hama|fungisida|insektisida|rodentisida|antracol|akodan)\b/.test(text)) {
      penalty -= 4;
    }

    if (/\b(keranjang|pot|sprayer|paranet|media tanam)\b/.test(text)) {
      penalty += 4;
    }

    if (/\b(jamur|anti jamur|fungisida)\b/.test(normalizedMessage) && !/\b(fungisida|antracol)\b/.test(text)) {
      penalty += 8;
    }
  }

  return penalty;
}

function searchProducts(products, message, limit = 5) {
  const terms = getSearchTerms(message);
  const normalizedMessage = normalizeForMatch(message);
  const scored = products
    .map((product) => ({
      product,
      score: scoreProduct(product, terms) - getProductPenalty(product, normalizedMessage)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || parsePrice(a.product.price) - parsePrice(b.product.price));

  return {
    terms,
    products: scored.slice(0, limit).map((item) => item.product),
    scored: scored.slice(0, limit).map((item) => ({
      name: item.product.name,
      score: item.score
    })),
    excluded: products
      .map((product) => ({
        name: product.name,
        score: scoreProduct(product, terms) - getProductPenalty(product, normalizedMessage)
      }))
      .filter((item) => item.score <= 0)
      .slice(0, 8)
  };
}

function parsePrice(price) {
  const numeric = (price || '').replace(/[^\d]/g, '');
  return numeric ? Number(numeric) : Number.MAX_SAFE_INTEGER;
}

function hasNumericPrice(price) {
  return /\d/.test(price || '');
}

function parseDiscount(discount) {
  const match = (discount || '').match(/-?\d+/);
  return match ? Math.abs(Number(match[0])) : 0;
}

function formatProductLine(product, index, includeDiscount = false) {
  const price = product.price ? ` - ${product.price}` : '';
  const discount = includeDiscount && product.discount ? ` (${product.discount})` : '';

  return `${index + 1}. ${truncateProductName(product.name)}${price}${discount}`;
}

function formatProductMatches(title, products, options = {}) {
  if (!products || products.length === 0) return null;

  const limit = options.limit || 4;
  const includeDiscount = options.includeDiscount === true;
  const lines = [`${title}:`];

  products.slice(0, limit).forEach((product, index) => {
    lines.push(formatProductLine(product, index, includeDiscount));
  });

  if (products.length > limit) {
    lines.push('');
    lines.push(`Menampilkan 1-${limit} dari ${products.length} produk.`);
  }

  return lines.join('\n');
}

function formatPriceResponse(products) {
  if (!products || products.length === 0) return null;

  if (products.length === 1) {
    const product = products[0];
    const lines = [`Harga ${product.name}: ${product.price || 'belum tersedia di katalog'}.`];
    return lines.join('\n');
  }

  return formatProductMatches('Berikut pilihan harga yang tersedia', products, {
    limit: 5,
    includeDiscount: false
  });
}

function sortProductsByPrice(products, direction = 'asc') {
  const factor = direction === 'desc' ? -1 : 1;

  return [...products]
    .filter((product) => hasNumericPrice(product.price))
    .sort((a, b) => {
      const priceDiff = parsePrice(a.price) - parsePrice(b.price);
      if (priceDiff !== 0) return priceDiff * factor;
      return normalizeForMatch(a.name).localeCompare(normalizeForMatch(b.name));
    });
}

function getDiscountedProducts(products, message) {
  const normalizedMessage = normalizeForMatch(message);
  const discountAscending = /\b(terkecil|paling kecil|kecil)\b/.test(normalizedMessage);

  return products
    .filter((product) => parseDiscount(product.discount) > 0)
    .sort((a, b) => {
      if (discountAscending) {
        return parseDiscount(a.discount) - parseDiscount(b.discount) ||
          parsePrice(a.price) - parsePrice(b.price);
      }

      return parseDiscount(b.discount) - parseDiscount(a.discount) ||
        parsePrice(a.price) - parsePrice(b.price);
    });
}

function formatGreetingResponse(storeName) {
  return `Halo, selamat datang di ${storeName || 'CV Netafarm'}. Saya bisa bantu cek daftar produk, harga, diskon, kategori, atau rekomendasi produk dari katalog kami.`;
}

function formatStoreInfoResponse(storeName, products) {
  const categories = summarizeProductCategories(products);
  const categoryText = categories.length
    ? categories.map((item) => item.replace(/\s\(\d+\)$/, '')).join(', ')
    : 'produk pertanian';

  return `${storeName || 'CV Netafarm'} menyediakan ${categoryText}. Saat ini ada ${products.length} produk di katalog kami.`;
}

function getAvailableBrands(products) {
  return Array.from(new Set(products.map((product) => product.brand).filter(Boolean))).sort();
}

function getSelectedBrand(products, message) {
  const normalizedMessage = normalizeForMatch(message);
  return getAvailableBrands(products).find((brand) =>
    normalizedMessage.includes(normalizeForMatch(brand))
  );
}

function formatBrandResponse(products, message) {
  const brands = getAvailableBrands(products);
  const selectedBrand = getSelectedBrand(products, message);

  if (!selectedBrand) {
    return brands.length
      ? [
          'Kami menyediakan beberapa brand seperti:',
          ...brands.map((brand) => `- ${brand}`),
          '',
          'Silakan ketik nama brand untuk melihat produknya.'
        ].join('\n')
      : null;
  }

  const matches = products.filter(
    (product) => normalizeForMatch(product.brand) === normalizeForMatch(selectedBrand)
  );

  return formatProductMatches(`Berikut produk dari brand ${selectedBrand}`, matches, {
    limit: 5,
    includeDiscount: false
  });
}

function formatDiscountResponse(products, message) {
  const normalizedMessage = normalizeForMatch(message);
  const discountAscending = /\b(terkecil|paling kecil|kecil)\b/.test(normalizedMessage);
  const discounted = products
    .filter((product) => parseDiscount(product.discount) > 0)
    .sort((a, b) => {
      if (/\b(murah|termurah)\b/.test(normalizedMessage)) {
        return parsePrice(a.price) - parsePrice(b.price);
      }

      if (discountAscending) {
        return parseDiscount(a.discount) - parseDiscount(b.discount);
      }

      return parseDiscount(b.discount) - parseDiscount(a.discount);
    });

  return formatProductMatches(
    /\b(murah|termurah)\b/.test(normalizedMessage)
      ? 'Produk murah yang tersedia'
      : discountAscending
        ? 'Produk dengan diskon paling kecil'
        : 'Produk dengan diskon',
    discounted,
    {
      limit: 6,
      includeDiscount: true
    }
  );
}

function getCategoryTarget(message) {
  const normalizedMessage = normalizeForMatch(message);

  if (/\b(produk pertanian lain|pertanian lain)\b/.test(normalizedMessage)) {
    return 'Produk pertanian lain';
  }

  if (/\b(hidroponik|nutrisi tanaman|nutrisi)\b/.test(normalizedMessage)) {
    return 'Nutrisi hidroponik';
  }

  if (/\b(media tanam|sekam|perlite|cocopeat|tanah|pasir)\b/.test(normalizedMessage)) {
    return 'Media tanam';
  }

  if (/\b(pupuk tanaman|pupuk|pertumbuhan tanaman)\b/.test(normalizedMessage)) {
    return 'Pupuk tanaman';
  }

  if (/\b(pestisida|hama|tikus|pembasmi|anti hama)\b/.test(normalizedMessage)) {
    return 'Pestisida dan pengendalian hama';
  }

  if (/\b(alat pertanian|semprot|sprayer|alat)\b/.test(normalizedMessage)) {
    return 'Alat pertanian';
  }

  return '';
}

function getCategoryLabel(category) {
  if (category === 'Produk pertanian lain') return 'produk lainnya';
  return category;
}

function getProductsByCategory(products, message, limit = 6) {
  const normalizedMessage = normalizeForMatch(message);
  const targetCategory = getCategoryTarget(message);

  if (targetCategory) {
    return products
      .filter((product) => (product.category || classifyProductCategory(product.name)) === targetCategory)
      .sort((a, b) => parsePrice(a.price) - parsePrice(b.price))
      .slice(0, limit);
  }

  const categoryTerms = getNeedTerms(normalizedMessage);

  if (/\b(hidroponik|nutrisi tanaman|nutrisi)\b/.test(normalizedMessage)) {
    categoryTerms.push('Nutrisi hidroponik');
  }

  if (/\b(media tanam)\b/.test(normalizedMessage)) {
    categoryTerms.push('Media tanam');
  }

  if (/\b(pupuk|tanaman)\b/.test(normalizedMessage)) {
    categoryTerms.push('Pupuk tanaman');
  }

  if (/\b(pestisida|hama|tikus)\b/.test(normalizedMessage)) {
    categoryTerms.push('Pestisida dan pengendalian hama');
  }

  if (/\b(alat pertanian|semprot|sprayer)\b/.test(normalizedMessage)) {
    categoryTerms.push('Alat pertanian');
  }

  const scored = products
    .map((product) => ({
      product,
      score: scoreProduct(product, categoryTerms)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || parsePrice(a.product.price) - parsePrice(b.product.price));

  return scored.slice(0, limit).map((item) => item.product);
}

function isGenericCategoryQuery(message) {
  const normalizedMessage = normalizeForMatch(message);

  return /\b(kategori produk|kategori tersedia|kategori barang|jenis produk|produk berdasarkan kategori|ada kategori apa)\b/.test(normalizedMessage) ||
    /^kategori$/.test(normalizedMessage) ||
    /^jenis barang$/.test(normalizedMessage);
}

function formatCategorySummaryResponse(products) {
  const categories = getCategorySummary(products);
  if (categories.length === 0) return null;

  return [
    'Kami memiliki beberapa kategori produk:',
    ...categories.map(({ category }) => `- ${category}`),
    '',
    'Silakan pilih kategori yang ingin dilihat.'
  ].join('\n');
}

function formatCategoryProductsResponse(products, message) {
  if (isGenericCategoryQuery(message)) {
    return formatCategorySummaryResponse(products);
  }

  const categoryProducts = getProductsByCategory(products, message, 5);
  return formatProductMatches('Berikut produk pada kategori tersebut', categoryProducts, {
    limit: 5,
    includeDiscount: false
  });
}

function detectChatIntent(message, products) {
  const normalizedMessage = normalizeForMatch(message);
  const safetyIntent = classifySafetyIntent(message);

  if (safetyIntent) {
    console.log(
      `[DEBUG:SAFETY] detected=${safetyIntent.intent} reason=${safetyIntent.reason} query=${JSON.stringify(normalizedMessage)}`
    );
    return safetyIntent.intent;
  }

  if (
    !hasShoppingContext(message) &&
    !/^(halo|hai|hi|hello|permisi|selamat\s+(pagi|siang|sore|malam)|assalamualaikum)\b/.test(normalizedMessage)
  ) {
    console.log(
      `[DEBUG:INTENT] rejectedLowConfidence reason=no_shopping_context query=${JSON.stringify(normalizedMessage)}`
    );
    return 'unrelated_query';
  }

  if (/^(halo|hai|hi|hello|permisi|selamat\s+(pagi|siang|sore|malam)|assalamualaikum)\b/.test(normalizedMessage) || /\bada admin\b/.test(normalizedMessage)) {
    return 'greeting';
  }

  if (/\b(nama toko|toko ini|cv netafarm|fokus toko|toko apa)\b/.test(normalizedMessage)) {
    return 'store_info';
  }

  if (isGenericCategoryQuery(message)) {
    return 'category';
  }

  if (getCategoryTarget(message)) {
    return 'category';
  }

  if (EXPENSIVE_QUERY_RE.test(normalizedMessage)) {
    return 'expensive_products';
  }

  if (CHEAP_QUERY_RE.test(normalizedMessage)) {
    return 'cheap_products';
  }

  if (/\b(diskon|promo)\b/.test(normalizedMessage)) {
    return 'discount';
  }

  if (/\b(harga|harganya|berapa)\b/.test(normalizedMessage)) {
    const priceIntent = getPriceIntentConfidence(message);
    console.log(
      `[DEBUG:INTENT] priceConfidence=${priceIntent.confidence} details=${JSON.stringify(priceIntent)}`
    );

    if (priceIntent.confidence >= 0.55) {
      return 'price';
    }

    console.log(
      `[DEBUG:INTENT] rejectedLowConfidence reason=price_intent_below_threshold query=${JSON.stringify(normalizedMessage)}`
    );
    return 'unrelated_query';
  }

  if (/\b(rekomendasi|rekomendasikan|terbaik|pemula|paling laris)\b/.test(normalizedMessage)) {
    return 'recommendation';
  }

  if (/\b(untuk|membasmi|basmi|anti hama|anti jamur|anti tikus|hidroponik|media tanam|alat semprot|pestisida|nutrisi tanaman|pupuk tanaman|pembasmi hama|pertumbuhan tanaman)\b/.test(normalizedMessage)) {
    return /\b(hidroponik|media tanam|pupuk tanaman|alat pertanian|pestisida|nutrisi tanaman)\b/.test(normalizedMessage)
      ? 'category'
      : 'function_based_search';
  }

  if (/\bbrand\b/.test(normalizedMessage) || getAvailableBrands(products).some((brand) => normalizedMessage.includes(normalizeForMatch(brand)))) {
    return 'brand';
  }

  if (/\b(daftar|list|katalog|menu|produk tersedia|ada barang|jual apa aja|produk apa aja|apa aja produknya)\b/.test(normalizedMessage)) {
    return 'product_list';
  }

  const searchResult = searchProducts(products, message, 1);
  if (searchResult.products.length > 0) {
    if (!hasShoppingContext(message)) {
      console.log(
        `[DEBUG:INTENT] rejectedLowConfidence reason=search_without_shopping_context terms=${JSON.stringify(searchResult.terms)}`
      );
      return 'unrelated_query';
    }

    return 'product_search';
  }

  return 'unrelated_query';
}

function buildIntentResponse(message, products, behavior) {
  const storeName = extractStoreNameFromBehavior(behavior) || 'CV Netafarm';
  const fallbackResponse =
    behavior.fallback_response || 'Mohon maaf, untuk item itu belum ada di toko kami.';
  const intent = detectChatIntent(message, products);
  let response = null;
  let fallbackReason = null;
  let matches = [];
  let paginationState = null;

  if (intent === 'greeting') {
    response = formatGreetingResponse(storeName);
  } else if (intent === 'unsupported_admin_command') {
    response = MANAGEMENT_UNSUPPORTED_RESPONSE;
    fallbackReason = 'unsupported_admin_command';
    console.log(
      `[DEBUG:SAFETY] blockedAdminCommand query=${JSON.stringify(normalizeForMatch(message))}`
    );
  } else if (intent === 'unrelated_query' || intent === 'math_or_calculation') {
    response = STORE_SCOPE_FALLBACK_RESPONSE;
    fallbackReason = intent === 'math_or_calculation'
      ? 'math_or_calculation'
      : 'unrelated_question';
    console.log(
      `[DEBUG:SAFETY] blockedUnrelated intent=${intent} query=${JSON.stringify(normalizeForMatch(message))}`
    );
  } else if (intent === 'product_list') {
    const pagination = buildPaginationResult({
      mode: 'product_list',
      products,
      label: 'Berikut produk yang tersedia:'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = products.slice(0, DEFAULT_PAGE_SIZE);
  } else if (intent === 'product_search') {
    const result = searchProducts(products, message, 50);
    const pagination = buildPaginationResult({
      mode: 'search',
      products: result.products,
      label: 'Berikut produk yang tersedia:'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = result.scored;
  } else if (intent === 'price') {
    const result = searchProducts(products, message, 5);
    response = formatPriceResponse(result.products);
    matches = result.scored;
  } else if (intent === 'expensive_products') {
    const sorted = sortProductsByPrice(products, 'desc');
    const pagination = buildPaginationResult({
      mode: 'expensive_products',
      products: sorted,
      label: 'Berikut produk dengan harga tertinggi:',
      sortingMode: 'price_desc'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = sorted.slice(0, DEFAULT_PAGE_SIZE).map((product) => product.name);
    console.log(
      `[DEBUG:INTENT] expensiveProductQuery total=${sorted.length} query=${JSON.stringify(normalizeForMatch(message))}`
    );
  } else if (intent === 'cheap_products') {
    const sorted = sortProductsByPrice(products, 'asc');
    const pagination = buildPaginationResult({
      mode: 'cheap_products',
      products: sorted,
      label: 'Berikut produk dengan harga terendah:',
      sortingMode: 'price_asc'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = sorted.slice(0, DEFAULT_PAGE_SIZE).map((product) => product.name);
    console.log(
      `[DEBUG:INTENT] cheapProductQuery total=${sorted.length} query=${JSON.stringify(normalizeForMatch(message))}`
    );
  } else if (intent === 'function_based_search') {
    const result = searchProducts(products, message, 12);
    const pagination = buildPaginationResult({
      mode: 'search',
      products: result.products,
      label: 'Berikut beberapa produk yang cocok untuk kebutuhan tersebut:'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = { selected: result.scored, excludedLowRelevance: result.excluded };
  } else if (intent === 'category') {
    const categoryProducts = getProductsByCategory(products, message, 50);
    const categoryTarget = getCategoryTarget(message);
    if (isGenericCategoryQuery(message)) {
      response = formatCategorySummaryResponse(products);
    } else {
      const pagination = buildPaginationResult({
        mode: 'category',
        products: categoryProducts,
        label: categoryTarget
          ? `Berikut produk kategori ${getCategoryLabel(categoryTarget)}:`
          : 'Berikut produk pada kategori tersebut:'
      });
      paginationState = pagination.state;
      response = pagination.response;
    }
    matches = isGenericCategoryQuery(message)
      ? getCategorySummary(products)
      : categoryProducts.map((product) => product.name);
  } else if (intent === 'discount') {
    const normalizedMessage = normalizeForMatch(message);
    const discounted = getDiscountedProducts(products, message);
    const discountAscending = /\b(terkecil|paling kecil|kecil)\b/.test(normalizedMessage);
    const pagination = buildPaginationResult({
      mode: discountAscending ? 'smallest_discount' : 'largest_discount',
      products: discounted,
      label: discountAscending
        ? 'Berikut produk dengan diskon paling kecil:'
        : 'Berikut produk promo dengan diskon terbesar:',
      includeDiscount: true,
      sortingMode: discountAscending ? 'discount_asc' : 'discount_desc'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = discounted.slice(0, DEFAULT_PAGE_SIZE).map((product) => ({
      name: product.name,
      discount: product.discount
    }));
  } else if (intent === 'brand') {
    const selectedBrand = getSelectedBrand(products, message);
    if (selectedBrand) {
      const brandProducts = products.filter(
        (product) => normalizeForMatch(product.brand) === normalizeForMatch(selectedBrand)
      );
      const pagination = buildPaginationResult({
        mode: 'brand',
        products: brandProducts,
        label: `Berikut produk dari brand ${selectedBrand}:`
      });
      paginationState = pagination.state;
      response = pagination.response;
      matches = brandProducts.map((product) => product.name);
    } else {
      response = formatBrandResponse(products, message);
    }
  } else if (intent === 'store_info') {
    response = formatStoreInfoResponse(storeName, products);
  } else if (intent === 'recommendation') {
    const result = searchProducts(products, message, 12);
    const recommended = result.products.length
      ? result.products
      : products
          .filter((product) => /pupuk|nutrisi|ab mix|hidroponik/i.test(productSearchText(product)))
          .slice(0, 12);
    const pagination = buildPaginationResult({
      mode: 'recommendation',
      products: recommended,
      label: 'Berikut beberapa produk yang bisa kami rekomendasikan:'
    });
    paginationState = pagination.state;
    response = pagination.response;
    matches = { selected: result.scored, excludedLowRelevance: result.excluded };
  }

  if (paginationState && paginationState.products.length === 0) {
    paginationState = null;
    response = null;
  }

  if (!response && intent === 'recommendation') {
    const fallbackRecommendations = products
      .filter((product) => /pupuk|nutrisi|ab mix|hidroponik/i.test(productSearchText(product)))
      .slice(0, 12);
    const pagination = buildPaginationResult({
      mode: 'recommendation',
      products: fallbackRecommendations,
      label: 'Berikut beberapa produk yang bisa kami rekomendasikan:'
    });
    paginationState = pagination.state;
    response = pagination.response;
  }

  if (!response) {
    response = fallbackResponse;
    fallbackReason = intent === 'unrelated_query' ? 'unrelated_question' : 'no_matching_csv_product';
  }

  return {
    intent,
    response,
    fallbackReason,
    matches,
    paginationState
  };
}

async function getAIResponse(
  message,
  contextItems = [],
  behavior = null,
  retrievalDebug = null
) {
  try {
    const activeBehavior = behavior || loadBehavior() || getDefaultBehavior();
    const contextBlock = ragEngine.buildContextBlock(contextItems);
    const intent = retrievalDebug && retrievalDebug.intent ? retrievalDebug.intent : {};

    if (!contextBlock || contextItems.length === 0) {
      console.log(
        `[DEBUG:AI] fallbackTrigger=no_context message=${JSON.stringify(message)} contextItems=${contextItems.length}`
      );
      return (
        activeBehavior.fallback_response ||
        'Mohon maaf, untuk item itu belum ada di toko kami.'
      );
    }

    if (!groq) {
      console.error('GROQ_API_KEY belum diatur.');
      return null;
    }

    const systemParts = [];
    if (activeBehavior.system_instructions) {
      systemParts.push(activeBehavior.system_instructions);
    }

    systemParts.push(
      `Jawab hanya menggunakan konteks berikut. Jika konteks benar-benar kosong atau tidak relevan, jawab persis: ${activeBehavior.fallback_response}`
    );

    if (intent.productList || contextHasProductSummary(contextItems)) {
      systemParts.push(
        'Jika konteks berisi ringkasan produk atau daftar produk, langsung jawab dengan daftar produk yang rapi. Jangan menulis bahwa informasi tidak ditemukan.'
      );
    }

    systemParts.push(
      `Jawab maksimal ${activeBehavior.max_sentences || 2} kalimat. Bahasa: ${activeBehavior.language || 'id'}.`
    );

    const systemMessage = systemParts.join(' ');
    const userMessage = `Konteks:\n${contextBlock}\n\nPertanyaan: ${message}`;

    console.log(
      `[DEBUG:AI] sendingToGroq contextItems=${contextItems.length} contextChars=${contextBlock.length} model=${process.env.GROQ_MODEL || 'llama-3.1-8b-instant'}`
    );
    console.log(
      `[DEBUG:AI] promptPreview=${JSON.stringify(`${systemMessage}\n${userMessage}`.slice(0, 1200))}`
    );

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: Number(process.env.GROQ_MAX_TOKENS || 200),
      temperature: 0.1
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error getting AI response:', error.message);
    return null;
  }
}

async function startBot() {
  if (isReady || isInitializing) {
    return { success: false, message: 'Bot sudah berjalan atau sedang dimulai' };
  }

  if (isCleaning) {
    return { success: false, message: 'Bot sedang dihentikan, harap tunggu' };
  }

  isInitializing = true;

  try {
    const clientInstance = initializeClient();

    clientInstance.initialize().catch((error) => {
      isInitializing = false;
      isReady = false;
      client = null;
      qrCodeData = null;
      isCleaning = false;
      console.error('Error initializing bot:', error.message);
    });

    return { success: true, message: 'Bot dimulai, silakan scan QR code' };
  } catch (error) {
    isInitializing = false;
    client = null;
    qrCodeData = null;
    isCleaning = false;
    throw error;
  }
}

function initializeClient() {
  if (client) return client;

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-resources',
        '--disable-sync',
        '--disable-translate',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages'
      ],
      timeout: 120000
    }
  });

  client.on('qr', (qr) => {
    console.log('QR Code Generated');
    console.log('\nScan QR Code di bawah untuk connect bot:\n');
    qrCodeData = qr;
    isInitializing = false;
    qrcode.generate(qr, { small: true });
    console.log('\n');
  });

  client.on('ready', () => {
    console.log('Bot is ready!');
    isReady = true;
    isCleaning = false;
    isInitializing = false;
    qrCodeData = null;
  });

  client.on('authenticated', () => {
    console.log('Client authenticated');
  });

  client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    isReady = false;
    isInitializing = false;
    client = null;
    qrCodeData = null;
  });

  const handleIncomingMessage = async (msg, eventName) => {
    try {
      console.log(
        `${eventName} event: from=${msg.from}, fromMe=${msg.fromMe}, body=${JSON.stringify(msg.body)}`
      );

      const messageId =
        msg && msg.id && msg.id._serialized ? msg.id._serialized : null;

      if (messageId) {
        if (handledMessageIds.has(messageId)) {
          console.log('Ignoring duplicate event for same message');
          return;
        }

        handledMessageIds.add(messageId);
        setTimeout(() => handledMessageIds.delete(messageId), 5 * 60 * 1000);
      }

      if (msg.fromMe) {
        console.log('Ignoring self-sent message to avoid reply loop');
        return;
      }

      const isPersonalChat =
        msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
      const isNotStatus = !msg.from.endsWith('@status');

      if (!isPersonalChat || !isNotStatus) {
        console.log(`Ignoring non-personal or status message: from=${msg.from}`);
        return;
      }

      console.log(`Personal Message from ${msg.from}: ${msg.body}`);
      console.log(
        `[DEBUG:WA] incomingMessage from=${msg.from} normalized=${JSON.stringify(
          normalizeForMatch(msg.body)
        )} raw=${JSON.stringify(msg.body)}`
      );

      try {
        await msg.getChat().then((chat) => chat.sendStateTyping());
      } catch (error) {
        console.log('Note: Cannot show typing indicator');
      }

      const chatId = msg.from;

      if (isContinuationCommand(msg.body)) {
        const continuation = renderNextPaginationPage(chatId);
        await msg.reply(continuation.response);
        console.log(
          `[DEBUG:PAGINATION] continuationCommand chatId=${chatId} handled=${continuation.handled}`
        );
        return;
      }

      const knowledge = loadKnowledge();
      const faqMatch = findKnowledgeResponse(msg.body, knowledge);

      if (faqMatch) {
        clearPaginationState(msg.from, 'faq_match');
        await msg.reply(faqMatch.response);
        console.log(
          `[DEBUG:FAQ] matched type=${faqMatch.matchType} keyword=${JSON.stringify(faqMatch.keyword)}`
        );
        return;
      }

      console.log(
        `[DEBUG:FAQ] no_match responses=${Object.keys(knowledge.responses || {}).length} keywordGroups=${Object.keys(knowledge.keywords || {}).length}`
      );

      const behavior = loadBehavior() || getDefaultBehavior();
      const datasetDocuments = datasetManager.getAllDocuments();
      const behaviorDocuments = buildBehaviorContextDocuments(behavior);
      const allDocuments = [...behaviorDocuments, ...datasetDocuments];
      const products = datasetManager.getProductCatalog();
      const intentResult = buildIntentResponse(msg.body, products, behavior);

      console.log(
        `[DEBUG:DATASET] datasets=${JSON.stringify(datasetManager.listDatasets())} datasetDocuments=${datasetDocuments.length} behaviorDocuments=${behaviorDocuments.length} totalDocuments=${allDocuments.length}`
      );
      console.log(
        `[DEBUG:INTENT] normalizedQuery=${JSON.stringify(normalizeForMatch(msg.body))} detectedIntent=${intentResult.intent} productCount=${products.length} matches=${JSON.stringify(intentResult.matches).slice(0, 1000)} fallbackReason=${intentResult.fallbackReason || 'none'}`
      );
      if (intentResult.intent === 'category') {
        console.log(
          `[DEBUG:CATEGORY] generic=${isGenericCategoryQuery(msg.body)} target=${getCategoryTarget(msg.body) || 'summary'}`
        );
      }
      if (
        intentResult.matches &&
        typeof intentResult.matches === 'object' &&
        intentResult.matches.excludedLowRelevance
      ) {
        console.log(
          `[DEBUG:RANKING] excludedLowRelevance=${JSON.stringify(intentResult.matches.excludedLowRelevance).slice(0, 1000)}`
        );
      }

      const contextItems = ragEngine.retrieveContext(
        msg.body,
        allDocuments,
        Number(process.env.RAG_TOP_K || 3)
      );
      const retrievalDebug = ragEngine.getLastDebug();
      logRetrievalDebug(retrievalDebug, contextItems);

      console.log(`RAG Retrieved ${contextItems.length} relevant context(s)`);

      if (intentResult.response) {
        if (intentResult.paginationState) {
          setPaginationState(chatId, intentResult.paginationState);
        } else {
          clearPaginationState(chatId, `new_intent_${intentResult.intent}`);
        }
        await msg.reply(intentResult.response);
        console.log(
          `[DEBUG:RESPONSE] type=deterministic intent=${intentResult.intent} formatterMode=${intentResult.intent} contexts=${contextItems.length} fallbackReason=${intentResult.fallbackReason || 'none'}`
        );
        return;
      }

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI response timeout')), 15000)
      );

      try {
        const aiResponse = await Promise.race([
          getAIResponse(msg.body, contextItems, behavior, retrievalDebug),
          timeoutPromise
        ]);

        if (aiResponse) {
          await msg.reply(aiResponse);
          console.log(
            `Replied with AI response (RAG contexts: ${contextItems.length})`
          );
        } else {
          await msg.reply('Maaf, saya tidak memahami pesan Anda. Silakan coba lagi.');
        }
      } catch (aiError) {
        console.error('AI Error:', aiError.message);
        await msg.reply(
          'Maaf, terjadi kesalahan dalam memproses pesan. Silakan coba lagi.'
        );
      }
    } catch (error) {
      console.error('Message handler error:', error.message);
    }
  };

  client.on('message', (msg) => handleIncomingMessage(msg, 'message'));
  client.on('message_create', (msg) =>
    handleIncomingMessage(msg, 'message_create')
  );

  return client;
}

app.get('/api/bot/status', (req, res) => {
  res.json({
    isReady,
    isCleaning,
    isInitializing,
    hasQRCode: qrCodeData ? true : false
  });
});

app.post('/api/bot/start', async (req, res) => {
  try {
    const result = await startBot();
    return res.json(result);
  } catch (error) {
    console.error('Error starting bot:', error.message);
    res.status(500).json({
      message: 'Error memulai bot. Pastikan koneksi internet stabil dan coba lagi.',
      success: false
    });
  }
});

app.post('/api/bot/stop', async (req, res) => {
  try {
    if (!client) {
      return res.json({ message: 'Bot tidak sedang berjalan', success: false });
    }

    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;

    const clientToDestroy = client;
    client = null;

    res.json({ message: 'Bot sudah dihentikan', success: true });

    setImmediate(async () => {
      try {
        await clientToDestroy.destroy();
      } catch (destroyError) {
        console.error('Error destroying client:', destroyError.message);
      } finally {
        isCleaning = false;
      }
    });
  } catch (error) {
    console.error('Error stopping bot:', error);
    isCleaning = false;
    res.status(500).json({
      message: 'Error menghentikan bot: ' + error.message,
      success: false
    });
  }
});

app.get('/api/bot/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else {
    res.json({ qr: null });
  }
});

app.get('/api/datasets', (req, res) => {
  res.json({
    datasets: datasetManager.listDatasets(),
    totalDocuments: datasetManager.getAllDocuments().length
  });
});

app.get('/api/datasets/:name', (req, res) => {
  const docs = datasetManager.getDatasetDocuments(req.params.name);
  if (docs.length === 0) {
    return res.status(404).json({ message: 'Dataset tidak ditemukan' });
  }
  res.json({ documents: docs });
});

app.post('/api/datasets', (req, res) => {
  try {
    const { name, data } = req.body;

    if (!name || !data) {
      return res.status(400).json({ message: 'name dan data harus diisi' });
    }

    const result = datasetManager.saveDataset(name, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message });
  }
});

app.get('/api/knowledge/keywords', (req, res) => {
  const knowledge = loadKnowledge();
  res.json(knowledge);
});

app.post('/api/knowledge/keyword', (req, res) => {
  try {
    const { keyword, response } = req.body;

    if (!keyword || !response) {
      return res.status(400).json({
        message: 'Keyword dan response harus diisi',
        success: false
      });
    }

    const knowledge = loadKnowledge();
    knowledge.responses[keyword.toLowerCase().trim()] = response;

    if (saveKnowledge(knowledge)) {
      res.json({ message: 'Keyword berhasil disimpan', success: true });
    } else {
      res.status(500).json({
        message: 'Error menyimpan keyword',
        success: false
      });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message, success: false });
  }
});

app.delete('/api/knowledge/keyword/:keyword', (req, res) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword).toLowerCase();
    const knowledge = loadKnowledge();

    if (knowledge.responses[keyword]) {
      delete knowledge.responses[keyword];

      if (saveKnowledge(knowledge)) {
        res.json({ message: 'Keyword berhasil dihapus', success: true });
      } else {
        res.status(500).json({
          message: 'Error menghapus keyword',
          success: false
        });
      }
    } else {
      res.status(404).json({
        message: 'Keyword tidak ditemukan',
        success: false
      });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message, success: false });
  }
});

app.get('/api/behavior', (req, res) => {
  try {
    const behavior = loadBehavior();
    if (!behavior) {
      return res.status(404).json({ message: 'Behavior config not found' });
    }
    res.json(behavior);
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message });
  }
});

app.post('/api/behavior', (req, res) => {
  try {
    const obj = req.body;
    if (!obj || typeof obj !== 'object') {
      return res.status(400).json({ message: 'Invalid behavior object' });
    }

    const saved = saveBehavior(obj);
    if (saved) {
      return res.json({ message: 'Behavior saved', success: true });
    }

    res.status(500).json({
      message: 'Error saving behavior',
      success: false
    });
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message });
  }
});

function startServer() {
  return app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    console.log(`Admin Dashboard: http://localhost:${PORT}`);
    console.log(`Datasets loaded: ${datasetManager.listDatasets().length}`);

    if (process.env.AUTO_START_BOT !== 'false') {
      setTimeout(() => {
        startBot().catch((error) => {
          console.error('Error auto-starting bot:', error.message);
        });
      }, 500);
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  buildIntentResponse,
  detectChatIntent,
  formatPaginatedProducts,
  formatProductListResponse,
  normalizeForMatch,
  renderNextPaginationPage,
  setPaginationState,
  startServer
};
