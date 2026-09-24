import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CHANNEL_ID, HANDLE, remainingCapacity, channelPosts, verifyReservation, runRollingQueue } from './sena-30day-rolling-queue.mjs';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const channel = {id: CHANNEL_ID, organizationId: 'test-org'};
const row = (id, channelId = CHANNEL_ID, status = 'scheduled') => ({id, channelId, status, text: id, dueAt: '2026-09-25T11:30:00.000Z'});
const page = (rows, hasNextPage = false) => ({posts: {edges: rows.map(node => ({node})), pageInfo: {hasNextPage}}});
const item = {day: 4, date: '2026-10-01', publishAt: '2026-10-01T20:30:00+09:00', caption: 'approved-test-caption'};
const exact = {...row('new'), text: item.caption, dueAt: '2026-10-01T11:30:00.000Z'};
await test('other channels cannot consume SENA capacity', () => assert.equal(remainingCapacity([...Array.from({length: 6}, (_, i) => row(`s${i}`)), ...Array.from({length: 11}, (_, i) => row(`other${i}`, 'mio-other'))]), 3));
await test('nine SENA reservations retain zero safety capacity', () => assert.equal(remainingCapacity(Array.from({length: 9}, (_, i) => row(`s${i}`))), 0));
await test('overfull queue never has negative capacity', () => assert.equal(remainingCapacity(Array.from({length: 10}, (_, i) => row(`s${i}`))), 0));
await test('sent and error items do not occupy scheduled capacity', () => assert.equal(remainingCapacity([row('a', CHANNEL_ID, 'sent'), row('b', CHANNEL_ID, 'error')]), 9));
await test('inventory query is scoped to exact channel', async () => {
  const result = await channelPosts(async (query, variables) => {
    assert.match(query, /channelIds:\[\$channelId\]/);
    assert.equal(variables.channelId, CHANNEL_ID);
    return page([row('a')]);
  }, channel, 'scheduled');
  assert.equal(result.length, 1);
});
await test('partial pages fail closed', () => assert.rejects(channelPosts(async () => page([], true), channel, 'scheduled'), /Incomplete/));
await test('missing pagination metadata fails closed', () => assert.rejects(channelPosts(async () => ({posts: {edges: []}}), channel, 'scheduled'), /Incomplete/));
await test('wrong-channel inventory fails closed', () => assert.rejects(channelPosts(async () => page([row('a', 'other')]), channel, 'scheduled'), /mismatch/));
await test('duplicate inventory IDs fail closed', () => assert.rejects(channelPosts(async () => page([row('a'), row('a')]), channel, 'scheduled'), /Duplicate/));
await test('invalid inventory status is rejected', () => assert.rejects(channelPosts(async () => page([]), channel, 'bogus'), /Invalid/));
await test('exact reservation readback succeeds', () => assert.equal(verifyReservation([exact], 'new', item).id, 'new'));
await test('missing reservation is not success', () => assert.throws(() => verifyReservation([], 'new', item), /mismatch/));
await test('caption drift is not success', () => assert.throws(() => verifyReservation([{...exact, text: 'different'}], 'new', item), /mismatch/));
await test('due-time drift is not success', () => assert.throws(() => verifyReservation([{...exact, dueAt: '2026-10-01T10:30:00Z'}], 'new', item), /mismatch/));
await test('wrong status is not success', () => assert.throws(() => verifyReservation([{...exact, status: 'error'}], 'new', item), /mismatch/));
await test('same-day duplicate blocks success', () => assert.throws(() => verifyReservation([exact, {...exact, id: 'other'}], 'new', item), /Duplicate/));

async function fixture(count, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'sena-queue-test-'));
  const previous = process.cwd();
  const bytes = Buffer.from('mock-media-bytes-never-sent-to-an-external-service');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const items = Array.from({length: count}, (_, i) => {
    const date = `2026-10-0${i + 1}`, day = i + 4, filename = `SENA_${date}_D0${day}.jpeg`;
    return {day, date, filename, account: HANDLE, aiDisclosure: true, qcStatus: 'accepted', sha256, caption: `approved-test-caption-${day}`, publishAt: `${date}T20:30:00+09:00`, mediaPath: `media/sena-30day-2026-09-28/${filename}`};
  });
  const scheduled = Array.from({length: 6}, (_, i) => ({...row(`existing-${i}`), dueAt: `2026-09-${24+i}T11:30:00.000Z`}));
  const other = Array.from({length: 11}, (_, i) => row(`mio-${i}`, 'other-channel'));
  let creates = 0, hideReadback = false;
  try {
    process.chdir(directory);
    await mkdir('automation/30day', {recursive: true});
    await mkdir('media/sena-30day-2026-09-28', {recursive: true});
    await writeFile('automation/30day/publishing-manifest.json', JSON.stringify({sena: items}));
    for (const entry of items) await writeFile(entry.mediaPath, bytes);
    const transport = async (url, options = {}) => {
      if (url.startsWith('https://raw.githubusercontent.com/')) return {ok: true, arrayBuffer: async () => bytes};
      assert.equal(url, 'https://api.buffer.com');
      const {query, variables} = JSON.parse(options.body);
      let data;
      if (query.includes('account {')) data = {account: {organizations: [{id: 'test-org'}]}};
      else if (query.includes('channels(input')) data = {channels: [{id: CHANNEL_ID, name: HANDLE, displayName: HANDLE, service: 'instagram', isDisconnected: false, isLocked: false, isQueuePaused: false}]};
      else if (query.startsWith('mutation')) {
        const input = variables.input;
        assert.equal(input.channelId, CHANNEL_ID);
        assert.equal(input.metadata.instagram.isAiGenerated, true);
        const intentState = JSON.parse(await readFile('automation/30day/sena-state.json', 'utf8'));
        assert.ok(intentState.pendingCreates.some(entry => entry.caption === input.text));
        const post = {id: `created-${++creates}`, channelId: CHANNEL_ID, text: input.text, dueAt: input.dueAt, status: 'scheduled'};
        scheduled.push(post);
        data = {createPost: {post}};
      } else {
        const status = query.match(/status:\[(\w+)\]/)?.[1];
        assert.equal(variables.channelId, CHANNEL_ID);
        const all = [...scheduled, ...other];
        const rows = all.filter(entry => entry.channelId === variables.channelId && entry.status === status && !(hideReadback && entry.id.startsWith('created-')));
        data = page(rows);
      }
      return {ok: true, json: async () => ({data})};
    };
    const run = () => runRollingQueue({transport, env: {BUFFER_API_KEY: 'mock-credential', GITHUB_SHA: 'mock-ref'}, clock: () => Date.parse('2026-09-24T01:00:00Z')});
    await callback({run, items, scheduled, creates: () => creates, hide: value => {hideReadback = value;}, state: async () => JSON.parse(await readFile('automation/30day/sena-state.json', 'utf8'))});
  } finally { process.chdir(previous); await rm(directory, {recursive: true, force: true}); }
}
await test('full runner refills 3 SENA slots despite 11 other-channel reservations', () => fixture(3, async ({run, creates, state}) => {
  const result = await run();
  assert.equal(result.created.length, 3);
  assert.equal(creates(), 3);
  assert.equal(result.remainingCapacity, 0);
  const saved = await state();
  assert.equal(saved.capacityScope, 'channel');
  assert.equal(saved.observedChannelScheduledCount, 6);
  assert.equal(saved.pendingCreates.length, 0);
  assert.ok(saved.scheduled.every(entry => entry.lastObservedStatus === 'scheduled' && entry.verifiedAt));
}));
await test('full runner second execution creates no duplicate', () => fixture(3, async ({run, creates}) => {
  await run();
  const second = await run();
  assert.equal(second.created.length, 0);
  assert.equal(creates(), 3);
}));
await test('failed readback preserves intent and ID; next read recovers without creating', () => fixture(1, async ({run, creates, hide, state}) => {
  hide(true);
  await assert.rejects(run(), /readback mismatch/);
  const interrupted = await state();
  assert.equal(interrupted.pendingCreates.length, 1);
  assert.equal(interrupted.scheduled[0].bufferPostId, 'created-1');
  assert.equal(interrupted.scheduled[0].lastObservedStatus, 'created_unverified');
  hide(false);
  await run();
  assert.equal(creates(), 1);
  assert.equal((await state()).pendingCreates.length, 0);
}));
console.log(`SENA rolling queue: ${passed} tests passed; all external services mocked.`);
