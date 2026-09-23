import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const runner=resolve('scripts/sena-30day-rolling-queue.mjs');
const cid='6aa72524ea19ca0bde39313c', bytes=Buffer.from('verified-fixture');
const hash=createHash('sha256').update(bytes).digest('hex');
for(const scenario of ['capacity','create','known','conflict','ambiguous','bad_hash']){
 const dir=await mkdtemp(join(tmpdir(),'sena-queue-'));
 try{
  await mkdir(join(dir,'automation/30day'),{recursive:true});await mkdir(join(dir,'media/sena-30day-2026-09-28'),{recursive:true});
  const item={day:1,date:'2099-09-28',publishAt:'2099-09-28T20:30:00+09:00',account:'sena.virtual.studio',aiDisclosure:true,qcStatus:'accepted',caption:'fixture',filename:'SENA_2099-09-28_D01.jpeg',mediaPath:'media/sena-30day-2026-09-28/SENA_2099-09-28_D01.jpeg',sha256:scenario==='bad_hash'?'bad':hash};
  await writeFile(join(dir,'automation/30day/publishing-manifest.json'),JSON.stringify({sena:[item]}));await writeFile(join(dir,item.mediaPath),bytes);
  const mock=`import {writeFile} from 'node:fs/promises';let creates=0;const cid=${JSON.stringify(cid)},scenario=${JSON.stringify(scenario)};
  globalThis.fetch=async(url,options)=>{
   if(url.startsWith('https://raw.'))return new Response(Buffer.from('verified-fixture'));
   const {query,variables}=JSON.parse(options.body);let data;
   if(query.includes('account {'))data={account:{organizations:[{id:'org'}]}};
   else if(query.includes('channels('))data={channels:[{id:cid,name:'sena.virtual.studio',displayName:'sena.virtual.studio',service:'instagram'}]};
   else if(query.includes('mutation')){creates++;await writeFile('creates.json',JSON.stringify(creates));if(scenario==='ambiguous')throw Error('timeout');data={createPost:{post:{id:'new',dueAt:variables.input.dueAt,status:'scheduled',text:variables.input.text}}};}
   else{let nodes=[];if(query.includes('[scheduled]')){
    if(scenario==='capacity')nodes=Array.from({length:9},(_,i)=>({id:'old'+i,channelId:'other',text:'old',dueAt:'2099-01-01',status:'scheduled'}));
    if(['known','conflict'].includes(scenario))nodes=[{id:'existing',channelId:cid,text:scenario==='known'?'fixture':'different',dueAt:'2099-09-28T11:30:00Z',status:'scheduled'}];
   }data={posts:{edges:nodes.map(node=>({node}))}};}return Response.json({data});};
  await import(${JSON.stringify(runner)});`;
  await writeFile(join(dir,'mock.mjs'),mock);
  const run=()=>spawnSync(process.execPath,['mock.mjs'],{cwd:dir,env:{...process.env,BUFFER_API_KEY:'fixture'},encoding:'utf8'});
  let r=run();assert.equal(r.status,['ambiguous','bad_hash'].includes(scenario)?1:0,r.stderr);
  const state=JSON.parse(await readFile(join(dir,'automation/30day/sena-state.json'),'utf8').catch(()=>'{"scheduled":[]}'));
  assert.equal(state.scheduled.length,['create','known'].includes(scenario)?1:0);
  if(['create','ambiguous'].includes(scenario)){r=run();assert.equal(r.status,0,r.stderr);const count=JSON.parse(await readFile(join(dir,'creates.json'),'utf8'));assert.equal(count,1);}
  if(scenario==='conflict')assert.equal(state.blocked[0].reason,'existing_post_on_tokyo_date');
  console.log('PASS',scenario);
 }finally{await rm(dir,{recursive:true,force:true});}
}
