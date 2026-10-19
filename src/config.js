/*
 * src/config.js — all runtime settings come from environment variables.
 * On Render these are set in the service's Environment tab; locally they
 * can live in a .env file (never committed, see .env.example).
 */
require('dotenv').config({ quiet: true });

const env = process.env.NODE_ENV || 'development';

// Dates on documents and emails are written in the court's time zone,
// whatever zone the hosting server runs in.
process.env.TZ = (process.env.APP_TIMEZONE || 'Africa/Lagos').trim();
const isProd = env === 'production';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

// The database name is the part of the connection string between the host
// and the "?". Without one, MongoDB silently uses a database called "test",
// so production refuses to start rather than share or guess a database.
function databaseName(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri || '');
  return m && m[1] ? decodeURIComponent(m[1]) : '';
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
  // Spaces around a value pasted into a hosting dashboard are removed.
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
  adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),

  // Recovery: with ADMIN_RESET=true, the next start resets the admin
  // account's password to ADMIN_PASSWORD and unlocks it (see seed.js).
  adminReset: /^(1|true|yes)$/i.test((process.env.ADMIN_RESET || '').trim()),

  // Email through Brevo's transactional API. MAIL_FROM must be a sender
  // address verified in Brevo. Without BREVO_API_KEY, invitations and reset
  // links are not offered and admins hand out one time passwords instead.
  brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),
  mailFrom: (process.env.MAIL_FROM || '').trim(),
  mailFromName: (process.env.MAIL_FROM_NAME || 'GSHC Registry').trim(),
  // 'memory' keeps messages in a list (tests); 'console' prints them (local development).
  mailTransport: (process.env.MAIL_TRANSPORT || (env === 'test' ? 'memory' : '')).trim(),
  inviteHours: 24,
  resetMinutes: 60,

  // Daily backup (src/services/backup.js). Stored privately on Cloudinary
  // when CLOUDINARY_URL is set; otherwise in BACKUP_DIR on this computer
  // (local development only, since a Render disk is wiped on every deploy).
  backupDir: (process.env.BACKUP_DIR || (isProd ? '' : 'backups')).trim(),
  backupKeepDays: parseInt(process.env.BACKUP_KEEP_DAYS, 10) || 30,
  backupEnabled: !/^(0|false|no|off)$/i.test((process.env.BACKUP_ENABLED || '').trim()),

  loginMaxAttempts: 5,
  loginLockMinutes: 15,
  pinMaxAttempts: 5,
  pinLockMinutes: 15
};

config.databaseName = databaseName(config.mongoUri);
if (isProd && !config.databaseName) {
  throw new Error('MONGODB_URI does not name a database. Add it after the host, for example ' +
    'mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/GSHC_DB?retryWrites=true&w=majority');
}

module.exports = config;
module.exports.databaseName = databaseName;
