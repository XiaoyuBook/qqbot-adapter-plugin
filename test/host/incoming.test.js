import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { payload, png } from '../helpers.js';

const link = 'https://b23.tv/example';
const ark = () => ({ ark_type: 'miniapp', fields: { jump_url: link, title: '示例视频', preview: 'https://example.test/cover.png', provider_extra: { source: 'fixture' } } });
const card = (patch = {}) => ({ message_type: 3, content: '[哔哩哔哩]', ark_data: { ...ark(), ...patch } });
const incoming = patch => ({ ...payload('group', { content: '', ...patch }), t: 'GROUP_MESSAGE_CREATE' });

async function parser(f, { reg = /(bilibili.com|b23.tv|t.bilibili.com|bili2233.cn|^BV[1-9a-zA-Z]{10}$|^av\d+$)/i, execute } = {}) {
  const events = [];
  class Probe extends f.Plugin {
    constructor() { super({ name: 'share-card-probe', event: 'message.*', rule: [{ reg, fnc: 'parse', log: false }] }); }
    async parse(e) { events.push(e); if (execute) await execute(e); return true; }
  }
  await f.loader.loadPlugin({ name: 'share-card-probe' }, Probe);
  return events;
}

function jsonOf(event) { return JSON.parse(event.message.find(item => item.type === 'json').data); }

test('real Miao loader routes an independent unmentioned card as native JSON and preserves replies', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true, mentionBeforeImage: true } }); f.groupCfg.onlyReplyAt = 0;
  const events = await parser(f, { execute: async e => { await e.reply({ type: 'image', file: png }); await e.reply({ type: 'video', file: 'https://example.test/video.mp4' }); } });
  const p = incoming(card()); await f.mapper.dispatch(p); await f.flush();
  assert.equal(events.length, 1); assert.equal(events[0].atBot, false); assert.deepEqual(jsonOf(events[0]), ark());
  assert.equal(events[0].msg, JSON.stringify(ark()));
  const sends = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(sends.length, 2); assert.equal(sends[0].body.msg_type, 2);
  assert.match(sends[0].body.markdown.content, /^<qqbot-at-user[^>]+\/>\n!\[/);
  assert.equal(sends[1].body.msg_type, 7); assert.ok(sends[1].body.media.file_info);
  assert.ok(sends.every(call => call.body.msg_id === p.d.id));
  await f.mapper.dispatch({ ...p, t: 'GROUP_AT_MESSAGE_CREATE' }); await f.flush(); assert.equal(events.length, 1);
});

test('real loader exposes the same JSON contract for nested, duplicate, plain-link and C2C cards', async t => {
  const cases = [
    ['parallel', incoming({ message_type: 101, msg_elements: [{ message_type: 101, msg_elements: [card()] }] })],
    ['plain', incoming({ content: link })],
    ['duplicate', incoming({ message_type: 101, content: link, msg_elements: [card(), card()] })],
    ['private-card', payload('c2c', card())]
  ];
  for (const [name, event] of cases) await t.test(name, async t => {
    const f = await harness(t, { adapterConfig: { receiveGroupMessages: true } }); f.groupCfg.onlyReplyAt = 0;
    const events = await parser(f);
    await f.mapper.dispatch(event); await f.flush();
    assert.equal(events.length, 1);
    if (name === 'plain') assert.equal(events[0].msg, link);
    else assert.ok(events[0].msg.includes('https://b23.tv/example'));
    if (name !== 'plain') assert.deepEqual(jsonOf(events[0]), ark());
  });
});

test('history, quotes and other authors stay out of the current message while business consumers receive card JSON', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true } }); f.groupCfg.onlyReplyAt = 0;
  const linkEvents = await parser(f);
  for (const [id, patch] of [
    ['quote', { message_type: 103, content: '#帮助', msg_elements: [card()] }],
    ['history', { message_type: 102, content: link, msg_elements: [card()] }],
    ['foreign-author', { message_type: 101, msg_elements: [{ ...card(), author: { member_openid: 'someone-else' } }] }],
    ['ordinary-command', { content: '#帮助' }]
  ]) { await f.mapper.dispatch(incoming({ id, ...patch })); await f.flush(); }
  assert.equal(linkEvents.length, 0);

  const cardEvents = await parser(f, { reg: /^\{/ });
  const current = incoming(card({ fields: { title: '#卡片标题', preview: 'https://example.test/cover.png', provider_extra: { source: 'fixture' } } }));
  await f.mapper.dispatch(current); await f.flush();
  assert.equal(cardEvents.length, 1);
  assert.equal(JSON.parse(cardEvents[0].msg).fields.title, '#卡片标题');
  assert.equal(cardEvents[0].message[0].type, 'json');
});

test('independent share cards still respect host mention rules and group allowlists', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true, allowedGroupOpenids: ['group-openid'] } });
  const events = await parser(f);
  await f.mapper.dispatch(incoming(card())); await f.flush(); assert.equal(events.length, 0);
  f.groupCfg.onlyReplyAt = 0;
  assert.equal(await f.mapper.dispatch(incoming({ id: 'denied', group_openid: 'other-group', ...card() })), false);
  await f.flush(); assert.equal(events.length, 0);
});
