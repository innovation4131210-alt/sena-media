import {readFile} from "node:fs/promises";
const repo=process.env.GITHUB_REPOSITORY;
const auth=JSON.parse(await readFile("automation/mio-tiktok-account-limit-bridge/duplicate-cleanup-authorization.json","utf8"));
const statePath="automation/mio-tiktok-account-limit-bridge/duplicate-cleanup.json";
if(!process.env.BUFFER_API_KEY||!process.env.GH_TOKEN) throw Error("Missing runner credentials");
if(auth.id!=="mio-tiktok-duplicate-cleanup-2026-10-16"||auth.account!=="mio.ai_life"||auth.channelId!=="6aa6312aea19ca0bde329a87"||auth.service!=="tiktok") throw Error("Authorization scope mismatch");
if(!Array.isArray(auth.pairs)||auth.pairs.length!==5||new Set(auth.pairs.flatMap(x=>[x.preserveId,x.removeId])).size!==10) throw Error("Expected five exact unique pairs");
async function gql(query,variables={}){
 const r=await fetch("https://api.buffer.com",{method:"POST",headers:{Authorization:"Bearer "+process.env.BUFFER_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
 const j=await r.json(); if(!r.ok||j.errors?.length) throw Error(JSON.stringify(j.errors??{status:r.status})); return j.data;
}
async function ghGet(){
 const r=await fetch("https://api.github.com/repos/"+repo+"/contents/"+statePath,{headers:{Authorization:"Bearer "+process.env.GH_TOKEN,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(30000)});
 if(r.status===404)return null;if(!r.ok)throw Error("State read HTTP "+r.status);return r.json();
}
async function persist(row){
 for(let attempt=1;attempt<=4;attempt++){
  const remote=await ghGet();const state=remote?JSON.parse(Buffer.from(remote.content,"base64").toString("utf8")):{version:1,authorizationId:auth.id,actions:[]};
  const i=state.actions.findIndex(x=>x.removeId===row.removeId);if(i>=0)state.actions[i]={...state.actions[i],...row};else state.actions.push(row);
  state.updatedAt=new Date().toISOString();
  const r=await fetch("https://api.github.com/repos/"+repo+"/contents/"+statePath,{method:"PUT",headers:{Authorization:"Bearer "+process.env.GH_TOKEN,Accept:"application/vnd.github+json","Content-Type":"application/json"},body:JSON.stringify({message:"Record MIO TikTok duplicate cleanup",content:Buffer.from(JSON.stringify(state,null,2)+"\n").toString("base64"),...(remote?{sha:remote.sha}:{})}),signal:AbortSignal.timeout(30000)});
  if(r.ok)return;if(r.status===409||r.status===422)continue;throw Error("State write HTTP "+r.status);
 }
 throw Error("State write conflict after retries");
}
const account=await gql("query { account { organizations { id } } }");let channel=null;
for(const o of account.account.organizations){
 const d=await gql("query($organizationId: OrganizationId!){ channels(input:{organizationId:$organizationId}){ id name displayName service isQueuePaused isDisconnected isLocked } }",{organizationId:o.id});
 for(const c of d.channels)if(c.id===auth.channelId&&c.service==="tiktok"&&[c.name,c.displayName].includes(auth.account))channel={...c,organizationId:o.id};
}
if(!channel||channel.isQueuePaused||channel.isDisconnected||channel.isLocked)throw Error("Exact MIO TikTok channel unavailable");
async function inventory(){
 const d=await gql("query($organizationId: OrganizationId!,$channelId: ChannelId!){ posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}){edges{node{id text status dueAt channelId}}pageInfo{hasNextPage}}}",{organizationId:channel.organizationId,channelId:channel.id});
 if(d.posts.pageInfo.hasNextPage)throw Error("Incomplete inventory");return d.posts.edges.map(e=>e.node);
}
let posts=await inventory();
for(const p of auth.pairs){
 const keep=posts.find(x=>x.id===p.preserveId),drop=posts.find(x=>x.id===p.removeId);
 if(!keep)throw Error("Preserved original missing "+p.preserveId);
 if(new Date(keep.dueAt).getTime()!==Date.parse(p.dueAt)||!["draft","scheduled","sent"].includes(keep.status))throw Error("Preserved original mismatch "+p.preserveId);
 if(!drop){
  await persist({...p,status:"already_absent",preservedStatus:keep.status,verifiedAt:new Date().toISOString()});continue;
 }
 if(new Date(drop.dueAt).getTime()!==Date.parse(p.dueAt)||drop.text!==keep.text||drop.status!=="scheduled")throw Error("Removal target mismatch "+p.removeId);
 const d=await gql("mutation($input: DeletePostInput!){deletePost(input:$input){__typename}}",{input:{id:p.removeId}});
 if(!d.deletePost?.__typename)throw Error("Delete returned no payload "+p.removeId);
 posts=await inventory();
 if(posts.some(x=>x.id===p.removeId)||!posts.some(x=>x.id===p.preserveId))throw Error("Delete readback failed "+p.removeId);
 await persist({...p,status:"cancelled_duplicate",preservedStatus:posts.find(x=>x.id===p.preserveId).status,cancelledAt:new Date().toISOString(),verifiedAt:new Date().toISOString()});
 console.log(JSON.stringify({cancelled:p.removeId,preserved:p.preserveId,date:p.date}));
}
console.log(JSON.stringify({ok:true,cancelled:auth.pairs.length,channelId:auth.channelId}));
