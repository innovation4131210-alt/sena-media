import { readFile, writeFile, access } from 'node:fs/promises';

const API='https://api.buffer.com';
const key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY is not configured');
const manifest=JSON.parse(await readFile('automation/30day/publishing-manifest.json','utf8'));
const items=manifest.sena;
const owner='innovation4131210-alt', repo='sena-media', branch='main';
const mediaDir='media/sena-30day-2026-09-28';
const statePath='automation/30day/sena-state.json';

async function gql(query,variables={}){
  const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});
  const j=await r.json();
  if(!r.ok||j.errors?.length) throw new Error(JSON.stringify(j.errors??j));
  return j.data;
}
async function channel(){
  const a=await gql('query { account { organizations { id name } } }');
  const all=[];
  for(const o of a.account.organizations){
    const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:o.id});
    for(const c of d.channels) all.push({organizationId:o.id,organization:o.name,...c});
  }
  const c=all.find(c=>String(c.service).toLowerCase()==='instagram'&&[c.name,c.displayName].filter(Boolean).some(v=>String(v).toLowerCase().includes('sena.virtual.studio')));
  if(!c) throw new Error('sena.virtual.studio is not connected to this Buffer key');
  if(c.isDisconnected||c.isLocked||c.isQueuePaused) throw new Error('SENA Buffer channel is not publishable');
  return c;
}
let state={version:1,scheduled:[]};
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch{}
for(const item of items){
  const base=item.filename.replace(/\.jpeg$/,'');
  const candidates=[`${mediaDir}/${base}.jpeg`,`${mediaDir}/${base}.png`];
  let file=null;
  for(const p of candidates){try{await access(p); file=p; break;}catch{}}
  if(!file) throw new Error(`Missing staged media for ${base}`);
}
const c=await channel();
const existing=await gql('query($organizationId: OrganizationId!) { posts(input:{organizationId:$organizationId,filter:{status:[scheduled]}}) { edges { node { id text channelId dueAt } } } }',{organizationId:c.organizationId});
const scheduled=(existing.posts?.edges??[]).map(e=>e.node).filter(p=>p.channelId===c.id);

for(const item of items){
  const already=state.scheduled.find(x=>x.day===item.day)||scheduled.find(x=>x.text===item.caption);
  if(already){
    if(!state.scheduled.find(x=>x.day===item.day)) state.scheduled.push({day:item.day,bufferPostId:already.id,dueAt:already.dueAt,reconciled:true});
    continue;
  }
  const base=item.filename.replace(/\.jpeg$/,'');
  let ext='jpeg';
  try{await access(`${mediaDir}/${base}.jpeg`);}catch{ext='png';}
  const url=`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${mediaDir}/${base}.${ext}`;
  const due=new Date(item.publishAt).toISOString();
  const data=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }',{
    input:{text:item.caption,channelId:c.id,schedulingType:'automatic',mode:'customScheduled',dueAt:due,aiAssisted:true,assets:[{image:{url,metadata:{altText:'SENA AI-generated lifestyle image'}}}],metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}}
  });
  if(!data.createPost?.post?.id) throw new Error(data.createPost?.message??JSON.stringify(data.createPost));
  state.scheduled.push({day:item.day,bufferPostId:data.createPost.post.id,dueAt:data.createPost.post.dueAt,mediaUrl:url});
  await writeFile(statePath,JSON.stringify(state,null,2)+'\n');
}
state.lastVerifiedAt=new Date().toISOString();
state.channel={id:c.id,name:c.name,displayName:c.displayName};
await writeFile(statePath,JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify({ok:true,count:state.scheduled.length,channel:c.name},null,2));
