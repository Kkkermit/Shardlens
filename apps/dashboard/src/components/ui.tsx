import { type ReactNode, useState } from 'react';
import { PRESETS, type PresetId } from '../range';

export function Panel(props: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel" aria-label={props.title}>
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

export function PageHead(props: { title: string; description?: ReactNode; actions?: ReactNode }) {
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

export function RangePicker(props: { value: PresetId; onChange: (id: PresetId) => void }) {
  return (
    <fieldset className="segmented" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="visually-hidden">Time range</legend>
      {PRESETS.map((p) => (
        <button key={p.id} type="button" aria-pressed={props.value === p.id} onClick={() => props.onChange(p.id)}>
          {p.label}
        </button>
      ))}
    </fieldset>
  );
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

export function ErrorNote(props: { error: unknown }) {
  return (
    <div className="empty" role="alert">
      Couldn't load this: {props.error instanceof Error ? props.error.message : 'unknown error'}
    </div>
  );
}

/** Who ran something, in audit mode: avatar (Discord's CDN only), username and ID. All rendered as text. */
export function UserTag(props: { id: string | null; username: string | null; avatar: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!props.id) return <>—</>;
  const valid = props.avatar && /^(a_)?[0-9a-f]{32}$/.test(props.avatar) && /^\d{17,20}$/.test(props.id);
  return (
    <span className="guild">
      {valid && !failed ? (
        <img
          src={`https://cdn.discordapp.com/avatars/${props.id}/${props.avatar}.png?size=64`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="initials" aria-hidden="true">
          {(props.username ?? '?').slice(0, 2).toUpperCase()}
        </span>
      )}
      <span>
        {props.username ? `${props.username} ` : ''}
        <code>{props.id}</code>
      </span>
    </span>
  );
}

/** Server icon from Discord's CDN only (the CSP allows nothing else); initials when there is none. */
export function GuildIcon(props: { id: string; icon: string | null | undefined; name: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const name = props.name || 'Unknown server';
  const valid = props.icon && /^(a_)?[0-9a-f]{32}$/.test(props.icon) && /^\d{17,20}$/.test(props.id);
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 3)
    .toUpperCase();
  return (
    <span className="guild">
      {valid && !failed ? (
        <img
          src={`https://cdn.discordapp.com/icons/${props.id}/${props.icon}.png?size=64`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="initials" aria-hidden="true">
          {initials}
        </span>
      )}
      <span>{name}</span>
    </span>
  );
}

export function Delta(props: { pct: number | null | undefined }) {
  if (props.pct === null || props.pct === undefined || !Number.isFinite(props.pct)) {
    return <span className="muted">new</span>;
  }
  const up = props.pct >= 0;
  return (
    <span className={up ? 'delta-up' : 'delta-down'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {Math.abs(props.pct).toFixed(1)}%
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
