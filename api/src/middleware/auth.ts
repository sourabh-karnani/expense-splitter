import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env, isProd } from '../env.js';
import { HttpError } from '../lib/httpError.js';

export const SESSION_COOKIE = 'splitter_session';
const SESSION_MS = 60 * 60 * 1000; // 1 hour

// The JWT lives in an httpOnly cookie, so page JavaScript (and any XSS) can't read it.
export function setSessionCookie(res: Response, userId: string) {
  const token = jwt.sign({}, env.JWT_SECRET, { algorithm: 'HS256', subject: userId, expiresIn: '1h' });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax', // not sent on cross-site POSTs, which blocks CSRF
    secure: isProd, // HTTPS-only in production
    maxAge: SESSION_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string') throw new HttpError(401, 'Not authenticated');
  try {
    // Pin the algorithm so tokens signed with "none" or another algorithm are rejected.
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) throw new Error('Malformed token');
    req.userId = payload.sub;
  } catch {
    throw new HttpError(401, 'Session expired or invalid');
  }
  next();
};

export function currentUserId(req: Request): string {
  if (!req.userId) throw new HttpError(401, 'Not authenticated');
  return req.userId;
}
