import {createHash} from 'node:crypto';

// New normal posts require a specifically reviewed photo. Historical sent posts
// bypass this policy in the runner; a saved status alone is not sent evidence.
export function approvedPhoto(post) {
 const p=post.photo;
 if(!p || !p.sourceImageId || !/^[a-f0-9]{64}$/.test(p.sha256??'')) throw Error('QC-approved photo identity/hash required: '+post.key);
 let url;try{url=new URL(p.url);}catch{throw Error('Photo HTTPS URL required: '+post.key);}
 if(url.protocol!=='https:' || url.username || url.password) throw Error('Photo HTTPS URL required: '+post.key);
 if(p.qc?.status!=='approved' || !p.qc.evidence?.trim() || !Number.isFinite(Date.parse(p.qc.approvedAt))) throw Error('Photo QC approval evidence required: '+post.key);
 return p;
}
export function requireRemotePhoto(post) {
 if(!Array.isArray(post.assets) || !post.assets.some(a=>a.id && String(a.mimeType??'').startsWith('image/'))) throw Error('Scheduled photo missing/unconfirmed; repair existing reservation separately');
}
export async function verifyPhotoBytes(post, fetchImpl=fetch) {
 const p=approvedPhoto(post);
 const r=await fetchImpl(p.url,{signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!r.ok) throw Error('Photo unavailable: HTTP '+r.status);
 if(!/^image\/(jpeg|png|webp)$/.test((r.headers.get('content-type')??'').split(';')[0].trim().toLowerCase())) throw Error('Photo MIME type unsupported');
 const maxBytes=20*1024*1024;
 if(Number(r.headers.get('content-length'))>maxBytes) throw Error('Photo too large');
 const chunks=[];let size=0;
 for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes)throw Error('Photo too large');chunks.push(chunk);}
 if(!size || createHash('sha256').update(Buffer.concat(chunks)).digest('hex')!==p.sha256) throw Error('Photo SHA256 mismatch');
 return [{image:{url:p.url}}];
}

export function requireRecordedPhoto(target, saved, remote) {
 const photo=approvedPhoto(target);requireRemotePhoto(remote);
 const ids=remote.assets.filter(a=>String(a.mimeType??'').startsWith('image/')).map(a=>a.id).sort();
 if(saved.photoSha256!==photo.sha256 || saved.photoSourceImageId!==photo.sourceImageId || !Array.isArray(saved.assetIds) || JSON.stringify([...saved.assetIds].sort())!==JSON.stringify(ids)) throw Error('Photo identity not reconciled; repair existing reservation separately');
}
