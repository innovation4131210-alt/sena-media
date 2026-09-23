import { readFile, writeFile, mkdir } from 'node:fs/promises';

const API='https://api.buffer.com';
const key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY is not configured');

const manifest=JSON.parse(await readFile('automation/sena-month/manifest.json','utf8'));
const statePath='automation/sena-month/state.json';
let state={version:1,items:[]};
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch{}

async function gql(query,variables={}){
  const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});
  const j=await r.json();
  if(!r.ok||j.errors?.length) throw new Error(JSON.stringify(j.errors??j));
  return j.data;
}
async function findChannel(){
  const a=await gql('query { account { organizations { id name } } }');
  for(const o of a.account.organizations){
    const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:o.id});
    const c=d.channels.find(c=>String(c.service).toLowerCase()==='instagram'&&[c.name,c.displayName].filter(Boolean).some(v=>String(v).toLowerCase().includes('sena.virtual.studio')));
    if(c){
      if(c.isDisconnected||c.isLocked||c.isQueuePaused) throw new Error('SENA Buffer channel is not publishable');
      return {organizationId:o.id,...c};
    }
  }
  throw new Error('sena.virtual.studio is not connected');
}
async function mediaUrl(base){
  for(const ext of ['jpg','jpeg','png','webp']){
    const url=`https://raw.githubusercontent.com/innovation4131210-alt/sena-media/main/media/sena-30day/${base}.${ext}`;
    const r=await fetch(url,{method:'HEAD'});
    if(r.ok) return url;
  }
  return null;
}

const c=await findChannel();
const q=await gql('query($organizationId: OrganizationId!) { posts(first:50,input:{organizationId:$organizationId,filter:{status:[scheduled]}}) { edges { node { id channelId text dueAt status } } } }',{organizationId:c.organizationId});
const allScheduled=(q.posts?.edges??[]).map(e=>e.node);
let capacity=Math.max(0,9-allScheduled.length);
const created=[];
let changed=false;

for(const item of manifest.items){
  if(capacity<=0) break;
  if(state.items.some(x=>x.day===item.day)) continue;
  if(allScheduled.some(x=>x.channelId===c.id && x.text===item.caption)){
    const p=allScheduled.find(x=>x.channelId===c.id && x.text===item.caption);
    state.items.push({day:item.day,filenameBase:item.filenameBase,bufferPostId:p.id,dueAt:p.dueAt,reconciled:true});
    changed=true;
    continue;
  }
  const url=await mediaUrl(item.filenameBase);
  if(!url) continue;
  const dueAt=new Date(item.publishAt).toISOString();
  if(new Date(dueAt).getTime()<=Date.now()+10*60*1000) continue;
  const data=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt status } } ... on MutationError { message } } }',{
    input:{
      text:item.caption,
      channelId:c.id,
      schedulingType:'automatic',
      mode:'customScheduled',
      dueAt,
      aiAssisted:true,
      assets:[{image:{url,metadata:{altText:'SENA AI-generated lifestyle image'}}}],
      metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}
    }
  });
  if(!data.createPost?.post?.id) throw new Error(data.createPost?.message??JSON.stringify(data.createPost));
  state.items.push({day:item.day,filenameBase:item.filenameBase,bufferPostId:data.createPost.post.id,dueAt:data.createPost.post.dueAt,mediaUrl:url});
  created.push({day:item.day,id:data.createPost.post.id,dueAt:data.createPost.post.dueAt});
  changed=true;
  capacity--;
}
state.lastRunAt=new Date().toISOString();
state.channel={id:c.id,name:c.name,displayName:c.displayName};
state.observedOrganizationScheduledCount=allScheduled.length;
state.createdThisRun=created;
await mkdir('automation/sena-month',{recursive:true});
await writeFile(statePath,JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify({ok:true,scheduledBefore:allScheduled.length,created,remainingCapacity:capacity},null,2));
