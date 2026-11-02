import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { OfficialApi, endpoints } from '../src/api.js';
import { GatewayTransport } from '../src/transport.js';
import { AccountRegistry } from '../src/accounts.js';
import { EventMapper } from '../src/events.js';
import { config, payload, quietLogger } from './helpers.js';

test('real HTTP/ws wire sends native Markdown, media and event replies and accepts empty DELETE/ACK responses', async t => {
  const requests = [], configValue = config(), logger = quietLogger(), tasks = [];
  const server = http.createServer(async (request, response) => {
    const buffers = []; for await (const buffer of request) buffers.push(buffer);
    const raw = Buffer.concat(buffers).toString(), body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, route: request.url, body, auth: request.headers.authorization });
    if (request.url === '/app/getAppAccessToken') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ access_token: 'WIRE_FAKE_TOKEN', expires_in: 7200 })); return; }
    if (request.method === 'DELETE' || request.method === 'PUT') { response.statusCode = request.method === 'DELETE' ? 204 : 200; response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/gateway') response.end(JSON.stringify({ url: 'wss://api.bot.qq.com/websocket' }));
    else if (request.url.endsWith('/files')) response.end(JSON.stringify({ file_info: 'WIRE_FILE_INFO', ttl: 300 }));
    else response.end(JSON.stringify({ id: `WIRE_MSG_${requests.length}`, timestamp: new Date().toISOString(), ext_info: { ref_idx: 'REFIDX_wire_sent==' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, wss = new WebSocketServer({ server });
  let peer;
  wss.on('connection', socket => {
    peer = socket; socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }));
    socket.on('message', raw => { const message = JSON.parse(raw); if (message.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 0, d: { session_id: 'wire-session', user: { id: 'bot-wire' } } })); else if (message.op === 1) socket.send(JSON.stringify({ op: 11 })); });
  });
  const api = new OfficialApi({ config: configValue, appSecret: 'WIRE_FAKE_SECRET', fetchImpl: (url, init) => fetch(origin + new URL(url).pathname, init) });
  const bot = new EventEmitter(); bot.uin = 88888; bot.adapter = [];
  const registry = new AccountRegistry(bot, configValue, { logger }); registry.register();
  const mapper = new EventMapper({ registry, api, config: configValue, logger });
  let online;
  const ready = new Promise(resolve => { online = resolve; });
  const transport = new GatewayTransport({ api, config: configValue, logger, socketFactory: () => new WebSocket(origin.replace('http:', 'ws:')), onDispatch: event => mapper.dispatch(event), onStatus: state => { registry.setOnline(state.state === 'online'); if (state.state === 'online') online(); } });
  t.after(async () => { transport.stop(); api.close(); registry.dispose(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  bot.on('message', e => tasks.push((async () => {
    const first = await e.reply([e.bot.segment.markdown('**native wire**'), e.bot.segment.button([{ text: '查询', input: '#uid' }])], true);
    assert.ok(first.message_id); assert.equal(await e.group.recallMsg(first.message_id), true);
    assert.ok((await e.reply({ type: 'file', file: Buffer.from('public test document'), name: 'native-test.txt' })).message_id);
  })()));
  bot.on('notice', e => tasks.push(e.reply(e.bot.segment.markdown('callback received'))));
  transport.start();
  async function until(check) { const started = Date.now(); while (!check()) { if (Date.now() - started > 3000) throw new Error('Wire test timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
  await until(() => registry.online); await ready;
  peer.send(JSON.stringify({ ...payload('group', { group_openid: 'group-wire', message_scene: { ext: ['msg_idx=REFIDX_wire==', 'auth_token=WIRE_PRIVATE_SCENE'] } }), s: 1 }));
  await until(() => tasks.length === 1); await Promise.all(tasks);
  const interaction = { op: 0, t: 'INTERACTION_CREATE', s: 2, id: 'INTERACTION_CREATE:wire-button', d: { id: 'wire-button', type: 11, scene: 'group', chat_type: 1, group_openid: 'group-wire', group_member_openid: 'wire-user', timestamp: new Date().toISOString(), data: { resolved: { button_data: 'opaque callback', button_id: 'test' } } } };
  peer.send(JSON.stringify(interaction));
  await until(() => tasks.length === 2); await Promise.all(tasks);
  const messages = requests.filter(request => request.method === 'POST' && request.route.endsWith('/messages'));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body.msg_type, 2); assert.equal(messages[0].body.message_reference.message_id, 'REFIDX_wire=='); assert.ok(messages[0].body.keyboard);
  assert.equal(messages[1].body.msg_type, 7); assert.equal(messages[1].body.media.file_info, 'WIRE_FILE_INFO');
  assert.equal(messages[2].body.event_id, interaction.id); assert.equal(messages[2].body.msg_id, undefined);
  const file = requests.find(request => request.route.endsWith('/files')); assert.equal(file.body.file_type, 4); assert.equal(Buffer.from(file.body.file_data, 'base64').toString(), 'public test document');
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 1); assert.equal(requests.filter(request => request.method === 'PUT').length, 1);
  assert.ok(requests.filter(request => request.route !== '/app/getAppAccessToken').every(request => request.auth === 'QQBot WIRE_FAKE_TOKEN'));
  assert.equal(JSON.stringify(requests).includes('WIRE_PRIVATE_SCENE'), false); assert.equal(endpoints.production, 'https://api.bot.qq.com');
});
