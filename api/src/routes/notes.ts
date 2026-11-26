import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { NoteModel, toNoteDTO } from '../models/Note.js';
import { currentUserId, requireAuth } from '../middleware/auth.js';
import { HttpError } from '../lib/httpError.js';
import { objectId, parseIdOr404 } from '../lib/ids.js';

// Example resource. Copy this pattern for new resources.
export const notesRouter = Router();
notesRouter.use(requireAuth);

// strictObject rejects unknown fields, so a client can't set ownerId or other internal fields (mass assignment).
const createSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(5000).optional(),
});
const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const listQuerySchema = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

notesRouter.get('/', async (req, res) => {
  const { cursor, limit } = listQuerySchema.parse(req.query);
  const filter = {
    ownerId: currentUserId(req),
    ...(cursor ? { _id: mongoose.trusted({ $lt: cursor }) } : {}),
  };
  // Fetch one extra row to know whether there is another page.
  const rows = await NoteModel.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  res.json({
    items: page.map(toNoteDTO),
    nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
  });
});

notesRouter.post('/', async (req, res) => {
  const data = createSchema.parse(req.body);
  const note = await NoteModel.create({ ...data, ownerId: currentUserId(req) });
  res.status(201).json({ note: toNoteDTO(note) });
});

// Every lookup is scoped by ownerId, so nobody can read or change another user's note (OWASP API1: BOLA).
// Someone else's note returns 404, not 403, so ids of other users' data aren't confirmed.
notesRouter.get('/:id', async (req, res) => {
  const id = parseIdOr404(req.params.id, 'Note');
  const note = await NoteModel.findOne({ _id: id, ownerId: currentUserId(req) }).lean();
  if (!note) throw new HttpError(404, 'Note not found');
  res.json({ note: toNoteDTO(note) });
});

notesRouter.patch('/:id', async (req, res) => {
  const id = parseIdOr404(req.params.id, 'Note');
  const changes = updateSchema.parse(req.body);
  const note = await NoteModel.findOneAndUpdate(
    { _id: id, ownerId: currentUserId(req) },
    { $set: changes },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!note) throw new HttpError(404, 'Note not found');
  res.json({ note: toNoteDTO(note) });
});

notesRouter.delete('/:id', async (req, res) => {
  const id = parseIdOr404(req.params.id, 'Note');
  const { deletedCount } = await NoteModel.deleteOne({ _id: id, ownerId: currentUserId(req) });
  if (deletedCount === 0) throw new HttpError(404, 'Note not found');
  res.status(204).end();
});
