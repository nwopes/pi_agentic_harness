> Starting directory: a fresh copy of `demo-tasks/habit-tracker/fixture/` (the empty starter, not a finished habit tracker), after `npm install`.

# Quick task: dark mode + tip of the day

Add two small features to this starter app. Keep the existing structure and toolchain. `npm run typecheck`, `npm run build` and `npm test` must all pass when you are done.

## 1. Backend: `GET /api/tip`

In `server/app.ts`, inside `createApp()`, add `GET /api/tip`. It returns 200 with `{ "tip": string, "index": number }`.

- Keep a fixed list of exactly 5 short habit-building tips (write your own, one sentence each) in `server/tips.ts`.
- `index` is the number of whole days since 1970-01-01 (UTC), mod 5. The tip changes once a day. `tip` is the tip at that index.
- Optional query `?index=N` with an integer from 0 to 4 returns that tip instead. Any other value for `index` returns 400 with `{ "error": string }`.

## 2. Frontend: tip panel + dark mode

In `src/` (split into components if you like):

- **Tip panel** (`data-testid="tip-panel"`): on mount, fetch `/api/tip` and show the tip text in `data-testid="tip-text"`. Show `Loading...` while waiting and `No tip today.` if the request fails.
- **Theme toggle** (`data-testid="theme-toggle"`, a button in the page header): switches between light and dark.
  - Set `data-theme="light"` or `data-theme="dark"` on `document.documentElement`.
  - The button label names the theme it switches to: `Dark mode` or `Light mode`.
  - Save the choice in `localStorage` under the key `theme` and restore it on load. The default is light.
- Implement dark mode with CSS variables in `src/index.css` (page background, text and panel colours). Both themes must be readable.

## 3. Tests (visible, part of `npm test`)

- `server/tip.test.ts` (supertest + `createApp()`): the response shape, that `index` matches today's date (use `vi.setSystemTime`), the `?index=2` override, and a 400 for `?index=7` and `?index=abc`.
- `src/ThemeToggle.test.tsx` (Testing Library; first line `// @vitest-environment jsdom`): clicking the toggle sets `data-theme="dark"` and saves `dark` to `localStorage`, and a second click switches back to light. Stub `fetch` with `vi.stubGlobal`.
- `src/TipPanel.test.tsx`: shows the tip from a stubbed `fetch`, and `No tip today.` when the stubbed `fetch` fails.
- Update the existing `src/App.test.tsx` so it still passes (stub `fetch`).
