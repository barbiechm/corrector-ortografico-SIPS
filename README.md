# Corrector ortográfico de SIPs

Revisa ortografía y gramática del texto extraído de HTML y de imágenes PNG, JPG/JPEG y WebP con **Gemini 3.5 Flash Lite de pago mediante OpenRouter**. El análisis usa un Worker separado; la importación existente de Google Drive no cambia.

## Preparar el análisis

1. Usa `.dev.vars.example` como referencia para tu archivo privado `.dev.vars`. Si ya existe, no lo sobrescribas ni borres variables de Drive. Completa `OPENROUTER_API_KEY` y agrega `ANALYSIS_ACCESS_TOKEN`: una contraseña larga, aleatoria y distinta de la API key. El modelo es `google/gemini-3.5-flash-lite`.
2. Para desarrollo del análisis, ejecuta `npx --no-install wrangler dev --config wrangler.analysis.jsonc`. Configura `ALLOWED_ORIGINS` en ese archivo para el origen exacto del sitio de prueba (por ejemplo, `http://localhost:8080`). Sirve los archivos estáticos desde ese origen: abrir `index.html` directamente con `file://` no funciona con la política de acceso del análisis.
3. Asigna la URL local del Worker más `/analyze` a `analysisEndpoint` en `runtime-config.js`. No cambies `driveImportEndpoint`. Una URL de análisis vacía deshabilita las llamadas de pago.
4. En la interfaz, pega **la clave de acceso** (`ANALYSIS_ACCESS_TOKEN`), no la API key de OpenRouter. Selecciona HTML de hasta 25 MiB o imágenes de hasta 5 MiB; se revisan en una cola secuencial. **Volver a revisar todo** genera nuevas llamadas de pago.

La API key permanece en el servidor. La clave de acceso se guarda en el `localStorage` de ese navegador (clave `orthography.analysisToken`) para no tener que pegarla en cada sesión, y solo se envía al Worker de análisis; **Olvidar clave** la borra del navegador y detiene las siguientes solicitudes de la cola. Cualquiera con acceso a ese navegador puede leerla: no la guardes en equipos compartidos. La aplicación elimina la antigua key de Gemini de `localStorage` sin leerla. No subas `.dev.vars` a Git, Drive ni al alojamiento estático.

### Publicar el Worker de análisis

Estos comandos son instrucciones, no se ejecutaron como parte de la implementación:

```bash
npx --no-install wrangler secret put OPENROUTER_API_KEY --config wrangler.analysis.jsonc
npx --no-install wrangler secret put ANALYSIS_ACCESS_TOKEN --config wrangler.analysis.jsonc
npx --no-install wrangler deploy --config wrangler.analysis.jsonc
```

Configura el origen HTTPS del sitio en `ALLOWED_ORIGINS` y la URL publicada más `/analyze` en `analysisEndpoint`. Publica únicamente los archivos estáticos necesarios: `index.html`, `checker.js`, `runtime-config.js` y `_headers`, nunca todo el directorio de trabajo. El Worker de Drive conserva su configuración y secretos independientes.

La clave de acceso compartida no reemplaza cuentas de usuario ni cuotas. Cualquier persona que la conozca puede consumir tus créditos. Configura un límite de gasto en la key de OpenRouter. La interfaz reintenta una vez, tras unos segundos, solo cuando la solicitud de análisis probablemente no llegó al modelo (sin conexión, página de error de la plataforma o límite de solicitudes de OpenRouter); los demás errores quedan como tarjeta y se reintentan con **Reintentar fallidos**, que solo repite los archivos con error (y vuelve a pagar esas llamadas). Se solicita razonamiento mínimo, pero eso no garantiza cero tokens de razonamiento.

### Verificación local sin créditos

```bash
node --test scripts/test-checker.mjs scripts/test-analysis-worker.mjs scripts/test-ui.mjs scripts/test-drive-import.mjs
node scripts/verify-runtime-config.mjs
```

Las pruebas simulan OpenRouter y el navegador; no leen `.dev.vars` ni consumen créditos. No prueban la precisión visual del modelo ni un despliegue real. Para eso, revisa después un creativo pequeño con errores conocidos.

## Importar una carpeta de Drive en local

La importación necesita el Worker porque el navegador no lista ni descarga de forma fiable el contenido de Drive por CORS.

### 1. Preparar Google Cloud

1. Crea o selecciona un proyecto de Google Cloud.
2. Habilita **Google Drive API** para ese proyecto.
3. Crea una API key exclusivamente para este Worker.
4. En las restricciones de API de esa key, permite únicamente **Google Drive API**.

No pongas esta key en `runtime-config.js`, en el HTML ni en el navegador. El Worker la usa del lado del servidor como `GOOGLE_DRIVE_API_KEY`.

### 2. Configurar y ejecutar el Worker localmente

Wrangler está configurado en `wrangler.jsonc`; en este entorno se comprobó que `npx --no-install wrangler --version` está disponible. Crea un archivo no versionado llamado `.dev.vars` junto a `wrangler.jsonc`:

```text
GOOGLE_DRIVE_API_KEY=replace-with-your-restricted-drive-key
```

Luego inicia el Worker:

```bash
npx --no-install wrangler dev
```

Wrangler muestra la URL local al iniciar. En `runtime-config.js`, cambia únicamente `driveImportEndpoint` por esa URL más `/import`; por ejemplo, si Wrangler muestra `http://localhost:8787`, usa:

```js
window.ORTHOGRAPHY_RUNTIME_CONFIG = Object.freeze({
  version: 1,
  driveImportEndpoint: 'http://localhost:8787/import',
});
```

Después abre `index.html` y pega un enlace público de carpeta de Google Drive. Deja el endpoint vacío para desactivar la importación de Drive. No hay un servidor estático configurado en este repositorio; la ruta de uso local anterior abre el HTML directamente.

## Despliegue remoto del Worker en Cloudflare

Esta sección describe la configuración; estos comandos **no se ejecutan automáticamente**. El Worker puede usarse con el plan gratuito de Cloudflare solo mientras la cuenta y el uso cumplan las condiciones vigentes del proveedor; revisa los límites y precios actuales de Cloudflare y Google Cloud antes de publicarlo. Este repositorio configura un Worker, no un proyecto de Cloudflare Pages ni el alojamiento estático del HTML.

1. Autentícate en la cuenta de Cloudflare que administrará el Worker.
2. Carga la key restringida de Drive como secreto del Worker:

```bash
npx --no-install wrangler secret put GOOGLE_DRIVE_API_KEY
```

3. Despliega el Worker definido por `wrangler.jsonc`:

```bash
npx --no-install wrangler deploy
```

4. Copia la URL que Wrangler informe, agrega `/import` y asígnala a `driveImportEndpoint` en `runtime-config.js`.
5. Publica los archivos estáticos mediante el hosting estático que elijas. No incluyas `GOOGLE_DRIVE_API_KEY`, `OPENROUTER_API_KEY`, `ANALYSIS_ACCESS_TOKEN` ni `.dev.vars` en esos archivos.

Para limitar qué sitios pueden llamar al Worker, configura `ALLOWED_ORIGINS` como una lista separada por comas de los orígenes publicados. Con la lista configurada, el Worker rechaza con `403 ORIGIN_NOT_ALLOWED` cualquier solicitud cuyo `Origin` no esté en ella (también las que no envían `Origin`), para que otros sitios o scripts no consuman la cuota de Drive; un cliente que falsifique el encabezado sigue pudiendo llamarlo, así que no es autenticación. Si no se configura, el Worker responde con CORS abierto (`*`) y acepta cualquier origen. Configura el endpoint final antes de publicar el HTML; una URL vacía deshabilita el botón de importación.

## Límites de importación

El endpoint acepta únicamente enlaces HTTPS con la forma `drive.google.com/drive/folders/<id>` (también acepta la variante `/drive/u/<número>/folders/<id>`). La carpeta debe ser pública por enlace y se procesa solo su contenido inmediato.

| Límite | Valor |
| --- | --- |
| Solicitud al Worker | 4 KiB |
| Archivos HTML listados | Todos los de la carpeta pública inmediata (paginado) |
| Tamaño de cada HTML | 25 MiB (acción `file`); 5 MiB en la acción heredada `download` |
| Descargas por respuesta del Worker | 1 con `file` (3 con la acción heredada `download`) |

Solo se importan archivos cuyo nombre termine en `.html` o `.htm`. El contrato de `POST /import` usa `{ "action": "list", "folderUrl": "..." }` para devolver metadatos seguros y `{ "action": "file", "folderUrl": "...", "fileId": "..." }` para devolver un único HTML como `text/html`, transmitido sin decodificar para minimizar el uso de CPU del Worker. La acción heredada `{ "action": "download", "folderUrl": "...", "fileIds": ["..."] }` (hasta tres IDs, respuesta JSON) se mantiene por compatibilidad durante el despliegue. Con la página abierta, copia el enlace de la carpeta y pulsa **Ctrl+V** en cualquier parte (o pégalo en el campo): la interfaz lista la carpeta, descarga automáticamente cada HTML de hasta 25 MiB por separado (hasta dos a la vez) y los revisa en orden a medida que llegan. Solo se lee el contenido inmediato de la carpeta, no las subcarpetas. Cada HTML de la carpeta tiene su tarjeta: los que superan 25 MiB aparecen como error con su tamaño para revisarlos a mano. Las fallas transitorias (red, tiempo de espera, límite de Drive) se reintentan hasta dos veces con esperas crecientes; si siguen fallando quedan como tarjeta de error sin detener el resto y **Reintentar fallidos** las vuelve a descargar. Un `403` de Drive por límite o cuota (`rateLimitExceeded`, `downloadQuotaExceeded`) se informa como tal y no como acceso denegado. Cada descarga comprueba que el archivo pertenezca a la carpeta reutilizando durante 60 segundos el listado que hizo la importación (un ID que no aparece en él se verifica con un listado nuevo), así una carpeta de 40 HTML hace un listado en vez de 41. **Vaciar** cancela una importación en curso. Así el Worker nunca devuelve el pack completo ni actúa como descargador arbitrario de Drive. No hay límite agregado para el pack: el guard es de 25 MiB por HTML. El Worker no devuelve la key de Drive y la interfaz evita duplicados por nombre y contenido.

## Límites de la revisión

- La herramienta revisa el texto extraíble del HTML, incluso contenido escapado o `srcdoc` anidado, junto con todas las imágenes y videos embebidos como `data:` base64 en ese mismo archivo, incluidos los que los juegos de Cocos Creator guardan dentro de un ZIP embebido (`window.__zip`), cuyos data URI ofuscados se reparan y se validan por su firma antes de enviarse. Si son más de 10 imágenes, 2 videos o 6 MiB, la revisión se reparte en varias solicitudes (tandas) y los resultados se combinan; el máximo por archivo es 60 imágenes y 8 videos, y lo que quede fuera se informa como revisión parcial. No descarga medios desde URLs externas. También acepta PNG, JPG/JPEG y WebP independientes de hasta 5 MiB. El servidor valida formato, firmas y límites; admite hasta 60.000 caracteres de texto por solicitud y la interfaz divide textos más largos.
- El modelo clasifica cada hallazgo como **error** o **sugerencia**; las sugerencias no cuentan como errores. El análisis visual muestra el texto leído y advierte si hay texto ilegible, sin presentar una lectura incompleta como revisión limpia. Las respuestas inválidas, truncadas o rechazadas se muestran como errores del servicio.
- El modelo puede equivocarse. Cada resultado es un candidato para revisión humana; nombres de marca y palabras inventadas pueden ser falsos positivos. Imágenes borrosas o con texto pequeño requieren revisión manual.
- La carpeta de Drive debe ser pública y accesible por la API de Drive con la key configurada. Los errores de acceso, listado o descarga se muestran como errores de importación, traducidos al español cuando el Worker devuelve un código reconocido.
- El Worker está desplegado y su endpoint está configurado en `runtime-config.js`, pero no se verificó el flujo contra una carpeta pública real ni se ejecutó una prueba en navegador. La comprobación disponible cubrió la configuración y rutas simuladas, no una importación real desde Drive.

## Comprobación antes de publicar

- Confirma que `runtime-config.js` contiene únicamente configuración pública y endpoints, nunca secretos.
- Confirma que la key de Drive está restringida a Google Drive API y cargada como secreto de Cloudflare.
- Confirma que la API key de OpenRouter está en el Worker de análisis y que la clave de acceso es distinta; limita el gasto de la key antes de compartir acceso.
- Prueba una carpeta pública pequeña con archivos HTML antes de compartir el enlace de la herramienta.
