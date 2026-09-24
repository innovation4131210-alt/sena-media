import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateTransferGate} from './mio-instagram-transfer-guard.mjs';
const repo=process.env.GITHUB_REPOSITORY, statePath='automation/mio-instagram-overflow/state.json';
const manifest=JSON.parse(await readFile('automation/30day/publishing-manifest.json','utf8'));
const receipt=JSON.parse(await readFile('automation/mio-instagram-overflow/transfer-authorization.json','utf8'));
const expected=['2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27'];
const items=manifest.mio.filter(p=>expected.includes(p.date));
if(items.length!==6||items.some((p,i)=>p.date!==expected[i]||p.account!=='mio.ai_life'||p.aiDisclosure!==true||p.qcStatus!=='accepted'))throw Error('MIO six-day manifest gate failed');
if(!manifest.accounts?.mio?.scheduler?.includes('Buffer 2026-10-22 through 2026-10-27'))throw Error('Authoritative manifest no longer assigns these dates to Buffer');
if(!process.env.BUFFER_API_KEY||!process.env.GH_TOKEN)throw Error('Missing runner credentials');
async function gh(method,body){
 const r=await fetch('https://api.github.com/repos/'+repo+'/contents/'+statePath,{method,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(method==='GET'&&r.status===404)return null;
 if(!r.ok)throw Error('State persistence HTTP '+r.status);
 return r.json();
}
let remote=await gh('GET'), state=remote?JSON.parse(Buffer.from(remote.content,'base64').toString()):{posts:[]};
async function save(){
 const response=await gh('PUT',{message:'Record MIO Instagram overflow transfer',content:Buffer.from(JSON.stringify(state,null,2)+'\n').toString('base64'),...(remote?{sha:remote.sha}:{})});
 remote={sha:response.content.sha};
}
async function gql(query,variables={}){
 const r=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+process.env.BUFFER_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
 const j=await r.json();if(!r.ok||j.errors?.length)throw Error(JSON.stringify(j.errors??{status:r.status}));return j.data;
}
const account=await gql('query { account { organizations { id } } }'),matches=[];
for(const organization of account.account.organizations){
 const result=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:organization.id});
 for(const c of result.channels)if(c.id==='6aa630b7ea19ca0bde329146'&&c.service==='instagram'&&[c.name,c.displayName].includes('mio.ai_life'))matches.push({...c,organizationId:organization.id});
}
if(matches.length!==1)throw Error('Exact MIO Instagram channel missing');
const channel=matches[0];if(channel.isQueuePaused||channel.isDisconnected||channel.isLocked)throw Error('MIO Instagram unavailable');
async function inventory(){
 const data=await gql('query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink } } pageInfo { hasNextPage } } }',{organizationId:channel.organizationId,channelId:channel.id});
 if(data.posts.pageInfo.hasNextPage)throw Error('Incomplete Buffer inventory');
 return data.posts.edges.map(e=>e.node);
}
let current=await inventory();
for(const p of items){
 const prior=state.posts.find(x=>x.date===p.date), dueAt=new Date(p.publishAt).toISOString();
 const matches=current.filter(x=>x.text===p.caption&&new Date(x.dueAt).getTime()===new Date(dueAt).getTime());
 if(matches.length>1)throw Error('Buffer duplicate on '+p.date);
 if(matches.length===1){
  if(prior&&prior.id&&prior.id!==matches[0].id)throw Error('State id mismatch');
  if(!['scheduled','sent'].includes(matches[0].status))throw Error('Existing Buffer post requires reconciliation '+p.date);
  const observed={id:matches[0].id,status:matches[0].status,dueAt,verifiedAt:new Date().toISOString(),externalLink:matches[0].externalLink??null};
  if(!prior)state.posts.push({date:p.date,day:p.day,...observed,reconciled:true});
  else Object.assign(prior,observed);
  await save();continue;
 }
 // A stale reservation ID cannot authorize a create or a cancellation.
 // Only the exact, already-cancelled six IDs may be retired after fresh
 // Metricool absence evidence and the live empty Buffer date check.
 const gate=validateTransferGate(receipt,p,prior,current);
 if(current.filter(x=>x.status==='scheduled').length>=10)throw Error('Free Buffer queue full');
 if(Date.now()+600000>=new Date(dueAt).getTime())throw Error('Publication time passed');
 const path='media/mio-30day-2026-09-28/'+p.filename;
 if(path!==p.mediaPath||!p.sha256)throw Error('Media manifest mismatch '+p.date);
 const bytes=await readFile(path);
 if(createHash('sha256').update(bytes).digest('hex')!==p.sha256)throw Error('Local media hash mismatch '+p.date);
 const url='https://raw.githubusercontent.com/innovation4131210-alt/sena-media/bf85c83ec55429e7a41e49a03d568c5717780a8c/'+path;
 const response=await fetch(url,{signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw Error('Media HTTP '+response.status+' '+p.date);
 if(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')!==p.sha256)throw Error('Remote media hash mismatch '+p.date);
 if(gate.archivePrior){
  state.retiredReservations??=[];
  state.retiredReservations.push({...prior,retiredFromActiveStateAt:new Date().toISOString(),restorationAuthorizationId:gate.authorizationId});
  state.posts=state.posts.filter(x=>x!==prior);
 }
 const intent={date:p.date,day:p.day,dueAt,status:'intent',mediaSha256:p.sha256,captionSha256:createHash('sha256').update(p.caption).digest('hex'),restorationAuthorizationId:gate.authorizationId,previousBufferId:prior?.id??null};
 state.posts.push(intent);state.disposition='restoring_authoritative_buffer_only_dates';await save();
 const data=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt status } } ... on MutationError { message } } }',{input:{text:p.caption,channelId:channel.id,schedulingType:'automatic',mode:'customScheduled',dueAt,aiAssisted:true,assets:[{image:{url,metadata:{altText:'AI-generated image of MIO in an everyday scene'}}}],metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}}});
 const created=data.createPost?.post;if(!created?.id)throw Error(data.createPost?.message??JSON.stringify(data.createPost));
 Object.assign(intent,{id:created.id,status:'created_unverified',mediaUrl:url,aiDisclosureSubmitted:true});await save();
 current=await inventory();
 const observed=current.find(x=>x.id===created.id);
 if(!observed||observed.text!==p.caption||new Date(observed.dueAt).getTime()!==new Date(dueAt).getTime()||observed.status!=='scheduled')throw Error('Buffer readback mismatch '+p.date);
 intent.status='scheduled';intent.verifiedAt=new Date().toISOString();await save();
 console.log(JSON.stringify({date:p.date,id:created.id,status:observed.status,dueAt:observed.dueAt}));
}
state.channelId=channel.id;state.verifiedAt=new Date().toISOString();state.disposition='verified_buffer_primary_for_oct22_27_metricool_20_october_posts';await save();
console.log(JSON.stringify({ok:true,count:state.posts.length,channel:channel.name,disposition:state.disposition}));
