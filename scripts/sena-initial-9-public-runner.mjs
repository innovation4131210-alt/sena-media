import { readFile, writeFile, access } from 'node:fs/promises';

const API='https://api.buffer.com';
const key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY is not configured');
const captions=[
'出る前の最終確認。白とチャコールだけで今日は十分。あなたならここに黒を足す？',
'予定の合間に少しだけ。こういう何も決めない時間がいちばん好きかもしれない。',
'見るだけのつもりだった日ほど、袋が増える。買い物は即決する？一度帰って考える？',
'外に出ない日は、髪も服も少しだけ適当。こういう日も残しておく。',
'旅先の朝は、予定を決める前の時間が好き。今日は海から始めようかな。',
'昼より夜の方が似合う服ってある。もう一軒寄るか、そのまま帰るか。',
'最後にイヤリングだけ。黒の日は、アクセサリーを足す？それとも引く？',
'コーヒーを買ったら出発。行き先は着いてから少しずつ残します。',
'帰る直前に呼ばれて振り返っただけ。こういう一枚の方が、あとで残る。'
];
const files=['SENA_01_mirror_fitcheck.jpeg','SENA_02_cafe.jpeg','SENA_03_city_shopping.jpeg','SENA_04_private_room.jpeg','SENA_05_hotel_morning.jpeg','SENA_06_evening_city.jpeg','SENA_07_black_dress_vanity.jpeg','SENA_08_station_travel.jpeg','SENA_09_hotel_lounge_night.jpeg'];
const owner='innovation4131210-alt', repo='sena-media', branch='main';
const statePath='automation/sena-launch/state.json';
async function gql(query,variables={}){const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})}); const j=await r.json(); if(!r.ok||j.errors?.length) throw new Error(JSON.stringify(j.errors??j)); return j.data;}
async function channel(){const a=await gql('query { account { organizations { id name } } }'); const all=[]; for(const o of a.account.organizations){const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:o.id}); for(const c of d.channels) all.push({organizationId:o.id,organization:o.name,...c});} const c=all.find(c=>String(c.service).toLowerCase()==='instagram'&&[c.name,c.displayName].filter(Boolean).some(v=>String(v).toLowerCase().includes('sena.virtual.studio'))); if(!c) throw new Error('sena.virtual.studio is not connected to this Buffer key'); if(c.isDisconnected||c.isLocked||c.isQueuePaused) throw new Error('SENA Buffer channel is not publishable'); return c;}
function tokyoParts(d=new Date()){const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); return Object.fromEntries(f.formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));}
function firstSlot(){const p=tokyoParts(); const today=`${p.year}-${p.month}-${p.day}`; const nowM=Number(p.hour)*60+Number(p.minute); const base=new Date(`${today}T00:00:00+09:00`); if(nowM>=20*60) base.setUTCDate(base.getUTCDate()+1); return base;}
function dueAt(base,i){const d=new Date(base); d.setUTCDate(d.getUTCDate()+i); const ymd=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); return new Date(`${ymd}T20:30:00+09:00`).toISOString();}
let state={version:1,scheduled:[]}; try{state=JSON.parse(await readFile(statePath,'utf8'));}catch{}
for(const f of files) await access(`media/sena-initial-9/${f}`);
const c=await channel();
const existing=await gql('query($organizationId: OrganizationId!) { posts(input:{organizationId:$organizationId,filter:{status:[scheduled]}}) { edges { node { id text channelId dueAt } } } }',{organizationId:c.organizationId});
const scheduled=(existing.posts?.edges??[]).map(e=>e.node).filter(p=>p.channelId===c.id);
const base=firstSlot();
for(let i=0;i<files.length;i++){
 const already=state.scheduled.find(x=>x.order===i+1)||scheduled.find(x=>x.text===captions[i]); if(already){if(!state.scheduled.find(x=>x.order===i+1)) state.scheduled.push({order:i+1,bufferPostId:already.id,dueAt:already.dueAt,reconciled:true}); continue;}
 const url=`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/media/sena-initial-9/${files[i]}`;
 const due=dueAt(base,i);
 const data=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }',{input:{text:captions[i],channelId:c.id,schedulingType:'automatic',mode:'customScheduled',dueAt:due,aiAssisted:true,assets:[{image:{url,metadata:{altText:'SENA AI-generated lifestyle image'}}}],metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}}});
 if(!data.createPost?.post?.id) throw new Error(data.createPost?.message??JSON.stringify(data.createPost));
 state.scheduled.push({order:i+1,bufferPostId:data.createPost.post.id,dueAt:data.createPost.post.dueAt,mediaUrl:url});
 await writeFile(statePath,JSON.stringify(state,null,2)+'\n');
}
state.lastVerifiedAt=new Date().toISOString(); state.channel={id:c.id,name:c.name,displayName:c.displayName};
await writeFile(statePath,JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify({ok:true,count:state.scheduled.length,channel:c.name},null,2));
