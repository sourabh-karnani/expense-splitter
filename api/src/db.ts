import mongoose from 'mongoose';

// Neutralise query operators that arrive in user input: { "$ne": null } is wrapped in $eq,
// so it can't match every document. Operators written in our own code use mongoose.trusted().
mongoose.set('sanitizeFilter', true);
mongoose.set('strictQuery', true);

export async function connectDb(url: string) {
  await mongoose.connect(url);
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
