import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const EXPECTED_CHANNEL_ID = "6ab4f318ea19ca0bded37a49";
const EXPECTED_HANDLE = "sena_ai_studio";
const QUEUE_PATH = new URL("../automation/x-buffer/sena-queue.json", import.meta.url);
const LIVE_API = "https://api.buffer.com";
const MEDIA = {
  "sena-d27": {sha:"4767bf2481b5d9251601411413726ffdd90e67b3", bufferId:"6acf0ce8b610c3011f9fe31c"},
  "sena-d28": {sha:"ea89df57daed1e0105a6bd977e87feb10f84747f", bufferId:"6ad05bafc183410f7421af29"},
  "sena-d29": {sha:"7ee5d040502084a636ffcb4d4b103bf4ae06bbb5", bufferId:"6ad1aaf5a82f34dbe14743aa"},
  "sena-d30": {sha:"84542d07667ba790eaea0502bdb4c6b997192f53", bufferId:"6ad2fbbf8ac6cfe5442dedd3"}
};

function isVisual(row) {
  // Buffer public-URL ImageAsset objects may legitimately have no internal id.
  // Require the actual GraphQL ImageAsset union, JPEG MIME, source and dimensions.
  return Array.isArray(row?.assets) && row.assets.some(a =>
    a?.__typename==="ImageAsset" && /^image\//i.test(String(a.mimeType??"")) &&
    typeof a.source==="string" && Number(a.image?.width)>0 && Number(a.image?.height)>0
  );
}
function hasExactImage(row,url) {
  return isVisual(row) && row.assets.some(a =>
    a?.__typename==="ImageAsset" && a.source===url &&
    /^image\//i.test(String(a.mimeType??"")) &&
    Number(a.image?.width)>0 && Number(a.image?.height)>0
  );
}

async function gql(query, variables={}) {
  const response=await fetch(LIVE_API, {
    method:"POST",
    headers:{Authorization:"Bearer "+process.env.X_BUFFER_API_KEY,"Content-Type":"application/json"},
    body:JSON.stringify({query,variables}),
    signal:AbortSignal.timeout(30000)
  });
  const raw=await response.text();
  let data;try {data=JSON.parse(raw);} catch {throw Error("Buffer returned invalid JSON, HTTP "+response.status);}
  if(!response.ok || data.errors?.length || !data.data) {
    throw Error("Buffer request failed: HTTP "+response.status+" "+JSON.stringify(data.errors??data).slice(0,800));
  }
  return data.data;
}

async function channel() {
  const info=await gql("query {account {organizations {id}}}");
  let matches=[];
  for(const org of info.account?.organizations??[]) {
    const data=await gql(`query($organizationId:OrganizationId!) {
      channels(input:{organizationId:$organizationId}) {
        id name displayName service isLocked isDisconnected isQueuePaused
      }
    }`,{organizationId:org.id});
    for(const ch of data.channels??[]) if(ch.id===EXPECTED_CHANNEL_ID) matches.push({...ch,organizationId:org.id});
  }
  if(matches.length!==1) throw Error("SENA channel not uniquely found");
  const ch=matches[0];
  if(!["twitter","x"].includes(String(ch.service).toLowerCase()) ||
     ![ch.name,ch.displayName].some(v=>String(v??"").replace(/^@/,"").toLowerCase()===EXPECTED_HANDLE)) {
    throw Error("SENA channel identity mismatch");
  }
  if(ch.isLocked || ch.isDisconnected || ch.isQueuePaused) throw Error("SENA channel is unavailable");
  return ch;
}

async function inventory(ch) {
  const data=await gql(`query($organizationId:OrganizationId!,$channelId:ChannelId!) {
    posts(first:100,input:{
      organizationId:$organizationId,
      filter:{channelIds:[$channelId]},
      sort:[{field:dueAt,direction:asc}]
    }) {
      edges { node {id text status dueAt channelId assets {
        id mimeType __typename source
        ... on ImageAsset { image { width height } }
      }} }
      pageInfo {hasNextPage}
    }
  }`,{organizationId:ch.organizationId,channelId:ch.id});
  if(!Array.isArray(data.posts?.edges) || data.posts.pageInfo?.hasNextPage!==false) {
    throw Error("Incomplete Buffer inventory, refusing mutation");
  }
  const rows=data.posts.edges.map(e=>e?.node);
  if(rows.some(r=>!r?.id || r.channelId!==ch.id || !Array.isArray(r.assets))) {
    throw Error("Buffer response missing channel identity or asset inventory");
  }
  if(new Set(rows.map(r=>r.id)).size!==rows.length) throw Error("Duplicate Buffer post IDs");
  return rows;
}

function rowMatches(row,target) {
  return row?.id===target.bufferPostId &&
    row.text===target.text &&
    Date.parse(row.dueAt)===Date.parse(target.dueAt) &&
    Number.isFinite(Date.parse(row.dueAt));
}

async function verifyApprovedImage(url,expectedGitBlobSha) {
  if(!url.startsWith("https://raw.githubusercontent.com/innovation4131210-alt/sena-media/") &&
     !url.startsWith("https://cdn.jsdelivr.net/gh/innovation4131210-alt/sena-media@")) {
    throw Error("SENA media URL not from approved repository");
  }
  const res=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!res.ok) throw Error("Approved image source HTTP "+res.status);
  const type=(res.headers.get("content-type")??"").toLowerCase();
  if(!type.startsWith("image/")) throw Error("Approved asset is not an image");
  const bytes=Buffer.from(await res.arrayBuffer());
  if(bytes.length < 10000 || bytes.length > 12000000) throw Error("Approved image bytes out of expected range");
  const gitSha=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
  if(gitSha!==expectedGitBlobSha) throw Error("Exact approved source asset hash changed: "+gitSha);
  return bytes.length;
}

async function edit(id,fields) {
  const data=await gql(`mutation($input:EditPostInput!) {
    editPost(input:$input) {
      __typename
      ... on PostActionSuccess {
        post {id text status dueAt channelId assets {id mimeType}}
      }
      ... on MutationError {message}
    }
  }`,{input:{id,...fields}});
  if(!data.editPost?.post?.id) {
    throw Error("Buffer editPost rejected: "+String(data.editPost?.message??data.editPost?.__typename??"unknown"));
  }
  return data.editPost.post;
}

async function confirmed(ch,target,requireVisual=true,expectedImageUrl=null) {
  for(let attempt=0;attempt<4;attempt++) {
    const rows=await inventory(ch);
    const row=rows.find(r=>r.id===target.bufferPostId);
    if(row) {
      if(row.id!==target.bufferPostId || row.channelId!==ch.id || row.text!==target.text) {
        throw Error("Post identity or copy drift");
      }
      if(requireVisual) {
        if(!rowMatches(row,target)) throw Error("Post schedule drift");
        if(row.status==="scheduled" && isVisual(row) && (!expectedImageUrl || hasExactImage(row,expectedImageUrl))) return row;
      } else if(row.status==="draft") {
        return row;
      }
    }
    if(attempt<3) await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw Error(requireVisual?"Live Buffer visual asset readback missing":"Live Buffer still scheduled");
}

async function main() {
  if(!process.env.X_BUFFER_API_KEY) throw Error("X_BUFFER_API_KEY missing");
  const q=JSON.parse(await readFile(QUEUE_PATH,"utf8"));
  if(q.policy?.visualRequired!==true || q.policy?.enabled!==true) {
    throw Error("SENA visual-first policy not enabled");
  }
  const ch=await channel();
  let rows=await inventory(ch);
  let edited=0,verified=0,held=0;
  let errors=[];
  for(const [key,expected] of Object.entries(MEDIA)) {
    const t=q.posts.find(p=>p.key===key);
    if(!t || t.bufferPostId!==expected.bufferId) throw Error("Approved SENA queue or ID mismatch for "+key);
    const row=rows.find(r=>r.id===t.bufferPostId);
    if(!row) throw Error("Known scheduled SENA post absent from inventory "+key);
    if(!rowMatches(row,t)) throw Error("SENA scheduled post mismatch "+key);
    if(row.status==="sent") {console.log(JSON.stringify({key,status:"sent_no_change"}));continue;}
    if(row.status==="draft") {
      if(Date.parse(t.dueAt)<=Date.now()+10*60*1000) {
        console.log(JSON.stringify({key,status:"held_as_draft_past_safe_schedule_window"}));
        continue;
      }
      try {
        // Use a commit-pinned public CDN for the identical Git-approved bytes.
        // Raw GitHub was retried and Buffer persisted no image; never relax readback.
        const rawPrefix="https://raw.githubusercontent.com/innovation4131210-alt/sena-media/main/";
        if(!t.mediaUrl.startsWith(rawPrefix)) throw Error("Unexpected SENA approved media source");
        const pinnedCommit=process.env.GITHUB_SHA;
        if(!/^[a-f0-9]{40}$/.test(pinnedCommit??"")) throw Error("Cannot pin CDN asset to immutable commit");
        const hostedUrl="https://cdn.jsdelivr.net/gh/innovation4131210-alt/sena-media@"+pinnedCommit+"/"+t.mediaUrl.slice(rawPrefix.length);
        const bytes=await verifyApprovedImage(hostedUrl,expected.sha);
        await edit(t.bufferPostId,{
          text:t.text,assets:[{image:{url:hostedUrl}}],saveToDraft:true
        });
        let draft;
        for(let attempt=0;attempt<4;attempt++) {
          const current=(await inventory(ch)).find(r=>r.id===t.bufferPostId);
          if(current?.status==="draft" && current.text===t.text && hasExactImage(current,hostedUrl)) {
            draft=current;break;
          }
          if(attempt<3) await new Promise(done=>setTimeout(done,2000));
        }
        if(!draft) {
          console.log(JSON.stringify({key,status:"draft_media_not_verified_refusing_to_schedule"}));
          // Safe diagnostic: one exact-approved-image createPost draft. NEVER publish this probe.
          // If Buffer strips assets even on creation, retain it as an unscheduled draft.
          if (key==="sena-d27") {
            if (!t.visualProbeDraftId) {
              const response=await gql(`mutation($input:CreatePostInput!) {
                createPost(input:$input) {
                  __typename
                  ... on PostActionSuccess {post {id text status channelId assets {id mimeType}}}
                  ... on MutationError {message}
                }
              }`,{input:{
                text:t.text,channelId:ch.id,schedulingType:"automatic",mode:"addToQueue",
                saveToDraft:true,aiAssisted:true,assets:[{image:{url:hostedUrl}}]
              }});
              const created=response.createPost?.post;
              if(!created?.id || created.channelId!==ch.id || created.status!=="draft") {
                throw Error("Approved image-only draft probe rejected: "+String(response.createPost?.message??"unexpected response"));
              }
              t.visualProbeDraftId=created.id;
              t.visualProbeSourceGitBlob=expected.sha;
              await writeFile(QUEUE_PATH,JSON.stringify(q,null,2)+"\n");
            }
            const probe=(await inventory(ch)).find(r=>r.id===t.visualProbeDraftId);
            console.log(JSON.stringify({
              key,status:"new_draft_asset_probe",
              postId:t.visualProbeDraftId,
              isDraft:probe?.status==="draft",
              hasActualImage:isVisual(probe),
              mediaCount:probe?.assets?.length??null,
              assetTypes:probe?.assets?.map(a=>({
                type:a.__typename,mimeType:a.mimeType,
                hasId:Boolean(a.id),sourceHost:String(a.source??"").slice(0,55),
                width:a.image?.width??null,height:a.image?.height??null
              }))??[]
            }));
          }
          continue;
        }
        const current=await inventory(ch);
        const unsafe=current.some(r=>r.id!==t.bufferPostId &&
          r.status==="scheduled" && Number.isFinite(Date.parse(r.dueAt)) &&
          Math.abs(Date.parse(r.dueAt)-Date.parse(t.dueAt))<6*60*60*1000);
        if(unsafe) throw Error("No safe SENA six-hour open slot");
        await edit(t.bufferPostId,{
          text:t.text,assets:[{image:{url:hostedUrl}}],
          saveToDraft:false,mode:"customScheduled",
          dueAt:t.dueAt,schedulingType:"automatic",
        });
        const good=await confirmed(ch,t,true,hostedUrl);
        const visual=good.assets.find(a=>a.__typename==="ImageAsset" && a.source===hostedUrl);
        Object.assign(t,{
          status:"scheduled",bufferVisualVerifiedAt:new Date().toISOString(),
          bufferVisualMimeType:visual?.mimeType,bufferVisualAssetId:visual?.id,
          exactSourceGitBlob:expected.sha,
          bufferMediaUrl:hostedUrl,
          bufferImageAssetType:visual?.__typename,
          bufferImageWidth:visual?.image?.width,
          bufferImageHeight:visual?.image?.height,
          visualRepair:"draft_verified_ImageAsset_source_and_dimensions_then_rescheduled"
        });
        delete t.holdReason;
        edited++;verified++;
        await writeFile(QUEUE_PATH,JSON.stringify(q,null,2)+"\n");
        console.log(JSON.stringify({key,status:"draft_restored_as_verified_visual",bytes,id:good.id}));
      } catch(draftRepairError) {
        console.error(JSON.stringify({key,status:"draft_revival_unverified",error:draftRepairError.message}));
        const current=(await inventory(ch)).find(r=>r.id===t.bufferPostId);
        if(current?.status==="scheduled" && !isVisual(current)) {
          await edit(t.bufferPostId,{text:t.text,saveToDraft:true});
          await confirmed(ch,t,false);
          console.log(JSON.stringify({key,status:"unsafe_revival_rolled_back_to_draft"}));
        }
      }
      rows=await inventory(ch);
      continue;
    }
    if(row.status!=="scheduled") throw Error("Unexpected SENA post state "+key+" "+row.status);
    if(isVisual(row)) {
      // Reconcile the queue only after verifying both live Buffer image metadata
      // and the exact, approved Git blob bytes at the image source.
      const visual=row.assets.find(a=>
        a?.__typename==="ImageAsset" &&
        String(a.mimeType??"").toLowerCase().startsWith("image/") &&
        typeof a.source==="string" &&
        Number(a.image?.width)>0 && Number(a.image?.height)>0
      );
      if(!visual) throw Error("Scheduled SENA post lacks a complete ImageAsset: "+key);
      const bytes=await verifyApprovedImage(visual.source,expected.sha);
      t.status="scheduled";
      t.bufferVisualVerifiedAt=new Date().toISOString();
      t.bufferVisualMimeType=visual.mimeType;
      t.bufferVisualAssetId=visual.id??null;
      t.bufferMediaUrl=visual.source;
      t.bufferImageAssetType=visual.__typename;
      t.bufferImageWidth=visual.image.width;
      t.bufferImageHeight=visual.image.height;
      t.exactSourceGitBlob=expected.sha;
      t.visualRepair="scheduled_exact_visual_reverified";
      delete t.holdReason;
      delete t.heldAt;
      verified++;
      console.log(JSON.stringify({key,status:"scheduled_exact_visual_reverified",id:row.id,bytes}));
      await writeFile(QUEUE_PATH,JSON.stringify(q,null,2)+"\n");
      continue;
    }
    if(Date.parse(t.dueAt)<=Date.now()+180000) {
      throw Error("Too close to publishing to safely modify "+key);
    }
    try {
      const bytes=await verifyApprovedImage(t.mediaUrl,expected.sha);
      await edit(t.bufferPostId,{text:t.text,assets:[{image:{url:t.mediaUrl}}]});
      const good=await confirmed(ch,t,true);
      const visual=good.assets.find(a=>a.id && /^(image|video)\//.test(a.mimeType??""));
      Object.assign(t,{
        bufferVisualVerifiedAt:new Date().toISOString(),
        bufferVisualMimeType:visual.mimeType,
        bufferVisualAssetId:visual.id,
        exactSourceGitBlob:expected.sha,
        visualRepair:"added_exact_approved_image_via_editPost",
      });
      edited++;verified++;
      await writeFile(QUEUE_PATH,JSON.stringify(q,null,2)+"\n");
      console.log(JSON.stringify({key,status:"repaired_and_verified",id:good.id,bytes,assetMimeType:visual.mimeType}));
    } catch(error) {
      console.error(JSON.stringify({key,repairError:error.message}));
      // Never let an image-less original publish. If edit fails, take it out of the queue.
      const fresh=(await inventory(ch)).find(r=>r.id===t.bufferPostId);
      if(fresh?.status==="scheduled" && isVisual(fresh)) {
        t.bufferVisualVerifiedAt=new Date().toISOString();
        t.visualRepair="recovered_after_edit_error";
        verified++;
        await writeFile(QUEUE_PATH,JSON.stringify(q,null,2)+"\n");
        console.log(JSON.stringify({key,status:"media_present_after_error"}));
        continue;
      }
      if(fresh?.status==="scheduled") {
        try {
          await edit(t.bufferPostId,{text:t.text,saveToDraft:true});
          await confirmed(ch,t,false);
          Object.assign(t,{
            status:"held_visual_required",
            holdReason:"Buffer scheduled post had no image/video; moved to draft before original could publish",
            heldAt:new Date().toISOString(),
          });
          held++;
          await writeFile(QUEUE_PATH,JSON.stringify(q,null,2)+"\n");
          console.log(JSON.stringify({key,status:"moved_to_draft_for_visual_safety",id:t.bufferPostId}));
        } catch(draftError) {
          errors.push({key,error:"edit failed and draft fallback could not be verified: "+draftError.message});
        }
      } else {
        errors.push({key,error:"unresolved Buffer status after edit error"});
      }
    }
    rows=await inventory(ch);
  }
  console.log(JSON.stringify({result:"SENA_2026_10_24_VISUAL_REPAIR",channelId:ch.id,edited,verified,held,errors}));
  if(errors.length) throw Error("SENA safety intervention incomplete: "+JSON.stringify(errors));
}
main().catch(err=>{console.error(err.stack??err.message);process.exit(1)});
