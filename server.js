/*
 * GSHC Registry — Local Server
 * Serves the offline app on http://localhost:PORT.
 * This is ONLY a local host for the front-end. All data lives in the
 * browser's IndexedDB on the same machine. No remote server, no MySQL.
 */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3100; // distinct from HotelDesk (3000)

// Serve the app — no-store so the browser never caches JS/CSS; updates always load fresh
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// Single-page fallback so deep links still load index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('====================================================');
  console.log('  Gombe State High Court — Registry Forms System');
  console.log('  Directorate of ICT');
  console.log('----------------------------------------------------');
  console.log(`  Running at:  http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('====================================================');
});
