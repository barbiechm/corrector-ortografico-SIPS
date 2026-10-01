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

  function stripInlineTags(html) {
    return html.replace(BR_TAG_RE, ' ').replace(INLINE_TAG_RE, '');
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

  // ---- embedded media fallback ------------------------------------------
  // Used when extractText finds nothing: pull base64 data: URIs for images
  // and video out of the (fully decoded) source so the server can read them
  // visually instead.

  const MIN_IMAGE_BASE64_BYTES = 2 * 1024; // skip icons/spacers under ~2 KB
  const MAX_MEDIA_IMAGES = 6;
  const MAX_MEDIA_VIDEOS = 1;
  // Bound embedded media payloads independently of the provider.
  const MAX_MEDIA_TOTAL_BASE64_BYTES = 14 * 1024 * 1024;

  const MEDIA_DATA_URI_RE = /data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=\s]+)/gi;

  function normalizeMimeType(mime) {
    const lower = mime.toLowerCase();
    return lower === 'image/jpg' ? 'image/jpeg' : lower;
  }

  function base64ByteLength(payload) {
    const clean = payload.replace(/=+$/, '');
    return Math.floor((clean.length * 3) / 4);
  }

  function collectMediaCandidates(sources) {
    const seenPayloads = new Set();
    const imageCandidates = [];
    const videoCandidates = [];
    let skipped = 0;

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

  // decodedSource: the same multi-level-decoded string used for text
  // extraction. rawSource (optional): the original, undecoded source — also
  // scanned so media untouched by the decode passes is still found.
  function extractEmbeddedMedia(decodedSource, rawSource) {
    const { imageCandidates, videoCandidates, skipped: filterSkipped } =
      collectMediaCandidates([decodedSource, rawSource]);
    let skipped = filterSkipped;

    skipped += Math.max(0, imageCandidates.length - MAX_MEDIA_IMAGES);
    const images = imageCandidates.slice(0, MAX_MEDIA_IMAGES);

    let videos = [];
    if (videoCandidates.length > 0) {
      const largest = videoCandidates.reduce((a, b) => (b.byteLength > a.byteLength ? b : a));
      videos = [largest];
      skipped += videoCandidates.length - MAX_MEDIA_VIDEOS;
    }

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
    };
  }

  // ---- local uploads and analysis contract --------------------------------
  const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
  const IMAGE_EXTENSION_MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

  function classifyUploadFile(file) {
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error('El archivo supera 5 MiB o tiene un tamaño inválido.');
    }
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    if (extension === 'html' || extension === 'htm') return { kind: 'html', mimeType: 'text/html' };
    const mimeType = IMAGE_EXTENSION_MIMES[extension];
    if (!mimeType) throw new Error('Formato no admitido. Usa HTML, PNG, JPEG o WebP.');
    const declared = String(file.type || '').toLowerCase();
    if (declared && declared !== mimeType) throw new Error('El tipo de imagen no coincide con la extensión del archivo.');
    return { kind: 'image', mimeType };
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
    if (payload?.error) throw new Error(typeof payload.error.message === 'string' && payload.error.message
      ? payload.error.message : 'No se pudo completar el análisis.');
    if (!payload || !Array.isArray(payload.issues) || typeof payload.extractedText !== 'string'
      || typeof payload.unreadableText !== 'boolean' || typeof payload.model !== 'string') {
      throw new Error('El servicio de análisis devolvió una respuesta inválida.');
    }
    return { issues: normalizeIssues(payload.issues), extractedText: payload.extractedText,
      unreadableText: payload.unreadableText, model: payload.model };
  }

  // ---- Worker (Drive import) error translation ---------------------------

  const DRIVE_ERROR_MESSAGES = {
    INVALID_FOLDER_URL: 'El enlace no es una carpeta pública válida de Google Drive.',
    DRIVE_ACCESS_DENIED: 'Drive denegó el acceso al recurso solicitado.',
    DRIVE_RESOURCE_NOT_FOUND: 'No se encontró el recurso de Drive solicitado.',
    DRIVE_RATE_LIMITED: 'Drive está limitando las solicitudes temporalmente. Espera un momento y vuelve a intentar.',
    DRIVE_UPSTREAM_UNAVAILABLE: 'Drive no está disponible en este momento. Intenta de nuevo más tarde.',
    DRIVE_NETWORK_ERROR: 'No se pudo conectar con Drive.',
    FILE_TOO_LARGE: 'El archivo supera el límite de tamaño permitido.',
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
    // analysis and uploads
    buildAnalysisRequest,
    parseAnalysisResponse,
    classifyUploadFile,
    parseImageDataUrl,
    MAX_UPLOAD_FILE_BYTES,
    normalizeIssues,
    MIN_IMAGE_BASE64_BYTES,
    MAX_MEDIA_IMAGES,
    MAX_MEDIA_VIDEOS,
    MAX_MEDIA_TOTAL_BASE64_BYTES,
    // Drive/Worker errors
    describeDriveError,
    DRIVE_ERROR_MESSAGES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
