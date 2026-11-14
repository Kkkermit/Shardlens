import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, useMe, useMeta } from '../api';
import { ErrorNote, Loading, PageHead } from '../components/ui';

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'shardlens:theme';

function applyTheme(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => applyTheme(theme), [theme]);
  return [
    theme,
    (t) => {
      setTheme(t);
      try {
        localStorage.setItem(THEME_KEY, t);
      } catch {
        // ignore
      }
    },
  ];
}

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/commands', label: 'Commands' },
  { to: '/servers', label: 'Servers' },
  { to: '/growth', label: 'Growth' },
  { to: '/audience', label: 'Audience' },
  { to: '/time', label: 'Time patterns' },
  { to: '/reliability', label: 'Reliability' },
  { to: '/premium', label: 'Premium' },
  { to: '/events', label: 'Events' },
] as const;

/** Admin pages: shown to everyone, gated inside (Discord sign-in). Activity only exists in audit mode. */
const ADMIN_NAV = [
  { to: '/activity', label: 'Activity', auditOnly: true },
  { to: '/alerts', label: 'Alerts', auditOnly: false },
  { to: '/reports', label: 'Reports', auditOnly: false },
  { to: '/settings', label: 'Settings', auditOnly: false },
] as const;

export function NotFound() {
  return (
    <>
      <PageHead title="Page not found" description="There is nothing at this address." />
      <p>
        <Link to="/">Back to the overview</Link>
      </p>
    </>
  );
}

export function Root() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.error && !(me.error instanceof ApiError)) return <ErrorNote error={me.error} />;
  if (!me.data?.authenticated) return <Login discordLogin={me.data?.discordLogin ?? false} />;
  return <Shell demo={me.data.method === 'demo'} />;
}

function Shell(props: { demo: boolean }) {
  const meta = useMeta();
  const [theme, setTheme] = useTheme();
  const client = useQueryClient();
  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    await client.invalidateQueries();
  };
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <span>{meta.data?.name ?? 'Shardlens'}</span>
        </div>
        {NAV.map((item) => (
          <Link key={item.to} to={item.to} activeOptions={{ exact: item.to === '/' }}>
            {item.label}
          </Link>
        ))}
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%', margin: '8px 0' }} />
        {ADMIN_NAV.filter((item) => !item.auditOnly || meta.data?.mode === 'audit').map((item) => (
          <Link key={item.to} to={item.to}>
            {item.label}
          </Link>
        ))}
        <div className="spacer" />
        <button type="button" className="ghost" onClick={() => setTheme(next[theme])}>
          Theme: {theme}
        </button>
        {props.demo ? null : (
          <button type="button" className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </nav>
      <main className="main" id="main">
        {props.demo ? (
          <div className="notice" role="note">
            <strong>Public demo.</strong> Every number here is fictional seeded data. Settings, keys and alerts need a
            Discord sign-in.
          </div>
        ) : null}
        {meta.data?.mode === 'audit' ? (
          <div className="notice" role="note">
            <strong>Audit mode is on.</strong> Shardlens records who ran each interaction, encrypted, for support and
            abuse handling only. Disclose this in your bot's privacy policy.
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}

const LOGIN_ERRORS: Record<string, string> = {
  not_a_team_member: 'Only the app owner and its team members can open this dashboard.',
  invalid_state: 'The sign-in link expired. Please try again.',
  discord_error: 'Discord sign-in failed. Please try again.',
};

function Login(props: { discordLogin: boolean }) {
  const client = useQueryClient();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    return code ? (LOGIN_ERRORS[code] ?? 'Sign-in failed.') : '';
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/read-key', { body: { key } });
      window.history.replaceState(null, '', '/');
      await client.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That read key was not accepted.' : 'Sign-in failed.');
    }
  };
  return (
    <div className="login">
      <main className="panel">
        <div className="brand" style={{ padding: 0 }}>
          <img src="/favicon.svg" alt="" />
          <h1>Shardlens</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Sign in to see your bot's analytics.
        </p>
        {error ? (
          <p role="alert" className="badge bad" style={{ justifyContent: 'flex-start', borderRadius: 6, padding: 8 }}>
            {error}
          </p>
        ) : null}
        {props.discordLogin ? (
          <a className="button primary" href="/auth/discord" style={{ justifyContent: 'center' }}>
            Sign in with Discord
          </a>
        ) : null}
        <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="read-key">{props.discordLogin ? 'Or use a read key' : 'Read key'}</label>
          <input
            id="read-key"
            type="password"
            autoComplete="off"
            placeholder="slk_read_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
          />
          <button type="submit">Sign in</button>
        </form>
      </main>
    </div>
  );
}
