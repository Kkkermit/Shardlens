# Shardlens dashboard

The React app the collector serves: analytics pages for anyone signed in, and settings, keys, alerts, reports and the
audit-mode activity log for the app's owner and team. It is not published on its own. The collector's build copies
`dist/` into `@shardlens/collector` and the Docker image.

For what the pages show and how to use them, see the [docs site](https://kkkermit.github.io/Shardlens/). This file is
for people changing the dashboard.

## Run it

You need a collector to talk to. Set one up once, as in the
[development guide](https://kkkermit.github.io/Shardlens/contributing/development/) (PostgreSQL in Docker, a collector
on `http://localhost:8080`, demo data from the seeder). Then:

```sh
pnpm --filter @shardlens/dashboard dev
```

Vite serves the app on `http://localhost:5173` and passes `/v1` and `/auth` to the collector
(`SHARDLENS_COLLECTOR_URL` if yours is somewhere else). Sign in with the collector's read key. Admin pages need a
Discord sign-in, which needs a real Discord application: to work on them locally, list a Discord user ID in the
collector's `SHARDLENS_EXTRA_ADMINS` and add a session for it to the `sessions` table, as `e2e/global-setup.ts` does.

To try a production build, build it and restart the collector: it lists the built files when it starts.

## Check it

| Command                                        | What it runs                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm --filter @shardlens/dashboard typecheck` | TypeScript, for the app and for `e2e/`                                      |
| `pnpm --filter @shardlens/dashboard test`      | Unit tests in `test/` (Vitest, no browser)                                  |
| `pnpm --filter @shardlens/dashboard build`     | The production build in `dist/`                                             |
| `pnpm --filter @shardlens/dashboard test:e2e`  | Playwright and axe against a real collector with seeded data. Needs Docker. |

The end-to-end suite needs both builds first (`pnpm turbo run build --filter=@shardlens/collector...`) and a browser
(`pnpm --filter @shardlens/dashboard exec playwright install chromium`). It starts PostgreSQL with Testcontainers and
one collector for all files, on the port in `e2e/env.ts`. The files run in name order with one worker, and
`z-audit-mode.e2e.ts` runs last because it switches that collector into audit mode and back.

Unit tests cover logic that needs no page: formatting, chart labels, form checks, address parsing, error messages. A
fix to something people do in the page (sign in, page through a list, save a form) gets an end-to-end test too.

## Where things are

| Path                        | What it holds                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `src/main.tsx`              | Routes, the query client, and what happens when a session ends                     |
| `src/api.ts`                | Requests, `ApiError` and `errorText`, and the query hooks (`useSpec`, `useLive`)   |
| `src/routes/`               | One file per page; `shell.tsx` is the frame, sign-in and "page not found"          |
| `src/components/ui.tsx`     | Shared pieces: `Panel`, `QueryBody`, `ErrorNote`, `Name`, `Pager`, `StatusMessage` |
| `src/components/`           | `DataTable`, the charts (uPlot), and the Discord sign-in gate for admin pages      |
| `src/format.ts`             | Every number, date, duration and label on a page, in the viewer's locale           |
| `src/chart-data.ts`         | Chart helpers with no DOM: pivoting, axis labels, ranges                           |
| `src/forms.ts` and siblings | Small pure modules (`server-list.ts`, `commands.ts`, `table-sort.ts`, `range.ts`)  |
| `src/styles/`               | `tokens.css` (colours, light and dark) and `app.css`                               |
| `e2e/`                      | The end-to-end suite: `fixtures.ts` has the signed-in pages and the axe check      |

## Rules that matter here

The rules for the whole repository are in [`AGENTS.md`](../../AGENTS.md). In the dashboard they come down to:

- **Text from Discord or a bot is text.** Server, user, command, SKU and bot names, custom IDs and option values go
  through `<Name>`, which also isolates them (a right-to-left override can't reorder the page) and lets them wrap. In
  a plain-text message (a status line, a `confirm`), use `quoted()`. Never `dangerouslySetInnerHTML`.
- **No inline scripts or styles in markup.** The collector's Content Security Policy is `script-src 'self'` and
  `style-src 'self'`. React's `style` prop is fine (it sets properties, not an attribute); prefer a class.
- **A query's answer goes in `<QueryBody>`.** It shows loading, then the error with a retry, then the content. An
  empty state ("No data in this range yet") is only for an answer that came back empty, never for one that is on its
  way or failed.
- **No per-user views.** Privacy mode is the default; the activity log exists only in audit mode, behind a Discord
  sign-in.
- **Everything works from the keyboard and passes axe.** A clickable table row is a mouse shortcut: the row also
  holds a link or button. A button that can't be used now is `aria-disabled`, not `disabled`, when focus could be on
  it. Each page sets its title through `PageHead`.
- **Numbers and dates go through `format.ts`** (and chart labels through `chart-data.ts`), so one page never mixes
  locales.
