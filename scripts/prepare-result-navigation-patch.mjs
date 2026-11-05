import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Scoped migration for optional result navigation in the pinned Miao host.
// The adapter core preserves buttons regardless of how they were constructed.
export const resultNavigationSources = {
  'plugins/genshin/apps/role.js': { sha256: '580e690990194ec3261739f05d9de5447fb2ebc8753c850149831f2390fdbc05', count: 6 },
  'plugins/genshin/apps/ledger.js': { sha256: '9d3f15e11e6ce3174761c164835fab70dbd98ba5d6bcf1fa44cefccb49125ad4', count: 3 }
};

export function patchResultNavigationSource(file, input) {
  const spec = resultNavigationSources[file];
  if (!spec || createHash('sha256').update(input).digest('hex') !== spec.sha256) throw new Error('Unexpected Miao source: ' + file);
  let count = 0;
  const output = input.toString('utf8').replace(/^( +)this\.button,$/gm, (_line, indent) => {
    count++; return indent + '...(this.e?.adapter === "QQBot" ? [] : [this.button]),';
  });
  if (count !== spec.count) throw new Error('Unexpected result navigation count');
  return Buffer.from(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceDir, outputDir] = process.argv.slice(2);
  if (!sourceDir || !outputDir || path.resolve(sourceDir) === path.resolve(outputDir)) throw new Error('Usage: node scripts/prepare-result-navigation-patch.mjs <miao-source> <separate-output>');
  for (const file of Object.keys(resultNavigationSources)) {
    const output = patchResultNavigationSource(file, await fs.readFile(path.join(sourceDir, file)));
    const target = path.join(outputDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, output, { flag: 'wx' });
  }
  console.log('Prepared scoped result navigation migration for two checksum-verified host files.');
}
