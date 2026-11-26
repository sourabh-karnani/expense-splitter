import { createApp } from './app.js';
import { connectDb } from './db.js';
import { env } from './env.js';

await connectDb(env.MONGO_URL);

createApp().listen(env.PORT, (err) => {
  if (err) throw err;
  console.log(`API listening on http://localhost:${env.PORT}`);
});
