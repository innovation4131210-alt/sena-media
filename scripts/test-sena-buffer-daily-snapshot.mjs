import assert from 'node:assert/strict';
import {buildSnapshot,collectSnapshot,queryBuffer,SENA_CHANNEL_ID} from './sena-buffer-daily-snapshot.mjs';
const channel={id:SENA_CHANNEL_ID,name:'sena.virtual.studio',service:'instagram',isDisconnected:false,isLocked:false,isQueuePaused:false};
const connection=nodes=>({edges:nodes.map(node=>({node})),pageInfo:{hasNextPage:false}});
const data={sent:connection([{id:'sent1',status:'sent',metrics:[{type:'reach',value:0}]},{id:'sent2',status:'sent',metrics:null}]),failed:connection([]),scheduled:connection([{id:'future1',status:'scheduled'}])};
let passed=0;
function check(fn){fn();passed++;}
check(()=>{const s=buildSnapshot(channel,data,new Date('2026-09-23T16:00:00Z'));assert.equal(s.tokyoDate,'2026-09-24');assert.equal(s.inventoryComplete,true);});
check(()=>{const s=buildSnapshot(channel,data);assert.equal(s.sent[0].metrics[0].value,0);assert.equal(s.sent[1].metrics,null);});
check(()=>assert.throws(()=>buildSnapshot({...channel,id:'wrong'},data),/identity/));
check(()=>assert.throws(()=>buildSnapshot({...channel,name:'another-account'},data),/identity/));
check(()=>assert.throws(()=>buildSnapshot({...channel,isLocked:undefined},data),/availability/));
check(()=>assert.equal(buildSnapshot({...channel,isDisconnected:true},data).channelAvailable,false));
check(()=>assert.throws(()=>buildSnapshot(channel,{...data,sent:{...data.sent,pageInfo:{hasNextPage:true}}}),/Incomplete/));
check(()=>assert.throws(()=>buildSnapshot(channel,{...data,failed:{edges:[]}}),/Incomplete/));
check(()=>assert.throws(()=>buildSnapshot(channel,{...data,scheduled:connection([{id:'sent1',status:'scheduled'}])}),/duplicate/));
check(()=>assert.throws(()=>buildSnapshot(channel,{...data,failed:connection([{id:'bad',status:'sent'}])}),/Invalid/));
await assert.rejects(queryBuffer('secret','mutation { deletePost }',{},()=>{throw Error('called');}),/Read-only/);passed++;
await assert.rejects(collectSnapshot(''),/not configured/);passed++;
await assert.rejects(queryBuffer('secret','query { account }',{},async()=>({ok:false,status:401})),/HTTP 401/);passed++;
let calls=0;
const mock=async(_url,options)=>{calls++;const q=JSON.parse(options.body).query;assert.match(q,/^query/);const result=q.includes('account {')?{account:{organizations:[{id:'org'}]}}:q.includes('channels(input')?{channels:[channel]}:data;return {ok:true,json:async()=>({data:result})};};
const snapshot=await collectSnapshot('sensitive-test-value',mock,new Date('2026-09-24T00:00:00Z'));
check(()=>{assert.equal(calls,3);assert.equal(snapshot.sent.length,2);assert.equal(JSON.stringify(snapshot).includes('sensitive-test-value'),false);});
console.log(`SENA read-only snapshot tests: ${passed} passed; external services mocked.`);

// snapshot refresh trigger 2026-09-26T12:18+09:00


const NOW=new Date('2026-10-09T13:30:00Z');
const goodSent={id:'today',status:'sent',dueAt:'2026-10-09T11:30:00Z',sentAt:'2026-10-09T11:31:00Z',externalLink:'https://www.instagram.com/p/test/'};
const goodScheduled=[10,11,12].map(d=>({id:'future'+d,status:'scheduled',dueAt:`2026-10-${d}T11:30:00Z`}));
const good={sent:connection([goodSent]),failed:connection([]),scheduled:connection(goodScheduled)};
check(()=>{const c=buildSnapshot(channel,good,NOW).continuity;assert.equal(c.ok,true);assert.equal(c.todayPublicationStatus,'sent_verified');assert.equal(c.consecutiveFutureDays,3);assert.equal(c.firstUnverifiedDate,'2026-10-13');});
check(()=>{const c=buildSnapshot(channel,{...good,sent:connection([])},NOW).continuity;assert.equal(c.ok,false);assert.ok(c.errors.includes('expected_publication_unverified'));});
check(()=>{const c=buildSnapshot(channel,{...good,scheduled:connection([])},NOW).continuity;assert.equal(c.ok,false);assert.ok(c.errors.includes('next_day_reservation_unverified'));});
check(()=>{const c=buildSnapshot(channel,{...good,scheduled:connection(goodScheduled.slice(1))},NOW).continuity;assert.equal(c.firstUnverifiedDate,'2026-10-10');assert.equal(c.ok,false);});
check(()=>{const c=buildSnapshot(channel,{...good,sent:connection([{...goodSent,dueAt:'2026-10-08T11:30:00Z',sentAt:'2026-10-08T11:30:00Z'}])},NOW).continuity;assert.equal(c.ok,false);});
check(()=>{const c=buildSnapshot(channel,{...good,sent:connection([])},new Date('2026-10-09T12:00:00Z')).continuity;assert.equal(c.todayPublicationStatus,'not_due_for_verification');assert.equal(c.ok,true);});
check(()=>{const c=buildSnapshot(channel,{...good,sent:connection([{...goodSent,sentAt:'2026-10-10T11:30:00Z'}])},NOW).continuity;assert.equal(c.ok,false);});
check(()=>{const c=buildSnapshot({...channel,isQueuePaused:true},good,NOW).continuity;assert.equal(c.status,'channel_unavailable');assert.equal(c.mutationAllowed,false);});
for(const override of [{dueAt:'invalid'},{dueAt:'2026-10-10T10:30:00Z'},{draft:true},{autoPublish:false}]) check(()=>{const c=buildSnapshot(channel,{...good,scheduled:connection([{...goodScheduled[0],...override}])},NOW).continuity;assert.equal(c.ok,false);});
console.log(`SENA delivery+stock tests: ${passed} total passed; no external calls.`);

const batchScheduled=[10,13,16].flatMap(d=>[0,1,2].map(j=>({id:'batch'+d+'-'+j,status:'scheduled',dueAt:new Date(Date.parse('2026-10-'+d+'T11:30:00Z')+j*60000).toISOString()})));
const batchData={sent:connection([]),failed:connection([]),scheduled:connection(batchScheduled)};
check(()=>{const c=buildSnapshot(channel,batchData,new Date('2026-10-10T00:00:00Z')).continuity;assert.equal(c.ok,true);assert.equal(c.batchSize,3);});
check(()=>{const c=buildSnapshot(channel,batchData,new Date('2026-10-11T13:00:00Z')).continuity;assert.equal(c.ok,true);assert.equal(c.todayPublicationStatus,'no_feed_batch_planned');});
check(()=>{const c=buildSnapshot(channel,{...batchData,sent:connection([{...goodSent,dueAt:'2026-10-10T11:30:00Z',sentAt:'2026-10-10T11:30:30Z'}])},new Date('2026-10-10T13:00:00Z')).continuity;assert.equal(c.ok,false);assert.ok(c.errors.includes('three_post_publication_unverified'));});
check(()=>{const c=buildSnapshot(channel,{...batchData,scheduled:connection(batchScheduled.filter(x=>x.id!=='batch13-2'))},new Date('2026-10-11T13:00:00Z')).continuity;assert.equal(c.ok,false);});
console.log('PASS three-post read-only continuity before publication, off-days, partial publication and partial reservations.');
