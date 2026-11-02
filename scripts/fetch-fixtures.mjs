import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'test/host/manifest.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--from-host')) throw new Error('用法：npm run fixtures [-- --from-host 本地只读源码快照目录]');
const local = args.length ? path.resolve(args[1]) : null;
for (const [name, source] of Object.entries(manifest)) {
  for (const [file, expected] of Object.entries(source.files)) {
    const filename = path.join(root, '.verification-cache/fixtures', name, file);
    let content = await fs.readFile(filename).catch(() => null);
    if (!content || createHash('sha256').update(content).digest('hex') !== expected) {
      if (local) content = await fs.readFile(path.join(local, name === 'miao' ? '' : source.hostPath || 'plugins/napcat-adapter', file));
      else {
        let response;
        try { response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.ref}/${file}`, { signal: AbortSignal.timeout(20000), redirect: 'error' }); }
        catch { throw new Error(`Fixture download failed: ${name}/${file}. 可使用 --from-host 导入本地源码快照，仍须通过 SHA256 校验。`); }
        if (!response.ok) throw new Error(`Fixture download failed: ${name}/${file} HTTP ${response.status}`);
        content = Buffer.from(await response.arrayBuffer());
      }
      if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error(`Fixture checksum mismatch: ${name}/${file}`);
      await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content);
    }
  }
  process.stdout.write(`${name}: 固定提交与 SHA256 核验通过。\n`);
}
