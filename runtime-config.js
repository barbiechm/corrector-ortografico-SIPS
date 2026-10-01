// Versioned public runtime settings. Leave the endpoint empty to disable Drive imports.
window.ORTHOGRAPHY_RUNTIME_CONFIG = Object.freeze({
  version: 1,
  driveImportEndpoint: 'https://corrector-ortografico-drive-import.barbara-asucar.workers.dev/import',
  // Set the deployed analysis Worker's /analyze URL to enable paid analysis.
  analysisEndpoint: 'https://corrector-ortografico-analysis.barbara-asucar.workers.dev/analyze',
});
