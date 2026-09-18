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

- [x] DRI-04 Harden Drive API import diagnostics and shared-drive support.
  - Acceptance: the Worker follows the public-folder Drive API contract for shared drives, preserves key secrecy, and reports upstream failures accurately enough to resolve integration problems.
  - Checks: focused mocked Drive tests plus a real public-folder smoke test after deployment.

- [x] DRI-05 Support multi-file HTML SIP packs without aggregate-size rejection.
  - Acceptance: an HTML up to 5 MiB is accepted; the app lists a public folder before downloading content and processes selected files in bounded batches rather than buffering an entire pack in the Worker.
  - Checks: focused list/download boundary tests, batch-flow regressions, and existing import tests.

- [x] DRI-06 Paginate Drive folder listings without an application-defined SIP count cap.
  - Acceptance: the Worker lists all HTML entries across Drive API pages while downloads remain bounded and membership-validated.
  - Checks: mocked multi-page listing tests and existing import regressions.

## Progress and evidence
- 2026-09-18: Feature tracked before source edits. Existing code is a standalone HTML page with browser-side Gemini calls and heuristic copy extraction.
- 2026-09-18: DRI-01 implemented in `src/worker.mjs` with the `wrangler.jsonc` Worker configuration. The endpoint accepts only HTTPS `drive.google.com/drive[/u/{number}]/folders/{id}` links, uses the server-side `GOOGLE_DRIVE_API_KEY`, limits folder entries (100), HTML files (25), each file (1 MiB), and total imported content (10 MiB), and returns structured errors with CORS headers. It does not modify the browser UI.
- 2026-09-18: Observed checks: `node --check "src/worker.mjs"` exited successfully; `npx --no-install wrangler deploy --dry-run` validated the Worker configuration and produced an 8.82 KiB upload dry-run; a local mocked-fetch harness passed both unsafe non-Drive URL rejection (without any upstream request) and valid Drive listing/media import. No public Drive fixture or configured `GOOGLE_DRIVE_API_KEY` was available, so live Drive verification was not run.
- 2026-09-18: DRI-02 added a versioned, public `runtime-config.js` with an empty Drive endpoint by default; the UI imports and selects returned HTML without rendering it, reports loading/success/error states, deduplicates matching name/content entries, and keeps manual picker/drag-and-drop input. Gemini keys are not stored in localStorage and `gemini-3.5-flash-lite` is the default. Observed checks: a Node DOM/mock-fetch harness compiled the inline UI script and passed manual picker upload, mocked `POST` import response, selected-file addition, duplicate prevention, inert imported HTML, and structured error feedback; `git diff --check` and `node --check "src/worker.mjs"` exited successfully. No browser executable, configured endpoint, Drive credential, or public fixture was available, so browser and live Drive checks were not run.
- 2026-09-18: DRI-03 added `README.md` for local use and Cloudflare Worker deployment configuration. Documentation review was checked against `src/worker.mjs`, `wrangler.jsonc`, and `runtime-config.js`: it records the required server-side `GOOGLE_DRIVE_API_KEY`, Drive API restriction, `/import` endpoint configuration, CORS behavior, import limits, no Gemini-key persistence, and the known absence of live Drive, deployed-endpoint, and browser verification. `git diff --check` was run after the documentation change.
- 2026-09-18: The Worker was deployed through Cloudflare and the public `/import` endpoint was configured in `runtime-config.js`. A browser `GET` returned the expected `METHOD_NOT_ALLOWED` response, confirming the route is live; a real `POST` import using a public Drive folder and browser UI is still pending.
- 2026-09-18: The published app could retain the prior empty `runtime-config.js` in the browser cache because the static configuration file had no cache policy. Added the Cloudflare Pages `_headers` rule `Cache-Control: no-store` for that file and `scripts/verify-runtime-config.mjs`, which serves `index.html` locally, follows its runtime-config script reference, evaluates the config, and verifies the HTTPS `/import` endpoint. Observed checks: `node scripts/verify-runtime-config.mjs`, `node --check "src/worker.mjs"`, `node --check "scripts/verify-runtime-config.mjs"`, and `git diff --check` exited successfully.
- 2026-09-18: DRI-04 added shared-drive listing flags (`supportsAllDrives=true` and `includeItemsFromAllDrives=true`) while retaining the fixed Google API origin, validated folder IDs, and manual redirect handling. Outbound failures now return safe, stable codes for redirects, network failures, access/not-found responses, rate limits, upstream failures, and other HTTP failures without returning the API key or third-party response bodies. Observed checks: `node scripts/test-drive-import.mjs` passed 3 mocked cases (public-folder parameters/key secrecy, HTTP failure, redirect/network failure); `node --check "src/worker.mjs"`, `node --check "scripts/test-drive-import.mjs"`, `node --check "scripts/verify-runtime-config.mjs"`, and `git diff --check` exited successfully. Live public-folder verification remains deferred until an explicitly authorized post-deployment smoke test.
- 2026-09-18: DRI-05 replaced the aggregate import response with two explicit actions: `list` returns safe HTML metadata only, then `download` re-lists the requested public folder and accepts only 1–3 currently listed file IDs. The Worker preserves the fixed Google API origin, shared-drive flags, safe upstream classifications, and secret handling. It permits HTML files up to 5 MiB each, with no aggregate pack limit. The UI lists first and downloads selected files serially in batches of two. Observed checks: `node --test scripts/test-drive-import.mjs` passed 7 mocked cases (list, authorized single/batch selection, membership rejection, exact 5 MiB boundary, aggregate behavior, safe failures); `node scripts/verify-runtime-config.mjs`; `node --check src/worker.mjs`; `node --check scripts/test-drive-import.mjs`; `node --check scripts/verify-runtime-config.mjs`; and `git diff --check` all exited successfully. No real Drive folder, deployment, push, or Cloudflare configuration operation was performed.
- 2026-09-18: DRI-06 replaced the single-page listing rejection with `nextPageToken` traversal across all immediate folder-list pages. Listing and re-list membership validation now include HTML files from every page; content remains unbuffered during listing and each download request remains bounded to 1–3 selected files at 5 MiB each. Observed checks: `node --test scripts/test-drive-import.mjs` covers multi-page listing without content downloads and selection from a later re-listed page, alongside the existing import regressions. No real Drive data, deployment, push, or Cloudflare configuration operation was performed.
