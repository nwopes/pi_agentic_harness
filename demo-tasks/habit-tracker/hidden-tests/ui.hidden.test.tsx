// @vitest-environment jsdom
// Hidden acceptance tests: UI contract (see SPEC.md "Frontend").
// Run only by grade.sh with vitest.hidden.config.mjs. Test titles must match manifest.json.
import '@testing-library/jest-dom/vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../src/App';

configure({ asyncUtilTimeout: 4000 });

const TODAY = '2025-06-15';
const DUPLICATE_ERROR = 'A habit with that name already exists';

// ---------------------------------------------------------------------------
// In-memory fake of the API contract, served through a stubbed global fetch.
// ---------------------------------------------------------------------------
type SeedHabit = { name: string; checkins?: string[] };
type Call = { method: string; path: string; body: unknown };

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function computeStats(dates: Set<string>) {
  const days = [...dates].map(dayNumber).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const daySet = new Set(days);
  const today = dayNumber(utcToday());
  let cursor = daySet.has(today) ? today : today - 1;
  let current = 0;
  while (daySet.has(cursor)) {
    current++;
    cursor--;
  }
  return { currentStreak: current, longestStreak: longest, totalCheckins: days.length };
}

function json(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFakeApi(seed: SeedHabit[]) {
  let nextId = 1;
  const habits = seed.map((h) => ({
    id: `h${nextId++}`,
    name: h.name,
    checkins: new Set(h.checkins ?? []),
  }));
  const calls: Call[] = [];

  function route(method: string, path: string, body: any): Response {
    if (path === '/api/habits' && method === 'GET') {
      return json(200, habits.map(({ id, name }) => ({ id, name })));
    }
    if (path === '/api/habits' && method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) return json(400, { error: 'Name is required' });
      if (habits.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
        return json(400, { error: DUPLICATE_ERROR });
      }
      const habit = { id: `h${nextId++}`, name, checkins: new Set<string>() };
      habits.push(habit);
      return json(201, { id: habit.id, name: habit.name });
    }
    const match = /^\/api\/habits\/([^/]+)(\/checkins|\/stats)?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const sub = match[2] ?? '';
      const index = habits.findIndex((h) => h.id === id);
      const habit = habits[index];
      if (sub === '' && method === 'DELETE') {
        if (!habit) return json(404, { error: 'Habit not found' });
        habits.splice(index, 1);
        return json(204);
      }
      if (sub === '/checkins' && method === 'POST') {
        if (!habit) return json(404, { error: 'Habit not found' });
        const date = body?.date;
        if (!isRealDate(date) || date > utcToday()) return json(400, { error: 'Invalid date' });
        if (habit.checkins.has(date)) return json(409, { error: `Already checked in on ${date}` });
        habit.checkins.add(date);
        return json(201, { habitId: habit.id, date });
      }
      if (sub === '/stats' && method === 'GET') {
        if (!habit) return json(404, { error: 'Habit not found' });
        return json(200, computeStats(habit.checkins));
      }
    }
    return json(404, { error: `No route for ${method} ${path}` });
  }

  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    let url: string;
    let method = 'GET';
    let rawBody: unknown;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      url = input.url;
      method = input.method;
      rawBody = await input.clone().text();
    } else {
      url = String(input);
    }
    if (init?.method) method = init.method;
    if (init?.body != null) rawBody = init.body;
    method = method.toUpperCase();
    const path = new URL(url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    let body: unknown = rawBody;
    if (typeof rawBody === 'string') {
      try {
        body = rawBody.length ? JSON.parse(rawBody) : undefined;
      } catch {
        body = rawBody;
      }
    }
    calls.push({ method, path, body });
    await Promise.resolve();
    return route(method, path, body);
  };

  return { fetch: vi.fn(fetchImpl), calls, habits };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderApp(seed: SeedHabit[]) {
  const api = createFakeApi(seed);
  vi.stubGlobal('fetch', api.fetch);
  if (typeof window !== 'undefined' && window.fetch !== api.fetch) {
    (window as any).fetch = api.fetch;
  }
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}

function itemNames(): string[] {
  return screen
    .queryAllByTestId('habit-item')
    .map((item) => within(item).queryByTestId('habit-name')?.textContent?.trim() ?? '');
}

function getItem(name: string): HTMLElement {
  const item = screen
    .queryAllByTestId('habit-item')
    .find((el) => within(el).queryByTestId('habit-name')?.textContent?.trim() === name);
  if (!item) throw new Error(`No habit-item with habit-name "${name}". Found: ${JSON.stringify(itemNames())}`);
  return item;
}

async function findItem(name: string): Promise<HTMLElement> {
  await waitFor(() => getItem(name));
  return getItem(name);
}

async function expectStreak(name: string, value: number) {
  await waitFor(() => {
    const display = within(getItem(name)).getByTestId('streak-display');
    expect(display.textContent?.trim()).toBe(String(value));
  });
}

async function expectErrorShown() {
  await waitFor(() => {
    const el = screen.getByTestId('error-message');
    expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
}

function expectNoError() {
  const el = screen.queryByTestId('error-message');
  if (el) expect(el.textContent?.trim() ?? '').toBe('');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('on load, lists habits from GET /api/habits in order inside habit-list', async () => {
  const { api } = renderApp([{ name: 'Read' }, { name: 'Exercise' }, { name: 'Meditate' }]);
  await waitFor(() => expect(itemNames()).toEqual(['Read', 'Exercise', 'Meditate']));

  const list = screen.getByTestId('habit-list');
  for (const item of screen.getAllByTestId('habit-item')) {
    expect(list).toContainElement(item);
    expect(within(item).getByTestId('streak-display')).toBeInTheDocument();
    expect(within(item).getByTestId('checkin-button')).toBeInTheDocument();
    expect(within(item).getByTestId('delete-button')).toBeInTheDocument();
  }
  expect(screen.getByTestId('habit-name-input')).toBeInTheDocument();
  expect(screen.getByTestId('add-habit-button')).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === 'GET' && c.path === '/api/habits')).toBe(true);
  expectNoError();
});

test('on load, shows each habit current streak from GET /api/habits/:id/stats', async () => {
  renderApp([
    { name: 'Read', checkins: ['2025-06-15', '2025-06-14'] }, // current 2
    { name: 'Exercise', checkins: ['2025-06-07', '2025-06-08', '2025-06-09', '2025-06-10'] }, // current 0, longest 4
    { name: 'Meditate', checkins: ['2025-06-14', '2025-06-13', '2025-06-12', '2025-06-01'] }, // current 3, total 4
  ]);
  await expectStreak('Read', 2);
  await expectStreak('Exercise', 0);
  await expectStreak('Meditate', 3);
});

test('adding a habit POSTs the typed name, appends it with streak 0 and clears the input', async () => {
  const { api, user } = renderApp([{ name: 'Read', checkins: ['2025-06-15'] }]);
  await findItem('Read');

  await user.type(screen.getByTestId('habit-name-input'), 'Exercise');
  await user.click(screen.getByTestId('add-habit-button'));

  await waitFor(() => expect(itemNames()).toEqual(['Read', 'Exercise']));
  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/habits');
  expect(post?.body).toMatchObject({ name: 'Exercise' });
  await expectStreak('Exercise', 0);
  await expectStreak('Read', 1);
  await waitFor(() => expect(screen.getByTestId('habit-name-input')).toHaveValue(''));
  expectNoError();
});

test('adding an empty or whitespace-only name shows an error and adds nothing', async () => {
  const { api, user } = renderApp([{ name: 'Read' }]);
  await findItem('Read');

  await user.click(screen.getByTestId('add-habit-button'));
  await expectErrorShown();

  await user.type(screen.getByTestId('habit-name-input'), '   ');
  await user.click(screen.getByTestId('add-habit-button'));
  await expectErrorShown();

  expect(itemNames()).toEqual(['Read']);
  expect(api.habits.map((h) => h.name)).toEqual(['Read']);
});

test('adding a duplicate name shows an error and leaves the list unchanged', async () => {
  const { api, user } = renderApp([{ name: 'Read' }]);
  await findItem('Read');

  await user.type(screen.getByTestId('habit-name-input'), 'read');
  await user.click(screen.getByTestId('add-habit-button'));

  await expectErrorShown();
  await waitFor(() => expect(itemNames()).toEqual(['Read']));
  expect(api.habits.map((h) => h.name)).toEqual(['Read']);
});

test("check-in POSTs today's UTC date for that habit and refreshes its streak", async () => {
  const { api, user } = renderApp([
    { name: 'Read', checkins: ['2025-06-14', '2025-06-13', '2025-06-12'] }, // current 3
    { name: 'Exercise', checkins: ['2025-06-14'] }, // current 1
  ]);
  await expectStreak('Exercise', 1);
  await expectStreak('Read', 3);
  const exerciseId = api.habits.find((h) => h.name === 'Exercise')!.id;

  await user.click(within(getItem('Exercise')).getByTestId('checkin-button'));

  await expectStreak('Exercise', 2);
  await expectStreak('Read', 3);
  const posts = api.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/checkins'));
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ path: `/api/habits/${exerciseId}/checkins`, body: { date: TODAY } });
  expectNoError();
});

test("a rejected check-in shows the server's error message and keeps the streak", async () => {
  const { user } = renderApp([{ name: 'Read', checkins: ['2025-06-15', '2025-06-14'] }]);
  await expectStreak('Read', 2);

  await user.click(within(getItem('Read')).getByTestId('checkin-button'));

  await waitFor(() =>
    expect(screen.getByTestId('error-message')).toHaveTextContent(`Already checked in on ${TODAY}`),
  );
  await expectStreak('Read', 2);
});

test('delete sends DELETE /api/habits/:id and removes only that habit', async () => {
  const { api, user } = renderApp([{ name: 'Read' }, { name: 'Exercise' }, { name: 'Meditate' }]);
  await findItem('Exercise');
  const exerciseId = api.habits.find((h) => h.name === 'Exercise')!.id;

  await user.click(within(getItem('Exercise')).getByTestId('delete-button'));

  await waitFor(() => expect(itemNames()).toEqual(['Read', 'Meditate']));
  expect(api.calls.some((c) => c.method === 'DELETE' && c.path === `/api/habits/${exerciseId}`)).toBe(true);
  expect(api.habits.map((h) => h.name)).toEqual(['Read', 'Meditate']);
  expectNoError();
});
