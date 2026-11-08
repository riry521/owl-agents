import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeFetch, loadApiClient } from '../helpers/web-api-client.mjs';

function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(handler);
  return Promise.resolve(run(loadApiClient())).finally(() => {
    globalThis.fetch = original;
  });
}

const json = (status, body) => new Response(JSON.stringify(body), { status });

test('uploadAttachment sends the raw File with an encoded filename, its MIME and an idempotency key', () => {
  const calls = [];
  const file = new File(['hello'], '画像 1.png', { type: 'image/png' });
  return withFetch((url, init) => {
    calls.push({ url, init });
    return json(201, { data: { attachment_id: 'A1', filename: '画像 1.png', mime: 'image/png', bytes: 5, sha256: 'x', status: 'stored' } });
  }, async (api) => {
    const result = await api.uploadAttachment({ kind: 'work', id: 'W1' }, file);
    assert.equal(result.attachment_id, 'A1');
    const { url, init } = calls[0];
    assert.equal(url.pathname, '/api/v1/works/W1/attachments');
    assert.equal(init.body, file);
    assert.equal(init.headers['Content-Type'], 'image/png');
    assert.equal(init.headers['X-Owl-Filename'], encodeURIComponent('画像 1.png'));
    assert.ok(init.headers['X-Request-Id']);
    assert.equal(init.headers['Idempotency-Key'], `web-attachment:${init.headers['X-Request-Id']}`);
    await api.uploadAttachment({ kind: 'conversation', id: 'C1' }, file);
    assert.equal(calls[1].url.pathname, '/api/v1/conversations/C1/attachments');
  });
});

test('a 413 response becomes an ApiRequestError carrying details.max_bytes', () =>
  withFetch(() => json(413, { error: { code: 'upload_too_large', message: 'too big', details: { max_bytes: 1000 } } }), async (api) => {
    await assert.rejects(
      api.uploadAttachment({ kind: 'conversation', id: 'C1' }, new File(['x'], 'a.bin')),
      (error) => error instanceof api.ApiRequestError && error.status === 413 && error.details.max_bytes === 1000,
    );
  }));

test('getUploadLimits is fetched once and reused', () => {
  let count = 0;
  return withFetch(() => {
    count += 1;
    return json(200, { data: { max_bytes: 10, max_files: 2 } });
  }, async (api) => {
    assert.deepEqual(await api.getUploadLimits(), { max_bytes: 10, max_files: 2 });
    await api.getUploadLimits();
    assert.equal(count, 1);
  });
});

test('postMessage and sendWorkInstruction send attachment_ids (empty by default)', () => {
  const payloads = [];
  return withFetch((url, init) => {
    payloads.push(JSON.parse(init.body).payload);
    return json(200, { data: { message_id: 'M1' } });
  }, async (api) => {
    await api.postMessage('C1', 'hi', ['A1']);
    await api.postMessage('C1', 'hi');
    await api.sendWorkInstruction('W1', '', { attachmentIds: ['A1', 'A2'] });
    await api.sendWorkInstruction('W1', 'hi');
    assert.deepEqual(payloads.map((p) => p.attachment_ids), [['A1'], [], ['A1', 'A2'], []]);
  });
});
