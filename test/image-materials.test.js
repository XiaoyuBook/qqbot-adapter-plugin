import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageReplies } from '../src/image-reply.js';
import { prepareMedia } from '../src/media.js';
import { AdapterError } from '../src/errors.js';
import { png, config, FakeTimers, quietLogger, settle } from './helpers.js';

const reference = 'qqbot-media://image/v1/FAKE_TOKEN';
const image = () => prepareMedia('image', png, config(), 'original.png');
function network({ pages = [{ images: [], total: '0', next_cursor: '' }], ids = ['owned'], complete, remove, upload } = {}) {
  const calls = [], uploads = [];
  let page = 0, created = 0;
  return {
    calls, uploads,
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (method === 'GET') return typeof pages === 'function' ? pages(route, page++) : pages[page++];
      if (route.endsWith('/prepare')) return { upload_id: `upload-${created}`, presigned_url: 'https://unit.myqcloud.com/upload?signature=FAKE_SIGNED' };
      if (route.endsWith('/complete')) {
        const result = { image_id: ids[created] ?? `owned-${created}`, url: reference, ttl: 7776000, preview_url: 'https://unit.myqcloud.com/preview?signature=FAKE_SIGNED' };
        created++;
        return complete ? complete(result) : result;
      }
      if (method === 'DELETE') return remove ? remove(route) : {};
      throw new Error('Unexpected fake network operation');
    },
    async uploadPart(url, bytes, mime) { uploads.push({ url, bytes, mime }); return upload?.(url, bytes, mime); }
  };
}
const deletes = api => api.calls.filter(call => call.method === 'DELETE');
const prepares = api => api.calls.filter(call => call.route.endsWith('/prepare'));
function gate() {
  let resolve;
  const promise = new Promise(ready => { resolve = ready; });
  return { promise, resolve };
}

test('public HTTPS images call the sender directly without material requests', async () => {
  const api = network(), replies = new ImageReplies(api), url = 'https://example.test/image.png';
  let callbackCalls = 0;
  const result = await replies.send(await prepareMedia('image', url, config()), async (...args) => {
    callbackCalls++; assert.deepEqual(args, [url]); return { message_id: 'message' };
  });
  assert.equal(replies.api, api); assert.equal(callbackCalls, 1);
  assert.deepEqual(result, { message_id: 'message' }); assert.deepEqual(api.calls, []);
});

test('local images list every cursor page, upload a unique filename and delete only the new completed image', async () => {
  const api = network({ pages: [
    { images: [{ image_id: 'gallery-a' }], total: '2', next_cursor: 'cursor/a?=' },
    { images: [{ image_id: 'gallery-b' }], total: 2, next_cursor: '' }
  ] });
  const replies = new ImageReplies(api), prepared = await image();
  const result = await replies.send(prepared, async (...args) => {
    assert.deepEqual(args, [reference]); assert.equal(deletes(api).length, 0); return 'sent';
  });
  assert.equal(result, 'sent');
  assert.deepEqual(api.calls.filter(call => call.method === 'GET').map(call => call.route), ['/v2/media-images', '/v2/media-images?cursor=cursor%2Fa%3F%3D']);
  assert.match(prepares(api)[0].body.file_name, /^reply-[a-z0-9-]+\.png$/);
  assert.equal(prepared.fileName, 'original.png');
  assert.deepEqual(api.uploads[0].bytes, png); assert.equal(api.uploads[0].mime, 'image/png');
  assert.deepEqual(deletes(api).map(call => call.route), ['/v2/media-images/owned/delete']);
});

test('a deduplicated pre-existing gallery image is never deleted', async () => {
  const api = network({ pages: [{ images: [{ image_id: 'gallery' }], total: 1, next_cursor: '' }], ids: ['gallery'] });
  const replies = new ImageReplies(api);
  assert.equal(await replies.send(await image(), async () => 'sent'), 'sent');
  assert.deepEqual(deletes(api), []);
});

test('an uncertain callback failure is returned unchanged and cleans up after five minutes without resending', async () => {
  const timers = new FakeTimers(), api = network(), replies = new ImageReplies(api, { timers });
  const failure = new AdapterError('API_NETWORK'); let attempts = 0;
  await assert.rejects(replies.send(await image(), async () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 1); assert.deepEqual(deletes(api), []); assert.equal(timers.jobs.size, 1);
  await timers.tick(299999); assert.deepEqual(deletes(api), []);
  await timers.tick(1); assert.equal(deletes(api).length, 1); assert.equal(attempts, 1); assert.equal(timers.jobs.size, 0);
});

test('cleanup failure preserves the sent result and retries every thirty seconds at most three times total', async () => {
  const timers = new FakeTimers(), logger = quietLogger();
  const api = network({ remove: () => { throw new Error('FAKE_PRIVATE_ID FAKE_SIGNED_URL'); } });
  const replies = new ImageReplies(api, { timers, logger }); let sends = 0;
  assert.equal(await replies.send(await image(), async () => { sends++; return 'delivered'; }), 'delivered');
  assert.equal(deletes(api).length, 1); assert.equal(timers.jobs.size, 1);
  await timers.tick(29999); assert.equal(deletes(api).length, 1);
  await timers.tick(1); assert.equal(deletes(api).length, 2);
  await timers.tick(30000); assert.equal(deletes(api).length, 3);
  await timers.tick(300000); assert.equal(deletes(api).length, 3); assert.equal(timers.jobs.size, 0); assert.equal(sends, 1);
  assert.equal(logger.records.length, 3);
  for (const entry of logger.records) {
    assert.match(entry, /API_RESPONSE/);
    assert.doesNotMatch(entry, /FAKE_PRIVATE|FAKE_SIGNED|owned|qqbot-media|https:/);
  }
});

test('deferred cleanup also bounds retries and does not retry the uncertain message', async () => {
  const timers = new FakeTimers(), api = network({ remove: () => { throw new AdapterError('API_NETWORK'); } });
  const replies = new ImageReplies(api, { timers }); let sends = 0;
  await assert.rejects(replies.send(await image(), async () => { sends++; throw new AdapterError('API_NETWORK'); }), { code: 'API_NETWORK' });
  await timers.tick(300000); assert.equal(deletes(api).length, 1);
  await timers.tick(60000); assert.equal(deletes(api).length, 3);
  await timers.tick(300000); assert.equal(deletes(api).length, 3); assert.equal(timers.jobs.size, 0); assert.equal(sends, 1);
});

test('upload network failures do not call or resend the message and do not delete unknown materials', async () => {
  for (const stage of ['GET', '/prepare', 'uploadPart', '/complete']) {
    const timers = new FakeTimers(), api = network(), request = api.request.bind(api);
    const failure = new AdapterError('API_NETWORK'); let sends = 0;
    api.request = async (method, route, body) => { if (method === stage || route.endsWith(stage)) throw failure; return request(method, route, body); };
    if (stage === 'uploadPart') api.uploadPart = async () => { throw failure; };
    const replies = new ImageReplies(api, { timers });
    await assert.rejects(replies.send(await image(), async () => { sends++; }), error => error === failure);
    assert.equal(sends, 0, stage); assert.deepEqual(deletes(api), [], stage); assert.equal(timers.jobs.size, 0, stage);
  }
});

test('persistent uploads return only the reference fields and cancel matching temporary cleanup', async () => {
  const timers = new FakeTimers(), api = network({ ids: ['shared', 'shared'] });
  const replies = new ImageReplies(api, { timers });
  await assert.rejects(replies.send(await image(), async () => { throw new AdapterError('API_NETWORK'); }));
  assert.equal(timers.jobs.size, 1);
  assert.deepEqual(await replies.persistent(await image()), { image_id: 'shared', url: reference, ttl: 7776000 });
  assert.equal(timers.jobs.size, 0); await timers.tick(600000); assert.deepEqual(deletes(api), []);
  assert.equal(api.calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(prepares(api)[1].body.file_name, 'original.png');
});

test('close cancels owned timers and rejects new local, public and persistent work without network traffic', async () => {
  const timers = new FakeTimers(), api = network(), replies = new ImageReplies(api, { timers });
  await assert.rejects(replies.send(await image(), async () => { throw new AdapterError('API_NETWORK'); }));
  const count = api.calls.length;
  replies.close(); replies.close(); assert.equal(timers.jobs.size, 0); assert.equal(api.calls.length, count);
  await timers.tick(600000); assert.equal(api.calls.length, count);
  const local = await image(), remote = await prepareMedia('image', 'https://example.test/a.png', config());
  for (const prepared of [local, remote]) await assert.rejects(replies.send(prepared, async () => assert.fail('closed sender called')), { code: 'OFFLINE' });
  await assert.rejects(replies.persistent(local), { code: 'OFFLINE' }); assert.equal(api.calls.length, count);
});

test('malformed inventory pages fail safely before any upload, callback or deletion', async () => {
  const invalid = [
    null, [], {}, { images: null }, { images: [null] }, { images: [{}] },
    { images: [{ image_id: '' }] }, { images: [{ image_id: 'x'.repeat(257) }] },
    { images: [{ image_id: 'bad\nID' }] }, { images: [{ image_id: '..' }] },
    { images: [], total: null }, { images: [], total: -1 }, { images: [], total: 101 },
    { images: [], total: '00' }, { images: [], total: '1.0' }, { images: [], total: '101' },
    { images: [], total: 1 }, { images: [{ image_id: 'gallery' }], total: 0 },
    { images: [], next_cursor: null }, { images: [], next_cursor: 1 },
    { images: [], next_cursor: 'x'.repeat(2049) }, { images: [], next_cursor: 'bad\ncursor' },
    { images: Array.from({ length: 101 }, (_, i) => ({ image_id: `gallery-${i}` })) }
  ];
  for (const page of invalid) {
    const api = network({ pages: [page] }), replies = new ImageReplies(api);
    await assert.rejects(replies.send(await image(), async () => assert.fail('invalid inventory reached callback')), { code: 'API_RESPONSE' }, JSON.stringify(page));
    assert.deepEqual(prepares(api), []); assert.deepEqual(deletes(api), []);
  }
});

test('inventory traversal rejects repeated cursors, duplicate IDs and inconsistent totals within one hundred requests', async () => {
  for (const pages of [
    [{ images: [], next_cursor: 'same' }, { images: [], next_cursor: 'same' }],
    [{ images: [{ image_id: 'gallery' }], next_cursor: 'next' }, { images: [{ image_id: 'gallery' }] }],
    [{ images: [{ image_id: 'first' }], total: '2', next_cursor: 'next' }, { images: [{ image_id: 'second' }], total: '3' }],
    (_route, page) => ({ images: [], next_cursor: `cursor-${page}` })
  ]) {
    const api = network({ pages }), replies = new ImageReplies(api);
    await assert.rejects(replies.send(await image(), async () => assert.fail('invalid cursor reached callback')), { code: 'API_RESPONSE' });
    assert.ok(api.calls.length <= 100); assert.deepEqual(prepares(api), []); assert.deepEqual(deletes(api), []);
  }
});

test('complete cursor traversal accepts optional totals and all one hundred existing gallery items', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `gallery-${i}`);
  const api = network({ pages: [{ images: ids.slice(0, 50).map(image_id => ({ image_id })), next_cursor: 'next' }, { images: ids.slice(50).map(image_id => ({ image_id })) }], ids: [ids[99]] });
  assert.equal(await new ImageReplies(api).send(await image(), async () => 'sent'), 'sent');
  assert.deepEqual(deletes(api), []);
});

test('unsafe or oversized platform references never reach the sender or a persistent caller', async () => {
  for (const url of [reference + '\n', reference + ' ', reference + '](https://example.test)', reference + '`', reference + '"', 'qqbot-media://image/v1/', 'qqbot-media://image/v1/' + 'x'.repeat(8193)]) {
    for (const persistent of [false, true]) {
      const api = network({ complete: result => ({ ...result, url }) }), replies = new ImageReplies(api);
      await assert.rejects(persistent ? replies.persistent(await image()) : replies.send(await image(), async () => assert.fail('unsafe reference sent')), { code: 'API_RESPONSE' });
    }
  }
});

test('invalid completed material IDs fail safely without constructing a delete route', async () => {
  for (const image_id of ['', '..', 'bad\r\nID', 'x'.repeat(257), '\uD800']) {
    const api = network({ complete: result => ({ ...result, image_id }) }), replies = new ImageReplies(api);
    await assert.rejects(replies.send(await image(), async () => assert.fail('invalid ID sent')), { code: 'API_RESPONSE' });
    assert.deepEqual(deletes(api), []);
  }
});

test('local sends and persistent uploads share a serial operation queue', async () => {
  const started = gate(), finish = gate(), api = network();
  const replies = new ImageReplies(api), prepared = await image();
  const first = replies.send(prepared, async () => { started.resolve(); await finish.promise; return 'sent'; });
  await started.promise;
  const second = replies.persistent(prepared); await settle();
  assert.equal(prepares(api).length, 1); assert.deepEqual(deletes(api), []);
  finish.resolve(); assert.equal(await first, 'sent'); await second;
  assert.equal(prepares(api).length, 2);
  assert.ok(api.calls.indexOf(deletes(api)[0]) < api.calls.indexOf(prepares(api)[1]));
});

test('a persistent upload cancels a matching cleanup even when the expired timer has already queued it', async () => {
  const timers = new FakeTimers(), started = gate(), finish = gate(); let completions = 0;
  const api = network({ ids: ['shared', 'shared'], complete: async result => { if (++completions === 2) { started.resolve(); await finish.promise; } return result; } });
  const replies = new ImageReplies(api, { timers });
  await assert.rejects(replies.send(await image(), async () => { throw new AdapterError('API_NETWORK'); }));
  const durable = replies.persistent(await image()); await started.promise;
  await timers.tick(300000); assert.deepEqual(deletes(api), []);
  finish.resolve(); await durable; await settle(); assert.deepEqual(deletes(api), []); assert.equal(timers.jobs.size, 0);
});

test('a reused pending temporary image is protected while the new callback is in flight', async () => {
  const timers = new FakeTimers(), started = gate(), finish = gate();
  const api = network({ ids: ['shared', 'shared'], pages: (_route, page) => ({ images: page ? [{ image_id: 'shared' }] : [] }) });
  const replies = new ImageReplies(api, { timers });
  await assert.rejects(replies.send(await image(), async () => { throw new AdapterError('API_NETWORK'); }));
  const sent = replies.send(await image(), async () => { started.resolve(); await finish.promise; return 'sent'; }); await started.promise;
  await timers.tick(300000); assert.deepEqual(deletes(api), []);
  finish.resolve(); assert.equal(await sent, 'sent'); await settle(); assert.deepEqual(deletes(api), []);
  await timers.tick(299999); assert.deepEqual(deletes(api), []);
  await timers.tick(1); assert.equal(deletes(api).length, 1);
});

test('closing during an upload prevents later network stages and rejects queued work', async () => {
  const started = gate(), finish = gate();
  const api = network({ upload: async () => { started.resolve(); await finish.promise; } });
  const replies = new ImageReplies(api), prepared = await image();
  const first = replies.send(prepared, async () => assert.fail('closed upload reached sender'));
  await started.promise;
  const second = replies.persistent(prepared); replies.close(); const calls = api.calls.length;
  finish.resolve(); await assert.rejects(first, { code: 'OFFLINE' }); await assert.rejects(second, { code: 'OFFLINE' });
  assert.equal(api.calls.length, calls);
});

test('cleanup logging failure cannot change a successful send into failure', async () => {
  const timers = new FakeTimers(), api = network({ remove: () => { throw new AdapterError('API_NETWORK'); } });
  const replies = new ImageReplies(api, { timers, logger: { warn() { throw new Error('logger unavailable'); } } });
  assert.equal(await replies.send(await image(), async () => 'sent'), 'sent');
  await timers.tick(60000); assert.equal(deletes(api).length, 3); assert.equal(timers.jobs.size, 0);
});

test('inventory rejects a noncanonical total containing a trailing newline', async () => {
  const api = network({ pages: [{ images: [], total: '0\n', next_cursor: '' }] });
  await assert.rejects(new ImageReplies(api).send(await image(), async () => 'sent'), { code: 'API_RESPONSE' });
  assert.deepEqual(prepares(api), []);
});

test('a pre-existing gallery image remains durable even when the callback fails', async () => {
  const timers = new FakeTimers(), api = network({ pages: [{ images: [{ image_id: 'gallery' }] }], ids: ['gallery'] });
  const replies = new ImageReplies(api, { timers }), failure = new AdapterError('API_NETWORK');
  await assert.rejects(replies.send(await image(), async () => { throw failure; }), error => error === failure);
  await timers.tick(600000); assert.deepEqual(deletes(api), []); assert.equal(timers.jobs.size, 0);
});

test('later sends recover from an earlier callback failure and use different temporary filenames', async () => {
  const timers = new FakeTimers(), api = network({ pages: () => ({ images: [] }) });
  const replies = new ImageReplies(api, { timers }), prepared = await image();
  await assert.rejects(replies.send(prepared, async () => { throw new AdapterError('API_NETWORK'); }));
  assert.equal(await replies.send(prepared, async () => 'sent'), 'sent');
  assert.equal(new Set(prepares(api).map(call => call.body.file_name)).size, 2);
  assert.equal(prepared.fileName, 'original.png'); replies.close();
});

test('close during a callback leaves its original result or error intact and performs no cleanup requests', async () => {
  for (const failing of [false, true]) {
    const timers = new FakeTimers(), api = network(), replies = new ImageReplies(api, { timers });
    const failure = new AdapterError('API_NETWORK');
    const sending = replies.send(await image(), async () => { replies.close(); if (failing) throw failure; return 'sent'; });
    if (failing) await assert.rejects(sending, error => error === failure);
    else assert.equal(await sending, 'sent');
    await timers.tick(600000); assert.deepEqual(deletes(api), []); assert.equal(timers.jobs.size, 0);
  }
});

test('cleanup treats an already absent material as success without logging or retrying', async () => {
  const timers = new FakeTimers(), logger = quietLogger();
  const api = network({ remove: () => { throw new AdapterError('API_REJECTED', { platformCode: 40035008 }); } });
  const replies = new ImageReplies(api, { timers, logger });
  assert.equal(await replies.send(await image(), async () => 'sent'), 'sent');
  assert.equal(timers.jobs.size, 0); assert.deepEqual(logger.records, []);
  await timers.tick(600000); assert.equal(deletes(api).length, 1);
});
