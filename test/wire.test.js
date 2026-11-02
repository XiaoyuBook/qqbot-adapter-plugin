import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { OfficialApi } from '../src/api.js';
import { GatewayTransport } from '../src/transport.js';
import { AccountRegistry } from '../src/accounts.js';
import { EventMapper } from '../src/events.js';
import { config, host, payload, png, quietLogger } from './helpers.js';

async function until(condition) {
  const limit = Date.now() + 8000;
  while (!condition()) { if (Date.now() > limit) throw new Error('Local wire test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('real HTTP + ws wire: authentication, READY, text/image passive reply, reconnect RESUME and replay suppression', { timeout: 12000 }, async t => {
  const posts = [], identifies = [], clients = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/app/getAppAccessToken') {
      assert.deepEqual(body, { appId: '123456', clientSecret: 'FAKE_WIRE_SECRET' });
      response.end(JSON.stringify({ access_token: 'FAKE_WIRE_TOKEN', expires_in: 7200 })); return;
    }
    assert.equal(request.headers.authorization, 'QQBot FAKE_WIRE_TOKEN');
    if (request.url === '/gateway') { response.end(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket' })); return; }
    posts.push({ url: request.url, body });
    response.end(JSON.stringify(request.url.endsWith('/files') ? { file_info: 'WIRE_FILE_INFO', ttl: 60 } : { id: `wire-${posts.length}`, timestamp: 1 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const wss = new WebSocketServer({ server });
  const event = payload();
  wss.on('connection', socket => {
    clients.push(socket);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if ([2, 6].includes(frame.op)) {
        identifies.push(frame);
        socket.send(JSON.stringify({ op: 0, t: frame.op === 2 ? 'READY' : 'RESUMED', s: clients.length, d: { session_id: 'WIRE_SESSION', user: { id: 'wire-bot' } } }));
        socket.send(JSON.stringify(event)); socket.send(JSON.stringify({ ...event, s: 20 }));
      }
    });
  });
  const cfg = config(), logger = quietLogger(), bot = host();
  const registry = new AccountRegistry(bot, cfg); registry.register();
  const api = new OfficialApi({ config: cfg, appSecret: 'FAKE_WIRE_SECRET', fetchImpl: (url, options) => fetch(`${base}${new URL(url).pathname}`, options) });
  const mapper = new EventMapper({ registry, api, config: cfg, logger });
  const replies = []; let events = 0;
  bot.on('message', e => { events++; replies.push(e.reply(['wire text', { type: 'image', file: png }])); });
  const transport = new GatewayTransport({ api, config: cfg, logger, random: () => 0.5,
    socketFactory: () => new WebSocket(base.replace('http:', 'ws:')),
    onStatus: status => registry.setOnline(status.state === 'online'), onDispatch: event => mapper.dispatch(event)
  });
  t.after(async () => { transport.stop(); api.close(); registry.dispose(); for (const socket of clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  transport.start();
  await until(() => posts.length === 2); await Promise.all(replies);
  assert.equal(events, 1); assert.equal(posts[1].body.msg_id, event.d.id); assert.equal(posts[1].body.msg_seq, 1); assert.equal(posts[0].body.srv_send_msg, false); assert.equal(posts[1].body.content, 'wire text');
  clients[0].close(4009); await until(() => identifies.length === 2 && transport.state === 'online');
  assert.equal(identifies[1].op, 6); assert.equal(identifies[1].d.session_id, 'WIRE_SESSION');
  clients[1].send(JSON.stringify(payload('c2c'))); await until(() => posts.length === 4); await Promise.all(replies);
  assert.equal(events, 2); assert.equal(posts[3].url, '/v2/users/c2c-openid/messages');
  assert.equal(logger.records.join().includes('FAKE_WIRE_SECRET'), false); assert.equal(logger.records.join().includes('FAKE_WIRE_TOKEN'), false);
});
