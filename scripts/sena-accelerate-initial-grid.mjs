const API='https://api.buffer.com';
const key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY missing');
const owner='innovation4131210-alt', repo='sena-media', branch='main';
const oldIds=['6ab35020557b1c68e6c3bc9d','6ab3502198ae6feaa623f718','6ab350222aa0e20bb4721fa6','6ab35022557b1c68e6c3bce4','6ab350222aa0e20bb4721fcd','6ab35023557b1c68e6c3bd24','6ab3502498ae6feaa623f755','6ab350242aa0e20bb4721ffe','6ab350257f829c668079b70b'];
const captions=[
'出る前の最終確認。白とチャコールだけで今日は十分。あなたならここに黒を足す？',
'予定の合間に少しだけ。こういう何も決めない時間がいちばん好きかもしれない。',
'見るだけのつもりだった日ほど、袋が増える。買い物は即決する？一度帰って考える？',
'外に出ない日は、髪も服も少しだけ適当。こういう日も残しておく。',
'旅先の朝は、予定を決める前の時間が好き。今日は海から始めようかな。',
'昼より夜の方が似合う服ってある。もう一軒寄るか、そのまま帰るか。',
'最後にイヤリングだけ。黒の日は、アクセサリーを足す？それとも引く？',
'コーヒーを買ったら出発。行き先は着いてから少しずつ残します。',
'帰る直前に呼ばれて振り返っただけ。こういう一枚の方が、あとで残る。'];
const files=['SENA_01_mirror_fitcheck.jpeg','SENA_02_cafe.jpeg','SENA_03_city_shopping.jpeg','SENA_04_private_room.jpeg','SENA_05_hotel_morning.jpeg','SENA_06_evening_city.jpeg','SENA_07_black_dress_vanity.jpeg','SENA_08_station_travel.jpeg','SENA_09_hotel_lounge_night.jpeg'];
const dues=['2026-09-23T07:30:00.000Z','2026-09-23T10:30:00.000Z','2026-09-23T13:00:00.000Z','2026-09-24T02:00:00.000Z','2026-09-24T06:00:00.000Z','2026-09-24T12:00:00.000Z','2026-09-25T10:30:00.000Z','2026-09-26T03:30:00.000Z','2026-09-27T11:30:00.000Z'];

async function gql(query,variables={}){const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});const j=await r.json();if(!r.ok||j.errors?.length)throw new Error(JSON.stringify(j.errors??j));return j.data;}
async function channel(){const a=await gql('query { account { organizations { id name } } }');for(const o of a.account.organizations){const d=await gql('query($organizationId: OrganizationId!) { channels(input:{organizationId:$organizationId}) { id name displayName service isQueuePaused isDisconnected isLocked } }',{organizationId:o.id});const c=d.channels.find(c=>String(c.service).toLowerCase()==='instagram'&&[c.name,c.displayName].filter(Boolean).some(v=>String(v).toLowerCase().includes('sena.virtual.studio')));if(c)return {...c,organizationId:o.id};}throw new Error('SENA channel missing');}
const c=await channel();
async function createAt(i,dueAt){
 const url=`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/media/sena-initial-9/${files[i]}`;
 const data=await gql('mutation($input: CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id dueAt status } } ... on MutationError { message } } }',{input:{text:captions[i],channelId:c.id,schedulingType:'automatic',mode:'customScheduled',dueAt,aiAssisted:true,assets:[{image:{url,metadata:{altText:'SENA AI-generated lifestyle image'}}}],metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}}});
 if(!data.createPost?.post?.id) throw new Error(data.createPost?.message??JSON.stringify(data.createPost));
 return data.createPost.post;
}
const oldDues=['2026-09-23T11:30:00.000Z','2026-09-24T11:30:00.000Z','2026-09-25T11:30:00.000Z','2026-09-26T11:30:00.000Z','2026-09-27T11:30:00.000Z','2026-09-28T11:30:00.000Z','2026-09-29T11:30:00.000Z','2026-09-30T11:30:00.000Z','2026-10-01T11:30:00.000Z'];
const created=[];
for(let i=0;i<9;i++){
 const del=await gql('mutation($input: DeletePostInput!){deletePost(input:$input){__typename ... on DeletePostSuccess{id} ... on VoidMutationError{message}}}',{input:{id:oldIds[i]}});
 if(del.deletePost?.message) throw new Error(`Delete old ${oldIds[i]}: ${del.deletePost.message}`);
 try{
  created.push(await createAt(i,dues[i]));
 }catch(e){
  try{await createAt(i,oldDues[i]);}catch(rollback){throw new Error(`Replacement failed: ${e.message}; rollback also failed: ${rollback.message}`);}
  throw e;
 }
}
console.log(JSON.stringify({ok:true,newPosts:created},null,2));
