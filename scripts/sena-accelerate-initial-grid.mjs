const API='https://api.buffer.com';
const key=process.env.BUFFER_API_KEY;
if(!key) throw new Error('SENA_BUFFER_API_KEY missing');

const targets=[
 ['6ab35020557b1c68e6c3bc9d','2026-09-23T07:30:00.000Z'],
 ['6ab3502198ae6feaa623f718','2026-09-23T10:30:00.000Z'],
 ['6ab350222aa0e20bb4721fa6','2026-09-23T13:00:00.000Z'],
 ['6ab35022557b1c68e6c3bce4','2026-09-24T02:00:00.000Z'],
 ['6ab350222aa0e20bb4721fcd','2026-09-24T06:00:00.000Z'],
 ['6ab35023557b1c68e6c3bd24','2026-09-24T12:00:00.000Z'],
 ['6ab3502498ae6feaa623f755','2026-09-25T10:30:00.000Z'],
 ['6ab350242aa0e20bb4721ffe','2026-09-26T03:30:00.000Z'],
 ['6ab350257f829c668079b70b','2026-09-27T11:30:00.000Z']
];

async function gql(query,variables){
 const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,variables})});
 const j=await r.json();
 if(!r.ok||j.errors?.length) throw new Error(JSON.stringify(j.errors??j));
 return j.data;
}
const mutation=`mutation EditPost($input: EditPostInput!){
 editPost(input:$input){
  ... on PostActionSuccess { post { id dueAt status } }
  ... on MutationError { message }
 }
}`;
const results=[];
for(const [id,dueAt] of targets){
 const data=await gql(mutation,{input:{id,mode:'customScheduled',dueAt}});
 if(data.editPost.message) throw new Error(`${id}: ${data.editPost.message}`);
 results.push(data.editPost.post);
}
console.log(JSON.stringify({ok:true,results},null,2));
