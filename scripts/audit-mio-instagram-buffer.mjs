const key = process.env.BUFFER_API_KEY;
if (!key) { console.log(JSON.stringify({audit:"mio-instagram-buffer",status:"secret_missing"})); process.exit(0); }
async function gql(query,variables={}) {
 const response=await fetch("https://api.buffer.com",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});
 const result=await response.json();
 if(!response.ok||result.errors?.length) throw Error(JSON.stringify(result.errors??{status:response.status}));
 return result.data;
}
const account=await gql("query { account { organizations { id } } }");
const channels=[];
for(const organization of account.account.organizations){
 const list=await gql("query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }",{organizationId:organization.id});
 for(const channel of list.channels) if(channel.service.toLowerCase()==="instagram" && [channel.name,channel.displayName].some(value=>String(value).toLowerCase()==="mio.ai_life")) channels.push({organizationId:organization.id,...channel});
}
if(channels.length!==1) throw Error("Expected exactly one MIO Instagram channel; found "+channels.length);
const channel=channels[0];
const response=await gql("query($organizationId: OrganizationId!, $channelId: ChannelId!) { posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]}}) { edges { node { id text status dueAt sentAt externalLink } } pageInfo { hasNextPage } } }",{organizationId:channel.organizationId,channelId:channel.id});
if(response.posts.pageInfo.hasNextPage) throw Error("More than 100 posts; audit incomplete");
console.log(JSON.stringify({audit:"mio-instagram-buffer",status:"verified",channel:{id:channel.id,name:channel.name,service:channel.service,isQueuePaused:channel.isQueuePaused,isDisconnected:channel.isDisconnected,isLocked:channel.isLocked},posts:response.posts.edges.map(({node})=>({id:node.id,status:node.status,dueAt:node.dueAt,sentAt:node.sentAt,externalLink:node.externalLink})),count:response.posts.edges.length}));
