const fs = require('fs');
const path = require('path');

class DatasetManager {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.ensureDataDir();
    this.datasets = new Map();
    this.loadAllDatasets();
  }

  parseCsvLine(line) {
    const values = [];
    let current = '';
    let insideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (character === '"') {
        if (insideQuotes && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          insideQuotes = !insideQuotes;
        }
        continue;
      }

      if (character === ',' && !insideQuotes) {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += character;
    }

    values.push(current.trim());
    return values;
  }

  buildTextFromCsvRow(headers, row) {
    const semanticText = this.buildSemanticCsvText(headers, row);
    if (semanticText) return semanticText;

    const fields = [];

    headers.forEach((header, index) => {
      const value = row[index] ? row[index].trim() : '';
      if (!value) return;

      const normalizedHeader = header.toLowerCase();
      if (
        normalizedHeader.includes('href') ||
        normalizedHeader.includes('src')
      ) {
        return;
      }

      fields.push(`${header}: ${value}`);
    });

    return fields.join('\n');
  }

  isUrlValue(value) {
    return /^https?:\/\//i.test(value) || /^data:/i.test(value);
  }

  isNumericValue(value) {
    return /^[\d.,%+\-\s]+$/.test(value);
  }

  looksLikePrice(value) {
    return /^[\d.,]+$/.test(value) && /\d/.test(value);
  }

  formatPrice(value) {
    const cleanValue = value ? value.trim() : '';
    if (!cleanValue) return '';
    if (/^rp/i.test(cleanValue)) return cleanValue;
    return `Rp ${cleanValue}`;
  }

  cleanRepeatedText(value) {
    const cleanValue = value ? value.trim().replace(/\s+/g, ' ') : '';
    if (!cleanValue) return '';

    for (let splitIndex = Math.floor(cleanValue.length / 2) - 3; splitIndex <= Math.floor(cleanValue.length / 2) + 3; splitIndex += 1) {
      if (splitIndex <= 0 || splitIndex >= cleanValue.length) continue;

      const first = cleanValue.slice(0, splitIndex).trim();
      const second = cleanValue.slice(splitIndex).trim();

      if (first && this.normalizeText(first) === this.normalizeText(second)) {
        return first;
      }
    }

    return cleanValue;
  }

  normalizeText(value) {
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

  detectBrandFromName(productName) {
    const knownBrands = [
      'NETAFARM',
      'PETROKUM',
      'GAVIOTA',
      'ASENA',
      'REDINET',
      'TANI JAYA',
      'EM4'
    ];
    const normalizedName = this.normalizeText(productName);

    for (const brand of knownBrands) {
      if (normalizedName.includes(this.normalizeText(brand))) {
        return brand;
      }
    }

    return '';
  }

  classifyProductCategory(productName) {
    const normalizedName = this.normalizeText(productName);

    if (/\b(keranjang|pot pupuk|tempat pupuk|sprayer|semprot|jaring|paranet|alat|net)\b/.test(normalizedName)) {
      return 'Alat pertanian';
    }

    if (/\b(media tanam|sekam|perlite|cocopeat|pasir|tanah)\b/.test(normalizedName)) {
      return 'Media tanam';
    }

    if (/\b(ab mix|nutrisi|hidroponik|em4)\b/.test(normalizedName)) {
      return 'Nutrisi hidroponik';
    }

    if (/\b(pupuk|booster|npk|gaviota|kapur|dolomit|dolomite|vegetatif)\b/.test(normalizedName)) {
      return 'Pupuk tanaman';
    }

    if (/\b(racun|hama|rodentisida|insektisida|fungisida|pestisida|anti hama)\b/.test(normalizedName)) {
      return 'Pestisida dan pengendalian hama';
    }

    return 'Produk pertanian lain';
  }

  buildSemanticCsvText(headers, row) {
    const values = row.map((value) => (value ? value.trim() : ''));
    const productIndex = values.findIndex((value) => {
      if (!value) return false;
      if (this.isUrlValue(value)) return false;
      if (this.isNumericValue(value)) return false;
      return value.length >= 4;
    });

    if (productIndex === -1) return '';

    const productName = this.cleanRepeatedText(values[productIndex]);
    const price = values
      .slice(productIndex + 1)
      .find((value) => value && this.looksLikePrice(value));
    const discount = values.find((value) => /^-?\d+%$/.test(value));
    const productUrl = values.find((value) => /^https?:\/\/shopee\.co\.id\//i.test(value));
    const brand = this.detectBrandFromName(productName);
    const category = this.classifyProductCategory(productName);
    const fields = [
      `Produk: ${productName}`,
      'Jenis data: produk',
      'Status: tersedia dalam dataset produk',
      `Kategori: ${category}`
    ];

    if (price) {
      fields.push(`Harga: ${this.formatPrice(price)}`);
    }

    if (discount) {
      fields.push(`Diskon: ${discount}`);
    }

    if (brand) {
      fields.push(`Brand: ${brand}`);
    }

    if (productUrl) {
      fields.push(`Sumber marketplace: Shopee`);
    }

    return fields.join('\n');
  }

  extractCsvLabel(row) {
    for (const value of row) {
      const cleanValue = value ? value.trim() : '';
      if (!cleanValue) continue;
      if (/^https?:\/\//i.test(cleanValue)) continue;
      if (/^data:/i.test(cleanValue)) continue;
      if (/^[\d.,%+-]+$/.test(cleanValue)) continue;
      if (cleanValue.length < 4) continue;

      return this.cleanRepeatedText(cleanValue);
    }

    return 'baris';
  }

  extractProductNameFromText(text) {
    const match = text.match(/^(?:Nama produk|Produk):\s*(.+)$/im);
    return match ? match[1].trim() : '';
  }

  buildCsvSummaryDocument(datasetName, documents) {
    const products = documents
      .map((doc) => {
        const productName = this.extractProductNameFromText(doc.text);
        if (!productName) return null;

        return {
          name: productName,
          category: this.parseDocumentField(doc.text, 'Kategori'),
          brand: this.parseDocumentField(doc.text, 'Brand')
        };
      })
      .filter(Boolean);
    const productNames = products.map((product) => product.name);

    if (productNames.length === 0) return null;

    const categoryCounts = new Map();
    const brands = new Set();

    products.forEach((product) => {
      if (product.category) {
        categoryCounts.set(
          product.category,
          (categoryCounts.get(product.category) || 0) + 1
        );
      }

      if (product.brand) {
        brands.add(product.brand);
      }
    });

    const categorySummary = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${category} (${count})`)
      .join('; ');
    const brandSummary = Array.from(brands).sort().join(', ');
    const sampleProducts = productNames.slice(0, 30).join('; ');
    const fields = [
      `Ringkasan dataset: ${datasetName}`,
      'Jenis data: katalog produk toko',
      `Jumlah produk tersedia: ${productNames.length}`,
      `Kategori utama: ${categorySummary || 'Tidak terdeteksi'}`,
      `Brand tersedia: ${brandSummary || 'Tidak terdeteksi'}`,
      `Produk tersedia: ${sampleProducts}`,
      'Pertanyaan umum: produk yang tersedia, apa aja produk, apa saja barang, daftar produk, list produk, katalog produk, menu produk, stok, harga produk'
    ];

    return {
      source: 'ringkasan-produk',
      text: fields.join('\n')
    };
  }

  loadCsvDataset(filePath, datasetName) {
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 2) {
      return {
        name: datasetName,
        file: filePath,
        data: { documents: [] },
        loadedAt: new Date().toISOString()
      };
    }

    const headers = this.parseCsvLine(lines[0]);
    const documents = [];

    for (let index = 1; index < lines.length; index += 1) {
      const row = this.parseCsvLine(lines[index]);
      const text = this.buildTextFromCsvRow(headers, row);

      if (!text) continue;

      const title = this.extractCsvLabel(row);

      documents.push({
        source: title,
        text
      });
    }

    const summaryDocument = this.buildCsvSummaryDocument(datasetName, documents);
    if (summaryDocument) {
      documents.unshift(summaryDocument);
    }

    return {
      name: datasetName,
      file: filePath,
      data: {
        metadata: {
          name: datasetName,
          type: 'csv'
        },
        documents
      },
      loadedAt: new Date().toISOString()
    };
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      console.log(`Created data directory: ${this.dataDir}`);
    }
  }

  loadAllDatasets() {
    try {
      const files = fs.readdirSync(this.dataDir);

      for (const file of files) {
        const filePath = path.join(this.dataDir, file);

        try {
          if (file.endsWith('.json')) {
            const datasetName = file.replace('.json', '');
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);

            this.datasets.set(datasetName, {
              name: datasetName,
              file: filePath,
              data,
              loadedAt: new Date().toISOString()
            });

            console.log(`Loaded dataset: ${datasetName}`);
          }

          if (file.endsWith('.csv')) {
            const datasetName = file.replace('.csv', '');
            const dataset = this.loadCsvDataset(filePath, datasetName);

            this.datasets.set(datasetName, dataset);
            console.log(`Loaded CSV dataset: ${datasetName}`);
          }
        } catch (error) {
          console.error(`Error loading dataset ${file}:`, error.message);
        }
      }

      if (this.datasets.size === 0) {
        console.log('No datasets found in data directory');
      }
    } catch (error) {
      console.error('Error loading datasets:', error.message);
    }
  }

  getAllDocuments() {
    const allDocs = [];

    for (const [name, dataset] of this.datasets) {
      if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
        for (const doc of dataset.data.documents) {
          allDocs.push({
            source: `${name}/${doc.source || 'unknown'}`,
            text: doc.text || ''
          });
        }
      }

      if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
        for (const faq of dataset.data.faq) {
          allDocs.push({
            source: `${name}/FAQ: ${faq.question || 'unknown'}`,
            text: `${faq.question}\n${faq.answer}`
          });
        }
      }
    }

    return allDocs;
  }

  getDatasetDocuments(datasetName) {
    const dataset = this.datasets.get(datasetName);
    if (!dataset) return [];

    const docs = [];

    if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
      for (const doc of dataset.data.documents) {
        docs.push({
          source: `${datasetName}/${doc.source || 'unknown'}`,
          text: doc.text || ''
        });
      }
    }

    if (dataset.data.faq && Array.isArray(dataset.data.faq)) {
      for (const faq of dataset.data.faq) {
        docs.push({
          source: `${datasetName}/FAQ: ${faq.question || 'unknown'}`,
          text: `${faq.question}\n${faq.answer}`
        });
      }
    }

    return docs;
  }

  parseDocumentField(text, fieldName) {
    const pattern = new RegExp(`^${fieldName}:\\s*(.+)$`, 'im');
    const match = text.match(pattern);
    return match ? match[1].trim() : '';
  }

  extractProductFromDocument(doc, datasetName) {
    if (!doc || !doc.text || /ringkasan-produk/i.test(doc.source || '')) {
      return null;
    }

    const name =
      this.parseDocumentField(doc.text, 'Produk') ||
      this.parseDocumentField(doc.text, 'Nama produk');

    if (!name) return null;

    return {
      name,
      price: this.parseDocumentField(doc.text, 'Harga'),
      discount: this.parseDocumentField(doc.text, 'Diskon'),
      brand: this.parseDocumentField(doc.text, 'Brand'),
      category: this.parseDocumentField(doc.text, 'Kategori'),
      source: `${datasetName}/${doc.source || name}`
    };
  }

  getProductCatalog() {
    const products = [];

    for (const [name, dataset] of this.datasets) {
      if (!dataset.data.documents || !Array.isArray(dataset.data.documents)) {
        continue;
      }

      for (const doc of dataset.data.documents) {
        const product = this.extractProductFromDocument(doc, name);
        if (product) products.push(product);
      }
    }

    return products;
  }

  saveDataset(datasetName, data) {
    try {
      const filePath = path.join(this.dataDir, `${datasetName}.json`);

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      this.datasets.set(datasetName, {
        name: datasetName,
        file: filePath,
        data,
        loadedAt: new Date().toISOString()
      });

      console.log(`Saved dataset: ${datasetName}`);
      return { success: true, message: `Dataset ${datasetName} saved` };
    } catch (error) {
      console.error(`Error saving dataset ${datasetName}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  listDatasets() {
    return Array.from(this.datasets.values()).map((dataset) => ({
      name: dataset.name,
      loadedAt: dataset.loadedAt,
      documentCount: this.getDatasetDocuments(dataset.name).length
    }));
  }

  reloadDatasets() {
    this.datasets.clear();
    this.loadAllDatasets();
  }
}

module.exports = DatasetManager;
