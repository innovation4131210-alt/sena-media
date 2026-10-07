
import {readFile} from 'node:fs/promises';
import {approvedPhoto, requireRemotePhoto, requireRecordedPhoto, verifyPhotoBytes} from './mio-threads-photo-policy.mjs';
const manifest=JSON.parse(await readFile('automation/mio-threads/manifest.json','utf8'));
const repo=process.env.GITHUB_REPOSITORY;
const statePath='automation/mio-threads/state.json';
async function gh(method,body){
 const r=await fetch('https://api.github.com/repos/'+repo+'/contents/'+statePath,{method,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(r.status===404&&method==='GET')return null;
 if(!r.ok)throw Error('State persistence HTTP '+r.status);
 return r.json();
}
let remote=await gh('GET');
let state=remote?JSON.parse(Buffer.from(remote.content,'base64').toString()):{posts:[]};
async function save(){
 const r=await gh('PUT',{message:'Record MIO Threads reservation state',content:Buffer.from(JSON.stringify(state,null,2)+'\n').toString('base64'),...(remote?{sha:remote.sha}:{})});
 remote={sha:r.content.sha};
}
async function gql(query,variables={}){
 const r=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+process.env.BUFFER_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
 const j=await r.json();if(!r.ok||j.errors?.length)throw Error(JSON.stringify(j.errors??{status:r.status}));return j.data;
}
const a=await gql('query { account { organizations { id } } }');
const matches=[];
for(const o of a.account.organizations){
 const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name service isDisconnected isLocked isQueuePaused } }',{organizationId:o.id});
 for(const c of d.channels)if(c.id===manifest.channelId&&c.name===manifest.handle&&c.service==='threads')matches.push({...c,organizationId:o.id});
}
if(matches.length!==1)throw Error('Exact channel identity not found');
const c=matches[0];if(c.isDisconnected||c.isLocked||c.isQueuePaused)throw Error('Channel unavailable');
async function inventory(){
 const d=await gql('query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink channelId assets { id mimeType } } } pageInfo { hasNextPage } } }',{organizationId:c.organizationId,channelId:c.id});
 if(d.posts.pageInfo.hasNextPage)throw Error('Incomplete history; stop for pagination');
 const rows=d.posts.edges.map(e=>e.node);
 if(rows.some(p=>p.channelId!==c.id))throw Error('Inventory channel mismatch');
 return rows;
}
async function editPostText(id,text){
 const d=await gql('mutation($input: EditPostInput!) { editPost(input:$input) { __typename ... on PostActionSuccess { post { id text status dueAt } } ... on MutationError { message } } }',{input:{id,text,aiAssisted:true}});
 if(!d.editPost?.post?.id)throw Error(d.editPost?.message??'Unknown edit mutation result');
 return d.editPost.post;
}
let existing=await inventory();
for(const p of manifest.posts){
 const old=state.posts.find(x=>x.key===p.key);
 if(old){
  let byId=existing.find(x=>x.id===old.id);
  if(!byId)throw Error('Prior intent missing from remote inventory; manual reconciliation required, no retry');
  const expectedAt=new Date(p.dueAt).getTime();
  const remoteAt=new Date(byId.dueAt??byId.sentAt).getTime();
  if(!Number.isFinite(remoteAt)||Math.abs(remoteAt-expectedAt)>60000)throw Error('Existing date mismatch');
  // Never rewrite sent history or infer a photo from old local status.
  if(byId.status==='sent'){
   Object.assign(old,{status:byId.status,dueAt:byId.dueAt??p.dueAt});await save();continue;
  }
  if(byId.status!=='scheduled')throw Error('Existing post not scheduled or sent');
  requireRecordedPhoto(p,old,byId);
  if(byId.text!==p.text){
   await editPostText(byId.id,p.text);
   existing=await inventory();
   byId=existing.find(x=>x.id===old.id);
   if(!byId||byId.text!==p.text||byId.status!=='scheduled'||Math.abs(new Date(byId.dueAt).getTime()-expectedAt)>60000)throw Error('Edit readback failed');
   requireRecordedPhoto(p,old,byId);
   Object.assign(old,{id:byId.id,status:byId.status,dueAt:byId.dueAt,textReconciledAt:new Date().toISOString(),verifiedAt:new Date().toISOString()});
   await save();
   console.log(JSON.stringify({key:p.key,id:byId.id,dueAt:byId.dueAt,status:byId.status,edited:true}));
   continue;
  }
  if(byId.text===p.text){
   Object.assign(old,{id:byId.id,status:byId.status,dueAt:byId.dueAt??p.dueAt});
   await save();
   continue;
  }
  throw Error('Existing post text mismatch');
 }
 const same=existing.filter(x=>x.text===p.text);
 if(same.length>1)throw Error('Duplicate text already exists');
 if(same.length===1){
  const x=same[0];if(new Date(x.dueAt).getTime()!==new Date(p.dueAt).getTime())throw Error('Existing date mismatch');
  if(x.status!=='sent'){if(x.status!=='scheduled')throw Error('Unexpected recovery status');throw Error('Untracked scheduled post; reconcile photo identity separately');}
  if(!old)state.posts.push({key:p.key,id:x.id,dueAt:x.dueAt,status:x.status});
  else Object.assign(old,{id:x.id,status:x.status,dueAt:x.dueAt});
  await save();continue;
 }
 if(new Date(p.dueAt)<=new Date())throw Error('Past date; no catchup');
 if(existing.filter(x=>x.status==='scheduled').length>=10)throw Error('Free queue cap reached');
 // Validate and hash the actual approved bytes before recording an intent.
 const assets=await verifyPhotoBytes(p);
 if(existing.some(x=>Math.abs(Date.parse(x.dueAt??x.sentAt)-Date.parse(p.dueAt))<=60000))throw Error('Existing slot occupied');
 const intent={key:p.key,status:'intent',dueAt:p.dueAt,photoSourceImageId:p.photo.sourceImageId,photoSha256:p.photo.sha256};state.posts.push(intent);await save();
 const d=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt channelId assets { id mimeType } } } ... on MutationError { message } } }',{input:{channelId:c.id,text:p.text,schedulingType:'automatic',mode:'customScheduled',dueAt:p.dueAt,aiAssisted:true,assets}});
 if(!d.createPost?.post?.id)throw Error(d.createPost?.message??'Unknown mutation result');
 Object.assign(intent,{id:d.createPost.post.id,status:'created_unverified'});await save();
 requireRemotePhoto(d.createPost.post);
 if(d.createPost.post.channelId!==c.id)throw Error('Created channel mismatch');
 intent.assetIds=d.createPost.post.assets.filter(a=>String(a.mimeType??'').startsWith('image/')).map(a=>a.id);await save();
 existing=await inventory();
 const verified=existing.find(x=>x.id===intent.id);
 if(!verified||verified.text!==p.text||new Date(verified.dueAt).getTime()!==new Date(p.dueAt).getTime()||verified.status!=='scheduled')throw Error('Readback failed');
 requireRecordedPhoto(p,intent,verified);
 Object.assign(intent,{assetIds:verified.assets.filter(a=>String(a.mimeType??'').startsWith('image/')).map(a=>a.id),status:verified.status,verifiedAt:new Date().toISOString()});await save();
 console.log(JSON.stringify({key:p.key,id:intent.id,dueAt:verified.dueAt,status:verified.status}));
}
state.channelId=c.id;state.verifiedAt=new Date().toISOString();await save();
console.log(JSON.stringify({ok:true,count:state.posts.length,channel:c.name}));

