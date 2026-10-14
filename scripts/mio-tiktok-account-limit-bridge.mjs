import {readFile} from "node:fs/promises";

const repo=process.env.GITHUB_REPOSITORY;
const statePath="automation/mio-tiktok-account-limit-bridge/state.json";
const auth=JSON.parse(await readFile("automation/mio-tiktok-account-limit-bridge/transfer-authorization.json","utf8"));
if(!process.env.BUFFER_API_KEY||!process.env.GH_TOKEN) throw Error("Missing runner credentials");
if(auth.destination?.provider!=="buffer"||auth.destination?.service!=="tiktok"||auth.account!=="mio.ai_life") throw Error("Authorization scope mismatch");
if(!Array.isArray(auth.posts)||auth.posts.length!==6) throw Error("Expected six exact bridge posts");
if(auth.posts.some(p=>p.metricool?.draft!==true||!/※MIOは架空のAIキャラクターです。画像はAIで制作しています。/.test(p.text))) throw Error("Draft or disclosure gate failed");

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
  state.posts.sort((a,b)=>a.date.localeCompare(b.date));
  state.updatedAt=new Date().toISOString();
  const body={message:"Record MIO TikTok account-limit bridge",content:Buffer.from(JSON.stringify(state,null,2)+"\n").toString("base64"),...(remote?{sha:remote.sha}:{})};
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
 for(const c of d.channels) if(c.id===auth.destination.channelId&&c.service==="tiktok"&&[c.name,c.displayName].includes(auth.account)) matches.push({...c,organizationId:o.id});
}
if(matches.length!==1) throw Error("Exact MIO TikTok channel missing");
const channel=matches[0];
if(channel.isQueuePaused||channel.isDisconnected||channel.isLocked) throw Error("MIO TikTok Buffer channel unavailable");

async function inventory(){
 const d=await gql("query($organizationId: OrganizationId!,$channelId: ChannelId!){ posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}){ edges{node{id text status dueAt sentAt externalLink channelId assets{id mimeType}}} pageInfo{hasNextPage} } }",{organizationId:channel.organizationId,channelId:channel.id});
 if(d.posts.pageInfo.hasNextPage) throw Error("Incomplete MIO TikTok Buffer inventory");
 return d.posts.edges.map(e=>e.node);
}
async function createPost(p){
 const d=await gql("mutation($input: CreatePostInput!){ createPost(input:$input){ __typename ... on PostActionSuccess{post{id text status dueAt channelId}} ... on MutationError{message} } }",{input:{text:p.text,channelId:channel.id,schedulingType:"automatic",mode:"customScheduled",dueAt:p.dueAt,aiAssisted:true,assets:[{image:{url:p.mediaUrl,metadata:{altText:"MIO AI-generated lifestyle image"}}}],needsApproval:false,saveToDraft:false}});
 if(!d.createPost?.post?.id) throw Error(d.createPost?.message??"Buffer create returned no post ID");
 return d.createPost.post;
}

let current=await inventory();
for(const p of auth.posts){
 if(Date.parse(p.dueAt)<=Date.now()+10*60*1000){
  await persist({date:p.date,status:"not_created_past_or_imminent",dueAt:p.dueAt,checkedAt:new Date().toISOString()});
  continue;
 }
 const exact=current.filter(x=>x.text===p.text&&new Date(x.dueAt).getTime()===Date.parse(p.dueAt)&&["scheduled","sent"].includes(x.status));
 if(exact.length>1) throw Error("Duplicate exact MIO TikTok posts on "+p.date);
 const slot=current.filter(x=>new Date(x.dueAt).getTime()===Date.parse(p.dueAt)&&["scheduled","sent"].includes(x.status));
 if(slot.length>1||(slot.length===1&&exact.length===0)) throw Error("Occupied TikTok slot on "+p.date);
 let target=exact[0], action="recovered_existing";
 if(!target){
  const media=await fetch(p.mediaUrl,{method:"HEAD",signal:AbortSignal.timeout(30000)});
  if(!media.ok||!String(media.headers.get("content-type")||"").startsWith("image/")) throw Error("Authorized media unavailable for "+p.date);
  target=await createPost(p);
  action="created";
 }
 current=await inventory();
 const verified=current.find(x=>x.id===target.id);
 if(!verified||verified.channelId!==channel.id||verified.text!==p.text||new Date(verified.dueAt).getTime()!==Date.parse(p.dueAt)||verified.status!=="scheduled"||!verified.assets?.some(a=>String(a.mimeType||"").startsWith("image/"))) throw Error("Buffer readback failed for "+p.date);
 await persist({date:p.date,status:"scheduled",bufferPostId:verified.id,dueAt:verified.dueAt,metricoolDraftId:p.metricool.draftId,metricoolUuid:p.metricool.uuid,action,verifiedAt:new Date().toISOString()});
 console.log(JSON.stringify({date:p.date,action,id:verified.id,dueAt:verified.dueAt,status:verified.status}));
}
