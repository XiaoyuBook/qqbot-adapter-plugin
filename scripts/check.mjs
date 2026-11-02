import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = ['index.js', 'guoba.support.js'];
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(filename);
    else if (/\.m?js$/.test(entry.name)) files.push(filename);
  }
}
for (const directory of ['src', 'scripts', 'test']) await collect(directory);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
process.stdout.write(`语法检查通过：${files.length} 个文件。\n`);
