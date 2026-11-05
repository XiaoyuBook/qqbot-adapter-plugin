import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { payload, png } from '../helpers.js';

const link = 'https://b23.tv/example';
const card = () => ({ message_type: 3, content: '[哔哩哔哩]', ark_data: { ark_type: 'miniapp', fields: { jump_url: link, title: '示例视频', preview: 'https://example.test/cover.png' } } });
const incoming = patch => ({ ...payload('group', { content: '', ...patch }), t: 'GROUP_MESSAGE_CREATE' });
async function parser(f, execute) {
  const events = [];
  class VideoParser extends f.Plugin {
    constructor() { super({ name: 'share-link-probe', event: 'message.*', rule: [{ reg: /(bilibili.com|b23.tv|t.bilibili.com|bili2233.cn|^BV[1-9a-zA-Z]{10}$|^av\d+$)/i, fnc: 'parse', log: false }] }); }
    async parse(e) { events.push(e); if (execute) await execute(e); return true; }
  }
  await f.loader.loadPlugin({ name: 'share-link-probe' }, VideoParser); return events;
}

test('real Miao loader routes an independent unmentioned share card into link parsing and image/video replies', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true, mentionBeforeImage: true } }); f.groupCfg.onlyReplyAt = 0;
  const events = await parser(f, async e => { await e.reply({ type: 'image', file: png }); await e.reply({ type: 'video', file: 'https://example.test/video.mp4' }); });
  const p = incoming(card()); await f.mapper.dispatch(p); await f.flush();
  assert.equal(events.length, 1); assert.equal(events[0].msg, link); assert.equal(events[0].atBot, false);
  const sends = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(sends.length, 2); assert.equal(sends[0].body.msg_type, 2);
  assert.match(sends[0].body.markdown.content, /^<qqbot-at-user[^>]+\/>\n!\[/);
  assert.equal(sends[1].body.msg_type, 7); assert.ok(sends[1].body.media.file_info);
  assert.ok(sends.every(call => call.body.msg_id === p.d.id));
  await f.mapper.dispatch({ ...p, t: 'GROUP_AT_MESSAGE_CREATE' }); await f.flush(); assert.equal(events.length, 1);
});

test('real loader recognizes nested parallel cards, plain links and private cards once each', async t => {
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
    assert.equal(events.length, 1); assert.equal(events[0].msg, link);
  });
});

test('real loader never parses links from quoted history, card labels, previews or another author', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true } }); f.groupCfg.onlyReplyAt = 0;
  const events = await parser(f);
  for (const [id, patch] of [
    ['quote', { message_type: 103, content: '#帮助', msg_elements: [card()] }],
    ['history', { message_type: 102, content: link, msg_elements: [card()] }],
    ['unknown-card', { message_type: 3, content: link, ark_data: { prompt: link, fields: { title: link, preview: link } } }],
    ['foreign-author', { message_type: 101, msg_elements: [{ ...card(), author: { member_openid: 'someone-else' } }] }],
    ['ordinary-command', { content: '#帮助' }]
  ]) { await f.mapper.dispatch(incoming({ id, ...patch })); await f.flush(); }
  assert.equal(events.length, 0); assert.equal(f.api.calls.length, 0);
});

test('independent share cards still respect host mention rules and group allowlists', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true, allowedGroupOpenids: ['group-openid'] } });
  const events = await parser(f);
  await f.mapper.dispatch(incoming(card())); await f.flush(); assert.equal(events.length, 0);
  f.groupCfg.onlyReplyAt = 0;
  assert.equal(await f.mapper.dispatch(incoming({ id: 'denied', group_openid: 'other-group', ...card() })), false);
  await f.flush(); assert.equal(events.length, 0);
});
