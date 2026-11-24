import type { Db } from '../../db.js';
import type { QueryStorage } from '../store.js';
import { eventProps, events, funnel, retention } from './query/funnels.js';
import {
  audience,
  bursts,
  command,
  commands,
  gauge,
  growth,
  guildNames,
  heatmap,
  overview,
  series,
  server,
  servers,
  top,
} from './query/pages.js';
import { badgeValue, installs, premium, reliability } from './query/reports.js';

export function postgresQueries(db: Db): QueryStorage {
  return {
    series: (appId, spec, metric, now) => series(db, appId, spec, metric, now),
    top: (appId, spec, metric, now) => top(db, appId, spec, metric, now),
    heatmap: (appId, spec, metric, now) => heatmap(db, appId, spec, metric, now),
    commands: (appId, spec, now) => commands(db, appId, spec, now),
    command: (appId, spec, now) => command(db, appId, spec, now),
    servers: (appId, spec) => servers(db, appId, spec),
    server: (appId, spec, now) => server(db, appId, spec, now),
    growth: (appId, spec, now) => growth(db, appId, spec, now),
    audience: (appId, spec, now) => audience(db, appId, spec, now),
    overview: (appId, _spec, now) => overview(db, appId, now),
    gauge: (appId, spec) => gauge(db, appId, spec),
    bursts: (appId, spec, now) => bursts(db, appId, spec, now),
    reliability: (appId, spec, now) => reliability(db, appId, spec.range, now),
    premium: (appId, spec, now) => premium(db, appId, spec.range, now),
    installs: (appId, spec) => installs(db, appId, spec.range, spec.timezone),
    events: (appId, spec) => events(db, appId, spec),
    eventProps: (appId, spec) => eventProps(db, appId, spec),
    funnel: (appId, spec) => funnel(db, appId, spec),
    retention: (appId, spec) => retention(db, appId, spec),
    guildNames: (appId, ids) => guildNames(db, appId, ids),
    badge: (appId, metric) => badgeValue(db, appId, metric),
  };
}
