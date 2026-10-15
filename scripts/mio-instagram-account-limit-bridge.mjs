import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const repo=process.env.GITHUB_REPOSITORY;
const authPath="automation/mio-instagram-account-limit-bridge/transfer-authorization.json";
const statePath="automation/mio-instagram-account-limit-bridge/state.json";
if(!process.env.BUFFER_API_KEY||!process.env.GH_TOKEN) throw Error("Missing runner credentials");
const auth=JSON.parse(await readFile(authPath,"utf8"));
if(auth.id!=="mio-instagram-metricool-limit-bridge-2026-10-19"||auth.account!=="mio.ai_life") throw Error("Authorization scope mismatch");
if(auth.destination?.provider!=="buffer"||auth.destination?.service!=="instagram"||auth.destination?.channelId!=="6aa630b7ea19ca0bde329146") throw Error("Destination mismatch");
if(!Array.isArray(auth.posts)||auth.posts.length!==1) throw Error("Expected one exact authorized post");
const p=auth.posts[0];
if(p.date!=="2026-10-19"||p.metricool?.draft!==true||p.metricool?.uuid!=="1783177037967412459") throw Error("Metricool draft evidence mismatch");
if(p.text!=="片方の靴下、またいない。洗濯機って絶対どこかに隠してると思う。"||p.dueAt!=="2026-10-19T09:30:00.000Z") throw Error("Exact post mismatch");
if(!p.mediaUrl||!p.mediaSha256) throw Error("Media evidence missing");

async function gql(query,variables={}){
 const r=await fetch("https://api.buffer.com",{method:"POST",headers:{Authorization:"Bearer "+process.env.BUFFER_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
 const j=await r.json();
 if(!r.ok||j.errors?.length) throw Error(JSON.stringify(j.errors??{status:r.status}));
 return j.data;
}
async function ghGet(){
 const r=await fetch("https://api.github.com/repos/"+repo+"/contents/"+statePath,{headers:{Authorization:"Bearer "+process.env.GH_TOKEN,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(30000)});
 if(r.status===404) return null;
 if(!r.ok) throw Error("State read HTTP "+r.status);
 return r.json();
}
async function persist(row){
 for(let attempt=1;attempt<=4;attempt++){
  const remote=await ghGet();
  const state=remote?JSON.parse(Buffer.from(remote.content,"base64").toString("utf8")):{version:1,authorizationId:auth.id,posts:[]};
  const i=state.posts.findIndex(x=>x.date===row.date);
  if(i>=0) state.posts[i]={...state.posts[i],...row}; else state.posts.push(row);
  state.updatedAt=new Date().toISOString();
  const body={message:"Record MIO Instagram account-limit bridge",content:Buffer.from(JSON.stringify(state,null,2)+"\n").toString("base64"),...(remote?{sha:remote.sha}:{})};
  const r=await fetch("https://api.github.com/repos/"+repo+"/contents/"+statePath,{method:"PUT",headers:{Authorization:"Bearer "+process.env.GH_TOKEN,Accept:"application/vnd.github+json","Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(r.ok) return;
  if(r.status===409||r.status===422) continue;
  throw Error("State write HTTP "+r.status);
 }
 throw Error("State write conflict after retries; recover live Buffer ID, do not recreate");
}
const account=await gql("query { account { organizations { id } } }");
const matches=[];
for(const o of account.account.organizations){
 const d=await gql("query($organizationId: OrganizationId!){ channels(input:{organizationId:$organizationId}){ id name displayName service isQueuePaused isDisconnected isLocked } }",{organizationId:o.id});
 for(const c of d.channels) if(c.id===auth.destination.channelId&&c.service==="instagram"&&[c.name,c.displayName].includes(auth.account)) matches.push({...c,organizationId:o.id});
}
if(matches.length!==1) throw Error("Exact MIO Instagram channel missing");
const channel=matches[0];
if(channel.isQueuePaused||channel.isDisconnected||channel.isLocked) throw Error("MIO Instagram Buffer channel unavailable");
async function inventory(){
 const d=await gql("query($organizationId: OrganizationId!,$channelId: ChannelId!){ posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}){ edges{node{id text status dueAt sentAt externalLink channelId assets{id mimeType}}} pageInfo{hasNextPage} } }",{organizationId:channel.organizationId,channelId:channel.id});
 if(d.posts.pageInfo.hasNextPage) throw Error("Incomplete MIO Instagram Buffer inventory");
 return d.posts.edges.map(e=>e.node);
}
let current=await inventory();
const exact=current.filter(x=>x.text===p.text&&new Date(x.dueAt).getTime()===Date.parse(p.dueAt)&&["scheduled","sent"].includes(x.status));
if(exact.length>1) throw Error("Duplicate exact MIO Instagram posts");
const slot=current.filter(x=>new Date(x.dueAt).getTime()===Date.parse(p.dueAt)&&["scheduled","sent"].includes(x.status));
if(slot.length>1||(slot.length===1&&exact.length===0)) throw Error("Occupied Instagram slot");
let target=exact[0],action="recovered_existing";
if(!target){
 if(current.filter(x=>x.status==="scheduled").length>=10) throw Error("Free Buffer queue full");
 if(Date.parse(p.dueAt)<=Date.now()+10*60*1000) throw Error("Publication time passed or imminent");
 const media=await fetch(p.mediaUrl,{signal:AbortSignal.timeout(45000)});
 if(!media.ok) throw Error("Authorized media unavailable");
 const bytes=Buffer.from(await media.arrayBuffer());
 if(createHash("sha256").update(bytes).digest("hex")!==p.mediaSha256) throw Error("Authorized media hash mismatch");
 await persist({date:p.date,status:"intent",dueAt:p.dueAt,metricoolDraftId:p.metricool.draftId,metricoolUuid:p.metricool.uuid,checkedAt:new Date().toISOString()});
 const d=await gql("mutation($input: CreatePostInput!){ createPost(input:$input){ __typename ... on PostActionSuccess{post{id text status dueAt channelId}} ... on MutationError{message} } }",{input:{text:p.text,channelId:channel.id,schedulingType:"automatic",mode:"customScheduled",dueAt:p.dueAt,aiAssisted:true,assets:[{image:{url:p.mediaUrl,metadata:{altText:p.altText}}}],needsApproval:false,saveToDraft:false,metadata:{instagram:{type:"post",shouldShareToFeed:true,isAiGenerated:true}}}});
 if(!d.createPost?.post?.id) throw Error(d.createPost?.message??"Buffer create returned no post ID");
 target=d.createPost.post;
 action="created";
}
current=await inventory();
const verified=current.find(x=>x.id===target.id);
if(!verified||verified.channelId!==channel.id||verified.text!==p.text||new Date(verified.dueAt).getTime()!==Date.parse(p.dueAt)||verified.status!=="scheduled"||!verified.assets?.some(a=>String(a.mimeType||"").startsWith("image/"))) throw Error("Buffer readback failed");
await persist({date:p.date,status:"scheduled",bufferPostId:verified.id,dueAt:verified.dueAt,metricoolDraftId:p.metricool.draftId,metricoolUuid:p.metricool.uuid,action,aiDisclosureSubmitted:true,verifiedAt:new Date().toISOString()});
console.log(JSON.stringify({ok:true,date:p.date,action,id:verified.id,dueAt:verified.dueAt,status:verified.status}));
