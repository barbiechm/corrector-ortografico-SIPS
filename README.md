# Corrector ortográfico de SIPs

Revisa el texto extraído de archivos HTML con Gemini y, si se configura un Worker, importa los HTML de una carpeta pública de Google Drive. La ruta rápida es usar el selector local de archivos y una clave propia de Gemini: no requiere desplegar nada.

## Ruta rápida: uso local sin importar desde Drive

1. Abre `index.html` en un navegador.
2. Pega tu clave de Gemini y deja seleccionado `gemini-3.5-flash-lite` o elige otro modelo.
3. Arrastra o selecciona los archivos `.html` o `.htm` del SIP: se revisan automáticamente en cuanto se cargan. **Volver a revisar todo** repite la revisión.

La clave de Gemini se usa desde el navegador para llamar a Gemini. La aplicación la guarda en el `localStorage` de ese navegador para no pedirla en cada recarga; **Olvidar key** la borra. No la envía al Worker y no debe incluirse en archivos del repositorio. En equipos compartidos, bórrala al terminar: cualquier script que corra en el mismo origen puede leer `localStorage`.

Cada persona debe usar y pagar su propia clave de Gemini. La persona propietaria puede compartir la suya de forma temporal, bajo su propia decisión y responsabilidad; no es un mecanismo de cuentas, cuotas ni facturación compartidas.

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
5. Publica el HTML estático y `runtime-config.js` mediante el hosting estático que elijas. No incluyas `GOOGLE_DRIVE_API_KEY`, `.dev.vars` ni una clave de Gemini en esos archivos.

Para limitar qué sitios pueden llamar al Worker, configura `ALLOWED_ORIGINS` como una lista separada por comas de los orígenes publicados. Si no se configura, el Worker responde con CORS abierto (`*`), según la implementación actual. Configura el endpoint final antes de publicar el HTML; una URL vacía deshabilita el botón de importación.

## Límites de importación

El endpoint acepta únicamente enlaces HTTPS con la forma `drive.google.com/drive/folders/<id>` (también acepta la variante `/drive/u/<número>/folders/<id>`). La carpeta debe ser pública por enlace y se procesa solo su contenido inmediato.

| Límite | Valor |
| --- | --- |
| Solicitud al Worker | 4 KiB |
| Archivos HTML listados | Todos los de la carpeta pública inmediata (paginado) |
| Tamaño de cada HTML | 5 MiB |
| Descargas por respuesta del Worker | 3 |

Solo se importan archivos cuyo nombre termine en `.html` o `.htm`. El contrato de `POST /import` usa `{ "action": "list", "folderUrl": "..." }` para devolver metadatos seguros y `{ "action": "download", "folderUrl": "...", "fileIds": ["..."] }` para una selección de hasta tres IDs. Al pegar el enlace, la interfaz lista la carpeta, descarga automáticamente todos los HTML de hasta 5 MiB de a dos y los revisa a medida que llegan; cada solicitud de descarga vuelve a listar la carpeta y rechaza IDs que ya no pertenezcan a ella. Así el Worker nunca devuelve el pack completo ni actúa como descargador arbitrario de Drive. No hay límite agregado para el pack: el guard es de 5 MiB por HTML. El Worker no devuelve la key de Drive y la interfaz evita duplicados por nombre y contenido.

## Límites de la revisión

- La herramienta revisa texto extraíble del HTML, incluso contenido escapado o `srcdoc` anidado. Si un HTML no tiene texto extraíble, revisa como respaldo las imágenes y el video embebidos como `data:` base64 en ese mismo archivo (hasta 6 imágenes y 1 video, con un presupuesto total de ~14 MiB); no descarga imágenes ni video desde URLs externas. Ese análisis visual consume más tokens de Gemini (aprox. 560 por imagen y 70 por fotograma de video).
- Gemini clasifica cada hallazgo como **error** (ortografía, acentuación o gramática claramente incorrecta) o como **sugerencia** (mejoras opcionales de gramática, puntuación o claridad); las sugerencias se muestran aparte y no cuentan como errores.
- Gemini puede equivocarse. Cada resultado es un candidato para revisión humana; nombres de marca y palabras inventadas pueden ser falsos positivos.
- La carpeta de Drive debe ser pública y accesible por la API de Drive con la key configurada. Los errores de acceso, listado o descarga se muestran como errores de importación, traducidos al español cuando el Worker devuelve un código reconocido.
- El Worker está desplegado y su endpoint está configurado en `runtime-config.js`, pero no se verificó el flujo contra una carpeta pública real ni se ejecutó una prueba en navegador. La comprobación disponible cubrió la configuración y rutas simuladas, no una importación real desde Drive.

## Comprobación antes de publicar

- Confirma que `runtime-config.js` contiene solo la URL pública de `/import`, nunca secretos.
- Confirma que la key de Drive está restringida a Google Drive API y cargada como secreto de Cloudflare.
- Confirma que cada persona proporciona su propia key de Gemini; se guarda solo en su navegador y se borra con **Olvidar key**.
- Prueba una carpeta pública pequeña con archivos HTML antes de compartir el enlace de la herramienta.
