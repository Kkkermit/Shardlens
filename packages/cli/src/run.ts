import { parseArgs } from 'node:util';
import { doctor, init, newKey, privacyParagraph, type Scope } from './commands.js';

const HELP = `shardlens <command> [options]

Commands
  init      Write docker-compose.yml, Caddyfile and a .env with generated secrets and keys
            --dir <path> (default ./shardlens)  --domain <host>  --app-id <id>  [--force]
            [--identify-users]  also create the key that allows identified users (audit mode)
  keys      Print a new API key            --scope ingest|read (default ingest)
  privacy   Print a privacy-policy paragraph matching your setup
            [--audit] [--ids-only] [--option-values a,b] [--webhook-events] [--retention <days>]
  doctor    Check Node, discord.js, the collector and your key
            [--url <collector>] [--key <slk_ingest_…>]  (or SHARDLENS_URL / SHARDLENS_INGEST_KEY)
`;

/** Runs one invocation of the CLI and returns its exit code. */
export async function run(argv: string[]): Promise<number> {
  // The command is the first word that isn't an option, so `shardlens --help` and `shardlens init --help` both work.
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      domain: { type: 'string' },
      'app-id': { type: 'string' },
      force: { type: 'boolean' },
      scope: { type: 'string' },
      audit: { type: 'boolean' },
      'ids-only': { type: 'boolean' },
      'identify-users': { type: 'boolean' },
      'option-values': { type: 'string' },
      'webhook-events': { type: 'boolean' },
      retention: { type: 'string' },
      url: { type: 'string' },
      key: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, unexpected] = positionals;
  if (!command || values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (unexpected !== undefined) {
    console.error(`Unexpected argument "${unexpected}".\n`);
    console.log(HELP);
    return 2;
  }
  switch (command) {
    case 'init': {
      if (!values.domain || !values['app-id']) {
        console.error('init needs --domain and --app-id');
        return 2;
      }
      const result = await init({
        dir: values.dir ?? 'shardlens',
        domain: values.domain,
        appId: values['app-id'],
        force: values.force ?? false,
        identifyUsers: values['identify-users'] ?? false,
      });
      console.log(`Wrote ${result.written.join(', ')} to ${result.dir}`);
      console.log('Your ingest and read keys are in .env (SHARDLENS_INGEST_KEY, SHARDLENS_READ_KEY).');
      console.log(
        `Next: point DNS for ${values.domain} at this server, then run: cd ${result.dir} && docker compose up -d`,
      );
      return 0;
    }
    case 'keys': {
      const scope = (values.scope ?? 'ingest') as Scope;
      if (scope !== 'ingest' && scope !== 'read') {
        console.error('--scope must be ingest or read');
        return 2;
      }
      console.log(newKey(scope));
      console.error('Add it to the collector .env (it stores only a hash) or create keys in Settings → API keys.');
      return 0;
    }
    case 'privacy': {
      const retention = values.retention ? Number(values.retention) : undefined;
      console.log(
        privacyParagraph({
          audit: values.audit ?? false,
          idsOnly: values['ids-only'] ?? false,
          optionValues:
            values['option-values']
              ?.split(',')
              .map((s) => s.trim())
              .filter(Boolean) ?? [],
          webhookEvents: values['webhook-events'] ?? false,
          ...(retention ? { retentionDays: retention } : {}),
        }),
      );
      console.error('\nThis is a starting point, not legal advice: check it against your own bot and obligations.');
      return 0;
    }
    case 'doctor': {
      const url = values.url ?? process.env.SHARDLENS_URL;
      const key = values.key ?? process.env.SHARDLENS_INGEST_KEY;
      const checks = await doctor({ ...(url ? { url } : {}), ...(key ? { key } : {}) });
      for (const c of checks) console.log(`${c.ok ? '✓' : c.warnOnly ? '!' : '✗'} ${c.name}: ${c.detail}`);
      return checks.some((c) => !c.ok && !c.warnOnly) ? 1 : 0;
    }
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 2;
  }
}
