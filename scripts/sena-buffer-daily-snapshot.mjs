import { mkdir, writeFile } from 'node:fs/promises';

const API='https://api.buffer.com';
const key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY is not configured');

async function gql(query,variables={}){
  const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});
  const j=await r.json();
  if(!r.ok||j.errors?.length) throw new Error(JSON.stringify(j.errors??j));
  return j.data;
}
async function findChannel(){
  const a=await gql('query { account { organizations { id name } } }');
  for(const o of a.account.organizations){
    const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:o.id});
    const c=d.channels.find(c=>String(c.service).toLowerCase()==='instagram'&&[c.name,c.displayName].filter(Boolean).some(v=>String(v).toLowerCase()==='sena.virtual.studio'));
    if(c) return {organizationId:o.id,organization:o.name,...c};
  }
  throw new Error('sena.virtual.studio is not connected to this Buffer key');
}
const c=await findChannel();
const data=await gql(`query($organizationId: OrganizationId!, $channelId: ChannelId!) {
  sent: posts(first:50,input:{organizationId:$organizationId,filter:{status:[sent],channelIds:[$channelId]},sort:[{field:dueAt,direction:desc}]}) {
    edges { node { id text status dueAt sentAt externalLink metrics { type name value unit } metricsUpdatedAt } }
  }
  failed: posts(first:50,input:{organizationId:$organizationId,filter:{status:[error],channelIds:[$channelId]},sort:[{field:dueAt,direction:desc}]}) {
    edges { node { id text status dueAt } }
  }
  scheduled: posts(first:50,input:{organizationId:$organizationId,filter:{status:[scheduled],channelIds:[$channelId]},sort:[{field:dueAt,direction:asc}]}) {
    edges { node { id text status dueAt } }
  }
}`,{organizationId:c.organizationId,channelId:c.id});

const now=new Date();
const tokyoDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const snapshot={
  capturedAt:now.toISOString(),
  tokyoDate,
  channel:{id:c.id,name:c.name,displayName:c.displayName},
  sent:data.sent.edges.map(e=>e.node),
  failed:data.failed.edges.map(e=>e.node),
  scheduled:data.scheduled.edges.map(e=>e.node)
};
await mkdir('analytics/sena-buffer-history',{recursive:true});
await writeFile('analytics/sena-buffer-latest.json',JSON.stringify(snapshot,null,2)+'\n');
await writeFile(`analytics/sena-buffer-history/${tokyoDate}.json`,JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({ok:true,sent:snapshot.sent.length,failed:snapshot.failed.length,scheduled:snapshot.scheduled.length},null,2));
if(snapshot.failed.length) process.exitCode=2;
