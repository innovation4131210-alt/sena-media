// Saved provider readback only; no I/O or repair. Schedules below are the existing
// SENA feed manifest and the two Threads daily cadences effective 2026-10-09.
export const EXPECTED_LANES = Object.freeze({
 '6aa72524ea19ca0bde39313c': {lane:'sena_instagram',name:'sena.virtual.studio',service:'instagram',time:'20:30'},
 '6ab3f6bdea19ca0bdec6f4d4': {lane:'mio_threads',name:'mio.ai_life',service:'threads',time:'19:00'},
 '6ab75347ea19ca0bdef0d04a': {lane:'sena_threads',name:'sena.virtual.studio',service:'threads',time:'20:10'},
});
const day = value => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const nextDay = date => {const d=new Date(`${date}T00:00:00+09:00`);d.setUTCDate(d.getUTCDate()+1);return day(d);};
export function evaluateContinuity(channel, posts, now=new Date(), inventoryComplete=true) {
 const rule=EXPECTED_LANES[channel?.id];
 if(!rule) return {status:'cadence_not_configured',mutationAllowed:false};
 const common={lane:rule.lane,expectedTimeJst:rule.time,evaluatedAt:now.toISOString(),mutationAllowed:false};
 if(channel.name!==rule.name||channel.service!==rule.service) return {...common,status:'identity_unverified',ok:false};
 if(!inventoryComplete) return {...common,status:'inventory_incomplete',ok:false};
 if(['isDisconnected','isLocked','isQueuePaused'].some(k=>typeof channel[k]!=='boolean')) return {...common,status:'availability_unverified',ok:false};
 if(channel.isDisconnected||channel.isLocked||channel.isQueuePaused) return {...common,status:'channel_unavailable',ok:false};
 const today=day(now);
 if(rule.lane==='sena_instagram' && today>='2026-10-10') return evaluateSenaBatches(common,posts,now);
 if(today<'2026-10-09') return {...common,status:'before_daily_cadence_effective_date',ok:null};
 const at=date=>Date.parse(`${date}T${rule.time}:00+09:00`);
 const matching=(post,date)=>Boolean(post.id)&&Number.isFinite(Date.parse(post.dueAt))&&Math.abs(Date.parse(post.dueAt)-at(date))<=60000;
 const sent=posts.filter(p=>p.status==='sent'&&Number.isFinite(Date.parse(p.sentAt))&&Date.parse(p.sentAt)<=now.getTime()&&Date.parse(p.sentAt)>=at(today)-60000&&matching(p,today));
 const due=now.getTime()>=at(today)+60*60000;
 const tomorrow=nextDay(today);
 const dates=[...new Set(posts.filter(p=>p.status==='scheduled'&&Boolean(p.id)&&p.draft!==true&&p.autoPublish!==false&&Number.isFinite(Date.parse(p.dueAt))&&Date.parse(p.dueAt)>now.getTime()).filter(p=>matching(p,day(p.dueAt))).map(p=>day(p.dueAt)))].sort();
 let gap=tomorrow,days=0;
 while(dates.includes(gap)){days++;gap=nextDay(gap);}
 const errors=[];
 if(due&&!sent.length)errors.push('expected_publication_unverified');
 if(!dates.includes(tomorrow))errors.push('next_day_reservation_unverified');
 const warnings=days<3?['future_stock_below_three_days']:[];
 return {...common,status:errors.length?'action_required':warnings.length?'stock_warning':'observed_delivery_and_coverage',ok:errors.length===0,
  expectedPublicationDueAt:new Date(at(today)).toISOString(),publicationGraceMinutes:60,
  todayPublicationStatus:sent.length?'sent_verified':due?'unverified_after_grace':'not_due_for_verification',
  publishedIds:sent.map(p=>p.id),publishedUrls:sent.map(p=>p.externalLink).filter(Boolean),
  futureDates:dates,consecutiveFutureDays:days,firstUnverifiedDate:gap,errors,warnings,
  note:'A missing observation is not proof of failed publication and never authorizes catch-up, replacement or restart.'};
}
function evaluateSenaBatches(common,posts,now) {
 const anchor=Date.parse('2026-10-10T20:30:00+09:00'),step=3*86400000;
 const base=anchor+Math.max(0,Math.floor((now.getTime()-anchor)/step))*step;
 const isBatchDay=day(base)===day(now), due=isBatchDay&&now.getTime()>=base+62*60000;
 const matches=(status,start)=>[0,1,2].map(j=>posts.filter(p=>p.id&&p.status===status&&Date.parse(p.dueAt)===start+j*60000&&(status!=='sent'||Date.parse(p.sentAt)<=now.getTime())));
 const sent=isBatchDay?matches('sent',base):[[],[],[]];
 const next=base>now.getTime()?base:base+step;
 const future=[];const errors=[];
 for(let start=next;start<=next+2*step;start+=step) {
  const group=matches('scheduled',start), count=group.reduce((s,x)=>s+x.length,0);
  if(count===3&&group.every(x=>x.length===1))future.push(day(start));
  else if(count)errors.push('incomplete_or_duplicate_future_batch');
 }
 if(due&&!sent.every(x=>x.length===1))errors.push('three_post_publication_unverified');
 if(!future.includes(day(next)))errors.push('next_batch_reservation_unverified');
 return {...common,status:errors.length?'action_required':'observed_batch_coverage',ok:errors.length===0,
  cadence:'three_posts_every_three_days',batchSize:3,expectedPublicationDueAt:isBatchDay?new Date(base).toISOString():null,
  todayPublicationStatus:isBatchDay?(sent.every(x=>x.length===1)?'three_sent_verified':due?'unverified_after_grace':'not_due_for_verification'):'no_feed_batch_planned',
  publishedIds:sent.flat().map(x=>x.id),publishedUrls:sent.flat().map(x=>x.externalLink).filter(Boolean),
  futureDates:future,nextBatchDate:day(next),errors,warnings:future.length<3?['future_stock_below_three_batches']:[],
  note:'Sequential publication, not atomic. No catch-up/replacement is authorized by missing observations.'};
}
export function summarizeContinuity(connections, now=new Date()) {
 const channels=connections.flatMap(c=>c.channels??[]);
 return Object.fromEntries(Object.entries(EXPECTED_LANES).map(([id,rule])=>{
  const candidates=channels.filter(c=>c.id===id);
  // A failed/incomplete connection must not hide a complete observation from
  // another existing key. Keep all connection errors in the parent report.
  const verified=c=>c.name===rule.name&&c.service===rule.service&&c.inventoryComplete===true
   && ['isDisconnected','isLocked','isQueuePaused'].every(k=>c[k]===false);
  const channel=candidates.find(verified)??candidates.find(c=>c.name===rule.name&&c.service===rule.service&&c.inventoryComplete===true)??candidates[0];
  return [rule.lane,channel?evaluateContinuity(channel,channel.posts??[],now,channel.inventoryComplete):{lane:rule.lane,status:'provider_observation_unavailable',ok:false,mutationAllowed:false}];
 }));
}

