import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseActivitySearch } from './activity-search';
import { parseSearch, stringifySearch } from './address';
import { ApiError, onUnauthorized } from './api';
import { ActivityPage } from './routes/activity';
import { AlertsPage } from './routes/alerts';
import { AudiencePage } from './routes/audience';
import { CommandPage, CommandsPage } from './routes/commands';
import { EventsPage } from './routes/events';
import { GrowthPage } from './routes/growth';
import { OverviewPage } from './routes/overview';
import { PremiumPage } from './routes/premium';
import { ReliabilityPage } from './routes/reliability';
import { ReportsPage } from './routes/reports';
import { ServerPage, ServersPage } from './routes/servers';
import { SettingsPage } from './routes/settings';
import { NotFound, Root } from './routes/shell';
import { TimePage } from './routes/time-patterns';
import { parseServerListSearch } from './server-list';
import { applyTheme, storedTheme } from './theme';
import './styles/tokens.css';
import './styles/app.css';

// Before first paint, and not from an inline script: the CSP forbids one.
applyTheme(storedTheme());

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });
const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/commands', component: CommandsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/commands/$name', component: CommandPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/servers',
    component: ServersPage,
    validateSearch: parseServerListSearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/servers/$id', component: ServerPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/growth', component: GrowthPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/audience', component: AudiencePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/time', component: TimePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/reliability', component: ReliabilityPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/premium', component: PremiumPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/events', component: EventsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/activity',
    component: ActivityPage,
    validateSearch: parseActivitySearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/alerts', component: AlertsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/reports', component: ReportsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: OverviewPage }),
];
const router = createRouter({ routeTree: rootRoute.addChildren(routes), parseSearch, stringifySearch });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

// A session that expired or was ended in another tab: ask again who is signed in, so Root shows the sign-in page.
onUnauthorized(() => void queryClient.invalidateQueries({ queryKey: ['me'] }));

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
