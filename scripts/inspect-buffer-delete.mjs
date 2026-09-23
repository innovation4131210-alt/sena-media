const key=process.env.BUFFER_API_KEY;
if(!key)throw Error('Missing key');
const response=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({query:'query { __schema { mutationType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } } } } }'})});
const result=await response.json();
if(!response.ok||result.errors?.length)throw Error(JSON.stringify(result.errors??{status:response.status}));
const fields=result.data.__schema.mutationType.fields.filter(field=>/delete|remove|cancel/i.test(field.name));
console.log(JSON.stringify(fields));
