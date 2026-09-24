import { writeFile, mkdir } from "node:fs/promises";
const API="https://api.buffer.com";
const POST_ID="6ab5268839278d5bab6236bb";
async function gql(query,variables={}){
  const key=process.env.X_BUFFER_API_KEY;
  if(!key) throw Error("X_BUFFER_API_KEY missing");
  const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
  const j=await r.json();
  if(!r.ok||j.errors?.length) throw Error(JSON.stringify(j.errors??{status:r.status}));
  return j.data;
}
const account=await gql("query { account { organizations { id } } }");
let found=null;
for(const org of account.account.organizations){
  const d=await gql(`query($organizationId: OrganizationId!){ posts(first:100,input:{organizationId:$organizationId}) { edges { node { id text status dueAt channelId assets { id mimeType source type } } } pageInfo { hasNextPage } } }`,{organizationId:org.id});
  if(d.posts.pageInfo.hasNextPage) throw Error("Incomplete inventory");
  const p=d.posts.edges.map(e=>e.node).find(p=>p.id===POST_ID);
  if(p){found=p;break;}
}
if(!found) throw Error("Target SENA strong post not found");
const report={checkedAt:new Date().toISOString(),postId:POST_ID,status:found.status,dueAt:found.dueAt,channelId:found.channelId,text:found.text,assets:found.assets};
if(found.status!=="scheduled") throw Error("Target post is not scheduled");
if(!Array.isArray(found.assets)||found.assets.length<1) throw Error("Target post has no media asset");
if(!found.assets.some(a=>String(a.mimeType||"").startsWith("image/"))) throw Error("Target post has no image asset");
await mkdir("analytics",{recursive:true});
await writeFile("analytics/sena-x-strong-readback.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report));
