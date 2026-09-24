// Pure(-ish) extraction and Gemini-request logic shared by index.html.
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

  function extractText(source, decodeEntities) {
    const d = stripInlineTags(decodeMultiple(source, decodeEntities));

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
  // and video out of the (fully decoded) source so Gemini can read them
  // visually instead.

  const MIN_IMAGE_BASE64_BYTES = 2 * 1024; // skip icons/spacers under ~2 KB
  const MAX_MEDIA_IMAGES = 6;
  const MAX_MEDIA_VIDEOS = 1;
  // Stay comfortably under Gemini's ~20 MB inline-request limit.
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

  // ---- Gemini prompts -----------------------------------------------------

  const PROMPT = `Eres un corrector ortográfico y de gramática. Te doy el texto visible de un anuncio (creativo publicitario) que puede estar en español y/o inglés. Clasifica cada hallazgo en una de dos categorías:

- "error": errores ortográficos y de acentuación reales, y errores de gramática claros e inequívocos (concordancia, forma verbal incorrecta).
- "suggestion": mejoras opcionales de gramática, puntuación o claridad (por ejemplo, falta de ¿/¡ de apertura, uso de comas, concordancia discutible). Estas NO cuentan como errores.

Reglas:
- No corrijas mayúsculas de marketing.
- Ignora nombres de marca, hashtags, URLs, códigos y palabras claramente inventadas.
- Si una palabra o frase puede ser correcta, no la marques como error; a lo sumo, como sugerencia.
- Detecta el idioma de cada fragmento por su contexto.

Devuelve SOLO un objeto JSON válido, sin texto alrededor ni markdown, con esta forma:
{"issues":[{"original":"texto tal cual aparece","suggestion":"corrección o mejora","reason":"motivo breve","lang":"es|en","type":"error|suggestion"}]}
Si no hay hallazgos, devuelve {"issues":[]}.

TEXTO:
`;

  const VISUAL_PROMPT = `Eres un corrector ortográfico y de gramática. No se pudo extraer texto del HTML de este anuncio, así que te doy las imágenes y/o el video embebidos. Lee todo el texto visible en las imágenes y en los fotogramas del video, y aplica las mismas reglas que para texto:

- "error": errores ortográficos y de acentuación reales, y errores de gramática claros e inequívocos.
- "suggestion": mejoras opcionales de gramática, puntuación o claridad. NO cuentan como errores.
- Ignora nombres de marca, hashtags, URLs, códigos y palabras claramente inventadas.
- Si un texto puede ser correcto, no lo marques como error; a lo sumo, como sugerencia.

Para cada hallazgo, usa "original" con el texto tal cual aparece en la imagen o el video, y "source" con "image" o "video" según corresponda.

Devuelve SOLO un objeto JSON válido, sin texto alrededor ni markdown, con esta forma:
{"issues":[{"original":"texto tal cual aparece","suggestion":"corrección o mejora","reason":"motivo breve","lang":"es|en","type":"error|suggestion","source":"image|video"}]}
Si no hay hallazgos, devuelve {"issues":[]}.
`;

  // ---- Gemini request/response ------------------------------------------

  const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com/v1beta/models';
  const MAX_OUTPUT_TOKENS = 8192; // Gemini 3 thinking tokens were exhausting 2048 -> truncated JSON.
  // 560 tokens/image, 70 tokens/video frame at medium resolution.
  const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_MEDIUM';

  const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      issues: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            original: { type: 'STRING' },
            suggestion: { type: 'STRING' },
            reason: { type: 'STRING' },
            lang: { type: 'STRING' },
            type: { type: 'STRING', enum: ['error', 'suggestion'] },
            source: { type: 'STRING', enum: ['text', 'image', 'video'] },
          },
          required: ['original', 'suggestion', 'type'],
        },
      },
    },
    required: ['issues'],
  };

  function buildEndpointUrl(model) {
    return `${GEMINI_API_ORIGIN}/${encodeURIComponent(model)}:generateContent`;
  }

  function buildRequestBody(promptText, media) {
    const parts = [{ text: promptText }];
    const hasMedia = !!(media && ((media.images && media.images.length) || (media.videos && media.videos.length)));
    if (hasMedia) {
      for (const img of media.images || []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      for (const vid of media.videos || []) parts.push({ inlineData: { mimeType: vid.mimeType, data: vid.data } });
    }
    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
    if (hasMedia) generationConfig.mediaResolution = MEDIA_RESOLUTION;
    return { contents: [{ parts }], generationConfig };
  }

  const VALID_ISSUE_TYPES = new Set(['error', 'suggestion']);
  const VALID_ISSUE_SOURCES = new Set(['text', 'image', 'video']);

  function normalizeIssues(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((issue) => issue
        && typeof issue.original === 'string' && issue.original
        && typeof issue.suggestion === 'string' && issue.suggestion)
      .map((issue) => ({
        original: issue.original,
        suggestion: issue.suggestion,
        reason: typeof issue.reason === 'string' ? issue.reason : '',
        lang: typeof issue.lang === 'string' ? issue.lang : '',
        type: VALID_ISSUE_TYPES.has(issue.type) ? issue.type : 'error',
        source: VALID_ISSUE_SOURCES.has(issue.source) ? issue.source : 'text',
      }));
  }

  // Defensive fallback parse in case responseMimeType/responseSchema is
  // ignored by a given model/proxy and the model still fences the JSON.
  function parseGeminiResponseText(raw) {
    const clean = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return normalizeIssues(parsed && parsed.issues);
  }

  const RATE_LIMIT_MESSAGE = 'Gemini está limitando las solicitudes (429). Espera un momento y vuelve a intentar.';

  function describeGeminiHttpError(status, detail) {
    if (status === 429) return RATE_LIMIT_MESSAGE;
    return `Gemini ${status}${detail ? ': ' + detail : ''}`;
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
    // prompts
    PROMPT,
    VISUAL_PROMPT,
    // Gemini request/response
    buildEndpointUrl,
    buildRequestBody,
    normalizeIssues,
    parseGeminiResponseText,
    describeGeminiHttpError,
    RESPONSE_SCHEMA,
    MAX_OUTPUT_TOKENS,
    MEDIA_RESOLUTION,
    MIN_IMAGE_BASE64_BYTES,
    MAX_MEDIA_IMAGES,
    MAX_MEDIA_VIDEOS,
    MAX_MEDIA_TOTAL_BASE64_BYTES,
    // Drive/Worker errors
    describeDriveError,
    DRIVE_ERROR_MESSAGES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
