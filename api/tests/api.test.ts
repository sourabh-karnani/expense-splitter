import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { UserModel } from '../src/models/User.js';
import { NoteModel } from '../src/models/Note.js';

const app = createApp();

beforeAll(async () => {
  if (!env.MONGO_URL.includes('_test')) throw new Error('Refusing to run tests against a non-test database');
  await connectDb(env.MONGO_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.init(), NoteModel.init()]); // wait for indexes, e.g. unique email
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDb();
});

async function signUp(email: string) {
  const agent = request.agent(app); // keeps the session cookie between requests
  await agent.post('/api/auth/register').send({ email, name: 'Test', password: 'correct-horse-battery' }).expect(201);
  return agent;
}

describe('api', () => {
  it('reports health', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('requires a session for notes', async () => {
    await request(app).get('/api/notes').expect(401);
  });

  it('logs in with the right password only', async () => {
    await signUp('login@test.dev');
    await request(app).post('/api/auth/login').send({ email: 'login@test.dev', password: 'wrong-password' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'LOGIN@test.dev', password: 'correct-horse-battery' }).expect(200);
  });

  it('rejects duplicate emails', async () => {
    await signUp('dup@test.dev');
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@test.dev', name: 'Again', password: 'correct-horse-battery' })
      .expect(409);
  });

  it('creates, lists, updates and deletes own notes', async () => {
    const alice = await signUp('alice@test.dev');
    const created = await alice.post('/api/notes').send({ title: 'Hello', body: 'World' }).expect(201);
    const id = created.body.note.id;

    const list = await alice.get('/api/notes').expect(200);
    expect(list.body.items).toHaveLength(1);

    const updated = await alice.patch(`/api/notes/${id}`).send({ title: 'Hi' }).expect(200);
    expect(updated.body.note.title).toBe('Hi');

    await alice.delete(`/api/notes/${id}`).expect(204);
    await alice.get(`/api/notes/${id}`).expect(404);
  });

  it("hides other users' notes (BOLA)", async () => {
    const owner = await signUp('owner@test.dev');
    const other = await signUp('other@test.dev');
    const { body } = await owner.post('/api/notes').send({ title: 'Private' }).expect(201);

    await other.get(`/api/notes/${body.note.id}`).expect(404);
    await other.patch(`/api/notes/${body.note.id}`).send({ title: 'Hacked' }).expect(404);
    await other.delete(`/api/notes/${body.note.id}`).expect(404);
  });

  it('rejects unknown fields and query-operator injection', async () => {
    const user = await signUp('strict@test.dev');
    await user.post('/api/notes').send({ title: 'x', ownerId: '000000000000000000000000' }).expect(400);
    await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: 'x' }).expect(400);
  });

  it('paginates with a cursor', async () => {
    const user = await signUp('pages@test.dev');
    for (let i = 1; i <= 3; i++) await user.post('/api/notes').send({ title: `Note ${i}` }).expect(201);

    const first = await user.get('/api/notes?limit=2').expect(200);
    expect(first.body.items.map((n: { title: string }) => n.title)).toEqual(['Note 3', 'Note 2']);

    const second = await user.get(`/api/notes?limit=2&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.items.map((n: { title: string }) => n.title)).toEqual(['Note 1']);
    expect(second.body.nextCursor).toBeNull();
  });
});
