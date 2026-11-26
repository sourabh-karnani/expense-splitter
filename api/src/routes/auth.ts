import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import argon2 from 'argon2';
import { z } from 'zod';
import { UserModel, toUserDTO } from '../models/User.js';
import { HttpError } from '../lib/httpError.js';
import { clearSessionCookie, currentUserId, requireAuth, setSessionCookie } from '../middleware/auth.js';

export const authRouter = Router();

// Stricter limit on credential endpoints to slow down brute-force attempts.
const credentialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });

const registerSchema = z.strictObject({
  email: z.email().toLowerCase(),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(128),
});

const loginSchema = z.strictObject({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(128),
});

// Verified against when the email doesn't exist, so a failed login takes the same time either way.
const dummyHash = argon2.hash('dummy-password-for-constant-timing');

authRouter.post('/register', credentialLimiter, async (req, res) => {
  const { email, name, password } = registerSchema.parse(req.body);
  const passwordHash = await argon2.hash(password); // argon2id by default
  try {
    const user = await UserModel.create({ email, name, passwordHash });
    setSessionCookie(res, user.id);
    res.status(201).json({ user: toUserDTO(user) });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new HttpError(409, 'Email is already registered');
    throw err;
  }
});

authRouter.post('/login', credentialLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await UserModel.findOne({ email }).select('+passwordHash');
  const ok = await argon2.verify(user?.passwordHash ?? (await dummyHash), password);
  // Same message for unknown email and wrong password, so accounts can't be enumerated here.
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  setSessionCookie(res, user.id);
  res.json({ user: toUserDTO(user) });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await UserModel.findById(currentUserId(req));
  if (!user) throw new HttpError(401, 'Not authenticated');
  res.json({ user: toUserDTO(user) });
});
