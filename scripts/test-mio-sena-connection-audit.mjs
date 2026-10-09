import {summarizeContinuity} from './lib/posting-continuity.mjs';
import assert from 'node:assert/strict';
import {audit, summarize, queryBuffer, KNOWN_MIO_X_POST} from './mio-sena-connection-audit.mjs';
const channel = {id:'target', name:'mio', service:'twitter', isDisconnected:false, isLocked:false, isQueuePaused:false};
const connection = {edges:[{node:{id:KNOWN_MIO_X_POST, text:'private caption', status:'sent', dueAt:'2026-09-23T00:00:00Z'}}], pageInfo:{hasNextPage:false}};
const s = summarize(channel, connection);
assert.equal(s.knownMioXPostPresent, true);
assert.equal(s.inventoryComplete, true);
assert.equal(s.counts.sent, 1);
assert.equal(JSON.stringify(s).includes('private caption'), false);
assert.equal(summarize(channel, {...connection, pageInfo:{hasNextPage:true}}).inventoryComplete, false);
await assert.rejects(queryBuffer('secret', 'mutation { bad }', {}, () => {throw Error('called');}), /Read-only/);
let calls=0;
const mock=async (_url, options) => {
  calls++;
  const {query}=JSON.parse(options.body);
  assert.match(query, /^query/);
  let data;
  if(query.includes('account {')) data={account:{organizations:[{id:'org'}]}};
  else if(query.includes('channels(input')) data={channels:[channel]};
  else data={posts:connection};
  return {ok:true, json:async()=>({data})};
};
const report = await audit([['TEST_KEY','sensitive-value']], mock);
assert.equal(report.complete, true);
assert.equal(report.mioXMatches.length, 1);
assert.equal(report.mioXMatches[0].available, true);
assert.equal(calls, 3);
assert.equal(JSON.stringify(report).includes('sensitive-value'), false);
const missing = await audit([['MISSING','']], mock);
assert.equal(missing.complete, false);
assert.equal(missing.mioXMatches.length, 0);
const errorReport = await audit([['TEST_KEY','secret']], async()=>({ok:false,status:401}));
assert.equal(errorReport.complete, false);
assert.equal(errorReport.connections[0].errors[0].message,'Buffer HTTP 401');
console.log('Audit tests passed: identity match, redaction, incomplete pagination, read-only guard, missing keys, HTTP failure.');


const NOW=new Date('2026-10-09T13:30:00Z');
const channels=[
 {id:'6aa72524ea19ca0bde39313c',name:'sena.virtual.studio',service:'instagram',time:'11:30'},
 {id:'6ab3f6bdea19ca0bdec6f4d4',name:'mio.ai_life',service:'threads',time:'10:00'},
 {id:'6ab75347ea19ca0bdef0d04a',name:'sena.virtual.studio',service:'threads',time:'11:10'},
].map(c=>({...c,isDisconnected:false,isLocked:false,isQueuePaused:false}));
let partialCalls=0;
const partialMock=async(_url,options)=>{
 partialCalls++;
 if(options.headers.Authorization==='Bearer blocked') return {ok:false,status:429};
 const {query,variables}=JSON.parse(options.body);let data;
 if(query.includes('account {'))data={account:{organizations:[{id:'org'}]}};
 else if(query.includes('channels(input'))data={channels};
 else {
  const c=channels.find(c=>c.id===variables.channelId);
  data={posts:{edges:[{node:{id:c.id+'sent',status:'sent',text:'private',dueAt:`2026-10-09T${c.time}:00Z`,sentAt:`2026-10-09T${c.time}:30Z`,externalLink:'https://example.com/sent'}},...[10,11,12].map(d=>({node:{id:c.id+d,status:'scheduled',dueAt:`2026-10-${d}T${c.time}:00Z`}}))],pageInfo:{hasNextPage:false}}};
 }
 return {ok:true,json:async()=>({data})};
};
const partial=await audit([['MIO_BUFFER_API_KEY','blocked'],['SENA_BUFFER_API_KEY','working']],partialMock,NOW);
assert.equal(partialCalls,6,'same requests only; no retry or new provider polling');
assert.equal(partial.complete,false);
assert.equal(partial.connections[0].errors[0].message,'Buffer HTTP 429');
for(const key of ['sena_instagram','mio_threads','sena_threads']) {
 assert.equal(partial.lanes[key].todayPublicationStatus,'sent_verified');
 assert.equal(partial.lanes[key].consecutiveFutureDays,3);
 assert.equal(partial.lanes[key].ok,true);
}
assert.equal(partial.continuityOk,true,'failed unrelated key does not erase verified lanes');
assert.equal(JSON.stringify(partial).includes('Bearer'),false);
const unavailable=await audit([['KEY','blocked']],partialMock,NOW);
for(const lane of Object.values(unavailable.lanes))assert.equal(lane.status,'provider_observation_unavailable');
console.log('Per-lane 429 isolation and unchanged request-count tests passed.');

const validChannel=partial.connections[1].channels.find(c=>c.service==='instagram');
for(const bad of [
 {...validChannel,inventoryComplete:false},
 {...validChannel,name:'wrong-account'},
 {...validChannel,isQueuePaused:true},
 {...validChannel,isDisconnected:undefined},
]) {
 const connections=[{channels:[bad],errors:[{message:'first-key observation incomplete'}]},{channels:[validChannel],errors:[]}];
 const before=structuredClone(connections);
 const lanes=summarizeContinuity(connections,NOW);
 assert.equal(lanes.sena_instagram.todayPublicationStatus,'sent_verified');
 assert.equal(lanes.sena_instagram.ok,true);
 assert.deepEqual(connections,before,'provider errors and source data remain unchanged');
}
const missingAvailability=summarizeContinuity([{channels:[{...validChannel,isLocked:undefined}],errors:[]}],NOW);
assert.equal(missingAvailability.sena_instagram.status,'availability_unverified');
assert.equal(missingAvailability.sena_instagram.ok,false);
console.log('Duplicate-channel best verified observation and missing availability tests passed.');
