import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runBatchQueue,validateBatches,verifyPost} from './sena-three-post-queue.mjs';
const id='6aa72524ea19ca0bde39313c',handle='sena.virtual.studio';
const items=Array.from({length:3},(_,i)=>({day:13+i,date:'2026-10-10',publishAt:new Date(Date.parse('2026-10-10T11:30:00Z')+i*60000).toISOString(),account:handle,caption:'caption-'+i,qcStatus:'accepted',aiDisclosure:true,batchId:'test'}));
validateBatches(items);
assert.throws(()=>validateBatches(items.slice(0,2)),/Complete/);
assert.throws(()=>validateBatches(items.map((x,i)=>({...x,publishAt:items[0].publishAt}))),/Invalid/);
const original=items.map((x,i)=>({id:'existing-'+i,channelId:id,text:x.caption,dueAt:`2026-10-${10+i}T11:30:00.000Z`,status:'scheduled',assets:[{id:'asset-'+i,mimeType:'image/jpeg',source:'https://example.com/'+i,image:{altText:'original alt',userTags:[]}}],metadata:{type:'post',shouldShareToFeed:true,isAiGenerated:true,firstComment:null,link:null,geolocation:null,stickerFields:null}}));
verifyPost(original[0],original[0],items[0].publishAt);
assert.throws(()=>verifyPost(original[0],{...original[0],assets:[]},items[0].publishAt),/readback/);
const root=await mkdtemp(join(tmpdir(),'sena-batch-test-')),prev=process.cwd();
let mutations=0,failAt=0,creates=0;
const mediaBytes=Buffer.from('test fixture media bytes');
let posts=structuredClone(original);
async function transport(url,options) {
 if(url.startsWith('https://raw.githubusercontent.com/'))return {ok:true,arrayBuffer:async()=>mediaBytes};
 assert.equal(url,'https://api.buffer.com');const {query,variables}=JSON.parse(options.body);let data;
 if(query.includes('account {'))data={account:{organizations:[{id:'org'}]}};
 else if(query.includes('channels(input'))data={channels:[{id,name:handle,displayName:handle,service:'instagram',isQueuePaused:false,isDisconnected:false,isLocked:false}]};
 else if(query.startsWith('mutation')) {
   if(query.includes('createPost')) {
     const input=variables.input;assert.equal(input.channelId,id);assert.equal(input.metadata.instagram.isAiGenerated,true);creates++;
     const p={id:'new-'+creates,channelId:id,text:input.text,dueAt:input.dueAt,status:'scheduled',assets:[{id:'new-asset-'+creates,mimeType:'image/jpeg',source:input.assets[0].image.url,image:{altText:input.assets[0].image.metadata.altText,userTags:[]}}],metadata:{...input.metadata.instagram,firstComment:null,link:null,geolocation:null,stickerFields:null}};
     posts.push(p);data={createPost:{post:{id:p.id}}};return {ok:true,json:async()=>({data})};
   }
   mutations++;assert.ok(query.includes('editPost'));assert.deepEqual(Object.keys(variables.input).sort(),['aiAssisted','assets','dueAt','id','metadata','mode','text']);
   const originalPost=posts.find(x=>x.id===variables.input.id);assert.equal(variables.input.text,originalPost.text);assert.equal(variables.input.assets[0].image.url,originalPost.assets[0].source);assert.equal(variables.input.metadata.instagram.isAiGenerated,true);
   if(mutations===failAt)throw Error('simulated edit failure');
   const p=posts.find(x=>x.id===variables.input.id);p.dueAt=variables.input.dueAt;data={editPost:{post:{id:p.id}}};
 } else {assert.equal(variables.channelId,id);const status=query.match(/status:\[(\w+)\]/)[1];data={posts:{edges:posts.filter(p=>p.status===status).map(node=>({node:structuredClone(node)})),pageInfo:{hasNextPage:false}}};}
 return {ok:true,json:async()=>({data})};
}
try {
 process.chdir(root);await mkdir('automation/30day',{recursive:true});
 const policy={channelId:id,handle,batchSize:3,cadenceDays:3,startDay:13,existing:original.map((x,i)=>({day:13+i,id:x.id,originalDueAt:x.dueAt}))};
 await writeFile('automation/30day/sena-grid-policy.json',JSON.stringify(policy));await writeFile('automation/30day/publishing-manifest.json',JSON.stringify({sena:items}));await writeFile('automation/30day/sena-state.json',JSON.stringify({scheduled:[]}));
 const run=()=>runBatchQueue({transport,env:{BUFFER_API_KEY:'mock'},clock:()=>Date.parse('2026-10-09T23:00:00Z')});
 failAt=2;await assert.rejects(run(),/simulated/);assert.equal(mutations,2);
 let saved=JSON.parse(await readFile('automation/30day/sena-state.json','utf8'));assert.equal(saved.batchMigration.edits.length,1);assert.equal(saved.batchMigration.pendingEdit.id,'existing-2');
 failAt=0;let result=await run();assert.equal(result.ok,true);assert.equal(mutations,3);assert.equal(result.scheduled.length,3);
 await run();assert.equal(mutations,3);assert.deepEqual(posts.map(x=>x.id),original.map(x=>x.id));assert.deepEqual(posts.map(x=>x.assets),original.map(x=>x.assets));
 posts.push({...original[0],id:'unmanaged'});await assert.rejects(run(),/Unmanaged/);assert.equal(mutations,3);
 posts.pop();
 const future=items.map((x,i)=>{const filename=`SENA_2026-10-13_D${16+i}.jpeg`;return {...x,day:16+i,caption:'next-'+i,date:'2026-10-13',publishAt:new Date(Date.parse(x.publishAt)+3*86400000).toISOString(),filename,mediaPath:'media/sena-30day-2026-09-28/'+filename,sha256:createHash('sha256').update(mediaBytes).digest('hex')};});
 await writeFile('automation/30day/publishing-manifest.json',JSON.stringify({sena:[...items,...future]}));
 await assert.rejects(run(),e=>e.code==='ENOENT');assert.equal(creates,0);
 await mkdir('media/sena-30day-2026-09-28',{recursive:true});for(const x of future)await writeFile(x.mediaPath,mediaBytes);
 const filled=await run();assert.equal(filled.scheduled.length,6);assert.equal(creates,3);await run();assert.equal(creates,3);
 console.log('PASS three-post cadence, asset/ID preservation, partial failure recovery, idempotency, unmanaged-post block; all services mocked.');
} finally {process.chdir(prev);await rm(root,{recursive:true,force:true});}
