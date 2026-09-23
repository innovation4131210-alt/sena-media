import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const API='https://api.buffer.com', key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY is not configured');
const manifest=JSON.parse(await readFile('automation/30day/publishing-manifest.json','utf8'));
const statePath='automation/30day/sena-state.json';
async function readState(path, fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
const state=await readState(statePath,{version:2,scheduled:[]});
const legacy=await readState('automation/sena-month/state.json',{items:[]});
for(const old of legacy.items??[])if(!state.scheduled.some(x=>x.day===old.day))state.scheduled.push({...old,migratedFrom:'sena-month'});
async function save(){await mkdir('automation/30day',{recursive:true});await writeFile(statePath,JSON.stringify(state,null,2)+'\n');}
async function gql(query,variables={}){
 const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
 const j=await r.json();if(!r.ok||j.errors?.length)throw new Error(JSON.stringify(j.errors??j));return j.data;
}
async function findChannel(){
 const a=await gql('query { account { organizations { id name } } }'), found=[];
 for(const o of a.account.organizations){
  const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:o.id});
  for(const c of d.channels)if(String(c.service).toLowerCase()==='instagram'&&[c.name,c.displayName].includes('sena.virtual.studio'))found.push({organizationId:o.id,...c});
 }
 if(found.length!==1)throw new Error('Expected exactly one sena.virtual.studio Instagram channel');
 const c=found[0];if(c.id!=='6aa72524ea19ca0bde39313c'||c.isDisconnected||c.isLocked||c.isQueuePaused)throw new Error('SENA identity or publishability check failed');return c;
}
async function posts(c,status){
 const d=await gql(`query($organizationId: OrganizationId!) { posts(first:100,input:{organizationId:$organizationId,filter:{status:[${status}]}}) { edges { node { id channelId text dueAt status } } } }`,{organizationId:c.organizationId});
 const rows=(d.posts?.edges??[]).map(e=>e.node);if(rows.length>=100)throw new Error(`Incomplete ${status} listing; refusing to schedule`);return rows;
}
const dayKey=v=>new Date(new Date(v).getTime()+9*3600000).toISOString().slice(0,10);
const c=await findChannel(), queued=await posts(c,'scheduled'), sent=await posts(c,'sent'), failed=await posts(c,'error');
const known=[...queued,...sent,...failed].filter(p=>p.channelId===c.id);
state.version=2;state.lastRunAt=new Date().toISOString();state.channel={id:c.id,name:c.name,displayName:c.displayName};
state.observedOrganizationScheduledCount=queued.length;state.createdThisRun=[];state.blocked=[];state.pendingCreates??=[];
let capacity=Math.max(0,9-queued.length);
for(const item of manifest.sena){
 if(item.account!=='sena.virtual.studio'||item.aiDisclosure!==true||item.qcStatus!=='accepted')throw new Error(`Invalid account/disclosure/QC at D${item.day}`);
 const recorded=state.scheduled.find(x=>x.day===item.day);
 if(recorded){const live=known.find(x=>x.id===recorded.bufferPostId);if(live)recorded.lastObservedStatus=live.status;if(recorded.mediaSha256&&recorded.mediaSha256!==item.sha256)throw new Error(`Scheduled media changed at D${item.day}`);continue;}
 const matches=known.filter(x=>x.text===item.caption);
 if(matches.length>1)throw new Error(`Multiple exact-caption posts at D${item.day}`);
 if(matches.length){const p=matches[0];if(new Date(p.dueAt).getTime()!==new Date(item.publishAt).getTime())throw new Error(`Existing caption has different date at D${item.day}`);state.scheduled.push({day:item.day,bufferPostId:p.id,dueAt:p.dueAt,reconciled:true,lastObservedStatus:p.status,mediaVerification:'requires API media verification; not recreated'});await save();continue;}
 if(state.pendingCreates.some(p=>p.day===item.day)){state.blocked.push({day:item.day,reason:'unresolved_create_attempt'});continue;}
 if(known.some(p=>p.dueAt&&dayKey(p.dueAt)===item.date)){state.blocked.push({day:item.day,reason:'existing_post_on_tokyo_date'});continue;}
 if(!capacity)continue;
 if(new Date(item.publishAt).getTime()<=Date.now()+10*60*1000){state.blocked.push({day:item.day,reason:'past_or_imminent_slot'});continue;}
 const expected=`media/sena-30day-2026-09-28/${item.filename}`;
 if(item.mediaPath!==expected||!/^SENA_\d{4}-\d{2}-\d{2}_D\d{2}\.jpeg$/.test(item.filename))throw new Error('Invalid exact media path');
 let bytes;try{bytes=await readFile(expected);}catch(e){if(e.code==='ENOENT'){state.blocked.push({day:item.day,reason:'missing_exact_media'});continue;}throw e;}
 if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error(`Local media mismatch at D${item.day}`);
 const ref=process.env.GITHUB_SHA||'main', url=`https://raw.githubusercontent.com/innovation4131210-alt/sena-media/${ref}/${expected}`;
 const r=await fetch(url,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw new Error(`Media HTTP ${r.status} at D${item.day}`);
 if(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')!==item.sha256)throw new Error(`Remote media mismatch at D${item.day}`);
 const dueAt=new Date(item.publishAt).toISOString();
 state.pendingCreates.push({day:item.day,dueAt,caption:item.caption,attemptedAt:new Date().toISOString()});await save();
 const d=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt status } } ... on MutationError { message } } }',{
  input:{text:item.caption,channelId:c.id,schedulingType:'automatic',mode:'customScheduled',dueAt,aiAssisted:true,assets:[{image:{url,metadata:{altText:'SENA AI-generated lifestyle image'}}}],metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}}
 });
 const p=d.createPost?.post;if(!p?.id)throw new Error(d.createPost?.message??JSON.stringify(d.createPost));
 state.scheduled.push({day:item.day,date:item.date,bufferPostId:p.id,dueAt:p.dueAt,mediaUrl:url,mediaSha256:item.sha256,caption:item.caption,lastObservedStatus:p.status});
 state.pendingCreates=state.pendingCreates.filter(x=>x.day!==item.day);
 state.createdThisRun.push({day:item.day,id:p.id,dueAt:p.dueAt});known.push({...p,channelId:c.id});capacity--;await save();
}
state.lastVerifiedAt=new Date().toISOString();await save();
console.log(JSON.stringify({ok:true,scheduledBefore:queued.length,created:state.createdThisRun,remainingCapacity:capacity,blocked:state.blocked}));
