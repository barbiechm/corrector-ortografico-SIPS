// Pure extraction and analysis request logic shared by index.html.
//
// This is a CLASSIC script on purpose (not an ES module): the README tells
// users to open index.html directly via file://, where <script type="module">
// fails to load. It attaches everything under globalThis.OrthographyChecker.
//
// DOM-only bits (HTML entity decoding via a <textarea>) are NOT done here —
// callers inject a decodeEntities(str) function so this file stays testable
// under plain Node (see scripts/test-checker.mjs).
(function (global) {
  'use strict';

  // ---- copy extraction --------------------------------------------------
  // Banner creatives package their text inside iframes anidados (srcdoc) and
  // HTML escaped several times over. Instead of rendering, we unescape the
  // file repeatedly and pull the user-facing text between tags, filtering
  // out scaffolding (JS, base64, tool tokens).

  const MAX_COPY_LENGTH = 400;

  // Code-shaped fragments to reject. Word-boundary/structural patterns
  // instead of bare substrings, so real copy like "Free returns" survives.
  const CODE_LIKE_PATTERNS = [
    /\bfunction\s*\(/,
    /\bvar\s/,
    /\bconst\s/,
    /\breturn\s*[;(]/,
    /\d+px\b/,
    /rgba?\(/,
    /\binset\s*:/,
    /\bSPRT\b/,
    /\bCHUNK\b/,
    /\bwindow\./,
    /\bdocument\./,
    /:\/\//,
    /\.js\b/,
    /\blocale\b/,
    /__/,
    /node-defs/,
    /formatDate/,
    /viewBox/,
    /translate[XYZ]?\(/,
    /opacity\s*:/,
  ];

  function looksLikeCopy(t) {
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > MAX_COPY_LENGTH) return false;
    if (/^(data:|https?:|\/\/|@@|\/\*|\*|\{|\})/.test(t)) return false;
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(t)) return false;
    if (CODE_LIKE_PATTERNS.some((re) => re.test(t))) return false;
    // Only reject actual code-shaped punctuation; apostrophes/quotes
    // (straight or curly) are normal copy ("Don't miss it", "It's here",
    // "Oferta").
    if (/[=;{}]/.test(t)) return false;
    // proporción mínima de letras
    const letters = (t.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g) || []).length;
    if (letters / t.length < 0.4) return false;
    return true;
  }

  // Nombres internos que la herramienta mete y no son copy real.
  function isInternalName(t) {
    return /^Untitled(_\d+)?$/i.test(t.trim());
  }

  // Inline formatting tags that split a sentence across fragments
  // ("Compra <b>ya</b>" -> two matches) if left in place. Block tags are
  // left untouched.
  const INLINE_TAG_NAMES = ['b', 'strong', 'i', 'em', 'span', 'sup', 'sub', 'u', 'small', 'a', 'font'];
  const INLINE_TAG_RE = new RegExp(`</?(?:${INLINE_TAG_NAMES.join('|')})\\b[^>]*>`, 'gi');
  const BR_TAG_RE = /<br\s*\/?>/gi;

  // An inline tag styled as a block starts a new visual line (the banner tool
  // animates copy line by line this way), so it separates words like a <br>.
  // Per-character animation uses inline-block and must keep letters together.
  const BLOCK_DISPLAY_RE = /\bdisplay\s*:\s*(?:block|flex|grid|list-item|table)\b/i;

  function stripInlineTags(html) {
    return html.replace(BR_TAG_RE, ' ')
      .replace(INLINE_TAG_RE, (tag) => (BLOCK_DISPLAY_RE.test(tag) ? ' ' : ''));
  }

  // Desescapar varios niveles (iframe srcdoc anidado).
  function decodeMultiple(source, decodeEntities) {
    let d = source;
    for (let i = 0; i < 4; i++) d = decodeEntities(d);
    return d;
  }

  // Bloques que nunca son copy visible: código (incluidos los assets JS que la
  // herramienta guarda como <script type="text/sprt-asset">), estilos, el
  // <title> interno y comentarios. Se quitan en cada nivel de desescapado,
  // antes de que el siguiente nivel exponga el HTML anidado.
  const NON_COPY_BLOCK_RE = /<(script|style|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;

  function stripNonCopyBlocks(html) {
    return html.replace(NON_COPY_BLOCK_RE, ' ');
  }

  function decodeForCopy(source, decodeEntities) {
    let d = stripNonCopyBlocks(source);
    for (let i = 0; i < 4; i++) d = stripNonCopyBlocks(decodeEntities(d));
    return d;
  }

  function extractText(source, decodeEntities) {
    const d = stripInlineTags(decodeForCopy(source, decodeEntities));

    const seen = new Set();
    const out = [];
    // Texto entre > y < que no contenga otras etiquetas ni llaves.
    const re = /> *([^<>{}]+?) *</g;
    let m;
    while ((m = re.exec(d)) !== null) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (looksLikeCopy(t) && !isInternalName(t) && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out.join('\n');
  }

  // ---- embedded media -----------------------------------------------------
  // Pull base64 data: URIs for images and video out of the (fully decoded)
  // source so the server can read the copy drawn inside them. Everything
  // found is reviewed: the analysis is split into several requests
  // (planAnalysisBatches) instead of dropping media past a per-request cap.

  const MIN_IMAGE_BASE64_BYTES = 2 * 1024; // skip icons/spacers under ~2 KB
  // Per-file bounds (across all requests for that file), far above real packs.
  const MAX_MEDIA_IMAGES = 60;
  const MAX_MEDIA_VIDEOS = 8;
  const MAX_MEDIA_TOTAL_BASE64_BYTES = 64 * 1024 * 1024;
  // Per-request bounds. Keep at or below MAX_IMAGES / MAX_VIDEOS / MEDIA_LIMIT in
  // src/analysis-worker.mjs; small requests also keep the Worker's CPU time low.
  const MAX_BATCH_IMAGES = 10;
  const MAX_BATCH_VIDEOS = 2;
  const MAX_BATCH_MEDIA_BYTES = 6 * 1024 * 1024;
  // The analysis Worker accepts up to 60,000 characters of text per request.
  const MAX_BATCH_TEXT_CHARS = 50000;

  const MEDIA_DATA_URI_RE = /data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=\s]+)/gi;

  function normalizeMimeType(mime) {
    const lower = mime.toLowerCase();
    return lower === 'image/jpg' ? 'image/jpeg' : lower;
  }

  function base64ByteLength(payload) {
    const clean = payload.replace(/=+$/, '');
    return Math.floor((clean.length * 3) / 4);
  }

  function collectMediaCandidates(sources, extraMedia) {
    const seenPayloads = new Set();
    const imageCandidates = [];
    const videoCandidates = [];
    let skipped = 0;

    for (const { mimeType: rawMime, data } of extraMedia || []) {
      const mimeType = normalizeMimeType(rawMime);
      if (seenPayloads.has(data)) continue;
      const byteLength = base64ByteLength(data);
      const isVideo = mimeType.startsWith('video/');
      if (!isVideo && byteLength < MIN_IMAGE_BASE64_BYTES) { skipped++; continue; }
      seenPayloads.add(data);
      (isVideo ? videoCandidates : imageCandidates).push({ mimeType, data, byteLength });
    }

    for (const src of sources) {
      if (typeof src !== 'string') continue;
      MEDIA_DATA_URI_RE.lastIndex = 0;
      let match;
      while ((match = MEDIA_DATA_URI_RE.exec(src)) !== null) {
        const rawMime = match[1].toLowerCase();
        const rawPayload = match[2].replace(/\s+/g, '');

        if (rawMime === 'image/svg+xml') { skipped++; continue; } // not supported inline as image
        if (!/^[A-Za-z0-9+/=]+$/.test(rawPayload)) { skipped++; continue; }
        if (seenPayloads.has(rawPayload)) continue;

        const mimeType = normalizeMimeType(rawMime);
        const byteLength = base64ByteLength(rawPayload);
        const isVideo = mimeType.startsWith('video/');
        if (!isVideo && byteLength < MIN_IMAGE_BASE64_BYTES) { skipped++; continue; }

        seenPayloads.add(rawPayload);
        const item = { mimeType, data: rawPayload, byteLength };
        (isVideo ? videoCandidates : imageCandidates).push(item);
      }
    }

    return { imageCandidates, videoCandidates, skipped };
  }

  // Past the per-file count, keep the largest items (most likely to carry copy)
  // while preserving their order in the source.
  function largestInOrder(candidates, limit) {
    if (candidates.length <= limit) return candidates;
    const kept = new Set([...candidates].sort((a, b) => b.byteLength - a.byteLength).slice(0, limit));
    return candidates.filter((item) => kept.has(item));
  }

  // decodedSource: the same multi-level-decoded string used for text
  // extraction. rawSource (optional): the original, undecoded source — also
  // scanned so media untouched by the decode passes is still found.
  // extraMedia (optional): already-decoded { mimeType, data } items, e.g. from
  // extractPackedMedia.
  function extractEmbeddedMedia(decodedSource, rawSource, extraMedia) {
    const { imageCandidates, videoCandidates, skipped: filterSkipped } =
      collectMediaCandidates([decodedSource, rawSource], extraMedia);
    let skipped = filterSkipped;

    skipped += Math.max(0, imageCandidates.length - MAX_MEDIA_IMAGES);
    const images = largestInOrder(imageCandidates, MAX_MEDIA_IMAGES);

    // Largest videos first: they most likely carry the advertisement's copy.
    const videos = [...videoCandidates]
      .sort((a, b) => b.byteLength - a.byteLength)
      .slice(0, MAX_MEDIA_VIDEOS);
    skipped += videoCandidates.length - videos.length;

    let totalBytes = 0;
    const selectedImages = [];
    const selectedVideos = [];
    for (const item of images) {
      if (totalBytes + item.byteLength > MAX_MEDIA_TOTAL_BASE64_BYTES) { skipped++; continue; }
      totalBytes += item.byteLength;
      selectedImages.push(item);
    }
    for (const item of videos) {
      if (totalBytes + item.byteLength > MAX_MEDIA_TOTAL_BASE64_BYTES) { skipped++; continue; }
      totalBytes += item.byteLength;
      selectedVideos.push(item);
    }

    return {
      images: selectedImages.map(({ mimeType, data }) => ({ mimeType, data })),
      videos: selectedVideos.map(({ mimeType, data }) => ({ mimeType, data })),
      skipped,
      // Usable media left out by the count or size limits (not icons/SVG): its text goes unreviewed.
      omitted: imageCandidates.length + videoCandidates.length - selectedImages.length - selectedVideos.length,
    };
  }

  // ---- media packed in an embedded ZIP (Cocos Creator "super-html") --------
  // Cocos playables ship every asset inside a ZIP stored as one base64 string
  // (window.__zip = "UEsDB..."). Images sit in it as files and, in the
  // "__res" JSON entry, as data: URIs with one junk digit inserted near the
  // start of the payload. Nothing here runs the creative's code.

  const ZIP_BASE64_RE = /UEsDB[A-Za-z0-9+/]{2000,}={0,2}/g;
  const MAX_ZIP_ENTRIES = 5000;
  const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
  const PACKED_MEDIA_EXTENSIONS = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // Strict header checks: long enough that removing the wrong character fails.
  function hasMediaSignature(bytes, mimeType) {
    const ascii = (offset, text) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
    const starts = (...signature) => signature.every((byte, i) => bytes[i] === byte);
    switch (mimeType) {
      case 'image/png': return starts(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13) && ascii(12, 'IHDR');
      case 'image/jpeg': return starts(255, 216, 255);
      case 'image/webp': return ascii(0, 'RIFF') && ascii(8, 'WEBPVP8');
      case 'image/gif': return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
      case 'video/mp4': return ascii(4, 'ftyp');
      case 'video/webm': return starts(26, 69, 223, 163);
      default: return false;
    }
  }

  function headerOf(payload) {
    try { return base64ToBytes(payload.slice(0, 24)); } catch { return new Uint8Array(); }
  }

  function canonicalBase64(payload) {
    if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
    const tail = payload.slice(-4);
    try { return btoa(atob(tail)) === tail; } catch { return false; }
  }

  // Positions whose removal turns an obfuscated payload into a valid one.
  function junkDigitCandidates(payload, mimeType) {
    const positions = [];
    if (payload.length % 4 !== 1) return positions;
    for (let pos = 0; pos < 40 && pos < payload.length; pos++) {
      if (!/[0-9]/.test(payload[pos])) continue;
      const fixed = payload.slice(0, pos) + payload.slice(pos + 1);
      if (hasMediaSignature(headerOf(fixed), mimeType)) positions.push(pos);
    }
    return positions;
  }

  // Data URIs from "__res": valid ones are kept; obfuscated ones are repaired
  // only when a single junk position validates, or when it matches the offset
  // the unambiguous entries of the same file agree on (position + key length).
  function repairResourceDataUris(resources) {
    const entries = [];
    for (const [key, value] of Object.entries(resources)) {
      if (typeof value !== 'string') continue;
      const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value);
      if (!match) continue;
      const mimeType = normalizeMimeType(match[1]);
      if (!Object.values(PACKED_MEDIA_EXTENSIONS).includes(mimeType)) continue;
      entries.push({ key, mimeType, payload: match[2] });
    }
    const offsets = new Map();
    for (const entry of entries) {
      entry.candidates = canonicalBase64(entry.payload) && hasMediaSignature(headerOf(entry.payload), entry.mimeType)
        ? null : junkDigitCandidates(entry.payload, entry.mimeType);
      if (entry.candidates?.length === 1) {
        const offset = entry.candidates[0] + entry.key.length;
        offsets.set(offset, (offsets.get(offset) || 0) + 1);
      }
    }
    const fileOffset = [...offsets].sort((a, b) => b[1] - a[1])[0]?.[0];
    const media = [];
    let unrecoverable = 0;
    for (const entry of entries) {
      let data = entry.payload;
      if (entry.candidates) {
        const pos = entry.candidates.length === 1 ? entry.candidates[0]
          : entry.candidates.includes(fileOffset - entry.key.length) ? fileOffset - entry.key.length : -1;
        data = pos < 0 ? '' : entry.payload.slice(0, pos) + entry.payload.slice(pos + 1);
      }
      if (data && canonicalBase64(data) && hasMediaSignature(headerOf(data), entry.mimeType)) {
        media.push({ mimeType: entry.mimeType, data });
      } else unrecoverable++;
    }
    return { media, unrecoverable };
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream unavailable');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readZipEntries(zip) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const count = Math.min(view.getUint16(eocd + 10, true), MAX_ZIP_ENTRIES);
    let pointer = view.getUint32(eocd + 16, true);
    const entries = [];
    const decoder = new TextDecoder();
    for (let k = 0; k < count && pointer + 46 <= zip.length; k++) {
      if (view.getUint32(pointer, true) !== 0x02014b50) break;
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const size = view.getUint32(pointer + 24, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decoder.decode(zip.subarray(pointer + 46, pointer + 46 + nameLength));
      pointer += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/') || localOffset + 30 > zip.length) continue;
      const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      entries.push({ name, method, size, data: zip.subarray(start, start + compressedSize) });
    }
    return entries;
  }

  async function entryBytes(entry) {
    if (entry.size > MAX_ZIP_ENTRY_BYTES) return null;
    if (entry.method === 0) return entry.data;
    if (entry.method === 8) return inflateRaw(entry.data);
    return null;
  }

  // Returns { media: [{ mimeType, data }], unrecoverable, found } where found
  // says an embedded ZIP was present, so callers never report it as empty.
  async function extractPackedMedia(source) {
    const result = { media: [], unrecoverable: 0, found: false };
    if (typeof source !== 'string' || !source.includes('UEsDB')) return result;
    ZIP_BASE64_RE.lastIndex = 0;
    let match;
    while ((match = ZIP_BASE64_RE.exec(source)) !== null) {
      let zip;
      try { zip = base64ToBytes(match[0].length % 4 ? match[0].slice(0, match[0].length - (match[0].length % 4)) : match[0]); }
      catch { continue; }
      const entries = readZipEntries(zip);
      if (!entries.length) continue;
      result.found = true;
      // Media files may be binary or, like "__res" values, data: URI text.
      const resources = {};
      for (const entry of entries) {
        const extension = (entry.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
        const mimeType = PACKED_MEDIA_EXTENSIONS[extension];
        const isResources = entry.name === '__res' || /(^|\/)__res(\.json)?$/.test(entry.name);
        if (!mimeType && !isResources) continue;
        let bytes;
        try { bytes = await entryBytes(entry); } catch { bytes = null; }
        if (!bytes) { result.unrecoverable++; continue; }
        if (mimeType && hasMediaSignature(bytes.subarray(0, 24), mimeType)) {
          result.media.push({ mimeType, data: bytesToBase64(bytes) });
          continue;
        }
        const text = new TextDecoder().decode(bytes);
        if (mimeType) {
          if (text.startsWith('data:')) resources[entry.name] = text.trim();
          else result.unrecoverable++;
          continue;
        }
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') Object.assign(resources, parsed);
        } catch { result.unrecoverable++; }
      }
      const repaired = repairResourceDataUris(resources);
      result.media.push(...repaired.media);
      result.unrecoverable += repaired.unrecoverable;
    }
    // Audio and other resources are not media this tool reviews.
    return result;
  }

  // ---- splitting one file's review across several requests ---------------
  function chunkText(text) {
    if (text.length <= MAX_BATCH_TEXT_CHARS) return text.trim() ? [text] : [];
    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
      const piece = line.slice(0, MAX_BATCH_TEXT_CHARS);
      if (current && current.length + 1 + piece.length > MAX_BATCH_TEXT_CHARS) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
    if (current.trim()) chunks.push(current);
    return chunks;
  }

  // Returns [{ text, media: { images, videos } }]: the text travels with the
  // first media batch, so text and images of the same creative are read together.
  function planAnalysisBatches(text = '', media = {}) {
    const mediaBatches = [];
    let current = null;
    const items = [
      ...(media.images || []).map((item) => ({ kind: 'images', item })),
      ...(media.videos || []).map((item) => ({ kind: 'videos', item })),
    ];
    for (const { kind, item } of items) {
      const bytes = base64ByteLength(item.data);
      const full = current && (
        (kind === 'images' && current.images.length >= MAX_BATCH_IMAGES)
        || (kind === 'videos' && current.videos.length >= MAX_BATCH_VIDEOS)
        || current.bytes + bytes > MAX_BATCH_MEDIA_BYTES);
      if (!current || full) {
        current = { images: [], videos: [], bytes: 0 };
        mediaBatches.push(current);
      }
      current[kind].push({ mimeType: item.mimeType, data: item.data });
      current.bytes += bytes;
    }
    const textChunks = chunkText(text);
    const batches = mediaBatches.map((batch, index) => ({
      text: index === 0 ? (textChunks[0] || '') : '', media: { images: batch.images, videos: batch.videos } }));
    const remainingText = mediaBatches.length ? textChunks.slice(1) : textChunks;
    for (const chunk of remainingText) batches.push({ text: chunk, media: { images: [], videos: [] } });
    return batches;
  }

  const collapseSpace = (text) => text.replace(/\s+/g, ' ').trim();

  // Same rule as the analysis Worker: an image fragment that appears elsewhere
  // as part of a longer word is a clipped copy of a line shown complete.
  function clippedElsewhere(visibleText, fragment) {
    if (!fragment) return false;
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<=\\p{L})${escaped}|${escaped}(?=\\p{L})`, 'u').test(visibleText);
  }

  // Combines parsed results of every batch of one file into a single result.
  function mergeAnalysisResults(results, text = '') {
    const extractedText = results.map((result) => result.extractedText).filter((part) => part && part.trim()).join('\n');
    const visibleText = collapseSpace(`${text}\n${extractedText}`);
    const seen = new Set();
    const issues = [];
    let discardedIssues = 0;
    for (const result of results) {
      discardedIssues += result.discardedIssues || 0;
      for (const issue of result.issues) {
        const key = `${issue.source}\u0000${issue.original}\u0000${issue.suggestion}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Layers reviewed in different requests can still cover each other.
        if (issue.source !== 'text' && results.length > 1 && clippedElsewhere(visibleText, collapseSpace(issue.original))) continue;
        issues.push(issue);
      }
    }
    return { issues, discardedIssues, extractedText,
      unreadableText: results.some((result) => result.unreadableText), model: results[0]?.model || '' };
  }

  // ---- local uploads and analysis contract --------------------------------
  const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_HTML_FILE_BYTES = 25 * 1024 * 1024;
  const IMAGE_EXTENSION_MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

  function classifyUploadFile(file) {
    if (!Number.isFinite(file.size) || file.size < 0) throw new Error('El archivo tiene un tamaño inválido.');
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    if (extension === 'html' || extension === 'htm') {
      if (file.size > MAX_HTML_FILE_BYTES) throw new Error(`El HTML pesa ${formatMiB(file.size)} y supera el límite de 25 MiB. Revísalo manualmente.`);
      return { kind: 'html', mimeType: 'text/html' };
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) throw new Error('La imagen supera 5 MiB.');
    const mimeType = IMAGE_EXTENSION_MIMES[extension];
    if (!mimeType) throw new Error('Formato no admitido. Usa HTML, PNG, JPEG o WebP.');
    const declared = String(file.type || '').toLowerCase();
    if (declared && declared !== mimeType) throw new Error('El tipo de imagen no coincide con la extensión del archivo.');
    return { kind: 'image', mimeType };
  }

  function formatMiB(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MiB`;
  }

  function parseImageDataUrl(result, mimeType) {
    const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(result || ''));
    if (!match || (match[1].toLowerCase() !== mimeType && match[1].toLowerCase() !== 'application/octet-stream' && match[1] !== '')
      || match[2].length % 4 !== 0 || base64ByteLength(match[2]) > MAX_UPLOAD_FILE_BYTES) {
      throw new Error('No se pudo leer una imagen válida del archivo.');
    }
    return { mimeType, data: match[2] };
  }

  function buildAnalysisRequest(text = '', media = {}) {
    const copyMedia = entries => (entries || []).map(({ mimeType, data }) => ({ mimeType, data }));
    return { text, media: { images: copyMedia(media.images), videos: copyMedia(media.videos) } };
  }

  const VALID_ISSUE_TYPES = new Set(['error', 'suggestion']);
  const VALID_ISSUE_SOURCES = new Set(['text', 'image', 'video']);

  function normalizeIssues(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((issue) => issue
        && typeof issue.original === 'string' && issue.original
        && typeof issue.suggestion === 'string' && issue.suggestion
        // Un hallazgo que "corrige" el texto por sí mismo no aporta nada.
        && issue.suggestion.trim() !== issue.original.trim())
      .map((issue) => ({
        original: issue.original,
        suggestion: issue.suggestion,
        reason: typeof issue.reason === 'string' ? issue.reason : '',
        lang: typeof issue.lang === 'string' ? issue.lang : '',
        type: VALID_ISSUE_TYPES.has(issue.type) ? issue.type : 'error',
        source: VALID_ISSUE_SOURCES.has(issue.source) ? issue.source : 'text',
      }));
  }

  function parseAnalysisResponse(payload) {
    if (payload?.error) {
      const message = typeof payload.error.message === 'string' && payload.error.message
        ? payload.error.message : 'No se pudo completar el análisis.';
      // The service names the failed check (never content) so failures can be reported.
      const detail = typeof payload.error.detail === 'string' && /^[a-z_]{1,48}$/.test(payload.error.detail)
        ? ` (diagnóstico: ${payload.error.detail})` : '';
      const code = typeof payload.error.code === 'string' ? payload.error.code : '';
      throw Object.assign(new Error(message + detail), { code });
    }
    if (!payload || !Array.isArray(payload.issues) || typeof payload.extractedText !== 'string'
      || typeof payload.unreadableText !== 'boolean' || typeof payload.model !== 'string') {
      throw new Error('El servicio de análisis devolvió una respuesta inválida.');
    }
    const issues = normalizeIssues(payload.issues);
    const discarded = Number.isSafeInteger(payload.discardedIssues) && payload.discardedIssues > 0
      ? payload.discardedIssues : 0;
    // Hallazgos descartados (por el servidor o aquí) impiden mostrar un "sin errores" limpio.
    return { issues, discardedIssues: discarded + (payload.issues.length - issues.length),
      extractedText: payload.extractedText, unreadableText: payload.unreadableText, model: payload.model };
  }

  // ---- Worker (Drive import) error translation ---------------------------

  const DRIVE_ERROR_MESSAGES = {
    INVALID_FOLDER_URL: 'El enlace no es una carpeta pública válida de Google Drive.',
    DRIVE_ACCESS_DENIED: 'Drive denegó el acceso al recurso solicitado.',
    DRIVE_RESOURCE_NOT_FOUND: 'No se encontró el recurso de Drive solicitado.',
    DRIVE_RATE_LIMITED: 'Drive está limitando las solicitudes temporalmente. Espera un momento y usa “Reintentar fallidos”.',
    DRIVE_QUOTA_EXCEEDED: 'Se agotó la cuota de descarga de Drive para este archivo. Intenta de nuevo en unas horas.',
    ORIGIN_NOT_ALLOWED: 'Este sitio no está autorizado para usar la importación de Drive.',
    DRIVE_UPSTREAM_UNAVAILABLE: 'Drive no está disponible en este momento. Intenta de nuevo más tarde.',
    DRIVE_NETWORK_ERROR: 'No se pudo conectar con Drive.',
    FILE_TOO_LARGE: 'El HTML supera el límite de 25 MiB. Revísalo manualmente.',
    FILE_NOT_IN_FOLDER: 'El archivo seleccionado ya no pertenece a la carpeta solicitada.',
    REQUEST_TOO_LARGE: 'La solicitud es demasiado grande.',
    SERVER_MISCONFIGURED: 'La importación de Drive no está configurada correctamente en el servidor.',
    INVALID_FILE_SELECTION: 'La selección de archivos no es válida.',
  };

  function describeDriveError(code, fallbackMessage) {
    return (code && DRIVE_ERROR_MESSAGES[code]) || fallbackMessage || 'No se pudo completar la operación con Drive.';
  }

  global.OrthographyChecker = {
    // extraction
    extractText,
    decodeMultiple,
    looksLikeCopy,
    isInternalName,
    stripInlineTags,
    extractEmbeddedMedia,
    extractPackedMedia,
    // analysis and uploads
    buildAnalysisRequest,
    planAnalysisBatches,
    mergeAnalysisResults,
    parseAnalysisResponse,
    classifyUploadFile,
    parseImageDataUrl,
    formatMiB,
    MAX_UPLOAD_FILE_BYTES,
    MAX_HTML_FILE_BYTES,
    normalizeIssues,
    MIN_IMAGE_BASE64_BYTES,
    MAX_MEDIA_IMAGES,
    MAX_MEDIA_VIDEOS,
    MAX_MEDIA_TOTAL_BASE64_BYTES,
    MAX_BATCH_IMAGES,
    MAX_BATCH_VIDEOS,
    MAX_BATCH_MEDIA_BYTES,
    MAX_BATCH_TEXT_CHARS,
    // Drive/Worker errors
    describeDriveError,
    DRIVE_ERROR_MESSAGES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
