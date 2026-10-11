import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const ID="6ac8efeba5e49fef9bb4062a", CHANNEL="6ab74779ea19ca0bdef024db";
const DUE="2026-10-13T03:15:00.000Z";
const OLD="本を開いたのに、マグを持ったままひと休み☕\n朝食と読書の写真5枚を、Fanvueの無料フォロワー向けに公開しました。\nhttps://www.fanvue.com/mio_ai_life_jp\n\n18+｜MIOは架空の成人AIキャラクター。画像はAI制作です。";
const NEW=OLD.replace("https://www.fanvue.com/mio_ai_life_jp","https://www.fanvue.com/mio_ai_life_jp/fv-1");
const SHA="703d21035cb007f6d238f9f8db00cbfee54ad963461d975bc42baecaaeeb9dec";
function check(p) {
 assert.equal(p.id,ID); assert.equal(p.channelId,CHANNEL); assert.equal(p.status,"scheduled");
 assert.equal(Date.parse(p.dueAt),Date.parse(DUE));
 assert.ok(p.text===OLD||p.text===NEW,"Unexpected text; no edit permitted");
 assert.equal(p.assets?.length,1); assert.ok(p.assets[0].id); assert.ok(p.assets[0].mimeType.startsWith("image/"));
 return p;
}
function after(before, rows) {
 const p=check(rows.find(p=>p.id===ID));assert.equal(p.text,NEW);
 assert.deepEqual(p.assets,before.find(p=>p.id===ID).assets);
 const others=a=>a.filter(p=>p.id!==ID).sort((a,b)=>a.id.localeCompare(b.id));
 assert.deepEqual(others(rows),others(before),"Another post changed concurrently");
 return p;
}
function tests(){
 const p={id:ID,channelId:CHANNEL,status:"scheduled",dueAt:DUE,text:OLD,assets:[{id:"image-1",mimeType:"image/jpeg",source:"https://example.com/source.jpg"}]};
 check(p);check({...p,text:NEW});
 for(const patch of [{id:"wrong"},{channelId:"wrong"},{status:"sent"},{dueAt:"2026-10-14T03:15:00Z"},{text:"other"},{assets:[]},{assets:[{id:"x",mimeType:"video/mp4"}]}])assert.throws(()=>check({...p,...patch}));
 const other={...p,id:"untouched"};after([p,other],[{...p,text:NEW},other]);
 assert.throws(()=>after([p,other],[{...p,text:NEW},{...other,text:"modified"}]));
 assert.throws(()=>after([p],[{...p,text:NEW,assets:[{...p.assets[0],id:"different"}]}]));
 assert.equal(OLD.split("https://www.fanvue.com/mio_ai_life_jp").length,2);
 console.log("Offline safety tests passed: 13 checks");
}
async function gql(query,variables={}){
 const key=process.env.X_BUFFER_API_KEY;if(!key)throw new Error("Existing Buffer credential unavailable");
 const r=await fetch("https://api.buffer.com",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error("Buffer HTTP "+r.status+"; no retry");
 const j=await r.json();if(j.errors?.length||!j.data)throw new Error("Buffer GraphQL failure; no retry");return j.data;
}
async function inventory(org){
 const d=await gql(`query($organizationId:OrganizationId!,$channelId:ChannelId!){posts(first:100,input:{organizationId:$organizationId,filter:{channelIds:[$channelId]},sort:[{field:dueAt,direction:asc}]}){edges{node{id text status dueAt channelId assets{id mimeType source}}}pageInfo{hasNextPage}}}`,{organizationId:org,channelId:CHANNEL});
 assert.equal(d.posts?.pageInfo?.hasNextPage,false,"Incomplete inventory");
 const rows=d.posts.edges.map(e=>e.node);assert.equal(new Set(rows.map(p=>p.id)).size,rows.length);
 for(const p of rows)assert.equal(p.channelId,CHANNEL);
 return rows;
}
async function live(){
 tests();
 assert.ok(Date.now()<Date.parse(DUE),"Scheduled time has passed");
 const a=await gql("query {account {organizations {id}}}");
 const matches=[];
 for(const o of a.account.organizations){
  const c=await gql(`query($organizationId:OrganizationId!){channels(input:{organizationId:$organizationId}){id name displayName service isQueuePaused isDisconnected isLocked}}`,{organizationId:o.id});
  for(const ch of c.channels??[])if(ch.id===CHANNEL)matches.push({...ch,org:o.id});
 }
 assert.equal(matches.length,1,"Expected one target channel");const ch=matches[0];
 assert.ok(["twitter","x"].includes(ch.service));assert.ok([ch.name,ch.displayName].some(x=>String(x).replace(/^@/,"").toLowerCase()==="mio_ai_life_jp"));
 assert.ok(!ch.isQueuePaused&&!ch.isDisconnected&&!ch.isLocked,"Target channel unavailable");
 const before=await inventory(ch.org);const p=check(before.find(p=>p.id===ID));
 const u=new URL(p.assets[0].source);assert.equal(u.protocol,"https:");assert.equal(u.username,"");assert.equal(u.password,"");
 const media=await fetch(u,{signal:AbortSignal.timeout(30000)});assert.ok(media.ok,"Cannot verify image");
 const bytes=Buffer.from(await media.arrayBuffer());assert.ok(bytes.length<20000000);assert.equal(createHash("sha256").update(bytes).digest("hex"),SHA,"Asset differs from approved image");
 console.log(JSON.stringify({phase:"preflight_passed",id:ID,channelId:CHANNEL,dueAt:p.dueAt,status:p.status,assetIds:p.assets.map(x=>x.id),assetSha256:SHA}));
 let edited=false;
 if(p.text===OLD){
  const d=await gql(`mutation($input:EditPostInput!){editPost(input:$input){__typename ... on PostActionSuccess{post{id}} ... on MutationError{message}}}`,{input:{id:ID,text:NEW}});
  assert.equal(d.editPost?.post?.id,ID,"Mutation response unverified; do not retry");
  edited=true;
 }
 const confirmed=after(before,await inventory(ch.org));
 console.log(JSON.stringify({ok:true,edited,id:ID,channelId:CHANNEL,dueAt:confirmed.dueAt,status:confirmed.status,text:confirmed.text,assets:confirmed.assets,verifiedAt:new Date().toISOString(),otherPostsUnchanged:true}));
}
if(process.argv.includes("--offline"))tests();else live().catch(e=>{console.error("STOP:",e.message);process.exitCode=1;});
