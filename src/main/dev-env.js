const fs = require('node:fs');
const path = require('node:path');

// Development convenience only. `.env` is gitignored, so a contributor can keep
// their own Google Desktop OAuth client ID out of tracked files. Packaged builds
// must ignore this entirely: the shipped client ID comes from package.json alone.
const ALLOWED_PREFIX = 'KINDLESYNC_';

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator < 1) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function loadDevEnv({ isPackaged, root, env = process.env, readFileSync = fs.readFileSync } = {}) {
  if (isPackaged) return [];
  let text;
  try {
    text = readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return [];
  }
  const applied = [];
  for (const [key, value] of parseEnv(text)) {
    // The shell always wins, and only this app's own namespace is loadable so a
    // stray file cannot inject NODE_OPTIONS or other interpreter switches.
    if (!key.startsWith(ALLOWED_PREFIX) || Object.hasOwn(env, key)) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

module.exports = { loadDevEnv, parseEnv, ALLOWED_PREFIX };
