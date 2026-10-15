// Hidden acceptance tests: API contract (see SPEC.md "Backend").
// Run only by grade.sh with vitest.hidden.config.mjs. Test titles must match manifest.json.
import request from 'supertest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as appModule from '../server/app';

const TODAY = '2025-06-15';

function setNow(date: string, time = '12:00:00') {
  vi.setSystemTime(new Date(`${date}T${time}.000Z`));
}

beforeEach(() => {
  // Only Date is faked, so HTTP/timers stay real. "Today" for the API = TODAY (UTC).
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

async function makeApp(): Promise<any> {
  const createApp = (appModule as any).createApp;
  if (typeof createApp !== 'function') {
    throw new Error('server/app must export a named function createApp()');
  }
  return await createApp();
}

const enc = (id: unknown) => encodeURIComponent(String(id));

function expectError(res: request.Response, status: number, label = '') {
  expect(res.status, `${label} status`).toBe(status);
  expect(typeof res.body?.error, `${label} body.error should be a string`).toBe('string');
  expect(res.body.error.trim().length, `${label} body.error should be non-empty`).toBeGreaterThan(0);
}

async function createHabit(app: any, name: string) {
  const res = await request(app).post('/api/habits').send({ name });
  expect(res.status, `POST /api/habits ${JSON.stringify(name)}`).toBe(201);
  return res.body as { id: string; name: string };
}

function checkin(app: any, id: string, date: unknown) {
  return request(app).post(`/api/habits/${enc(id)}/checkins`).send({ date });
}

async function checkinAll(app: any, id: string, dates: string[]) {
  for (const date of dates) {
    const res = await checkin(app, id, date);
    expect(res.status, `check-in ${date}`).toBe(201);
  }
}

async function stats(app: any, id: string) {
  const res = await request(app).get(`/api/habits/${enc(id)}/stats`);
  expect(res.status, 'GET stats').toBe(200);
  return res.body;
}

async function listNames(app: any) {
  const res = await request(app).get('/api/habits');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  return (res.body as { name: string }[]).map((h) => h.name);
}

test('createApp() returns a fresh, empty store on every call', async () => {
  const a = await makeApp();
  const b = await makeApp();
  const first = await request(a).get('/api/habits');
  expect(first.status).toBe(200);
  expect(first.body).toEqual([]);

  await createHabit(a, 'Read');
  expect(await listNames(a)).toEqual(['Read']);

  const other = await request(b).get('/api/habits');
  expect(other.status).toBe(200);
  expect(other.body).toEqual([]);
  // Duplicate-name checks are per app as well.
  await createHabit(b, 'Read');
});

test('POST /api/habits returns 201 with a trimmed name; GET /api/habits lists habits in creation order', async () => {
  const app = await makeApp();
  const res = await request(app).post('/api/habits').send({ name: '  Read  ' });
  expect(res.status).toBe(201);
  expect(typeof res.body.id).toBe('string');
  expect(res.body.id.length).toBeGreaterThan(0);
  expect(res.body.name).toBe('Read');

  const exercise = await createHabit(app, 'Exercise');
  const meditate = await createHabit(app, 'Meditate');
  expect(new Set([res.body.id, exercise.id, meditate.id]).size).toBe(3);

  const list = await request(app).get('/api/habits');
  expect(list.status).toBe(200);
  expect(list.body.map((h: any) => h.name)).toEqual(['Read', 'Exercise', 'Meditate']);
  expect(list.body.map((h: any) => h.id)).toEqual([res.body.id, exercise.id, meditate.id]);
});

test('POST /api/habits rejects missing, non-string, empty and whitespace-only names with 400', async () => {
  const app = await makeApp();
  const bodies = [{}, { name: '' }, { name: '   ' }, { name: '\t \n' }, { name: 42 }, { name: null }, { name: ['Read'] }];
  for (const body of bodies) {
    const res = await request(app).post('/api/habits').send(body);
    expectError(res, 400, `POST /api/habits ${JSON.stringify(body)}`);
  }
  expect(await listNames(app)).toEqual([]);
});

test('POST /api/habits rejects duplicate names (trimmed, case-insensitive) with 400', async () => {
  const app = await makeApp();
  await createHabit(app, 'Read');
  for (const name of ['Read', 'read', '  READ  ']) {
    const res = await request(app).post('/api/habits').send({ name });
    expectError(res, 400, `duplicate ${JSON.stringify(name)}`);
  }
  await createHabit(app, 'Reading');
  expect(await listNames(app)).toEqual(['Read', 'Reading']);
});

test('DELETE /api/habits/:id returns 204 and removes the habit and its check-ins', async () => {
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  const gym = await createHabit(app, 'Gym');
  await checkinAll(app, read.id, ['2025-06-14', TODAY]);

  const del = await request(app).delete(`/api/habits/${enc(read.id)}`);
  expect(del.status).toBe(204);

  const list = await request(app).get('/api/habits');
  expect(list.body.map((h: any) => h.id)).toEqual([gym.id]);
  expectError(await request(app).get(`/api/habits/${enc(read.id)}/stats`), 404, 'stats of deleted habit');
  expectError(await request(app).delete(`/api/habits/${enc(read.id)}`), 404, 'second delete');

  // The name can be reused, and the new habit starts with no check-ins.
  const again = await createHabit(app, 'Read');
  expect(await stats(app, again.id)).toMatchObject({ currentStreak: 0, longestStreak: 0, totalCheckins: 0 });
});

test('unknown habit ids return 404 with an error body', async () => {
  const app = await makeApp();
  await createHabit(app, 'Read');
  for (const id of ['does-not-exist', '999999']) {
    expectError(await request(app).delete(`/api/habits/${id}`), 404, `DELETE ${id}`);
    expectError(await checkin(app, id, TODAY), 404, `check-in ${id}`);
    expectError(await request(app).get(`/api/habits/${id}/stats`), 404, `stats ${id}`);
  }
  expect(await listNames(app)).toEqual(['Read']);
});

test('POST /api/habits/:id/checkins returns 201 and the check-in is counted in stats', async () => {
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 0, longestStreak: 0, totalCheckins: 0 });

  const res = await checkin(app, read.id, TODAY);
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ habitId: read.id, date: TODAY });
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 1, longestStreak: 1, totalCheckins: 1 });
});

test('POST /api/habits/:id/checkins rejects malformed, impossible and future dates with 400', async () => {
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  const bad: unknown[] = [
    undefined,
    null,
    20250615,
    '',
    '2025-6-15',
    '2025-06-5',
    '15-06-2025',
    '2025/06/15',
    '2025-06-15T00:00:00.000Z',
    ' 2025-06-15',
    '2025-02-29',
    '2025-04-31',
    '2025-13-01',
    '2025-00-10',
    '2025-06-00',
    '2025-06-16', // tomorrow
    '2031-01-01',
  ];
  for (const date of bad) {
    const res = await request(app)
      .post(`/api/habits/${enc(read.id)}/checkins`)
      .send(date === undefined ? {} : { date });
    expectError(res, 400, `date ${JSON.stringify(date)}`);
  }
  expect(await stats(app, read.id)).toMatchObject({ totalCheckins: 0 });

  // A leap day is a real date.
  expect((await checkin(app, read.id, '2024-02-29')).status).toBe(201);
  expect(await stats(app, read.id)).toMatchObject({ totalCheckins: 1 });
});

test('a second check-in for the same habit and date returns 409 and is not counted', async () => {
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  const gym = await createHabit(app, 'Gym');

  expect((await checkin(app, read.id, TODAY)).status).toBe(201);
  expectError(await checkin(app, read.id, TODAY), 409, 'same day again');
  expect((await checkin(app, read.id, '2025-06-10')).status).toBe(201);
  expectError(await checkin(app, read.id, '2025-06-10'), 409, 'past day again');

  // Another habit can check in on the same date.
  expect((await checkin(app, gym.id, TODAY)).status).toBe(201);

  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 1, longestStreak: 1, totalCheckins: 2 });
  expect(await stats(app, gym.id)).toMatchObject({ currentStreak: 1, longestStreak: 1, totalCheckins: 1 });
});

test('stats: a gap ends a streak, and longest and current streaks are tracked separately', async () => {
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  await checkinAll(app, read.id, [
    '2025-06-07',
    '2025-06-08',
    '2025-06-09',
    '2025-06-10',
    '2025-06-13',
    '2025-06-14',
    '2025-06-15',
  ]);
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 3, longestStreak: 4, totalCheckins: 7 });

  // The current run can also be the longest one.
  const gym = await createHabit(app, 'Gym');
  await checkinAll(app, gym.id, ['2025-06-01', '2025-06-02', '2025-06-12', '2025-06-13', '2025-06-14', '2025-06-15']);
  expect(await stats(app, gym.id)).toMatchObject({ currentStreak: 4, longestStreak: 4, totalCheckins: 6 });
});

test('stats: a streak ending yesterday is still current, and it breaks once a whole day is missed', async () => {
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  const gym = await createHabit(app, 'Gym');
  await checkinAll(app, read.id, ['2025-06-12', '2025-06-13', '2025-06-14']); // ends yesterday
  await checkinAll(app, gym.id, ['2025-06-11', '2025-06-12', '2025-06-13']); // ends two days ago

  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 3, longestStreak: 3, totalCheckins: 3 });
  expect(await stats(app, gym.id)).toMatchObject({ currentStreak: 0, longestStreak: 3, totalCheckins: 3 });

  // One day later, Read's last check-in (06-14) is two days old.
  setNow('2025-06-16');
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 0, longestStreak: 3, totalCheckins: 3 });

  // Back-filling 06-15 reconnects the run (it now ends yesterday); checking in today extends it.
  await checkinAll(app, read.id, ['2025-06-15']);
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 4, longestStreak: 4, totalCheckins: 4 });
  await checkinAll(app, read.id, ['2025-06-16']);
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 5, longestStreak: 5, totalCheckins: 5 });
});

test('stats: out-of-order check-ins across month, year and leap-day boundaries', async () => {
  setNow('2025-03-01');
  const app = await makeApp();
  const read = await createHabit(app, 'Read');
  await checkinAll(app, read.id, [
    '2025-02-27',
    '2024-12-31',
    '2025-03-01',
    '2025-01-02',
    '2024-12-29',
    '2025-02-28',
    '2025-01-01',
    '2024-12-30',
  ]);
  // Runs: 2024-12-29..2025-01-02 (5 days) and 2025-02-27..2025-03-01 (3 days, ends today).
  expect(await stats(app, read.id)).toMatchObject({ currentStreak: 3, longestStreak: 5, totalCheckins: 8 });

  const gym = await createHabit(app, 'Gym');
  await checkinAll(app, gym.id, ['2024-03-01', '2024-02-28', '2024-02-29']);
  expect(await stats(app, gym.id)).toMatchObject({ currentStreak: 0, longestStreak: 3, totalCheckins: 3 });
});
