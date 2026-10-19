import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runBatchQueue,validateBatchPlan,validateBatches} from './sena-three-post-queue.mjs';
const CHANNEL='6aa72524ea19ca0bde39313c',HANDLE='sena.virtual.studio',ROOT=process.cwd();
// Deterministic historical fixture; every provider response is mocked.
const bytesFor=day=>Buffer.from(`Original PNG fixture for D${day}`),sha=b=>createHash('sha256').update(b).digest('hex');
const at=(day,slot,offsets=[0,1,2])=>new Date(Date.parse('2026-10-10T11:30:00Z')+day*86400000+offsets[slot]*60000).toISOString();
const historical=Array.from({length:36},(_,i)=>{
 const day=i+1, date=day<13?new Date(Date.parse('2026-09-28T11:30:00Z')+i*86400000).toISOString():at(Math.floor((day-13)/3),(day-13)%3);
 return {day,date:date.slice(0,10),bufferPostId:'history-'+day,dueAt:date,caption:'historical-caption-'+day,lastObservedStatus:'sent',verifiedAt:'2026-10-18T17:04:42Z',batchId:'history-'+date.slice(0,10),...(day>=31?{existingOnly:true,nativeAiGenerated:true,verificationSource:'Mock historical provider evidence',sourceBufferAssetId:'historical-asset-'+day}:{})};
});
const oldItems=historical.filter(x=>x.day>=13&&x.day<=30).map(x=>({day:x.day,date:x.date,publishAt:x.dueAt,account:HANDLE,caption:x.caption,qcStatus:'accepted',aiDisclosure:true,batchId:x.batchId}));
const newItems=Array.from({length:12},(_,i)=>{
 const day=37+i,publishAt=new Date(Date.parse('2026-10-20T11:30:00Z')+Math.floor(i/3)*86400000+[0,1,135][i%3]*60000).toISOString(),filename=`new-D${day}.png`;
 return {day,date:publishAt.slice(0,10),publishAt,account:HANDLE,caption:'new-caption-'+day,qcStatus:'accepted',aiDisclosure:true,batchId:'new-'+publishAt.slice(0,10),filename,mediaPath:'media/sena-30day-2026-09-28/'+filename,sha256:sha(bytesFor(day)),slotRole:i%3===2?'night_pajama_sleep':'daytime_lifestyle',contentClass:i%3===2?'pajama_sleep':'lifestyle'};
});
const defaultPolicy={channelId:CHANNEL,handle:HANDLE,batchSize:3,cadenceDays:1,startDay:13,existing:[],continuation:{afterDay:36,startDay:37,previousBatchLastAt:'2026-10-17T11:32:00.000Z',publishAt:'2026-10-20T11:30:00.000Z',offsetsMinutes:[0,1,135],activationReady:true}};
const historicalPosts=historical.map(x=>({id:x.bufferPostId,channelId:CHANNEL,text:x.caption,dueAt:x.dueAt,status:'sent',assets:[{id:'historical-asset-'+x.day,mimeType:'image/jpeg',source:'https://cdn.buffer.test/history/'+x.day,image:{altText:'historical',userTags:[]}}],metadata:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}));
const tests=[];
async function scenario(name,test) {
 const root=await mkdtemp(join(tmpdir(),'sena-continuation-')),previous=process.cwd();
 const ctx={posts:structuredClone(historicalPosts),state:{version:2,scheduled:structuredClone(historical),batchMigration:{edits:[{id:'prior-edit-evidence'}],pendingCreates:[]},pendingCreates:[],otherHistoricalEvidence:{preserved:true}},manifest:{sena:[...structuredClone(oldItems),...structuredClone(newItems)]},policy:structuredClone(defaultPolicy),creates:0,edits:0,reads:0,fetches:0,rawFetches:0,modes:{}};
 const write=async()=>{await writeFile('automation/30day/sena-state.json',JSON.stringify(ctx.state));await writeFile('automation/30day/publishing-manifest.json',JSON.stringify(ctx.manifest));await writeFile('automation/30day/sena-grid-policy.json',JSON.stringify(ctx.policy));};
 ctx.save=write;ctx.saved=async()=>JSON.parse(await readFile('automation/30day/sena-state.json','utf8'));
 const transport=async(url,options={})=>{
  if(url.startsWith('https://raw.githubusercontent.com/')) {ctx.rawFetches++;const day=Number(url.match(/new-D(\d+)\.png$/)?.[1]);assert.ok(day>=37);return {ok:true,arrayBuffer:async()=>ctx.modes.remoteMismatch?Buffer.from('wrong original'):bytesFor(day)};}
  if(url.startsWith('https://cdn.buffer.test/assets/')) {ctx.fetches++;assert.equal(options.redirect,'error');assert.equal(options.headers?.Authorization,undefined);const day=Number(url.match(/D(\d+)\.png$/)?.[1]);return {ok:!ctx.modes.mediaUnavailable,arrayBuffer:async()=>ctx.modes.providerMismatch?Buffer.from('transformed PNG bytes'):bytesFor(day)};}
  assert.equal(url,'https://api.buffer.com');assert.equal(options.headers.Authorization,'Bearer MOCK_ONLY_NEVER_LIVE');const {query,variables}=JSON.parse(options.body);let data;
  if(query.startsWith('mutation')) {
   if(query.includes('editPost')){ctx.edits++;throw Error('Test forbids editing historical posts');}
   assert.ok(query.includes('createPost'));ctx.creates++;const x=variables.input,day=Number(x.text.match(/new-caption-(\d+)/)?.[1]);assert.ok(day>=37);assert.equal(x.channelId,CHANNEL);assert.equal(x.metadata.instagram.isAiGenerated,true);assert.ok(x.assets[0].image.url.endsWith(`new-D${day}.png`));
   const p={id:'new-'+day,channelId:CHANNEL,text:x.text,dueAt:x.dueAt,status:'scheduled',assets:[{id:'asset-'+day,mimeType:'image/png',source:`https://cdn.buffer.test/assets/D${day}.png`,image:{altText:x.assets[0].image.metadata.altText,userTags:[]}}],metadata:{...x.metadata.instagram}};
   if(ctx.modes.nullAssetId)p.assets[0].id=null;
   if(ctx.modes.falseAi)p.metadata.isAiGenerated=false;if(ctx.modes.falseFeed)p.metadata.shouldShareToFeed=false;if(ctx.modes.wrongMime)p.assets[0].mimeType='image/jpeg';if(ctx.modes.extraAsset)p.assets.push({...p.assets[0],id:'unexpected-second'});
   ctx.posts.push(p);if(ctx.modes.duplicateOnCreate)ctx.posts.push({...structuredClone(p),id:p.id+'-duplicate'});
   if(ctx.modes.ambiguousCreate){ctx.modes.ambiguousCreate=false;throw Error('Simulated response lost after provider accepted');}
   data={createPost:{post:{id:p.id}}};
  } else {ctx.reads++;
   if(query.includes('account {'))data={account:{organizations:[{id:'org'}]}};
   else if(query.includes('channels(input'))data={channels:[{id:CHANNEL,name:HANDLE,displayName:HANDLE,service:'instagram',isQueuePaused:false,isDisconnected:false,isLocked:false}]};
   else {const status=query.match(/status:\[(\w+)\]/)?.[1];assert.ok(status);data={posts:{edges:ctx.posts.filter(p=>p.status===status).map(node=>({node:structuredClone(node)})),pageInfo:{hasNextPage:!!ctx.modes.incompleteInventory}}};}
  }
  return {ok:true,json:async()=>({data})};
 };
 ctx.run=()=>runBatchQueue({transport,env:{BUFFER_API_KEY:'MOCK_ONLY_NEVER_LIVE',GITHUB_SHA:'mock-commit'},clock:()=>Date.parse('2026-10-19T13:00:00Z')});
 try {process.chdir(root);await mkdir('automation/30day',{recursive:true});await mkdir('media/sena-30day-2026-09-28',{recursive:true});for(const x of newItems)await writeFile(x.mediaPath,bytesFor(x.day));await write();await test(ctx);tests.push(name);}
 finally {process.chdir(previous);await rm(root,{recursive:true,force:true});}
}
const combined=[...oldItems,...historical.filter(x=>x.day>=31).map(x=>({day:x.day,publishAt:x.dueAt,account:HANDLE,caption:x.caption,qcStatus:'accepted',aiDisclosure:true})),...newItems];
validateBatchPlan(combined,defaultPolicy);
assert.throws(()=>validateBatches(combined,1),/cadence|timing/);
assert.throws(()=>validateBatchPlan(combined,{...defaultPolicy,continuation:{...defaultPolicy.continuation,offsetsMinutes:[0,1,134]}}),/Unsupported/);
await scenario('unaltered history; CDN byte identity; native AI; cap9; rerun idempotency',async c=>{
 const before=JSON.stringify(c.state.scheduled),result=await c.run();assert.equal(result.scheduled.length,9);assert.equal(c.creates,9);assert.equal(c.edits,0);assert.ok(c.fetches>=9);let saved=await c.saved();assert.equal(JSON.stringify(saved.scheduled.filter(x=>x.day<=36)),before);assert.deepEqual(saved.otherHistoricalEvidence,{preserved:true});assert.deepEqual(saved.batchMigration.edits,[{id:'prior-edit-evidence'}]);assert.equal(saved.batchMigration.pendingCreates.length,0);await c.run();assert.equal(c.creates,9);
 // Completed first daily triple opens exactly three slots, never recreating sent posts.
 for(const p of c.posts.filter(p=>['new-37','new-38','new-39'].includes(p.id)))p.status='sent';await c.run();assert.equal(c.creates,12);assert.equal(c.posts.filter(x=>x.status==='scheduled').length,9);
});
await scenario('one ready first-day batch works while later proposals remain staged',async c=>{c.manifest.sena=c.manifest.sena.filter(x=>x.day<40);await c.save();await writeFile('automation/30day/sena-continuation-proposal.json',JSON.stringify({items:newItems.slice(3).map(x=>({...x,qcStatus:'pending',sha256:null}))}));const result=await c.run();assert.equal(c.creates,3);assert.equal(result.scheduled.length,3);assert.deepEqual(result.scheduled.map(x=>x.id),['new-37','new-38','new-39']);});
await scenario('inactive policy stops before any provider request',async c=>{c.policy.continuation.activationReady=false;await c.save();await assert.rejects(c.run(),/not activation-ready/);assert.equal(c.reads,0);assert.equal(c.creates,0);});
await scenario('fixed night offset enforced before provider access',async c=>{c.manifest.sena.find(x=>x.day===39).publishAt='2026-10-20T13:44:00.000Z';await c.save();await assert.rejects(c.run(),/Invalid batch/);assert.equal(c.reads,0);});
await scenario('no later-day gap within continuation',async c=>{c.manifest.sena.find(x=>x.day===40).publishAt='2026-10-22T11:30:00.000Z';await c.save();await assert.rejects(c.run(),/Invalid batch|cadence/);assert.equal(c.reads,0);});
await scenario('complete future triple required',async c=>{c.manifest.sena.pop();await c.save();await assert.rejects(c.run(),/Complete three/);assert.equal(c.reads,0);});
await scenario('duplicate planned image blocked',async c=>{c.manifest.sena.find(x=>x.day===38).sha256=c.manifest.sena.find(x=>x.day===37).sha256;await c.save();await assert.rejects(c.run(),/Duplicate planned image/);assert.equal(c.reads,0);});
await scenario('ordinary stock cannot occupy a night slot',async c=>{c.manifest.sena.find(x=>x.day===39).contentClass='lifestyle';await c.save();await assert.rejects(c.run(),/Night slot requires/);assert.equal(c.reads,0);});
await scenario('duplicate planned caption blocked',async c=>{c.manifest.sena.find(x=>x.day===38).caption='new-caption-37';await c.save();await assert.rejects(c.run(),/Duplicate planned/);assert.equal(c.reads,0);});
for(const mode of ['missing','not-sent','caption-drift','time-drift','asset-id-drift'])await scenario('historical '+mode+' blocks all creates',async c=>{
 const p=c.posts.find(p=>p.id==='history-'+(mode==='asset-id-drift'?31:1));if(mode==='missing')c.posts=c.posts.filter(x=>x!==p);if(mode==='not-sent')p.status='draft';if(mode==='caption-drift')p.text+=' changed';if(mode==='time-drift')p.dueAt='2026-09-28T11:31:00Z';if(mode==='asset-id-drift')p.assets[0].id='different';await assert.rejects(c.run(),/historical|Historical/);assert.equal(c.creates,0);assert.equal(c.edits,0);
});
await scenario('missing historical state checkpoint blocks',async c=>{c.state.scheduled=c.state.scheduled.filter(x=>x.day!==18);await c.save();await assert.rejects(c.run(),/historical checkpoint/);assert.equal(c.creates,0);});
await scenario('incomplete inventory blocks',async c=>{c.modes.incompleteInventory=true;await assert.rejects(c.run(),/Incomplete channel inventory/);assert.equal(c.creates,0);});
await scenario('unmanaged scheduled row blocks',async c=>{c.posts.push({...structuredClone(c.posts[0]),id:'unmanaged',status:'scheduled',text:'not managed'});await assert.rejects(c.run(),/Unmanaged/);assert.equal(c.creates,0);});
await scenario('local exact-byte mismatch stops whole triple before first create',async c=>{await writeFile(newItems[2].mediaPath,'wrong local');await assert.rejects(c.run(),/Local media hash/);assert.equal(c.creates,0);});
await scenario('remote original exact-byte mismatch stops before first create',async c=>{c.modes.remoteMismatch=true;await assert.rejects(c.run(),/Remote media hash/);assert.equal(c.creates,0);});
for(const mode of ['providerMismatch','mediaUnavailable','falseAi','falseFeed','wrongMime','extraAsset'])await scenario(mode+' fails safe retaining create intent',async c=>{
 c.modes[mode]=true;await assert.rejects(c.run(),/Provider image|metadata readback|asset count/);assert.equal(c.creates,1);const saved=await c.saved();assert.equal(saved.batchMigration.pendingCreates.length,1);assert.equal(saved.scheduled.find(x=>x.day===37).lastObservedStatus,'created_unverified');await assert.rejects(c.run(),/Provider image|metadata readback|asset count/);assert.equal(c.creates,1);
});
await scenario('unresolved create without a provider post is never resent',async c=>{c.state.batchMigration.pendingCreates.push({day:37,caption:'new-caption-37',dueAt:newItems[0].publishAt,attemptedAt:'2026-10-19T12:00:00Z'});await c.save();await assert.rejects(c.run(),/Unresolved create intent/);assert.equal(c.creates,0);assert.equal((await c.saved()).batchMigration.pendingCreates.length,1);});
await scenario('uncertain accepted create is reconciled by caption and exact media without resend',async c=>{c.modes.ambiguousCreate=true;await assert.rejects(c.run(),/response lost/);assert.equal(c.creates,1);assert.equal((await c.saved()).batchMigration.pendingCreates.length,1);await c.run();assert.equal(c.creates,9);assert.equal(c.posts.filter(x=>x.id==='new-37').length,1);assert.equal((await c.saved()).batchMigration.pendingCreates.length,0);});
await scenario('duplicate after uncertain create blocks retry and preserves intent',async c=>{c.modes.ambiguousCreate=true;c.modes.duplicateOnCreate=true;await assert.rejects(c.run(),/response lost/);await assert.rejects(c.run(),/Duplicate exact/);assert.equal(c.creates,1);assert.equal((await c.saved()).batchMigration.pendingCreates.length,1);});
await scenario('duplicate caption also blocked after recorded post ID',async c=>{await c.run();const p=c.posts.find(x=>x.id==='new-37');c.posts.push({...structuredClone(p),id:'shadow-new-37'});await assert.rejects(c.run(),/Duplicate exact/);assert.equal(c.creates,9);});
await scenario('nullable legacy and new asset IDs keep full checkpoint and exact-byte verification',async c=>{
 c.manifest.sena=c.manifest.sena.filter(x=>x.day<40);c.modes.nullAssetId=true;for(const p of c.posts.filter(x=>Number(x.id.split('-')[1])>=31))p.assets[0].id=null;await c.save();const before=JSON.stringify(c.state.scheduled);await c.run();assert.equal(c.creates,3);let saved=await c.saved();assert.equal(JSON.stringify(saved.scheduled.filter(x=>x.day<=36)),before);assert.equal(saved.continuationHistoryReadback.nullableAssetIds.length,6);assert.ok(saved.scheduled.filter(x=>x.day>=37).every(x=>x.sourceBufferAssetId===null&&x.nativeAiGenerated===true&&x.mediaSha256));await c.run();assert.equal(c.creates,3);
});
for(const mode of ['caption-drift','time-drift','not-sent'])await scenario('null historical asset ID does not permit '+mode,async c=>{
 const p=c.posts.find(x=>x.id==='history-31');p.assets[0].id=null;if(mode==='caption-drift')p.text+=' changed';if(mode==='time-drift')p.dueAt='2026-10-16T11:35:00Z';if(mode==='not-sent')p.status='draft';await assert.rejects(c.run(),/historical/);assert.equal(c.creates,0);
});
await scenario('null new asset ID never permits wrong provider image bytes',async c=>{c.modes.nullAssetId=true;c.modes.providerMismatch=true;await assert.rejects(c.run(),/Provider image bytes/);assert.equal(c.creates,1);assert.equal((await c.saved()).batchMigration.pendingCreates.length,1);await assert.rejects(c.run(),/Provider image bytes/);assert.equal(c.creates,1);});
await scenario('null new asset ID never permits missing native AI label',async c=>{c.modes.nullAssetId=true;c.modes.falseAi=true;await assert.rejects(c.run(),/Native Instagram AI/);assert.equal(c.creates,1);assert.equal((await c.saved()).batchMigration.pendingCreates.length,1);});
assert.equal(process.cwd(),ROOT);
console.log(`PASS ${tests.length} continuation/adversarial scenarios; every transport is mocked; no live API/network calls.`);
console.log(tests.map(x=>' - '+x).join('\n'));
