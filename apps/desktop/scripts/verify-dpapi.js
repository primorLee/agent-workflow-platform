const { app, safeStorage } = require('electron')

app.whenReady().then(() => {
  const results = {
    platform: process.platform,
    electronVersion: process.versions.electron,
    isEncryptionAvailable: safeStorage.isEncryptionAvailable(),
    backend: null,
    roundtrip: null,
    error: null,
  }
  try {
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      results.backend = safeStorage.getSelectedStorageBackend()
    }
    if (results.isEncryptionAvailable) {
      const secret = 'awp-dpapi-smoke-' + Date.now()
      const enc = safeStorage.encryptString(secret)
      const dec = safeStorage.decryptString(enc)
      results.roundtrip = {
        inputLen: secret.length,
        ciphertextLen: enc.length,
        match: dec === secret,
      }
    }
  } catch (e) {
    results.error = String(e && e.message || e)
  }
  console.log('DPAPI_SMOKE_RESULT=' + JSON.stringify(results))
  app.exit(results.isEncryptionAvailable && results.roundtrip && results.roundtrip.match ? 0 : 1)
})
