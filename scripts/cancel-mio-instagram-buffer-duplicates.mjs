import {readFile} from 'node:fs/promises';
const expected=[
 {id:'6ab45b0bb54e50f39d0c061d',dueAt:'2026-10-22T09:30:00.000Z',metricoolId:380555136},
 {id:'6ab45b0fc1b9b7f12c1e7e46',dueAt:'2026-10-23T09:30:00.000Z',metricoolId:380555202},
 {id:'6ab45b12b4fa591f3ecb94ae',dueAt:'2026-10-24T09:30:00.000Z',metricoolId:380555219},
 {id:'6ab45b15ccbef1e0a53d4c1d',dueAt:'2026-10-25T09:30:00.000Z',metricoolId:380555247},
 {id:'6ab45b1acdc0a64118060013',dueAt:'2026-10-26T09:30:00.000Z',metricoolId:380555261},
 {id:'6ab45b1e4ee8bfc2fd2263e5',dueAt:'2026-10-27T09:30:00.000Z',metricoolId:380555280}
];
const statePath='automation/mio-instagram-overflow/state.json';
const local=JSON.parse(await readFile(statePath,'utf8'));
if(local.channelId!=='6aa630b7ea19ca0bde329146')throw Error('Unexpected channel state');
const repo=process.env.GITHUB_REPOSITORY;
async function gh(method,body){
 const response=await fetch('https://api.github.com/repos/'+repo+'/contents/'+statePath,{method,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('State persistence HTTP '+response.status);
 return response.json();
}
let remote=await gh('GET');
let state=JSON.parse(Buffer.from(remote.content,'base64').toString());
async function save(){
 const response=await gh('PUT',{message:'Record removal of duplicate MIO Buffer overflow',content:Buffer.from(JSON.stringify(state,null,2)+'\n').toString('base64'),sha:remote.sha});
 remote={sha:response.content.sha};
}
async function gql(query,variables={}){
 const response=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+process.env.BUFFER_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
 const result=await response.json();
 if(!response.ok||result.errors?.length)throw Error(JSON.stringify(result.errors??{status:response.status}));
 return result.data;
}
const account=await gql('query { account { organizations { id } } }');
let organizationId=null,posts=[];
for(const organization of account.account.organizations){
 const channels=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id } }',{organizationId:organization.id});
 if(!channels.channels.some(channel=>channel.id===state.channelId))continue;
 const result=await gql('query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id status dueAt text } } pageInfo { hasNextPage } } }',{organizationId:organization.id,channelId:state.channelId});
 if(result.posts.pageInfo.hasNextPage)throw Error('Incomplete inventory; stop before delete');
 organizationId=organization.id;posts=result.posts.edges.map(({node})=>node);
}
if(!organizationId)throw Error('Exact MIO Instagram channel not found');
for(const item of expected){
 const saved=state.posts.find(post=>post.id===item.id);
 if(!saved)throw Error('State missing target '+item.id);
 const current=posts.find(post=>post.id===item.id);
 if(!current){
  if(saved.status==='cancelled_duplicate_metricool_primary')continue;
  throw Error('Target missing before cancellation '+item.id);
 }
 if(current.status!=='scheduled')throw Error('Target not scheduled '+item.id+' status='+current.status);
 if(new Date(current.dueAt).getTime()!==new Date(item.dueAt).getTime())throw Error('Due mismatch '+item.id);
 const data=await gql('mutation($input: DeletePostInput!) { deletePost(input:$input) { __typename } }',{input:{id:item.id}});
 if(!data.deletePost?.__typename)throw Error('Delete mutation returned no payload '+item.id);
 const check=await gql('query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id status dueAt } } } }',{organizationId,channelId:state.channelId});
 if(check.posts.edges.some(({node})=>node.id===item.id))throw Error('Delete readback failed '+item.id);
 Object.assign(saved,{status:'cancelled_duplicate_metricool_primary',duplicateOfMetricoolId:item.metricoolId,cancelledAt:new Date().toISOString(),cancellationReason:'Existing Metricool reservation is authoritative; Buffer overflow was created later at the same date/time.'});
 await save();
 posts=posts.filter(post=>post.id!==item.id);
 console.log(JSON.stringify({cancelled:item.id,preservedMetricoolId:item.metricoolId}));
}
state.verifiedAt=new Date().toISOString();
state.disposition='all_buffer_duplicates_cancelled_metricool_primary_preserved';
await save();
console.log(JSON.stringify({ok:true,cancelled:expected.length,channelId:state.channelId}));
