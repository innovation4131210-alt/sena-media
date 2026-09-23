const key=process.env.BUFFER_API_KEY;
if(!key)throw Error('Missing key');
const query='query { input: __type(name:"DeletePostInput") { inputFields { name type { kind name ofType { kind name ofType { kind name } } } } } mutation: __type(name:"Mutation") { fields(includeDeprecated:true) { name type { kind name ofType { kind name ofType { kind name } } } } } }';
const response=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({query})});
const result=await response.json();
if(!response.ok||result.errors?.length)throw Error(JSON.stringify(result.errors??{status:response.status}));
const deleteField=result.data.mutation.fields.find(field=>field.name==='deletePost');
console.log(JSON.stringify({input:result.data.input,deleteField}));
