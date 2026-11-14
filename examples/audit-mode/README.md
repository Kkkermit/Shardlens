# audit-mode

Shardlens in **audit mode**, with the ready-made `/privacy` command and opt-outs saved to a file.

Audit mode records who ran each interaction, encrypted at rest, for support and abuse handling. It has to be switched
on in both places:

1. **Collector**: set `SHARDLENS_AUDIT_KEY` (`openssl rand -base64 32`), restart, then **Settings → User identity → Identified**.
2. **SDK**: `mode: 'audit'`, as in `src/bot.ts`.

```sh
cp .env.example .env      # add DISCORD_TOKEN and SHARDLENS_INGEST_KEY
pnpm register             # registers /ping and /privacy
pnpm start
```

Update your privacy policy before turning it on: `npx shardlens privacy --audit` prints a matching paragraph. Read the
[audit mode guide](https://kkkermit.github.io/Shardlens/guides/audit-mode/) first.
