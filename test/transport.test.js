import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayTransport, validateGateway } from '../src/transport.js';
import { config, fakeApi, FakeTimers, FakeSocket, settle, quietLogger } from './helpers.js';

async function setup(patch = {}) {
  const timers = new FakeTimers(), api = fakeApi(), sockets = [], states = [], dispatches = [], logger = quietLogger();
  const transport = new GatewayTransport({ config: config(), api, timers, logger, random: () => 0.5, now: () => timers.time, onStatus: s => states.push(s), onDispatch: p => dispatches.push(p), socketFactory: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; }, ...patch });
  transport.start(); await settle();
  return { timers, api, sockets, states, dispatches, logger, transport };
}
function ready(ws, sequence = 0) { ws.frame({ op: 10, d: { heartbeat_interval: 1000 } }); ws.frame({ op: 0, t: 'READY', s: sequence, d: { session_id: 'session', user: { id: 'bot-platform-id' } } }); }

test('authenticate before first periodic heartbeat, including READY sequence 0', async t => {
  const f = await setup(); t.after(() => f.transport.stop()); ready(f.sockets[0]);
  assert.equal(f.transport.state, 'online');
  assert.deepEqual(f.sockets[0].sent[0].d.intents, 1 << 25); assert.equal(f.sockets[0].sent[0].d.token, 'QQBot fake-token');
  assert.equal(f.sockets[0].sent.length, 1); await f.timers.tick(1000); assert.deepEqual(f.sockets[0].sent.at(-1), { op: 1, d: 0 });
});
test('gateway that ignores pre-READY heartbeat remains connected over repeated ACK cycles', async t => {
  const f = await setup(); t.after(() => f.transport.stop());
  const ws = f.sockets[0]; ws.frame({ op: 10, d: { heartbeat_interval: 1000 } });
  await f.timers.tick(1000); assert.equal(ws.sent.length, 1); assert.equal(f.transport.pendingAck, false);
  ws.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } });
  for (let i = 0; i < 5; i++) { await f.timers.tick(1000); ws.frame({ op: 11 }); }
  assert.equal(f.sockets.length, 1); assert.equal(f.transport.state, 'online'); assert.equal(f.transport.ackCount, 5);
});
test('ACK watchdog retires silent link and resumes with sequence including 0', async t => {
  const f = await setup(); t.after(() => f.transport.stop()); ready(f.sockets[0]);
  await f.timers.tick(2000); assert.equal(f.transport.state, 'reconnecting'); assert.equal(f.sockets[0].terminated, true);
  assert.equal(f.states.at(-1).reason, 'heartbeat_timeout');
  await f.timers.tick(1000); assert.equal(f.sockets.length, 2);
  f.sockets[1].frame({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.deepEqual(f.sockets[1].sent[0], { op: 6, d: { token: 'QQBot fake-token', session_id: 'session', seq: 0 } });
  f.sockets[1].frame({ op: 0, t: 'RESUMED', s: 1, d: {} }); assert.equal(f.transport.state, 'online');
});
test('4006 / 4007 and invalid nonresumable session identify afresh', async t => {
  for (const reason of [4006, 4007, 9]) {
    const f = await setup(); t.after(() => f.transport.stop()); ready(f.sockets[0], 42);
    if (reason === 9) f.sockets[0].frame({ op: 9, d: false }); else f.sockets[0].closeCode(reason);
    await f.timers.tick(reason === 9 ? 3000 : 1000);
    f.sockets[1].frame({ op: 10, d: { heartbeat_interval: 1000 } }); assert.equal(f.sockets[1].sent[0].op, 2);
  }
});
test('4009 and opcode 7 resume, current link dispatches only once, stale callbacks ignored', async t => {
  for (const code of [4009, 7]) {
    const f = await setup(); t.after(() => f.transport.stop()); ready(f.sockets[0], 42);
    if (code === 7) f.sockets[0].frame({ op: 7 }); else f.sockets[0].closeCode(code);
    await f.timers.tick(1000); f.sockets[1].frame({ op: 10, d: { heartbeat_interval: 1000 } }); assert.equal(f.sockets[1].sent[0].op, 6);
    f.sockets[1].frame({ op: 11 }); f.sockets[1].frame({ op: 0, t: 'RESUMED', s: 43, d: {} });
    f.sockets[0].frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {} });
    f.sockets[1].frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {} }); assert.equal(f.dispatches.length, 1);
  }
});
test('terminal platform close codes stop retries, no upstream reason in logs', async () => {
  for (const code of [4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]) {
    const f = await setup(); ready(f.sockets[0]); f.sockets[0].closeCode(code); await f.timers.tick(300000);
    assert.equal(f.transport.state, 'blocked'); assert.equal(f.sockets.length, 1); assert.equal(f.timers.jobs.size, 0);
    assert.equal(f.logger.records.join().includes('upstream-secret-chat'), false); f.transport.stop();
  }
});
test('4008 rate limit delays at least 60 seconds; 4004 clears token', async t => {
  for (const code of [4008, 4004]) {
    const f = await setup(); t.after(() => f.transport.stop()); f.sockets[0].closeCode(code);
    await f.timers.tick(59999); assert.equal(f.sockets.length, 1); await f.timers.tick(1); assert.equal(f.sockets.length, 2);
    if (code === 4004) assert.equal(f.api.invalidated, 1);
  }
});
test('repeated early closes increase backoff; reaching READY alone does not reset', async t => {
  const f = await setup(); t.after(() => f.transport.stop());
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000]) {
    const before = f.sockets.length; ready(f.sockets.at(-1)); f.sockets.at(-1).closeCode(1006);
    await f.timers.tick(delay - 1); assert.equal(f.sockets.length, before); await f.timers.tick(1); assert.equal(f.sockets.length, before + 1);
  }
});
test('HELLO/READY timeouts, malformed frames and lost ACK retry with bounded state', async t => {
  const f = await setup(); t.after(() => f.transport.stop()); await f.timers.tick(15000); assert.equal(f.transport.state, 'reconnecting'); await f.timers.tick(1000);
  f.sockets[1].frame({ op: 10, d: { heartbeat_interval: -1 } }); assert.equal(f.transport.state, 'reconnecting');
  await f.timers.tick(2000); f.sockets[2].emit('message', Buffer.from('token=FAKE_SECRET not json'));
  assert.equal(f.logger.records.join().includes('FAKE_SECRET'), false); assert.equal(f.transport.state, 'reconnecting');
});
test('stop is idempotent, cancels all timers; late async connect cannot resurrect', async () => {
  let resolveToken; const api = fakeApi(); api.token = () => new Promise(resolve => { resolveToken = resolve; });
  const f = await setup({ api }); f.transport.stop(); f.transport.stop(); resolveToken('late-token'); await settle(); await f.timers.tick(100000);
  assert.equal(f.sockets.length, 0); assert.equal(f.timers.jobs.size, 0); assert.equal(f.transport.state, 'stopped');
});
test('gateway destinations restricted and HTTPS downgrade rejected', () => {
  assert.equal(validateGateway('wss://api.sgroup.qq.com/websocket'), 'wss://api.sgroup.qq.com/websocket');
  for (const url of ['ws://api.sgroup.qq.com', 'wss://evil.example', 'wss://api.sgroup.qq.com.evil.example', 'wss://user:pass@api.sgroup.qq.com', 'wss://api.sgroup.qq.com:8080']) assert.throws(() => validateGateway(url), { code: 'GATEWAY_INVALID' });
});
