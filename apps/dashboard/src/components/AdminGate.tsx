import { useMe } from '../api';
import { PageHead, Panel } from './ui';

/** Admin pages need a Discord sign-in (owner or team member). */
export function useAdminGate() {
  const me = useMe();
  return { loading: me.isLoading, allowed: me.data?.method === 'discord' };
}

export function NeedsDiscord(props: { title: string }) {
  const me = useMe();
  return (
    <>
      <PageHead title={props.title} />
      <Panel title="Sign in with Discord to continue">
        <p className="muted">
          Settings, alerts and audit data are limited to the app owner and team members signed in with Discord. Read-key
          sessions can view analytics only.
        </p>
        {me.data?.discordLogin ? (
          <a className="button primary" href="/auth/discord">
            Sign in with Discord
          </a>
        ) : (
          <p className="muted">
            Discord sign-in isn't set up on this collector. To use it, set <code>DISCORD_CLIENT_ID</code> and{' '}
            <code>DISCORD_CLIENT_SECRET</code>, or the <code>discord</code> option of an embedded collector.
          </p>
        )}
      </Panel>
    </>
  );
}
