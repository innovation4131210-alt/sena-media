import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const lanes=[['x-buffer-mio-refill.mjs','mio_ai_life_jp','6ab74779ea19ca0bdef024db','twitter'],['x-buffer-sena-refill.mjs','sena_ai_studio','6ab4f318ea19ca0bded37a49','twitter'],['sena-threads-refill.mjs','sena.virtual.studio','6ab75347ea19ca0bdef0d04a','threads']];
let passed=0;
for(const [file,handle,id,service] of lanes){
 const raw=await readFile(new URL('./'+file,import.meta.url),'utf8');
 const code=raw.replace(/^import .*;\n/gm,'').replace(/new URL\([^;]+;/,'"mock-queue";').replace(/main\(\)\.catch\([\s\S]*$/,'globalThis.run = main;');
 const target={key:'approved-1',status:'pending',dueAt:'2030-10-03T03:15:00.000Z',text:'approved original',mediaUrl:'https://mock.invalid/image.jpeg'};
 const row=(extra={})=>({id:'post-1',channelId:id,status:'scheduled',text:target.text,dueAt:target.dueAt,assets:[{mimeType:'image/jpeg'}],...extra});
 async function harness(opts={}){
  let queue=structuredClone(opts.queue??{policy:{enabled:true,visualRequired:true},posts:[target]});
  let rows=structuredClone(opts.rows??[]),mutations=0,inventories=0;
  const context=vm.createContext({console:{log(){},error(){}},AbortSignal,Date,URL,process:{env:{X_BUFFER_API_KEY:'mock',SENA_BUFFER_API_KEY:'mock'}},readFile:async()=>JSON.stringify(queue),writeFile:async(_path,data)=>{queue=JSON.parse(data)},fetch:async(url,options)=>{
   if(url!=='https://api.buffer.com')return {ok:true,headers:{get:()=> 'image/jpeg'}};
   const {query,variables}=JSON.parse(options.body);let data;
   if(query.includes('account {'))data={account:{organizations:[{id:'org'}]}};
   else if(query.includes('channels(input'))data={channels:[{id:opts.wrongChannel?'other':id,name:handle,displayName:handle,service,isLocked:false,isDisconnected:false,isQueuePaused:false}]};
   else if(query.includes('posts(first')){
    inventories++;
    data=opts.inventory??{posts:{edges:(opts.hideReadback&&mutations?[]:rows).map(node=>({node})),pageInfo:{hasNextPage:false}}};
   }else if(query.includes('createPost')){
    mutations++;
    assert.equal(queue.posts[0].status,'creating','intent saved before any create');
    assert.equal(variables.input.channelId,id);
    rows.push(row(opts.drift?{dueAt:'2030-10-03T04:15:00.000Z'}:{}));
    if(opts.throwCreate)throw Error('mock lost response');
    data={createPost:{post:rows.at(-1)}};
   }else throw Error('Unexpected mock operation');
   return {ok:true,text:async()=>JSON.stringify({data})};
  }});
  vm.runInContext(code,context);
  let error;try{await context.run();}catch(e){error=e;}
  return {error,queue,mutations,rows,inventories};
 }
 async function check(name,fn){await fn();passed++;console.log('PASS',file,name);}
 await check('happy path saves verified state',async()=>{const r=await harness();assert.ifError(r.error);assert.equal(r.mutations,1);assert.equal(r.queue.posts[0].status,'scheduled')});
 for(const [name,inventory] of [['missing connection',{}],['null connection',{posts:null}],['missing edges',{posts:{pageInfo:{hasNextPage:false}}}],['missing pagination',{posts:{edges:[]}}],['partial page',{posts:{edges:[],pageInfo:{hasNextPage:true}}}],['nonboolean pagination',{posts:{edges:[],pageInfo:{hasNextPage:0}}}],['wrong channel row',{posts:{edges:[{node:row({channelId:'wrong'})}],pageInfo:{hasNextPage:false}}}],['duplicate IDs',{posts:{edges:[{node:row()},{node:row()}],pageInfo:{hasNextPage:false}}}],['null node',{posts:{edges:[{node:null}],pageInfo:{hasNextPage:false}}}]]){
  await check(name+' fails closed',async()=>{const r=await harness({inventory});assert.ok(r.error);assert.equal(r.mutations,0)});
 }
 await check('identity mismatch fails closed',async()=>{const r=await harness({wrongChannel:true});assert.match(r.error.message,/identity mismatch/);assert.equal(r.mutations,0)});
 await check('recovery does not create duplicate',async()=>{const r=await harness({rows:[row()]});assert.ifError(r.error);assert.equal(r.mutations,0);assert.equal(r.queue.posts[0].bufferPostId,'post-1')});
 await check('error post is not marked scheduled',async()=>{const r=await harness({rows:[row({status:'error'})]});assert.match(r.error.message,/recovery status/);assert.equal(r.mutations,0);assert.equal(r.queue.posts[0].status,'pending')});
 await check('occupied slot fails closed',async()=>{const r=await harness({rows:[row({text:'another approved post'})]});assert.match(r.error.message,/occupied/);assert.equal(r.mutations,0)});
 await check('duplicate target fails closed',async()=>{const r=await harness({rows:[row(),row({id:'post-2'})]});assert.match(r.error.message,/Duplicate Buffer target/);assert.equal(r.mutations,0)});
 await check('readback drift preserves unresolved ID',async()=>{const r=await harness({drift:true});assert.match(r.error.message,/readback failed/);assert.equal(r.queue.posts[0].status,'created_unverified');assert.equal(r.queue.posts[0].bufferPostId,'post-1')});
 await check('lost response saves intent and refuses blind retry',async()=>{const r=await harness({throwCreate:true});assert.match(r.error.message,/lost response/);assert.equal(r.queue.posts[0].status,'creating');const retry=await harness({queue:r.queue});assert.match(retry.error.message,/manual reconciliation/);assert.equal(retry.mutations,0)});
 await check('uncertain create recovered from live inventory',async()=>{const r=await harness({throwCreate:true});const retry=await harness({queue:r.queue,rows:r.rows});assert.ifError(retry.error);assert.equal(retry.mutations,0);assert.equal(retry.queue.posts[0].status,'scheduled')});
 await check('readback failure retains ID and recovers later',async()=>{const r=await harness({hideReadback:true});assert.ok(r.error);assert.equal(r.queue.posts[0].status,'created_unverified');const retry=await harness({queue:r.queue,rows:r.rows});assert.ifError(retry.error);assert.equal(retry.mutations,0)});
 await check('recovery mismatched saved ID fails closed',async()=>{const r=await harness({queue:{policy:{enabled:true},posts:[{...target,status:'created_unverified',bufferPostId:'other'}]},rows:[row()]});assert.match(r.error.message,/ID mismatch/);assert.equal(r.mutations,0)});
}
console.log(`${passed} tests passed; all filesystem, network, and credentials are mocked.`);
