import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const script=new URL('./mio-threads-pilot.mjs',import.meta.url).pathname;
const hash=createHash('sha256').update('fixture').digest('hex');
const photo={url:'https://example.test/a.jpg',sha256:hash,sourceImageId:'s1',qc:{status:'approved',approvedAt:'2026-10-07T21:00:00Z',evidence:'synthetic'}};
async function run({old=false,status='scheduled',withPhoto=false,missingReadback=false,uncertain=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'threads-photo-test-'));
 try{
 await mkdir(join(dir,'automation/mio-threads'),{recursive:true});
 const p={key:'k1',text:'fixture text',dueAt:status==='sent'?'2026-09-01T00:00:00Z':'2099-01-01T00:00:00Z',...(withPhoto?{photo}:{})};
 await writeFile(join(dir,'automation/mio-threads/manifest.json'),JSON.stringify({channelId:'c1',handle:'mio.ai_life',posts:[p]}));
 const config={p,old,status,missingReadback,uncertain};
 const mock=`const cfg=${JSON.stringify(config)};let rows=cfg.old?[{...cfg.p,id:'p1',channelId:'c1',status:cfg.status,assets:[]}]:[];let state={posts:cfg.old?[{key:'k1',id:'p1',status:cfg.status,dueAt:cfg.p.dueAt}]:[]};globalThis.fetch=async(url,opts={})=>{if(url.startsWith('https://api.github.com')){if(opts.method==='PUT'){state=JSON.parse(Buffer.from(JSON.parse(opts.body).content,'base64'));return Response.json({content:{sha:'next'}});}return Response.json({sha:'initial',content:Buffer.from(JSON.stringify(state)).toString('base64')});}if(url.startsWith('https://example.test'))return new Response('fixture',{headers:{'content-type':'image/jpeg'}});const {query,variables}=JSON.parse(opts.body);if(query.includes('account {'))return Response.json({data:{account:{organizations:[{id:'o1'}]}}});if(query.includes('channels('))return Response.json({data:{channels:[{id:'c1',name:'mio.ai_life',service:'threads'}]}});if(query.includes('posts(first'))return Response.json({data:{posts:{edges:rows.map(node=>({node})),pageInfo:{hasNextPage:false}}}});if(query.includes('createPost(')){console.log('CREATE');if(!variables.input.assets?.[0]?.image?.url)throw Error('No image in create');rows=[{...cfg.p,id:'p2',channelId:'c1',status:'scheduled',assets:[{id:'a1',mimeType:'image/jpeg'}]}];if(cfg.uncertain)throw Error('simulated timeout');const made=structuredClone(rows[0]);if(cfg.missingReadback)rows[0].assets=[];return Response.json({data:{createPost:{post:made}}});}throw Error('Unexpected mutation/query');};`;
 await writeFile(join(dir,'mock.mjs'),mock);
 return spawnSync(process.execPath,['--import',join(dir,'mock.mjs'),script],{cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_REPOSITORY:'fixture/repo'}});
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('remote sent text-only history is preserved without create/edit',async()=>{const r=await run({old:true,status:'sent'});assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/CREATE/);});
test('existing text-only reservation requires repair, no mutation',async()=>{const r=await run({old:true,withPhoto:true});assert.notEqual(r.status,0);assert.match(r.stderr,/photo missing/);assert.doesNotMatch(r.stdout,/CREATE/);});
test('new text-only post rejected before create',async()=>{const r=await run();assert.notEqual(r.status,0);assert.match(r.stderr,/QC-approved photo/);assert.doesNotMatch(r.stdout,/CREATE/);});
test('approved photo creation and asset readback succeeds once',async()=>{const r=await run({withPhoto:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.match(/CREATE/g)?.length,1);});
test('missing image readback fails instead of success',async()=>{const r=await run({withPhoto:true,missingReadback:true});assert.notEqual(r.status,0);assert.match(r.stderr,/photo missing/);assert.equal(r.stdout.match(/CREATE/g)?.length,1);});
test('timeout does not retry create',async()=>{const r=await run({withPhoto:true,uncertain:true});assert.notEqual(r.status,0);assert.equal(r.stdout.match(/CREATE/g)?.length,1);});
