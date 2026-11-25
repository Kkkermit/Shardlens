# Set up the Shardlens collector

You are setting up the collector for Shardlens, privacy-first analytics for discord.js bots (MIT). The collector stores
what the bot's SDK (`@shardlens/discordjs`) sends and serves the dashboard. Everything you need is here; you don't need
web access. Read before you change anything, and ask me before you create anything that costs money or opens a port to
the internet.

## Pick the setup first

1. **The bot already uses MongoDB** (`mongodb` or `mongoose` in its dependencies, a connection string such as
   `MONGODB_URI` in its settings): there is no collector to run. It runs inside the bot, on that database, once the
   bot passes `createShardlens(client, { mongodb: process.env.MONGODB_URI })`. Follow the bot install prompt instead:
   https://kkkermit.github.io/Shardlens/install.md. Stop here unless I asked for a dashboard that stays open (below).
2. **No MongoDB, and I have a server with Docker and a domain**: the collector on PostgreSQL, behind Caddy for HTTPS.
3. **A dashboard that stays open for a bot on MongoDB**: the collector image on any host, pointed at the same database.

Tell me which you chose and why before you go on.

## 2. The collector on a server, with Docker

Run this in an empty folder on the server, with my domain and my Discord application ID (the bot's client ID, which the
bot's project may already have as `CLIENT_ID` or `APPLICATION_ID`):

```sh
npx shardlens init --domain stats.example.com --app-id 123456789012345678
cd shardlens && docker compose up -d
```

`init` writes `docker-compose.yml`, a `Caddyfile`, a `.env` with generated secrets and keys, and a `bot.env` with the
two settings the bot needs (`SHARDLENS_URL` and `SHARDLENS_INGEST_KEY`). Never print the `.env` or `bot.env`, and
never commit them. The domain must point at the server, with ports 80 and 443 open, before Caddy can get a
certificate. For a dashboard of my own or none, add `--dashboard own` or `--dashboard none`.

Then, in the bot's folder, the bot's two settings go wherever it reads its settings, and `npx shardlens doctor` checks
the connection. Show me its output; it never prints the key.

## 3. The image for a bot on MongoDB

The image is `ghcr.io/kkkermit/shardlens-collector`. On MongoDB it needs only:

```sh
DATABASE_URL=<the bot's own MongoDB connection string>
SHARDLENS_PUBLIC_URL=https://stats.example.com
SHARDLENS_APP_ID=123456789012345678
```

plus one way in: `SHARDLENS_READ_KEY` (from `npx shardlens keys --scope read`), or `DISCORD_CLIENT_ID` and
`DISCORD_CLIENT_SECRET` for Discord sign-in. It uses the session secret and settings key the bot generated in the
database, so don't set those. It must sit behind HTTPS (the host's own, or a reverse proxy). Keep every value in the
host's secret settings, never in a file you commit.

## Rules

- Never print, log or commit a key, a secret or a connection string.
- Don't turn on audit mode, ClickHouse or event sinks unless I asked.
- Don't publish the database's port.

## Tell me when you're done

What you set up, where each secret lives, the dashboard's address, and anything I still need to do (DNS, the bot's
settings, a first sign-in). Docs: https://kkkermit.github.io/Shardlens/getting-started/choose-your-setup/
