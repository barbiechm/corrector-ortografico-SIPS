# Drive pack import

## Objective
Let a user paste a public Google Drive folder link, select the HTML SIPs in that pack, and run the existing spelling check with their own Gemini API key.

## Problem
The current static application accepts only manually uploaded HTML files. Packs already live in individually shared public Drive folders, so manual selection is repetitive and error-prone.

## Why
Importing a complete pack from its source folder makes the tool shareable and reduces setup work. A server-side adapter is needed because browser access to Drive listings/downloads is not reliable due to CORS.

## Authorized scope
- Add a Cloudflare Worker endpoint that accepts and validates public Google Drive folder links, lists supported HTML files, and returns their contents safely.
- Update the static UI to import a pack from that endpoint and preserve the existing local upload flow.
- Add deployment and operational documentation, including how to use a personal Gemini API key.
- Do not persist, log, or centralize Gemini API keys.
- Do not deploy remotely without separate explicit user authorization.

## Constraints
- Input folders are public-by-link and contain one SIP pack.
- Gemini model default is `gemini-3.5-flash-lite`.
- Each user normally supplies and pays for their own Gemini API key; the creator may share theirs temporarily at their discretion.
- Google Drive API key must be server-side only and restricted.
- No database is required.
- TDD status: unavailable; this is a static HTML project with no existing test runner. Use focused functional checks instead.

## Delivery
- Strategy: feature-branch-chain.
- First planned review slice: DRI-01 `a519abe` and DRI-02 `a07176f`.
- DRI-03 is the documentation/configuration review slice.
- Git status: repository initialized; DRI-01 is committed as `a519abe` on `feat/drive-pack-import`.

## Tasks

- [x] DRI-01 Create the Cloudflare Worker import endpoint.
  - Acceptance: accepts only valid public Drive folder links; lists and fetches only `.html`/`.htm`; validates limits and returns actionable errors; never returns the Drive API key.
  - Checks: worker unit/integration checks where configured; manual request against a public fixture folder; unsafe URL rejection.

- [x] DRI-02 Add Drive folder import to the UI.
  - Acceptance: users can paste a folder link, preview/import supported files, choose files, and run the existing spelling flow; Gemini key is not remembered by default; default model is Flash-Lite.
  - Checks: browser smoke test for upload and Drive paths; validation/error-state checks; syntax check.

- [x] DRI-03 Document local configuration and free deployment.
  - Acceptance: README explains Cloudflare setup, Drive API restriction, no-key-persistence behavior, deployment steps, and usage/limits.
  - Checks: documentation readback and configuration review.

## Progress and evidence
- 2026-09-18: Feature tracked before source edits. Existing code is a standalone HTML page with browser-side Gemini calls and heuristic copy extraction.
- 2026-09-18: DRI-01 implemented in `src/worker.mjs` with the `wrangler.jsonc` Worker configuration. The endpoint accepts only HTTPS `drive.google.com/drive[/u/{number}]/folders/{id}` links, uses the server-side `GOOGLE_DRIVE_API_KEY`, limits folder entries (100), HTML files (25), each file (1 MiB), and total imported content (10 MiB), and returns structured errors with CORS headers. It does not modify the browser UI.
- 2026-09-18: Observed checks: `node --check "src/worker.mjs"` exited successfully; `npx --no-install wrangler deploy --dry-run` validated the Worker configuration and produced an 8.82 KiB upload dry-run; a local mocked-fetch harness passed both unsafe non-Drive URL rejection (without any upstream request) and valid Drive listing/media import. No public Drive fixture or configured `GOOGLE_DRIVE_API_KEY` was available, so live Drive verification was not run.
- 2026-09-18: DRI-02 added a versioned, public `runtime-config.js` with an empty Drive endpoint by default; the UI imports and selects returned HTML without rendering it, reports loading/success/error states, deduplicates matching name/content entries, and keeps manual picker/drag-and-drop input. Gemini keys are not stored in localStorage and `gemini-3.5-flash-lite` is the default. Observed checks: a Node DOM/mock-fetch harness compiled the inline UI script and passed manual picker upload, mocked `POST` import response, selected-file addition, duplicate prevention, inert imported HTML, and structured error feedback; `git diff --check` and `node --check "src/worker.mjs"` exited successfully. No browser executable, configured endpoint, Drive credential, or public fixture was available, so browser and live Drive checks were not run.
- 2026-09-18: DRI-03 added `README.md` for local use and Cloudflare Worker deployment configuration. Documentation review was checked against `src/worker.mjs`, `wrangler.jsonc`, and `runtime-config.js`: it records the required server-side `GOOGLE_DRIVE_API_KEY`, Drive API restriction, `/import` endpoint configuration, CORS behavior, import limits, no Gemini-key persistence, and the known absence of live Drive, deployed-endpoint, and browser verification. `git diff --check` was run after the documentation change.
- 2026-09-18: The Worker was deployed through Cloudflare and the public `/import` endpoint was configured in `runtime-config.js`. A browser `GET` returned the expected `METHOD_NOT_ALLOWED` response, confirming the route is live; a real `POST` import using a public Drive folder and browser UI is still pending.
