const API_URL = "https://api.buffer.com";
const key = process.env.BUFFER_API_KEY;
if (!key) throw new Error("BUFFER_API_KEY missing");
async function gql(query, variables={}) {
  const r = await fetch(API_URL,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});
  const j=await r.json();
  if(!r.ok||j.errors?.length) throw new Error(JSON.stringify(j.errors??j));
  return j.data;
}
const a=await gql("query { account { organizations { id name } } }");
const matches=[];
for(const o of a.account.organizations){
 const d=await gql("query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }",{organizationId:o.id});
 for(const c of d.channels){
   const label=[c.name,c.displayName].filter(Boolean).join(" ").toLowerCase();
   if(label.includes("sena") || label.includes("virtual")) matches.push({organization:o.name,...c});
 }
}
console.log(JSON.stringify({senaMatches:matches},null,2));
if(!matches.some(c=>String(c.service).toLowerCase()==="instagram" && [c.name,c.displayName].filter(Boolean).some(v=>String(v).toLowerCase().includes("sena.virtual.studio")))) process.exit(2);

const auditAccount=await gql("query { account { organizations { id } } }");
for(const o of auditAccount.account.organizations){
 const d=await gql("query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }",{organizationId:o.id});
 for(const c of d.channels.filter(c=>String(c.service).toLowerCase()==="tiktok" && [c.name,c.displayName].some(n=>/mio|sena/i.test(String(n))))){
  const ps=await gql("query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink } } pageInfo { hasNextPage } } }",{organizationId:o.id,channelId:c.id});
  console.log(JSON.stringify({audit:"tiktok-refresh-2026-09-23",channel:c,...ps}));
 }
 console.log(JSON.stringify({audit:"channel-inventory",channels:d.channels.map(c=>({id:c.id,name:c.name,displayName:c.displayName,service:c.service,isDisconnected:c.isDisconnected,isLocked:c.isLocked}))}));
}
