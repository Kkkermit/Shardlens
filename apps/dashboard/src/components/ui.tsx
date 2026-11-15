import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError, errorText } from '../api';
import { finite, firstCharacters, initials, pct } from '../format';
import { PRESETS, type PresetId } from '../range';

export function Panel(props: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** The content shows the previous answer while a new one loads. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel" aria-label={props.title} aria-busy={props.busy || undefined}>
      <div className="panel-head">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

export function Tile(props: { label: string; value: ReactNode; sub?: ReactNode; live?: boolean; stale?: boolean }) {
  return (
    <div className="tile">
      <div className="label">
        {props.live ? (
          <span
            className={`live-dot${props.stale ? ' stale' : ''}`}
            role="img"
            aria-label={props.stale ? 'Reconnecting' : 'Live'}
          />
        ) : null}
        {props.label}
      </div>
      <div className="value">{props.value}</div>
      {props.sub ? <div className="sub">{props.sub}</div> : null}
    </div>
  );
}

/** The browser tab's title, so tabs, history and screen readers name the page (WCAG 2.4.2). */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Shardlens` : 'Shardlens';
  }, [title]);
}

export function PageHead(props: { title: string; description?: ReactNode; actions?: ReactNode }) {
  useDocumentTitle(props.title);
  return (
    <div className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.actions}
    </div>
  );
}

/** One choice from a few, as toggle buttons in a labelled group. */
export function Segmented<T extends string>(props: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">{props.label}</legend>
      {props.options.map((o) => (
        <button key={o.id} type="button" aria-pressed={props.value === o.id} onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

export function RangePicker(props: { value: PresetId; onChange: (id: PresetId) => void }) {
  return <Segmented label="Time range" options={PRESETS} value={props.value} onChange={props.onChange} />;
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

export function Loading() {
  return (
    <div className="empty" role="status">
      Loading…
    </div>
  );
}

export function ErrorNote(props: { error: unknown; retry?: (() => void) | undefined }) {
  const error = props.error;
  return (
    <div className="empty" role="alert">
      Couldn't load this. {errorText(error)}
      {error instanceof ApiError && error.requestId ? (
        <>
          {' '}
          (request <code>{error.requestId}</code>)
        </>
      ) : null}
      {props.retry ? (
        <>
          {' '}
          <button type="button" onClick={props.retry}>
            Try again
          </button>
        </>
      ) : null}
    </div>
  );
}

interface QueryState {
  isLoading: boolean;
  error: unknown;
  data?: unknown;
  refetch?: () => unknown;
}

/**
 * What a query's answer is shown in: loading, its error (with a retry), or the content. Never an empty state while the
 * answer is on its way or failed. Several queries load and fail together. An answer already on the page stays when
 * asking again fails (a refresh in the background): the error is for when there is nothing to show.
 */
export function QueryBody(props: { query: QueryState | readonly QueryState[]; children: ReactNode }) {
  const queries: readonly QueryState[] = Array.isArray(props.query) ? props.query : [props.query as QueryState];
  if (queries.some((q) => q.isLoading)) return <Loading />;
  const failed = queries.filter((q) => q.error && q.data === undefined);
  if (failed.length > 0) {
    const retry = failed.every((q) => q.refetch) ? () => failed.forEach((q) => void q.refetch?.()) : undefined;
    return <ErrorNote error={failed[0]?.error} retry={retry} />;
  }
  return <>{props.children}</>;
}

/** A page for an address that names nothing: what was not found, and the way back. */
export function NotFoundPage(props: { title: string; back: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHead title={props.title} description={props.back} />
      <p className="muted">{props.children}</p>
    </>
  );
}

/**
 * Paging buttons. One that can't be used is marked unavailable instead of disabled: a disabled button drops the
 * keyboard focus when it was the one just pressed (the last page's Next).
 */
export function Pager(props: {
  label: string;
  status?: ReactNode;
  buttons: readonly { label: string; onClick: (() => void) | undefined }[];
}) {
  return (
    <nav className="pager" aria-label={props.label}>
      {props.buttons.map((b) => (
        <button key={b.label} type="button" aria-disabled={b.onClick ? undefined : true} onClick={() => b.onClick?.()}>
          {b.label}
        </button>
      ))}
      {props.status ? (
        <span className="muted" role="status">
          {props.status}
        </span>
      ) : null}
    </nav>
  );
}

/**
 * Text that came from Discord or a bot (a server, user, command or event name). Isolated, so a right-to-left override
 * in it can't reorder the text around it, and allowed to break anywhere, so one long name can't widen a table.
 */
export function Name(props: { children: ReactNode }) {
  return <bdi className="ext">{props.children}</bdi>;
}

/** The result of an action. The live region is always there, so screen readers announce each new message. */
export function StatusMessage(props: { message: string }) {
  return <div role="status">{props.message ? <p className="notice">{props.message}</p> : null}</div>;
}

/**
 * One message at a time for a page of several forms, shown next to the form it is about (a message at the top of a
 * long page is out of view of a form at the bottom). `say('', '')` clears it.
 */
export function usePanelStatus(): [(panel: string) => string, (panel: string, text: string) => void] {
  const [status, setStatus] = useState({ panel: '', text: '' });
  const messageFor = useCallback((panel: string) => (status.panel === panel ? status.text : ''), [status]);
  const say = useCallback((panel: string, text: string) => setStatus({ panel, text }), []);
  return [messageFor, say];
}

const CDN_HASH = /^(a_)?[0-9a-f]{32}$/;
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * An avatar or server icon from Discord's CDN, the only image host the CSP allows, with initials when there is none.
 * The ID and hash are checked so a stored value can't point the address anywhere else.
 */
function CdnImage(props: { path: 'avatars' | 'icons'; id: string; hash: string | null | undefined; initials: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !props.hash || !CDN_HASH.test(props.hash) || !SNOWFLAKE.test(props.id)) {
    return (
      <span className="initials" aria-hidden="true">
        {props.initials}
      </span>
    );
  }
  return (
    <img
      src={`https://cdn.discordapp.com/${props.path}/${props.id}/${props.hash}.png?size=64`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Who ran something, in audit mode: avatar, username and ID, all rendered as text. */
export function UserTag(props: { id: string | null; username: string | null; avatar: string | null }) {
  if (!props.id) return <>—</>;
  return (
    <span className="guild">
      <CdnImage
        path="avatars"
        id={props.id}
        hash={props.avatar}
        initials={firstCharacters(props.username ?? '?', 2).toUpperCase()}
      />
      <span>
        {props.username ? (
          <>
            <Name>{props.username}</Name>{' '}
          </>
        ) : null}
        <code>{props.id}</code>
      </span>
    </span>
  );
}

export function GuildIcon(props: { id: string; icon: string | null | undefined; name: string | null | undefined }) {
  const name = props.name || 'Unknown server';
  return (
    <span className="guild">
      <CdnImage path="icons" id={props.id} hash={props.icon} initials={initials(name, 3)} />
      <Name>{name}</Name>
    </span>
  );
}

/** A change in percent (`12.5` is +12.5%). */
export function Delta(props: { pct: number | null | undefined }) {
  if (!finite(props.pct)) return <span className="muted">new</span>;
  if (props.pct === 0) return <span className="muted">no change</span>;
  const up = props.pct > 0;
  return (
    <span className={up ? 'delta-up' : 'delta-down'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {pct(Math.abs(props.pct) / 100)}
      <span className="visually-hidden">{up ? ' increase' : ' decrease'}</span>
    </span>
  );
}

export function TableToggle(props: { pressed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ghost" aria-pressed={props.pressed} onClick={props.onToggle}>
      {props.pressed ? 'View as chart' : 'View as table'}
    </button>
  );
}
