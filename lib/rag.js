const STOPWORDS_ID = new Set([
  'yang',
  'dan',
  'di',
  'ke',
  'dari',
  'untuk',
  'dengan',
  'atau',
  'pada',
  'adalah',
  'ini',
  'itu',
  'dalam',
  'juga',
  'karena',
  'agar',
  'sebagai',
  'saat',
  'oleh',
  'akan',
  'bisa',
  'dapat',
  'sudah',
  'belum',
  'kami',
  'kamu',
  'anda',
  'saya',
  'aku',
  'kita',
  'mereka',
  'ada',
  'tidak',
  'nggak',
  'gak',
  'ga',
  'random',
  'jika',
  'kalau'
]);

const TOKEN_ALIASES = {
  produk: ['barang', 'item', 'katalog', 'daftar', 'jualan'],
  barang: ['produk', 'item'],
  item: ['produk', 'barang'],
  katalog: ['produk', 'daftar', 'list', 'menu'],
  daftar: ['produk', 'barang', 'katalog', 'list', 'menu'],
  list: ['produk', 'barang', 'katalog', 'daftar', 'menu'],
  menu: ['produk', 'barang', 'katalog', 'daftar', 'list'],
  tersedia: ['stok', 'stock', 'ready', 'ada'],
  stok: ['tersedia', 'stock', 'ready'],
  stock: ['stok', 'tersedia', 'ready'],
  jual: ['produk', 'barang', 'tersedia'],
  toko: ['store', 'shop', 'olshop', 'nama'],
  store: ['toko', 'shop'],
  nama: ['toko', 'brand'],
  halo: ['sapaan', 'salam'],
  hai: ['sapaan', 'salam', 'halo'],
  hello: ['sapaan', 'salam', 'halo']
};

const UNSUPPORTED_ADMIN_RE = /^(tambah|hapus|edit|ubah|update|delete|remove|insert)\b|\b(tambah|hapus|edit|ubah|delete|remove|insert|update)\b.*\b(produk|barang|item|kategori|brand|stok|harga)\b/;
const UNRELATED_RE = /\b(buat|generate|coding|koding|kodingan|script|skrip|program|programming|pemrograman|website|aplikasi|app|cv|resume|html|css|javascript|python|java|php|sql|presiden|cuaca|bitcoin|crypto|kripto|game|sepak bola|politik|berita)\b/;
const MATH_RE = /\b(hitung|berapa hasil|jumlahkan|kurangi|kali|bagi|tambah)\b.*\d|\d+\s*(?:x|\*|\/|\+|-)\s*\d+|\b\d+\s+(?:kali|dibagi|ditambah|dikurangi)\s+\d+\b/;
const STORE_CONTEXT_RE = /\b(produk|produknya|barang|barangnya|item|katalog|daftar produk|list produk|menu produk|tersedia|stok|stock|ready|jual|jualan|toko|harga|diskon|promo|kategori|brand|pupuk|media tanam|hidroponik|nutrisi|pestisida|sprayer|netafarm)\b/;

class RAGEngine {
  constructor() {
    this.cache = {
      signature: '',
      index: null
    };
    this.lastDebug = null;
  }

  normalizeText(text) {
    if (!text) return '';

    return text
      .toString()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tokenize(text) {
    if (!text) return [];

    const baseTokens = this.normalizeText(text)
      .split(/\s+/)
      .flatMap((token) => this.expandIndonesianToken(token))
      .filter((token) => token.length > 1 && !STOPWORDS_ID.has(token));

    const expanded = [];
    const seen = new Set();

    for (const token of baseTokens) {
      const variants = [token, ...(TOKEN_ALIASES[token] || [])];

      for (const variant of variants) {
        if (!variant || seen.has(variant)) continue;
        seen.add(variant);
        expanded.push(variant);
      }
    }

    return expanded;
  }

  expandIndonesianToken(token) {
    if (!token) return [];

    const variants = [token];

    for (const suffix of ['nya', 'lah', 'kah', 'pun']) {
      if (token.endsWith(suffix) && token.length > suffix.length + 2) {
        variants.push(token.slice(0, -suffix.length));
      }
    }

    return variants;
  }

  splitIntoChunks(text, chunkSize = 700, overlap = 120) {
    if (!text) return [];

    const normalized = text.replace(/\r/g, '').trim();
    if (!normalized) return [];

    const chunks = [];
    let start = 0;

    while (start < normalized.length) {
      let end = Math.min(start + chunkSize, normalized.length);

      if (end < normalized.length) {
        const lastBreak = normalized.lastIndexOf('\n', end);
        if (lastBreak > start + 120) {
          end = lastBreak;
        }
      }

      const chunk = normalized.slice(start, end).trim();
      if (chunk.length > 40) {
        chunks.push(chunk);
      }

      if (end >= normalized.length) break;
      start = Math.max(end - overlap, start + 1);
    }

    return chunks;
  }

  buildTfMap(tokens) {
    const tf = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    return tf;
  }

  buildIndexSignature(documents) {
    return documents
      .map((doc) => `${doc.source || ''}:${(doc.text || '').length}`)
      .join('|');
  }

  buildRagIndex(documents) {
    if (!documents || documents.length === 0) {
      return { idf: new Map(), vectors: [] };
    }

    const tokenizedDocs = documents.map((doc) => this.tokenize(doc.text));
    const docFreq = new Map();

    tokenizedDocs.forEach((tokens) => {
      const uniqueTokens = new Set(tokens);

      uniqueTokens.forEach((token) => {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      });
    });

    const totalDocs = Math.max(documents.length, 1);
    const idf = new Map();

    docFreq.forEach((freq, token) => {
      idf.set(token, Math.log((totalDocs + 1) / (freq + 1)) + 1);
    });

    const vectors = tokenizedDocs.map((tokens, idx) => {
      const tf = this.buildTfMap(tokens);
      const vector = new Map();
      let normSquared = 0;

      tf.forEach((count, token) => {
        const weight = count * (idf.get(token) || 0);
        vector.set(token, weight);
        normSquared += weight * weight;
      });

      return {
        source: documents[idx].source,
        text: documents[idx].text,
        vector,
        norm: Math.sqrt(normSquared)
      };
    });

    return { idf, vectors };
  }

  detectIntent(query) {
    const normalizedQuery = this.normalizeText(query);
    const rawQuery = query ? query.toString().toLowerCase() : '';
    const blocked = UNSUPPORTED_ADMIN_RE.test(normalizedQuery) ||
      UNRELATED_RE.test(normalizedQuery) ||
      MATH_RE.test(normalizedQuery) ||
      /\d+\s*(?:x|\*|\/|\+|-)\s*\d+/.test(rawQuery);
    const hasStoreContext = STORE_CONTEXT_RE.test(normalizedQuery) ||
      /\bada\s+(barang|produk|item)\s+apa\b/.test(normalizedQuery);

    return {
      blocked,
      productList: !blocked && hasStoreContext && (
        /\b(produk|produknya|barang|barangnya|item|katalog|tersedia|stok|stock|ready|jual|jualan)\b/.test(normalizedQuery) ||
        /\b(daftar|list|menu)\s+(produk|barang|item)\b/.test(normalizedQuery) ||
        /\bapa\s+(aja|saja)\b/.test(normalizedQuery) ||
        /\bada\s+(barang|produk|item)\s+apa\b/.test(normalizedQuery)
      ),
      storeInfo: /\b(nama\s+toko|toko\s+apa|nama\s+store|store|olshop)\b/.test(normalizedQuery),
      greeting: /^(halo|hai|hi|hello|pagi|siang|sore|malam|assalamualaikum)\b/.test(normalizedQuery)
    };
  }

  adjustScoreForIntent(score, item, intent) {
    const source = this.normalizeText(item.source || '');
    const text = this.normalizeText(item.text || '');
    let adjustedScore = score;

    if (intent.productList && source.includes('ringkasan produk')) {
      adjustedScore += 0.35;
    }

    if (intent.storeInfo) {
      if (source.includes('config behavior') || text.includes('nama toko')) {
        adjustedScore += 0.45;
      } else if (text.includes('brand toko')) {
        adjustedScore += 0.15;
      } else {
        adjustedScore *= 0.2;
      }
    }

    if (intent.greeting) {
      if (source.includes('config behavior') || text.includes('sapaan')) {
        adjustedScore += 0.45;
      } else {
        adjustedScore *= 0.1;
      }
    }

    return adjustedScore;
  }

  retrieveContext(query, documents, topK = 3, options = {}) {
    const threshold =
      options.threshold !== undefined
        ? Number(options.threshold)
        : Number(process.env.RAG_SCORE_THRESHOLD || 0.03);

    this.lastDebug = {
      query,
      normalizedQuery: this.normalizeText(query),
      documentCount: documents ? documents.length : 0,
      threshold,
      intent: this.detectIntent(query),
      queryTokens: [],
      topCandidates: [],
      returnedCount: 0,
      fallbackReason: null
    };

    if (!documents || documents.length === 0) {
      this.lastDebug.fallbackReason = 'no_documents_loaded';
      return [];
    }

    const signature = this.buildIndexSignature(documents);
    if (this.cache.signature !== signature || !this.cache.index) {
      this.cache.signature = signature;
      this.cache.index = this.buildRagIndex(documents);
    }

    const { idf, vectors } = this.cache.index;
    if (!vectors.length) {
      this.lastDebug.fallbackReason = 'empty_index';
      return [];
    }

    const queryTokens = this.tokenize(query);
    this.lastDebug.queryTokens = queryTokens;

    if (!queryTokens.length) {
      this.lastDebug.fallbackReason = 'no_query_tokens_after_filtering';
      return [];
    }

    const queryTf = this.buildTfMap(queryTokens);
    const queryVector = new Map();
    let queryNormSquared = 0;

    queryTf.forEach((count, token) => {
      const weight = count * (idf.get(token) || 0);
      if (weight > 0) {
        queryVector.set(token, weight);
        queryNormSquared += weight * weight;
      }
    });

    const queryNorm = Math.sqrt(queryNormSquared);
    if (!queryNorm) {
      this.lastDebug.fallbackReason = 'query_tokens_not_in_index';
      return [];
    }

    const intent = this.lastDebug.intent;
    const scored = vectors
      .map((item) => {
        if (!item.norm) return { ...item, score: 0 };

        let dot = 0;

        queryVector.forEach((qWeight, token) => {
          const dWeight = item.vector.get(token);
          if (dWeight) dot += qWeight * dWeight;
        });

        const rawScore = dot / (queryNorm * item.norm);

        return {
          source: item.source,
          text: item.text,
          score: this.adjustScoreForIntent(rawScore, item, intent),
          rawScore
        };
      })
      .sort((a, b) => b.score - a.score);

    this.lastDebug.topCandidates = scored.slice(0, 10).map((item) => ({
      source: item.source,
      score: Number(item.score.toFixed(4)),
      preview: item.text.replace(/\s+/g, ' ').trim().slice(0, 180)
    }));

    const filtered = scored
      .filter((item) => item.score >= threshold)
      .slice(0, topK);

    this.lastDebug.returnedCount = filtered.length;

    if (filtered.length === 0) {
      const bestScore = scored[0] ? scored[0].score : 0;
      this.lastDebug.fallbackReason =
        bestScore > 0
          ? `best_score_below_threshold:${bestScore.toFixed(4)}`
          : 'no_token_overlap';
    }

    return filtered;
  }

  buildContextBlock(contextItems) {
    if (!contextItems || !contextItems.length) return '';

    return contextItems
      .map((item, idx) => {
        const cleanText = item.text.replace(/\s+/g, ' ').trim();
        return `[Konteks ${idx + 1}] Sumber: ${item.source}\n${cleanText}`;
      })
      .join('\n\n');
  }

  clearCache() {
    this.cache.signature = '';
    this.cache.index = null;
    this.lastDebug = null;
  }

  getLastDebug() {
    return this.lastDebug;
  }
}

module.exports = RAGEngine;
