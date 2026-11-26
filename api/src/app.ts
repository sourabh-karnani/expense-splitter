import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { env } from './env.js';
import { authRouter } from './routes/auth.js';
import { notesRouter } from './routes/notes.js';
import { errorHandler, notFound } from './middleware/errors.js';

export function createApp() {
  const app = express();

  app.use(helmet()); // security headers (CSP, HSTS, no X-Powered-By, ...)
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true })); // explicit allowlist, never "*" with cookies
  app.use(express.json({ limit: '100kb' })); // cap request body size
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300 })); // per-IP limit on every API route

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: mongoose.connection.readyState === 1 });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/notes', notesRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
