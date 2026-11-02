import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Minimal log-only repair for the checksum-pinned GPLv3 Xiaoyao source.
export const qrLogSources = {
  'model/mhyTopUpLogin.js': 'fe87c3525b2647a95d0bc865851d371cbabce6c877fa2aa5ee8e2b509075775a',
  'model/mys/mihoyoApi.js': '27953c219d709fbdb24d2afa7dbd511987b00a17b10b93cfb5e92e4d12fb7ad7'
};

export function patchQrLogSource(file, input) {
  if (!qrLogSources[file] || createHash('sha256').update(input).digest('hex') !== qrLogSources[file]) throw new Error(`Unexpected Xiaoyao source: ${file}`);
  let output = input.toString('utf8');
  if (file === 'model/mhyTopUpLogin.js') {
    let count = 0;
    output = output.replace(/^([ \t]*)Bot\.logger\.mark\(JSON\.stringify\(res\)\)/gm, (_all, indent) => `${indent}Bot.logger.mark('[米哈游扫码登录] ${++count === 1 ? '二维码已扫描' : '扫码已确认'}')`);
    if (count !== 2) throw new Error('Unexpected QR status log count');
  } else {
    const replacements = [
      ['logger.error(error.toString())', "logger.error('[米游社接口] 请求失败')"],
      ['Bot.logger.debug(`[米游社接口][请求参数] ${url} ${JSON.stringify(param)}`)', "Bot.logger.debug('[米游社接口] 请求未成功')"]
    ];
    for (const [before, after] of replacements) {
      if (output.split(before).length !== 2) throw new Error('Unexpected QR request log count');
      output = output.replace(before, after);
    }
  }
  return Buffer.from(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceDir, outputDir] = process.argv.slice(2);
  if (!sourceDir || !outputDir || path.resolve(sourceDir) === path.resolve(outputDir)) throw new Error('Usage: node scripts/prepare-qr-log-patch.mjs <source-dir> <separate-output-dir>');
  for (const file of Object.keys(qrLogSources)) {
    const patched = patchQrLogSource(file, await fs.readFile(path.join(sourceDir, file)));
    const target = path.join(outputDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, patched, { flag: 'wx' });
  }
  console.log('Prepared four log-only replacements in two checksum-verified files.');
}
