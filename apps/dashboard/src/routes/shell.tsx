import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorText, useMe, useMeta } from '../api';
import { ErrorNote, Loading, PageHead } from '../components/ui';
import { type Theme, useTheme } from '../theme';

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

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
  // Only an answer that there is no session means signed out: a collector that is down is not a sign-in problem.
  if (!me.data && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <div className="login">
        <main className="panel">
          <ErrorNote error={me.error} retry={() => void me.refetch()} />
        </main>
      </div>
    );
  }
  if (!me.data?.authenticated) return <Login discordLogin={me.data?.discordLogin ?? false} />;
  return <Shell demo={me.data.method === 'demo'} />;
}

/** After navigating, focus the new page's heading, so screen readers announce it and Tab starts from the content. */
function useFocusOnNavigate() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const target = document.querySelector<HTMLElement>('#main h1') ?? document.getElementById('main');
    if (!target) return;
    target.tabIndex = -1;
    target.focus();
  }, [pathname]);
}

function Shell(props: { demo: boolean }) {
  const meta = useMeta();
  const [theme, setTheme] = useTheme();
  const client = useQueryClient();
  const [signOutError, setSignOutError] = useState('');
  useFocusOnNavigate();
  const logout = async () => {
    setSignOutError('');
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch (error) {
      // 401: the session had already ended, which is what signing out wanted.
      if (!(error instanceof ApiError && error.status === 401)) {
        setSignOutError(`Couldn't sign out: ${errorText(error)}`);
        return;
      }
    }
    await client.invalidateQueries();
  };
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
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
        <hr />
        {ADMIN_NAV.filter((item) => !item.auditOnly || meta.data?.mode === 'audit').map((item) => (
          <Link key={item.to} to={item.to}>
            {item.label}
          </Link>
        ))}
        <div className="spacer" />
        <button type="button" className="ghost" onClick={() => setTheme(NEXT_THEME[theme])}>
          Theme: {theme}
        </button>
        {props.demo ? null : (
          <button type="button" className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </nav>
      <main className="main" id="main" tabIndex={-1}>
        {signOutError ? (
          <p className="notice" role="alert">
            {signOutError}
          </p>
        ) : null}
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
  bot_not_reported:
    'The bot has not connected to Shardlens yet, so its owner and team are not known. Start the bot, or sign in with a read key.',
  invalid_state: 'The sign-in link expired. Please try again.',
  discord_error: 'Discord sign-in failed. Please try again.',
};

/** The message for an `?error=` code from the sign-in redirect. Only known codes: the URL is anyone's to write. */
export function loginError(code: string | null): string {
  if (!code) return '';
  return Object.hasOwn(LOGIN_ERRORS, code) ? (LOGIN_ERRORS[code] as string) : 'Sign-in failed.';
}

function Login(props: { discordLogin: boolean }) {
  const client = useQueryClient();
  const router = useRouter();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>(() =>
    loginError(new URLSearchParams(window.location.search).get('error')),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/read-key', { body: { key } });
      // Stay on the page that was asked for (a deep link), without the sign-in error in its address.
      const here = new URL(window.location.href);
      here.searchParams.delete('error');
      router.history.replace(here.pathname === '/login' ? '/' : `${here.pathname}${here.search}${here.hash}`);
      await client.invalidateQueries();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That read key was not accepted.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many sign-in attempts. Wait a minute and try again.'
            : 'Sign-in failed.',
      );
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
