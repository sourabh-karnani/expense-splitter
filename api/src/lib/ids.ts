import { z } from 'zod';
import { HttpError } from './httpError.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;

export const objectId = z.string().regex(OBJECT_ID, 'Invalid id');

// A malformed id is treated as "not found" instead of letting Mongoose throw a CastError (500).
export function parseIdOr404(raw: string, what = 'Resource'): string {
  if (!OBJECT_ID.test(raw)) throw new HttpError(404, `${what} not found`);
  return raw;
}
