import fs from 'node:fs/promises';

// Read one source of truth for help images and the registered account.
export const pluginVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
