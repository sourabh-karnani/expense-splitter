import { Schema, model } from 'mongoose';

const noteSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, default: '', maxlength: 5000 },
  },
  { timestamps: true },
);

// Serves "my notes, newest first" and cursor pagination on _id.
noteSchema.index({ ownerId: 1, _id: -1 });

export const NoteModel = model('Note', noteSchema);

type NoteLike = { _id: unknown; title: string; body?: string | null; createdAt?: Date; updatedAt?: Date };

// Explicit output shape: only these fields ever leave the API.
export function toNoteDTO(note: NoteLike) {
  return {
    id: String(note._id),
    title: note.title,
    body: note.body ?? '',
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
