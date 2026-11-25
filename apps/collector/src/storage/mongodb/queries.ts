import type { QueryStorage } from '../store.js';
import type { Mongo } from './connect.js';
import { mongoAudienceQueries } from './query/audience.js';
import { mongoChartsQueries } from './query/charts.js';
import { mongoCommandsQueries } from './query/commands.js';
import { mongoFunnelsQueries } from './query/funnels.js';
import { mongoHealthQueries } from './query/health.js';
import { mongoOverviewQueries } from './query/overview.js';
import { mongoReportsQueries } from './query/reports.js';
import { mongoServersQueries } from './query/servers.js';

export function mongoQuery(m: Mongo): QueryStorage {
  return {
    ...mongoChartsQueries(m),
    ...mongoCommandsQueries(m),
    ...mongoOverviewQueries(m),
    ...mongoFunnelsQueries(m),
    ...mongoServersQueries(m),
    ...mongoAudienceQueries(m),
    ...mongoHealthQueries(m),
    ...mongoReportsQueries(m),
  };
}
