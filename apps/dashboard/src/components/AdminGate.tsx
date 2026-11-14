import { useMe } from '../api';
import { Panel } from './ui';

/** Admin pages need a Discord sign-in (owner or team member). */
export function useAdminGate() {
  const me = useMe();
  return { loading: me.isLoading, allowed: me.data?.method === 'discord' };
}

export function NeedsDiscord() {
  return (
    <Panel title="Sign in with Discord to continue">
      <p className="muted">
        Settings, alerts and audit data are limited to the app owner and team members signed in with Discord. Read-key
        sessions can view analytics only.
      </p>
    </Panel>
  );
}
