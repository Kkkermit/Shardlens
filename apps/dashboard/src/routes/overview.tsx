import { useMemo } from 'react';
import { useLive, useMeta, useSpec } from '../api';
import { TimeChart } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { ErrorNote, Loading, PageHead, Panel, Tile } from '../components/ui';
import { ago, ms, num, pct } from '../format';

interface Overview {
  servers: number;
  uniqueUsersThisPeriod: number | null;
  periodStart: string;
  lastEventAt: string | null;
  runs30d: { day: string; runs: number; failures: number | null }[];
  appInfo: {
    approxGuilds: number | null;
    approxUserInstalls: number | null;
    eventWebhooksStatus: number | null;
    sessionStartRemaining: number | null;
    sessionStartTotal: number | null;
    libVersion: string | null;
    sdkVersion: string | null;
  } | null;
  sdkInstances: {
    instance: string;
    ts: string;
    shards: number[];
    queueDepth: number;
    failedFlushes: number;
    dropped: Record<string, number>;
    sdkVersion: string | null;
  }[];
  checklist: Record<string, boolean>;
}

export function OverviewPage() {
  const meta = useMeta();
  const { tiles, stale } = useLive();
  const overview = useSpec<Overview>({ kind: 'overview' });
  const runs = overview.data?.runs30d ?? [];
  const chart = useMemo(
    () => ({
      x: runs.map((r) => Date.parse(`${r.day}T00:00:00Z`) / 1000),
      series: [
        { name: 'Runs', values: runs.map((r) => r.runs) },
        { name: 'Failed', values: runs.map((r) => r.failures ?? 0) },
      ],
    }),
    [runs],
  );
  const total30 = runs.reduce((a, r) => a + r.runs, 0);
  const failed30 = runs.reduce((a, r) => a + (r.failures ?? 0), 0);
  const o = overview.data;

  return (
    <>
      <PageHead
        title="Overview"
        description={o?.lastEventAt ? `Last event ${ago(o.lastEventAt)}` : 'Waiting for the first events from your bot'}
      />
      <div className="stack">
        <div className="grid tiles">
          <Tile live stale={stale} label="Interactions / min" value={num(tiles?.perMinute)} />
          <Tile live stale={stale} label="p95 response (5 min)" value={ms(tiles?.p95Ms5m)} sub="Deadline: 3 s" />
          <Tile live stale={stale} label="Failures (15 min)" value={num(tiles?.errors15m)} />
          <Tile
            live
            stale={stale}
            label="Active shards"
            value={num(tiles?.activeShards)}
            sub={tiles?.staleShards?.length ? `Stale: ${tiles.staleShards.join(', ')}` : undefined}
          />
          <Tile
            label="Servers"
            value={num(o?.servers)}
            sub={o?.appInfo?.approxGuilds != null ? `Discord says ~${num(o.appInfo.approxGuilds)}` : undefined}
          />
          <Tile
            label="Unique users"
            value={num(o?.uniqueUsersThisPeriod)}
            sub={o ? `Since ${o.periodStart}` : undefined}
          />
        </div>

        <Panel
          title="Runs, last 30 days"
          subtitle={`${num(total30)} runs · ${pct(total30 > 0 ? failed30 / total30 : null)} failed · UTC days`}
        >
          {overview.isLoading ? (
            <Loading />
          ) : overview.error ? (
            <ErrorNote error={overview.error} />
          ) : (
            <TimeChart
              label="Command runs and failures per day for the last 30 days"
              x={chart.x}
              series={chart.series}
            />
          )}
        </Panel>

        <div className="grid two">
          <Panel title="Setup checklist">
            <ul className="checklist">
              <Check ok={o?.checklist.receivingEvents} text="Receiving events from your bot" />
              <Check ok={o?.checklist.appInfoReceived} text="Application info received (dashboard team list)" />
              <Check
                ok={o?.checklist.webhookEventsEnabled}
                text={
                  <>
                    Webhook events enabled for user-install tracking: Developer Portal → Webhooks →{' '}
                    <code>{`${window.location.origin}/v1/discord/events`}</code>
                  </>
                }
              />
              <Check ok={o?.checklist.requiredPermissionsSet} text="Required permissions set (permission health)" />
              <Check ok={meta.data?.mode === 'privacy' || meta.data?.auditKeyConfigured} text="Data mode configured" />
            </ul>
          </Panel>
          <Panel title="Bot processes" subtitle="SDK health reported with each batch">
            {o && o.sdkInstances.length > 0 ? (
              <DataTable
                caption="SDK instances"
                rowKey={(r) => r.instance}
                rows={o.sdkInstances}
                columns={[
                  { key: 'instance', header: 'Instance', render: (r) => r.instance },
                  { key: 'shards', header: 'Shards', render: (r) => r.shards.join(', ') || '—' },
                  { key: 'seen', header: 'Last seen', render: (r) => ago(r.ts), sort: (r) => r.ts },
                  { key: 'queue', header: 'Queued', numeric: true, render: (r) => num(r.queueDepth) },
                  {
                    key: 'dropped',
                    header: 'Dropped',
                    numeric: true,
                    render: (r) => num(Object.values(r.dropped).reduce((a, b) => a + b, 0)),
                  },
                  { key: 'failed', header: 'Failed sends', numeric: true, render: (r) => num(r.failedFlushes) },
                ]}
              />
            ) : (
              <p className="muted">No SDK has reported yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function Check(props: { ok: boolean | undefined; text: React.ReactNode }) {
  return (
    <li>
      <span className={`badge ${props.ok ? 'good' : ''}`} aria-hidden="true">
        {props.ok ? '✓' : '○'}
      </span>
      <span>
        <span className="visually-hidden">{props.ok ? 'Done: ' : 'To do: '}</span>
        {props.text}
      </span>
    </li>
  );
}
