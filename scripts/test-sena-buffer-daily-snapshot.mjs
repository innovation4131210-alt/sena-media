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
