/*
 * GSHC Registry — server entry point.
 * Connects to MongoDB, runs first run setup, then serves the app and API.
 */
const mongoose = require('mongoose');
const config = require('./src/config');
const { createApp } = require('./src/app');
const { seedAll, report } = require('./src/services/seed');

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 });
  await seedAll();
  await report();
  require('./src/services/backup').start();
  require('./src/services/hearings').start();
  const app = createApp();
  app.listen(config.port, () => {
    console.log('====================================================');
    console.log('  Gombe State High Court — Registry Forms System');
    console.log('  Directorate of ICT');
    console.log('----------------------------------------------------');
    console.log(`  Running on port ${config.port} (${config.env})`);
    console.log('====================================================');
  });
}

main().catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
