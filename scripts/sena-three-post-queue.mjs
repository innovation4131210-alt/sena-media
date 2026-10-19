import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const CHANNEL='6aa72524ea19ca0bde39313c', HANDLE='sena.virtual.studio';
const STATE='automation/30day/sena-state.json';
const hash=b=>createHash('sha256').update(b).digest('hex');
const time=s=>Date.parse(s);
export function validateBatches(items, cadenceDays=3, offsetsMinutes=[0,1,2]) {
  if(![JSON.stringify([0,1,2]),JSON.stringify([0,1,135])].includes(JSON.stringify(offsetsMinutes))) throw Error('Unsupported fixed batch offsets');
  if (!items.length || items.length%3) throw Error('Complete three-post batches required');
  const ids=new Set(), slots=new Set();
  for(let n=0;n<items.length;n+=3) {
    const group=items.slice(n,n+3), base=time(group[0].publishAt);
    for(let j=0;j<3;j++) {
      const x=group[j];
      if(ids.has(x.day)||slots.has(time(x.publishAt))||time(x.publishAt)!==base+offsetsMinutes[j]*60000||x.account!==HANDLE||x.qcStatus!=='accepted'||x.aiDisclosure!==true) throw Error('Invalid batch identity, timing or QC');
      ids.add(x.day); slots.add(time(x.publishAt));
    }
    if(n && base!==time(items[n-3].publishAt)+cadenceDays*86400000) throw Error('Configured cadence required');
  }
}
// A declared continuation starts a new cadence segment without rewriting history.
export function validateBatchPlan(items, policy) {
  const resume=policy.continuation;
  if(!resume) { validateBatches(items,policy.cadenceDays);return; }
  if(resume.activationReady!==true) throw Error('Continuation is not activation-ready; no provider access permitted');
  if(!Number.isInteger(resume.afterDay)||resume.afterDay<1||resume.startDay!==resume.afterDay+1||!Number.isFinite(time(resume.publishAt))||!Number.isFinite(time(resume.previousBatchLastAt))) throw Error('Invalid continuation boundary');
  const previous=items.filter(x=>x.day<resume.startDay), continuation=items.filter(x=>x.day>=resume.startDay);
  validateBatches(previous,policy.cadenceDays);validateBatches(continuation,policy.cadenceDays,resume.offsetsMinutes);
  if(previous.at(-1).day!==resume.afterDay||time(previous.at(-1).publishAt)!==time(resume.previousBatchLastAt)||continuation[0].day!==resume.startDay||time(continuation[0].publishAt)!==time(resume.publishAt)||time(resume.publishAt)<=time(resume.previousBatchLastAt)) throw Error('Continuation boundary mismatch');
  if(continuation.some((x,i)=>x.day!==resume.startDay+i)||new Set(items.map(x=>x.day)).size!==items.length||new Set(items.map(x=>time(x.publishAt))).size!==items.length) throw Error('Continuation identity collision');
  if(continuation.some(x=>x.existingOnly||!x.caption||!/^([a-f0-9]{64})$/.test(x.sha256||''))) throw Error('Incomplete continuation media evidence');
  if(new Set(items.map(x=>x.caption)).size!==items.length) throw Error('Duplicate planned caption');
  if(new Set(continuation.map(x=>x.sha256)).size!==continuation.length) throw Error('Duplicate planned image');
  if(JSON.stringify(resume.offsetsMinutes)===JSON.stringify([0,1,135])&&continuation.some((x,i)=>i%3===2&&(x.slotRole!=='night_pajama_sleep'||x.contentClass!=='pajama_sleep'))) throw Error('Night slot requires QC-approved pajama/sleep content');
}
export function verifyContinuationHistory(state, rows, policy) {
  if(!policy.continuation) return;
  const {afterDay}=policy.continuation;
  for(let day=1;day<=afterDay;day++) {
    const records=(state.scheduled??[]).filter(x=>x.day===day);
    if(records.length!==1||!records[0].bufferPostId||!records[0].caption||!records[0].dueAt) throw Error('Incomplete historical checkpoint');
    const old=records[0], matches=rows.filter(x=>x.id===old.bufferPostId), post=matches[0];
    if(matches.length!==1||post.channelId!==CHANNEL||post.status!=='sent'||post.text!==old.caption||time(post.dueAt)!==time(old.dueAt)||!post.assets?.length) throw Error('Continuation requires every historical ID live-sent and unchanged');
    // ImageAsset.id is nullable in Buffer's public schema. Null is unavailable,
    // never proof that the saved native asset ID is equal or has changed.
    if(old.sourceBufferAssetId&&(post.assets.length!==1||(post.assets[0].id!==null&&post.assets[0].id!==old.sourceBufferAssetId))) throw Error('Historical asset ID drift');
  }
}
export async function verifyCreatedMedia(item, post, transport) {
  if(!post||post.channelId!==CHANNEL||!['scheduled','sent'].includes(post.status)||post.text!==item.caption||time(post.dueAt)!==time(item.publishAt)||post.assets?.length!==1) throw Error('Created post identity/content/time/asset count readback failed');
  if(post.metadata?.type!=='post'||post.metadata.shouldShareToFeed!==true||post.metadata.isAiGenerated!==true) throw Error('Native Instagram AI/feed metadata readback failed');
  const asset=post.assets[0];
  const expectedMime=item.filename?.toLowerCase().endsWith('.png')?'image/png':'image/jpeg';
  if((asset.id!==null&&(typeof asset.id!=='string'||!asset.id))||asset.mimeType!==expectedMime||!asset.source||!asset.image||asset.image.altText!=='SENA AI-generated lifestyle image'||asset.image.userTags?.length) throw Error('Created image metadata readback failed');
  let source;try {source=new URL(asset.source);}catch {throw Error('Invalid provider image source');}
  if(source.protocol!=='https:'||source.username||source.password) throw Error('Unsafe provider image source');
  // Buffer may replace the source URL with its CDN URL. Verify returned bytes,
  // not URL equality; transformed/unavailable bytes remain unverified and stop.
  const response=await transport(source.href,{signal:AbortSignal.timeout(45000),redirect:'error'});
  if(!response.ok||hash(Buffer.from(await response.arrayBuffer()))!==item.sha256) throw Error('Provider image bytes differ or are unavailable; preserve intent');
}
export function verifyPost(before, after, dueAt) {
  if(!after||after.id!==before.id||after.channelId!==CHANNEL||after.status!=='scheduled'||after.text!==before.text||time(after.dueAt)!==time(dueAt)||JSON.stringify(after.assets.map(({id,...asset})=>asset))!==JSON.stringify(before.assets.map(({id,...asset})=>asset))||JSON.stringify(after.metadata)!==JSON.stringify(before.metadata)) throw Error('Post ID/content/assets/time readback failed');
}
export async function runBatchQueue({transport=fetch,env=process.env,clock=Date.now}={}) {
  if(!env.BUFFER_API_KEY) throw Error('SENA credential missing');
  const policy=JSON.parse(await readFile('automation/30day/sena-grid-policy.json','utf8'));
  if(policy.channelId!==CHANNEL||policy.handle!==HANDLE||policy.batchSize!==3||![1,3].includes(policy.cadenceDays)) throw Error('Invalid SENA policy');
  const manifest=JSON.parse(await readFile('automation/30day/publishing-manifest.json','utf8'));
  const state=JSON.parse(await readFile(STATE,'utf8'));
  const manifestItems=manifest.sena.filter(x=>x.day>=policy.startDay).map(x=>({...x,...(policy.overrides?.find(y=>y.day===x.day)||{})}));
  const externalItems=(state.scheduled??[]).filter(x=>x.existingOnly&&!manifestItems.some(y=>y.day===x.day)).map(x=>{
    if(!x.bufferPostId||!x.caption||!x.dueAt||!x.date||!x.batchId||x.nativeAiGenerated!==true||!x.verificationSource) throw Error('Incomplete external reservation evidence');
    return {day:x.day,date:x.date,publishAt:x.dueAt,account:HANDLE,caption:x.caption,qcStatus:'accepted',aiDisclosure:true,batchId:x.batchId,existingOnly:true};
  });
  const items=[...manifestItems,...externalItems].sort((a,b)=>time(a.publishAt)-time(b.publishAt));
  validateBatchPlan(items,policy);
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
    for(const status of ['scheduled','draft','sent','error']) {
      const d=await gql(`query($organizationId:OrganizationId!,$channelId:ChannelId!){posts(first:100,input:{organizationId:$organizationId,filter:{status:[${status}],channelIds:[$channelId]}}){edges{node{id channelId text dueAt status assets{id mimeType source ... on ImageAsset{image{altText userTags{__typename}}}} metadata{... on InstagramPostMetadata{type shouldShareToFeed isAiGenerated firstComment link geolocation{__typename} stickerFields{__typename}}}}}pageInfo{hasNextPage}}}`,{organizationId:c.organizationId,channelId:c.id});
      if(!Array.isArray(d.posts?.edges)||d.posts.pageInfo?.hasNextPage!==false) throw Error('Incomplete channel inventory');
      for(const {node:x} of d.posts.edges) {
        if(!x.id||x.channelId!==CHANNEL||x.status!==status||!Array.isArray(x.assets)||rows.some(y=>y.id===x.id)) throw Error('Invalid channel inventory'); rows.push(x);
      }
    }
    return rows;
  }
  let rows=await inventory();
  verifyContinuationHistory(state,rows,policy);
  const historicalAssetsAtStart=new Map((state.scheduled??[]).filter(x=>x.day<=policy.continuation?.afterDay).map(x=>[x.bufferPostId,JSON.stringify(rows.find(p=>p.id===x.bufferPostId).assets)]));
  const lookup=x=>{
    const id=policy.existing.find(y=>y.day===x.day)?.id||state.scheduled.find(y=>y.day===x.day)?.bufferPostId;
    const captionMatches=rows.filter(y=>y.text===x.caption);
    if(captionMatches.length>1||(id&&captionMatches.some(y=>y.id!==id))) throw Error('Duplicate exact post');
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
    if(policy.continuation&&x.day>=policy.continuation.startDay) Object.assign(e,{mediaSha256:x.sha256,sourceBufferAssetId:p.assets[0].id,nativeAiGenerated:true,mediaVerification:'SHA256 of provider-returned image bytes matched exact original; native Instagram AI/feed flags verified.'});
    state.batchMigration.pendingCreates=state.batchMigration.pendingCreates.filter(y=>y.day!==x.day);
  }
  // Reschedule existing IDs; explicitly resend unchanged content because Buffer validates edits as complete posts.
  for(const x of items) {
    const p=lookup(x); if(!p) continue;
    if(policy.continuation&&x.day<=policy.continuation.afterDay) continue; // Verified above; preserve historical checkpoints exactly.
    if(x.sha256&&(state.batchMigration.pendingCreates.some(y=>y.day===x.day)||x.day>=policy.continuation?.startDay)) await verifyCreatedMedia(x,p,transport);
    if(p.status==='sent') {record(x,p);continue;}
    if(p.status==='draft'||time(p.dueAt)!==time(x.publishAt)) {
      if(time(x.publishAt)<=clock()+15*60000) throw Error('Imminent post cannot be migrated safely');
      if(p.status!=='draft') {
        const original=policy.existing.find(y=>y.day===x.day);
        if(!original||time(p.dueAt)!==time(original.originalDueAt)) throw Error('Unexpected schedule drift');
      }
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
      if(!p||p.status!=='scheduled'||time(p.dueAt)!==time(dueAt)) throw Error('Create readback failed');
      await verifyCreatedMedia(x,p,transport);record(x,p);await save();
    }
  }
  rows=await inventory();
  const scheduled=rows.filter(x=>x.status==='scheduled');
  const finalExpectedIds=new Set(items.map(x=>lookup(x)?.id).filter(Boolean));
  if(scheduled.length>9||scheduled.some(x=>!finalExpectedIds.has(x.id))) throw Error('Final queue capacity or unmanaged-post drift');
  for(let n=0;n<items.length;n+=3) {
    const group=items.slice(n,n+3), members=group.map(lookup).filter(Boolean);
    if(members.length && members.length!==3) throw Error('Incomplete batch after readback');
    for(let j=0;j<members.length;j++) if(members[j].status==='scheduled'&&time(members[j].dueAt)!==time(group[j].publishAt)) throw Error('Final timing mismatch');
  }
  if(policy.continuation) {
    verifyContinuationHistory(state,rows,policy);
    for(const [id,assets] of historicalAssetsAtStart) if(JSON.stringify(rows.find(p=>p.id===id)?.assets)!==assets) throw Error('Historical asset data changed during run');
    state.continuationHistoryReadback={verifiedAt:stamp(),checkpointFields:['postId','channelId','caption','dueAt','sent'],legacyOriginalByteIdentity:'Not independently proven: the legacy checkpoint did not retain original image hashes. Null API asset IDs are unavailable, not equal to saved native IDs.',nullableAssetIds:(state.scheduled??[]).filter(x=>x.day<=policy.continuation.afterDay&&x.sourceBufferAssetId&&rows.find(p=>p.id===x.bufferPostId)?.assets[0]?.id===null).map(x=>{const asset=rows.find(p=>p.id===x.bufferPostId).assets[0];let sourcePathContainsSavedAssetId=false;try{sourcePathContainsSavedAssetId=new URL(asset.source).pathname.includes(x.sourceBufferAssetId);}catch{}return {day:x.day,postId:x.bufferPostId,savedNativeAssetId:x.sourceBufferAssetId,apiAssetId:null,sourcePathContainsSavedAssetId};})};
    for(const x of items.filter(x=>x.day>=policy.continuation.startDay)) {const post=lookup(x);if(post) await verifyCreatedMedia(x,post,transport);}
  }
  Object.assign(state,{lastRunAt:stamp(),lastVerifiedAt:stamp(),channel:{id:CHANNEL,name:HANDLE},observedChannelScheduledCount:scheduled.length,capacityScope:'channel',safeQueueLimit:9,remainingChannelCapacity:9-scheduled.length,publishingPolicy:policy.cadenceDays===1?'three_posts_daily':'three_posts_every_three_days',blocked:[]});
  state.batchMigration.status='verified';state.batchMigration.verifiedAt=stamp();await save();
  const result={ok:true,channelId:CHANNEL,handle:HANDLE,policy:policy.cadenceDays===1?'three_posts_daily':'three_posts_every_three_days',verifiedAt:stamp(),scheduled:scheduled.map(x=>({id:x.id,dueAt:x.dueAt,assetIds:x.assets.map(y=>y.id)})),editsVerified:state.batchMigration.edits.length};
  console.log(JSON.stringify(result));return result;
}
