import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // select: false keeps the hash out of every query unless explicitly requested.
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

export const UserModel = model('User', userSchema);

// Explicit output shape: only these fields ever leave the API.
export function toUserDTO(user: { _id: unknown; email: string; name: string }) {
  return { id: String(user._id), email: user.email, name: user.name };
}
