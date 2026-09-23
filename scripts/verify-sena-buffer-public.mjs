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
