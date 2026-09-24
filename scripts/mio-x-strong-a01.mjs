import {readFile,writeFile,mkdir} from "node:fs/promises";
const manifest=JSON.parse(await readFile("automation/mio-x/strong-60-a01.json","utf8"));
const API="https://api.buffer.com";
async function gql(query,variables={}){
 const key=process.env.SENA_BUFFER_API_KEY;
 if(!key) throw Error("SENA_BUFFER_API_KEY missing");
 const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
 const j=await r.json(); if(!r.ok||j.errors?.length) throw Error(JSON.stringify(j.errors??{status:r.status})); return j.data;
}
const account=await gql("query { account { organizations { id } } }");
const matches=[];
for(const org of account.account.organizations){
 const d=await gql(`query($organizationId: OrganizationId!){channels(input:{organizationId:$organizationId}){id name displayName service isDisconnected isLocked isQueuePaused}}`,{organizationId:org.id});
 for(const c of d.channels){
  if(c.id===manifest.channelId && c.name===manifest.handle && String(c.service).toLowerCase()==="twitter") matches.push({...c,organizationId:org.id});
 }
}
if(matches.length!==1) throw Error("Exact MIO X channel not found");
const channel=matches[0];
if(channel.isDisconnected||channel.isLocked||channel.isQueuePaused) throw Error("MIO X channel unavailable");
async function inventory(){
 const d=await gql(`query($organizationId: OrganizationId!, $channelId: ChannelId!){posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}){edges{node{id text status dueAt sentAt externalLink assets{id mimeType source type}}}pageInfo{hasNextPage}}}`,{organizationId:channel.organizationId,channelId:channel.id});
 if(d.posts.pageInfo.hasNextPage) throw Error("Incomplete inventory");
 return d.posts.edges.map(e=>e.node);
}
let posts=await inventory();
const exact=posts.find(p=>p.text===manifest.text && Math.abs(Date.parse(p.dueAt??p.sentAt)-Date.parse(manifest.dueAt))<60000);
let target=exact;
if(!target){
 if(Date.parse(manifest.dueAt)<=Date.now()) throw Error("Past due; no catchup");
 const d=await gql(`mutation($input: CreatePostInput!){createPost(input:$input){__typename ... on PostActionSuccess{post{id text status dueAt channelId assets{id mimeType source type}}} ... on MutationError{message}}}`,{input:{text:manifest.text,channelId:channel.id,dueAt:manifest.dueAt,schedulingType:"automatic",mode:"customScheduled",aiAssisted:true,assets:[{image:{url:manifest.mediaUrl}}],needsApproval:false,saveToDraft:false}});
 if(!d.createPost?.post?.id) throw Error(d.createPost?.message??"Unknown createPost error");
 target=d.createPost.post;
}
posts=await inventory();
const verified=posts.find(p=>p.id===target.id);
if(!verified||verified.status!=="scheduled"||verified.text!==manifest.text) throw Error("MIO strong post readback failed");
if(!Array.isArray(verified.assets)||!verified.assets.some(a=>String(a.mimeType||"").startsWith("image/"))) throw Error("MIO strong post image missing");
const report={checkedAt:new Date().toISOString(),key:manifest.key,postId:verified.id,status:verified.status,dueAt:verified.dueAt,channelId:channel.id,assets:verified.assets};
await mkdir("analytics",{recursive:true});
await writeFile("analytics/mio-x-strong-a01-readback.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report));
