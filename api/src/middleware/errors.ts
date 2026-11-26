import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError.js';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { message: 'Not found' } });
};

// The one place errors become responses. Clients never see stack traces or internal messages.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: 'Invalid input',
        issues: err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { message: err.message } });
    return;
  }
  // Errors from express.json(): malformed JSON (400) or body too large (413).
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: { message: status === 413 ? 'Request body too large' : 'Malformed request' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { message: 'Internal server error' } });
};
