import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const CHANNEL='6aa72524ea19ca0bde39313c', HANDLE='sena.virtual.studio';
const STATE='automation/30day/sena-state.json';
const hash=b=>createHash('sha256').update(b).digest('hex');
const time=s=>Date.parse(s);
export function validateBatches(items, cadenceDays=3) {
  if (!items.length || items.length%3) throw Error('Complete three-post batches required');
  const ids=new Set(), slots=new Set();
  for(let n=0;n<items.length;n+=3) {
    const group=items.slice(n,n+3), base=time(group[0].publishAt);
    for(let j=0;j<3;j++) {
      const x=group[j];
      if(ids.has(x.day)||slots.has(time(x.publishAt))||time(x.publishAt)!==base+j*60000||x.account!==HANDLE||x.qcStatus!=='accepted'||x.aiDisclosure!==true) throw Error('Invalid batch identity, timing or QC');
      ids.add(x.day); slots.add(time(x.publishAt));
    }
    if(n && base!==time(items[n-3].publishAt)+cadenceDays*86400000) throw Error('Configured cadence required');
  }
}
export function verifyPost(before, after, dueAt) {
  if(!after||after.id!==before.id||after.channelId!==CHANNEL||after.status!=='scheduled'||after.text!==before.text||time(after.dueAt)!==time(dueAt)||JSON.stringify(after.assets.map(({id,...asset})=>asset))!==JSON.stringify(before.assets.map(({id,...asset})=>asset))||JSON.stringify(after.metadata)!==JSON.stringify(before.metadata)) throw Error('Post ID/content/assets/time readback failed');
}
export async function runBatchQueue({transport=fetch,env=process.env,clock=Date.now}={}) {
  if(!env.BUFFER_API_KEY) throw Error('SENA credential missing');
  const policy=JSON.parse(await readFile('automation/30day/sena-grid-policy.json','utf8'));
  if(policy.channelId!==CHANNEL||policy.handle!==HANDLE||policy.batchSize!==3||![1,3].includes(policy.cadenceDays)) throw Error('Invalid SENA policy');
  const manifest=JSON.parse(await readFile('automation/30day/publishing-manifest.json','utf8'));
  const items=manifest.sena.filter(x=>x.day>=policy.startDay).map(x=>({...x,...(policy.overrides?.find(y=>y.day===x.day)||{})}));
  validateBatches(items,policy.cadenceDays);
  const state=JSON.parse(await readFile(STATE,'utf8'));
  state.batchMigration??={edits:[],pendingCreates:[]};
  const stamp=()=>new Date(clock()).toISOString();
  const save=async()=>{await mkdir('automation/30day',{recursive:true});await writeFile(STATE,JSON.stringify(state,null,2)+'\n');};
  async function gql(query,variables={}) {
    const r=await transport('https://api.buffer.com',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.BUFFER_API_KEY}`},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
    const j=await r.json(); if(!r.ok||j.errors?.length||!j.data) throw Error('Buffer operation failed; preserve checkpoint'); return j.data;
  }
  const account=await gql('query { account { organizations { id } } }');
  const found=[];
  for(const org of account.account.organizations) {
    const d=await gql('query($organizationId:OrganizationId!){channels(input:{organizationId:$organizationId}){id name displayName service isQueuePaused isDisconnected isLocked}}',{organizationId:org.id});
    for(const c of d.channels) if(c.id===CHANNEL&&c.service.toLowerCase()==='instagram'&&[c.name,c.displayName].includes(HANDLE)) found.push({...c,organizationId:org.id});
  }
  if(found.length!==1||found[0].isDisconnected||found[0].isLocked||found[0].isQueuePaused) throw Error('SENA identity/availability failed');
  const c=found[0];
  async function inventory() {
    const rows=[];
    for(const status of ['scheduled','sent','error']) {
      const d=await gql(`query($organizationId:OrganizationId!,$channelId:ChannelId!){posts(first:100,input:{organizationId:$organizationId,filter:{status:[${status}],channelIds:[$channelId]}}){edges{node{id channelId text dueAt status assets{id mimeType source ... on ImageAsset{image{altText userTags{__typename}}}} metadata{... on InstagramPostMetadata{type shouldShareToFeed isAiGenerated firstComment link geolocation{__typename} stickerFields{__typename}}}}}pageInfo{hasNextPage}}}`,{organizationId:c.organizationId,channelId:c.id});
      if(!Array.isArray(d.posts?.edges)||d.posts.pageInfo?.hasNextPage!==false) throw Error('Incomplete channel inventory');
      for(const {node:x} of d.posts.edges) {
        if(!x.id||x.channelId!==CHANNEL||x.status!==status||!Array.isArray(x.assets)||rows.some(y=>y.id===x.id)) throw Error('Invalid channel inventory'); rows.push(x);
      }
    }
    return rows;
  }
  let rows=await inventory();
  const lookup=x=>{
    const id=policy.existing.find(y=>y.day===x.day)?.id||state.scheduled.find(y=>y.day===x.day)?.bufferPostId;
    const matches=rows.filter(y=>id?y.id===id:y.text===x.caption);
    if(matches.length>1) throw Error('Duplicate exact post');
    if(id&&!matches.length) throw Error('Recorded post missing; no recreation');
    if(matches[0]&&(matches[0].text!==x.caption||!matches[0].assets.length||matches[0].status==='error')) throw Error('Existing post content/assets/status failed');
    return matches[0];
  };
  for(const x of items) lookup(x);
  const expectedIds=new Set(items.map(x=>lookup(x)?.id).filter(Boolean));
  if(rows.some(x=>x.status==='scheduled'&&!expectedIds.has(x.id))) throw Error('Unmanaged scheduled post would break grid');
  if(rows.filter(x=>x.status==='scheduled').length>9) throw Error('Queue capacity exceeded');
  function record(x,p) {
    let e=state.scheduled.find(y=>y.day===x.day);
    if(!e){e={day:x.day};state.scheduled.push(e);}
    Object.assign(e,{date:x.date,bufferPostId:p.id,dueAt:p.dueAt,caption:p.text,lastObservedStatus:p.status,verifiedAt:stamp(),batchId:x.batchId});
    if(x.existingOnly) e.existingOnly=true;
    state.batchMigration.pendingCreates=state.batchMigration.pendingCreates.filter(y=>y.day!==x.day);
  }
  // Reschedule existing IDs; explicitly resend unchanged content because Buffer validates edits as complete posts.
  for(const x of items) {
    const p=lookup(x); if(!p) continue;
    if(p.status==='sent') {record(x,p);continue;}
    if(time(p.dueAt)!==time(x.publishAt)) {
      if(Math.min(time(p.dueAt),time(x.publishAt))<=clock()+15*60000) throw Error('Imminent post cannot be migrated safely');
      const original=policy.existing.find(y=>y.day===x.day);
      if(!original||time(p.dueAt)!==time(original.originalDueAt)) throw Error('Unexpected schedule drift');
      if(!p.metadata||p.metadata.type!=='post'||p.metadata.geolocation||p.metadata.stickerFields||p.assets.some(a=>!a.mimeType.startsWith('image/')||!a.source||!a.image||a.image.userTags?.length)) throw Error('Unsupported existing metadata; refuse content changes');
      const {geolocation,stickerFields,...instagram}=p.metadata;
      const assets=p.assets.map(a=>({image:{url:a.source,metadata:{altText:a.image.altText}}}));
      state.batchMigration.pendingEdit={id:p.id,day:x.day,from:p.dueAt,to:x.publishAt,attemptedAt:stamp()};await save();
      const d=await gql('mutation($input:EditPostInput!){editPost(input:$input){__typename ... on PostActionSuccess{post{id}} ... on MutationError{message}}}',{input:{id:p.id,mode:'customScheduled',dueAt:new Date(x.publishAt).toISOString(),aiAssisted:true,text:p.text,assets,metadata:{instagram}}});
      if(d.editPost?.post?.id!==p.id) throw Error(`Edit rejected: ${d.editPost?.__typename || 'unknown'}: ${String(d.editPost?.message || 'no post ID').slice(0,400)}`);
      rows=await inventory(); const after=rows.find(y=>y.id===p.id);verifyPost(p,after,x.publishAt);
      state.batchMigration.edits.push({...state.batchMigration.pendingEdit,verifiedAt:stamp()});delete state.batchMigration.pendingEdit;
      record(x,after);await save();
    } else {if(state.batchMigration.pendingEdit?.id===p.id) delete state.batchMigration.pendingEdit;record(x,p);await save();}
  }
  // Fill only complete groups. Check all three exact media before first create.
  for(let n=0;n<items.length;n+=3) {
    const group=items.slice(n,n+3), missing=group.filter(x=>!lookup(x));
    if(!missing.length) continue;
    if(time(group[0].publishAt)<=clock()+15*60000) throw Error('Past/imminent incomplete batch');
    if(missing.some(x=>x.existingOnly)) throw Error('External reserved media must not be replaced');
    if(9-rows.filter(x=>x.status==='scheduled').length<missing.length) break;
    const urls=new Map();
    for(const x of missing) {
      if(state.batchMigration.pendingCreates.some(y=>y.day===x.day)) throw Error('Unresolved create intent; do not resend');
      if(x.mediaPath!==`media/sena-30day-2026-09-28/${x.filename}`) throw Error('Exact media path mismatch');
      if(hash(await readFile(x.mediaPath))!==x.sha256) throw Error('Local media hash mismatch');
      const url=`https://raw.githubusercontent.com/innovation4131210-alt/sena-media/${env.GITHUB_SHA||'main'}/${x.mediaPath}`;
      const r=await transport(url,{signal:AbortSignal.timeout(45000)});
      if(!r.ok||hash(Buffer.from(await r.arrayBuffer()))!==x.sha256) throw Error('Remote media hash mismatch'); urls.set(x.day,url);
    }
    for(const x of missing) {
      const dueAt=new Date(x.publishAt).toISOString();
      state.batchMigration.pendingCreates.push({day:x.day,caption:x.caption,dueAt,attemptedAt:stamp()});await save();
      const d=await gql('mutation($input:CreatePostInput!){createPost(input:$input){__typename ... on PostActionSuccess{post{id}} ... on MutationError{message}}}',{input:{text:x.caption,channelId:CHANNEL,schedulingType:'automatic',mode:'customScheduled',dueAt,aiAssisted:true,assets:[{image:{url:urls.get(x.day),metadata:{altText:'SENA AI-generated lifestyle image'}}}],metadata:{instagram:{type:'post',shouldShareToFeed:true,isAiGenerated:true}}}});
      if(!d.createPost?.post?.id) throw Error('Create ambiguous; preserve intent');
      state.scheduled.push({day:x.day,bufferPostId:d.createPost.post.id,lastObservedStatus:'created_unverified'});await save();
      rows=await inventory();const p=lookup(x);
      if(!p||p.status!=='scheduled'||time(p.dueAt)!==time(dueAt)) throw Error('Create readback failed');record(x,p);await save();
    }
  }
  rows=await inventory();
  const scheduled=rows.filter(x=>x.status==='scheduled');
  for(let n=0;n<items.length;n+=3) {
    const group=items.slice(n,n+3), members=group.map(lookup).filter(Boolean);
    if(members.length && members.length!==3) throw Error('Incomplete batch after readback');
    for(let j=0;j<members.length;j++) if(members[j].status==='scheduled'&&time(members[j].dueAt)!==time(group[j].publishAt)) throw Error('Final timing mismatch');
  }
  Object.assign(state,{lastRunAt:stamp(),lastVerifiedAt:stamp(),channel:{id:CHANNEL,name:HANDLE},observedChannelScheduledCount:scheduled.length,capacityScope:'channel',safeQueueLimit:9,remainingChannelCapacity:9-scheduled.length,publishingPolicy:policy.cadenceDays===1?'three_posts_daily':'three_posts_every_three_days',blocked:[]});
  state.batchMigration.status='verified';state.batchMigration.verifiedAt=stamp();await save();
  const result={ok:true,channelId:CHANNEL,handle:HANDLE,policy:policy.cadenceDays===1?'three_posts_daily':'three_posts_every_three_days',verifiedAt:stamp(),scheduled:scheduled.map(x=>({id:x.id,dueAt:x.dueAt,assetIds:x.assets.map(y=>y.id)})),editsVerified:state.batchMigration.edits.length};
  console.log(JSON.stringify(result));return result;
}
