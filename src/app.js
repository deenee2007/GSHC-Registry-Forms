/*
 * src/app.js — builds the Express application (no listening here, so the
 * tests can drive it directly).
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const mongoose = require('mongoose');
const config = require('./config');
const { loadUser, requireAppHeader, HttpError } = require('./middleware/auth');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render terminates HTTPS in front of the app
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  app.get('/healthz', (req, res) => res.json({ ok: mongoose.connection.readyState === 1 }));

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use(session({
    name: 'gshc.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({ client: mongoose.connection.getClient(), collectionName: 'sessions', ttl: config.sessionIdleMinutes * 60 }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: config.sessionIdleMinutes * 60000 }
  }));
  api.use(requireAppHeader);
  api.use(loadUser);

  api.use('/auth', require('./routes/auth'));
  api.use('/me', require('./routes/me'));
  api.use('/admin', require('./routes/admin'));
  api.use('/catalogue', require('./routes/catalogue'));
  api.use('/records', require('./routes/records'));
  api.use('/notifications', require('./routes/notifications'));
  api.use('/reports', require('./routes/reports'));
  api.use('/cases', require('./routes/cases'));
  api.use('/hearings', require('./routes/hearings'));
  api.use((req, res, next) => next(new HttpError(404, 'Not found.')));

  // Public verification needs no session.
  app.use('/api/verify', require('./routes/verify'));
  app.use('/api', api);

  // Front end. no-store so updates always load fresh.
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
  app.get(['/verify', '/verify/:code'], (req, res) => res.sendFile(path.join(pub, 'verify.html')));
  app.get('/guide', (req, res) => res.sendFile(path.join(pub, 'guide.html')));
  app.get('*', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // Errors: known ones get their message; anything else is logged and hidden.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.name === 'MulterError') { status = 400; message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Upload rejected.'; }
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed request.'; }
    if (status >= 500) {
      console.error(err);
      // Unexpected errors stay vague; an error meant for the user (expose) keeps its words.
      if (!err.expose) message = 'Something went wrong on the server. Please try again.';
    }
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
