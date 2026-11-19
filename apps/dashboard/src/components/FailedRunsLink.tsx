import { Link } from '@tanstack/react-router';
import { useMeta } from '../api';
import { useAdminGate } from './AdminGate';

/**
 * A link to the failed runs of one server or one command in the activity log. Rendered only where that log can be
 * opened: audit mode, with a Discord sign-in.
 */
export function FailedRunsLink(props: { guild?: string; command?: string }) {
  const gate = useAdminGate();
  const meta = useMeta();
  if (!gate.allowed || meta.data?.mode !== 'audit') return null;
  return (
    <Link to="/activity" search={{ ...props, outcome: 'failed' }}>
      View failed runs
    </Link>
  );
}
