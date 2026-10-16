/*
 * src/config.js — all runtime settings come from environment variables.
 * On Render these are set in the service's Environment tab; locally they
 * can live in a .env file (never committed, see .env.example).
 */
require('dotenv').config({ quiet: true });

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

const config = {
  env,
  isProd,
  port: parseInt(process.env.PORT, 10) || 3100,
  mongoUri: process.env.MONGODB_URI || (isProd ? required('MONGODB_URI') : 'mongodb://127.0.0.1:27017/gshc_registry'),
  sessionSecret: process.env.SESSION_SECRET || (isProd ? required('SESSION_SECRET') : 'dev-only-insecure-secret'),
  sessionIdleMinutes: parseInt(process.env.SESSION_IDLE_MINUTES, 10) || 60,

  // Base address printed in QR codes. Leave unset to use the address the app
  // is being served from (the Render address in testing, the court's own
  // domain later). Set it to pin QR links to one domain.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  // Cloudinary is used when CLOUDINARY_URL is set. Without it (local
  // development and tests) signature images are kept in MongoDB instead.
  cloudinaryUrl: process.env.CLOUDINARY_URL || '',
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'gshc-registry',

  // First run admin account. If ADMIN_PASSWORD is not set a random one is
  // generated and printed once to the server log.
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  loginMaxAttempts: 5,
  loginLockMinutes: 15,
  pinMaxAttempts: 5,
  pinLockMinutes: 15
};

module.exports = config;
