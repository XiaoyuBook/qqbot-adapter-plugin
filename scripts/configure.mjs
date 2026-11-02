import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ConfigStore } from '../src/config.js';
import { safeError } from '../src/errors.js';

const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !['--init', '--enable', '--disable'].includes(flag)) || (flags.has('--enable') && flags.has('--disable'))) {
  process.stderr.write('参数仅支持 --init / --enable / --disable；不接受命令行密钥。\n');
  process.exitCode = 1;
} else {
  try {
    const store = new ConfigStore();
    if (flags.has('--init')) {
      await store.save({});
      process.stdout.write('已创建私有配置（默认禁用）。请在本地安全终端配置凭据。\n');
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) throw new Error('TTY_REQUIRED');
      const existing = await store.publicData();
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      let appId;
      try { appId = (await terminal.question('AppID（空值保留）: ')).trim() || existing.appId; }
      finally { terminal.close(); }
      process.stdout.write('AppSecret（隐藏输入，空值保留）: ');
      const appSecret = await new Promise((resolve, reject) => {
        let value = '';
        const input = process.stdin;
        const finish = (error) => {
          input.off('data', read);
          input.setRawMode(false);
          input.pause();
          process.stdout.write('\n');
          error ? reject(error) : resolve(value);
          value = '';
        };
        const read = chunk => {
          for (const char of chunk.toString('utf8')) {
            if (char === '\u0003' || char === '\u0004') return finish(new Error('CANCELLED'));
            if (char === '\r' || char === '\n') return finish();
            if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
            else if (char >= ' ' && value.length < 4096) value += char;
          }
        };
        input.setRawMode(true);
        input.on('data', read);
        input.resume();
      });
      await store.save({ appId, appSecret, ...(flags.has('--enable') ? { enabled: true } : flags.has('--disable') ? { enabled: false } : {}) });
      process.stdout.write('已私有保存。命令行配置在下次加载插件时生效；本工具不会重启服务。\n');
    }
  } catch (error) {
    process.stderr.write(`${error.message === 'TTY_REQUIRED' ? '请在本机或 SSH 的交互终端运行，密钥不会从参数、管道或聊天接收。' : error.message === 'CANCELLED' ? '已取消，未保存。' : safeError(error, 'CONFIG_PRIVATE').message}\n`);
    process.exitCode = 1;
  }
}
