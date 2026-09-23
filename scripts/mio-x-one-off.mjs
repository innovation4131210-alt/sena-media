import {readFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile('automation/mio-x/one-off-2026-09-24.json','utf8'));
const repo=process.env.GITHUB_REPOSITORY;
const statePath='automation/mio-x/state.json';
async function github(method,body){
 const response=await fetch('https://api.github.com/repos/'+repo+'/contents/'+statePath,{method,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(response.status===404&&method==='GET')return null;
 if(!response.ok)throw Error('State persistence HTTP '+response.status);
 return response.json();
}
let remote=await github('GET');
let state=remote?JSON.parse(Buffer.from(remote.content,'base64').toString()):{version:1,posts:[]};
async function save(){
 const response=await github('PUT',{message:'Record guarded MIO X reservation',content:Buffer.from(JSON.stringify(state,null,2)+'\n').toString('base64'),...(remote?{sha:remote.sha}:{})});
 remote={sha:response.content.sha};
}
async function gql(query,variables={}){
 const response=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+process.env.BUFFER_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
 const result=await response.json();
 if(!response.ok||result.errors?.length)throw Error(JSON.stringify(result.errors??{status:response.status}));
 return result.data;
}
async function inventory(organizationId,channelId){
 const data=await gql('query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink } } pageInfo { hasNextPage } } }',{organizationId,channelId});
 if(data.posts.pageInfo.hasNextPage)throw Error('Incomplete channel inventory; stop before mutation');
 return data.posts.edges.map(({node})=>node);
}
const account=await gql('query { account { organizations { id } } }');
const matches=[];
for(const organization of account.account.organizations){
 const data=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isDisconnected isLocked isQueuePaused } }',{organizationId:organization.id});
 for(const channel of data.channels){
  if(!manifest.channelGuard.serviceCandidates.includes(String(channel.service).toLowerCase()))continue;
  const posts=await inventory(organization.id,channel.id);
  if(posts.some(post=>post.id===manifest.channelGuard.knownBufferPostId))matches.push({...channel,organizationId:organization.id,posts});
 }
}
if(matches.length!==1)throw Error('Expected exactly one X channel containing known post; found '+matches.length);
const channel=matches[0];
if(channel.isDisconnected||channel.isLocked||channel.isQueuePaused)throw Error('Resolved MIO X channel unavailable');
const target=manifest.post;
const exact=channel.posts.filter(post=>post.text===target.text);
if(exact.length>1)throw Error('Duplicate target text already exists');
let entry=state.posts.find(post=>post.key===target.key);
if(exact.length===1){
 const existing=exact[0];
 if(new Date(existing.dueAt).getTime()!==new Date(target.dueAt).getTime())throw Error('Existing target date mismatch');
 if(!entry){entry={key:target.key};state.posts.push(entry);}
 Object.assign(entry,{id:existing.id,status:existing.status,dueAt:existing.dueAt,recovered:true,verifiedAt:new Date().toISOString()});
 state.channel={id:channel.id,name:channel.name,service:channel.service};state.lastRunAt=new Date().toISOString();await save();
 console.log(JSON.stringify({ok:true,action:'recovered_existing',id:existing.id,status:existing.status,dueAt:existing.dueAt}));process.exit(0);
}
if(entry)throw Error('Saved intent missing from Buffer inventory; manual reconciliation required, no retry');
if(new Date(target.dueAt)<=new Date())throw Error('Target is past due; no catch-up');
entry={key:target.key,status:'intent',dueAt:target.dueAt,createdForReason:manifest.reason};state.posts.push(entry);
state.channel={id:channel.id,name:channel.name,service:channel.service};await save();
const created=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }',{input:{channelId:channel.id,text:target.text,schedulingType:'automatic',mode:'customScheduled',dueAt:target.dueAt,aiAssisted:true}});
if(!created.createPost?.post?.id)throw Error(created.createPost?.message??'Unknown Buffer mutation result');
Object.assign(entry,{id:created.createPost.post.id,status:'created_unverified'});await save();
const refreshed=await inventory(channel.organizationId,channel.id);
const verified=refreshed.find(post=>post.id===entry.id);
if(!verified||verified.text!==target.text||new Date(verified.dueAt).getTime()!==new Date(target.dueAt).getTime()||verified.status!=='scheduled')throw Error('Buffer readback failed');
Object.assign(entry,{status:verified.status,dueAt:verified.dueAt,verifiedAt:new Date().toISOString()});
state.lastRunAt=new Date().toISOString();await save();
console.log(JSON.stringify({ok:true,action:'created_and_verified',id:entry.id,status:entry.status,dueAt:entry.dueAt}));
