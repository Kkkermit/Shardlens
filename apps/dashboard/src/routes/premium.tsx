import { updating, useSpec } from '../api';
import { BarList } from '../components/charts';
import { DataTable } from '../components/DataTable';
import { Name, PageHead, Panel, QueryBody, RangePicker, Tile } from '../components/ui';
import { money, num, pct } from '../format';
import { useRange } from '../range';

interface Premium {
  changes: { sku: string; name: string; action: string; count: number; testCount: number }[];
  activeEntitlements: { sku: string; name: string; active: number }[];
  subscriptions: {
    sku: string;
    name: string;
    active: number;
    ending: number;
    inactive: number;
    price: { amount: number; currency: string } | null;
  }[];
  premiumShare: number | null;
  estimatedMonthlyRevenue: Record<string, number>;
  pricesConfigured: boolean;
}

export function PremiumPage() {
  const r = useRange();
  const q = useSpec<Premium>({ kind: 'premium', range: r.range });
  const p = q.data;
  const activeSubs = (p?.subscriptions ?? []).reduce((a, s) => a + s.active + s.ending, 0);
  const revenue = Object.entries(p?.estimatedMonthlyRevenue ?? {})
    .map(([currency, amount]) => money(amount, currency))
    .join(' + ');
  return (
    <>
      <PageHead
        title="Premium"
        description="Entitlements and subscriptions from Discord's monetisation. Discord sends SKU IDs, not amounts."
        actions={<RangePicker value={r.id} onChange={r.setId} />}
      />
      <QueryBody query={q}>
        <div className="stack" aria-busy={updating(q) || undefined}>
          <div className="grid tiles">
            <Tile label="Active subscriptions" value={num(activeSubs)} />
            <Tile label="Premium share of runs" value={pct(p?.premiumShare)} />
            <Tile
              label="Estimated revenue"
              value={revenue || '—'}
              sub={p?.pricesConfigured ? 'From your SKU prices' : 'Set SKU prices in Settings'}
            />
          </div>
          <div className="grid two">
            <Panel title="Subscriptions by SKU">
              <DataTable
                caption="Subscriptions by SKU"
                rowKey={(s) => s.sku}
                rows={p?.subscriptions ?? []}
                columns={[
                  { key: 'sku', header: 'SKU', render: (s) => <Name>{s.name}</Name> },
                  { key: 'active', header: 'Active', numeric: true, render: (s) => num(s.active) },
                  { key: 'ending', header: 'Ending', numeric: true, render: (s) => num(s.ending) },
                  { key: 'inactive', header: 'Ended', numeric: true, render: (s) => num(s.inactive) },
                ]}
              />
            </Panel>
            <Panel title="Active entitlements">
              <BarList
                label="Active entitlements by SKU"
                rows={(p?.activeEntitlements ?? []).map((e) => ({
                  key: e.sku,
                  name: <Name>{e.name}</Name>,
                  value: e.active,
                }))}
              />
            </Panel>
          </div>
          <Panel title="Entitlement changes" subtitle="In this range, test entitlements counted separately">
            <DataTable
              caption="Entitlement changes"
              rowKey={(c) => `${c.sku}-${c.action}`}
              rows={p?.changes ?? []}
              columns={[
                { key: 'sku', header: 'SKU', render: (c) => <Name>{c.name}</Name> },
                { key: 'action', header: 'Change', render: (c) => c.action },
                { key: 'count', header: 'Count', numeric: true, render: (c) => num(c.count) },
                { key: 'test', header: 'Of which test', numeric: true, render: (c) => num(c.testCount) },
              ]}
            />
          </Panel>
        </div>
      </QueryBody>
    </>
  );
}
