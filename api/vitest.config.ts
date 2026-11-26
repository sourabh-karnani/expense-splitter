import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests always use a separate database, never the dev one.
    env: { NODE_ENV: 'test', MONGO_URL: 'mongodb://127.0.0.1:27017/expense_splitter_test' },
    fileParallelism: false,
  },
});
