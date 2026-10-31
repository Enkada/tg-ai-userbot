import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitRunpodJob } from '../src/runpodSubmit.ts';

const options = { endpointId: 'test-endpoint', apiKey: 'test-key', input: { workflow: {} } };
const paused = { code: 'ENDPOINT_PAUSED' };
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body),
});
const noWait = async () => {};

test('an active endpoint submits once without management requests', async () => {
  const calls: string[] = [];
  const result = await submitRunpodJob(options, async (url, init) => {
    calls.push(init.method + ' ' + url);
    assert.deepEqual(JSON.parse(init.body), { input: options.input });
    return response(200, { id: 'accepted', status: 'IN_QUEUE' });
  }, noWait);
  assert.equal(result.id, 'accepted');
  assert.deepEqual(calls, ['POST https://api.runpod.ai/v2/test-endpoint/run']);
});

test('a paused endpoint is resumed with zero active workers and one maximum worker', async () => {
  const methods: string[] = [];
  let submissions = 0;
  const result = await submitRunpodJob(options, async (url, init) => {
    methods.push(init.method);
    if (init.method === 'PATCH') {
      assert.equal(url, 'https://api.runpod.io/v2/serverless/test-endpoint');
      assert.deepEqual(JSON.parse(init.body), { workers: { min: 0, max: 1 } });
      return response(200, {});
    }
    return ++submissions === 1 ? response(409, paused) : response(200, { id: 'resumed-job' });
  }, noWait);
  assert.equal(result.id, 'resumed-job');
  assert.deepEqual(methods, ['POST', 'PATCH', 'POST']);
});

test('management propagation can reject another submission without repeating the PATCH', async () => {
  let patches = 0, submissions = 0;
  const result = await submitRunpodJob(options, async (_, init) => {
    if (init.method === 'PATCH') { patches++; return response(200, {}); }
    return ++submissions < 3 ? response(409, paused) : response(200, { id: 'ready' });
  }, noWait);
  assert.equal(result.id, 'ready');
  assert.equal(patches, 1);
  assert.equal(submissions, 3);
});

test('a permanently paused endpoint has bounded retries', async () => {
  let patches = 0, submissions = 0;
  await assert.rejects(submitRunpodJob(options, async (_, init) => {
    if (init.method === 'PATCH') { patches++; return response(200, {}); }
    submissions++;
    return response(409, paused);
  }, noWait), /remained paused/);
  assert.equal(patches, 1);
  assert.equal(submissions, 6);
});

test('unrelated HTTP errors never resume or repeat a possibly accepted submission', async () => {
  for (const status of [401, 409, 429, 500]) {
    let calls = 0;
    await assert.rejects(submitRunpodJob(options, async () => {
      calls++;
      return response(status, { code: 'OTHER_ERROR' });
    }, noWait), new RegExp('HTTP ' + status));
    assert.equal(calls, 1);
  }
});

test('transport failures are not retried because the job may already exist', async () => {
  let calls = 0;
  await assert.rejects(submitRunpodJob(options, async () => {
    calls++;
    throw new Error('connection reset');
  }, noWait), /connection reset/);
  assert.equal(calls, 1);
});

test('a failed management update prevents another submission', async () => {
  const methods: string[] = [];
  await assert.rejects(submitRunpodJob(options, async (_, init) => {
    methods.push(init.method);
    return init.method === 'PATCH' ? response(403, {}) : response(409, paused);
  }, noWait), /reactivation failed: HTTP 403/);
  assert.deepEqual(methods, ['POST', 'PATCH']);
});

test('stopping during the resume wait prevents another image submission', async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  await assert.rejects(submitRunpodJob({ ...options, signal: controller.signal }, async (_, init) => {
    methods.push(init.method);
    return init.method === 'PATCH' ? response(200, {}) : response(409, paused);
  }, async () => { controller.abort(); }), { name: 'AbortError' });
  assert.deepEqual(methods, ['POST', 'PATCH']);
});

test('an accepted job ID is retained if stop arrives during submission, so the caller can cancel it', async () => {
  const controller = new AbortController();
  const result = await submitRunpodJob({ ...options, signal: controller.signal }, async (_, init) => {
    controller.abort();
    assert.equal(init.signal.aborted, false);
    return response(200, { id: 'must-cancel' });
  }, noWait);
  assert.equal(result.id, 'must-cancel');
});
