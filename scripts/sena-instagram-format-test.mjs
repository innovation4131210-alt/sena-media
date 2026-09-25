import { readFile, writeFile } from "node:fs/promises";

const API_URL="https://api.buffer.com";
const manifestPath=process.env.SENA_IG_FORMAT_TEST_MANIFEST || "automation/sena-launch/format-test-2026-09-26.json";

async function gql(query,variables={}){
  const key=process.env.SENA_BUFFER_API_KEY;
  if(!key) throw new Error("SENA_BUFFER_API_KEY missing");
  const r=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
  const raw=await r.text();
  let j; try{j=JSON.parse(raw);}catch{throw new Error(`Non-JSON Buffer response ${r.status}`);}
  if(!r.ok||j.errors?.length||!j.data) throw new Error(`Buffer API error: ${JSON.stringify(j.errors??j)}`);
  return j.data;
}
async function resolveChannel(){
  const a=await gql("query { account { organizations { id name } } }");
  const found=[];
  for(const org of a.account?.organizations??[]){
    const d=await gql(`query($organizationId:OrganizationId!){channels(input:{organizationId:$organizationId}){id name displayName service isQueuePaused isDisconnected isLocked}}`,{organizationId:org.id});
    for(const c of d.channels??[]){
      if(String(c.service).toLowerCase()!=="instagram") continue;
      if(c.id!=="6aa72524ea19ca0bde39313c") continue;
      found.push({...c,organizationId:org.id});
    }
  }
  if(found.length!==1) throw new Error(`Expected one SENA Instagram channel, got ${found.length}`);
  const c=found[0];
  if(c.isQueuePaused||c.isDisconnected||c.isLocked) throw new Error("SENA Instagram channel unavailable");
  return c;
}
async function inventory(channel){
  const d=await gql(`query($organizationId:OrganizationId!,$channelId:ChannelId!){posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]},sort:[{field:dueAt,direction:asc}]}){edges{node{id text status dueAt sentAt channelId assets{id mimeType}}}pageInfo{hasNextPage}}}`,{organizationId:channel.organizationId,channelId:channel.id});
  if(d.posts?.pageInfo?.hasNextPage) throw new Error("Incomplete inventory");
  return (d.posts?.edges??[]).map(e=>e.node);
}
async function verifyVideo(url){
  const r=await fetch(url,{method:"GET",headers:{Range:"bytes=0-64"},redirect:"follow",signal:AbortSignal.timeout(20000)});
  if(!r.ok && r.status!==206) throw new Error(`Video unavailable: ${r.status}`);
  const t=r.headers.get("content-type")??"";
  if(!t.startsWith("video/") && t!=="application/octet-stream") throw new Error(`Unexpected video content-type: ${t}`);
}
async function main(){
  const m=JSON.parse(await readFile(manifestPath,"utf8"));
  if(m.status==="scheduled_verified"){console.log("Already verified; no-op.");return;}
  const channel=await resolveChannel();
  const before=await inventory(channel);
  const target=before.find(p=>p.id===m.originalBufferPostId);
  if(!target) throw new Error("Target Buffer post not found");
  if(target.status!=="scheduled") throw new Error(`Target status is ${target.status}`);
  if(target.text!==m.expectedText) throw new Error("Target text drift");
  if(Date.parse(target.dueAt)!==Date.parse(m.expectedDueAt)) throw new Error("Target dueAt drift");
  await verifyVideo(m.videoUrl);

  const d=await gql(`mutation($input:EditPostInput!){editPost(input:$input){__typename ... on PostActionSuccess{post{id text status dueAt channelId assets{id mimeType}}} ... on MutationError{message}}}`,{
    input:{
      id:target.id,
      text:m.expectedText,
      dueAt:m.expectedDueAt,
      mode:"customScheduled",
      schedulingType:"automatic",
      aiAssisted:true,
      assets:[{video:{url:m.videoUrl}}],
      metadata:{instagram:{type:"reel",shouldShareToFeed:true,isAiGenerated:true}},
      saveToDraft:false
    }
  });
  const made=d.editPost?.post;
  if(!made?.id) throw new Error(d.editPost?.message??"editPost returned no post");

  const after=await inventory(channel);
  const readback=after.find(p=>p.id===made.id);
  if(!readback) throw new Error("Edited post missing on readback");
  if(readback.status!=="scheduled"||readback.text!==m.expectedText||Date.parse(readback.dueAt)!==Date.parse(m.expectedDueAt)) throw new Error("Edited post readback mismatch");
  const videoAssets=(readback.assets??[]).filter(a=>String(a.mimeType??"").startsWith("video/"));
  if(videoAssets.length<1) throw new Error("Edited post has no video asset");

  m.status="scheduled_verified";
  m.newBufferPostId=made.id;
  m.oldBufferPostId=target.id;
  m.channelId=channel.id;
  m.verifiedAt=new Date().toISOString();
  m.readback={status:readback.status,dueAt:readback.dueAt,videoAssets:videoAssets.map(a=>({id:a.id,mimeType:a.mimeType}))};
  await writeFile(manifestPath,JSON.stringify(m,null,2)+"\n");
  console.log(JSON.stringify({ok:true,oldId:target.id,newId:made.id,dueAt:readback.dueAt,assets:readback.assets},null,2));
}
main().catch(e=>{console.error(e.stack??e.message);process.exit(1);});
