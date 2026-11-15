// Per-server prefixes, kept in a JSON file. Servers without one use the default.
const fs = require('node:fs');
const FILE = './data/prefixes.json';
const DEFAULT_PREFIX = '!';

let prefixes = {};
try {
  prefixes = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  prefixes = {};
}

module.exports = {
  get(guildId) {
    return (guildId && prefixes[guildId]) || DEFAULT_PREFIX;
  },
  set(guildId, prefix) {
    prefixes[guildId] = prefix;
    fs.mkdirSync('./data', { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(prefixes));
  },
};
