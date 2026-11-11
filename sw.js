/* England offline cache: pages network-first (falls back to the saved copy when offline), files cache-first */
const C="england-v2",CORE=["./","./index.html","./manifest.webmanifest","./icon-180.png","./icon-192.png","./icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);
  if(u.origin===location.origin&&u.pathname.endsWith("version.json"))return;
  if(r.mode==="navigate"){e.respondWith((async()=>{
    try{const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),5000);const res=await fetch(r,{signal:ctl.signal,cache:"no-store"});clearTimeout(t);
      if(res.ok){const c=await caches.open(C);await c.put("./index.html",res.clone())}return res}
    catch(err){return (await caches.match("./index.html"))||(await caches.match("./"))||Response.error()}})());return}
  const font=/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if(u.origin!==location.origin&&!font)return;
  e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok||res.type==="opaque"){const cl=res.clone();caches.open(C).then(c=>c.put(r,cl))}return res})))});

/* daily reminder: pushes carry no payload; ask the reminder server what to say */
const PUSH_API="https://england-push.bws6625wn5.workers.dev";
self.addEventListener("push",e=>{e.waitUntil((async()=>{let m={title:"England",body:"今天還沒練英文喔，花 10 分鐘把今日訓練做完吧！"};
  try{const s=await self.registration.pushManager.getSubscription();const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),4000);
    const r=await fetch(PUSH_API+"/msg?e="+encodeURIComponent(s?s.endpoint:""),{signal:ctl.signal});clearTimeout(t);if(r.ok){const j=await r.json();if(j&&j.title)m=j}}catch(err){}
  await self.registration.showNotification(m.title,{body:m.body,icon:"./icon-192.png",badge:"./icon-192.png",tag:"england-daily",data:{url:"./?src=home"}})})())});
self.addEventListener("notificationclick",e=>{e.notification.close();e.waitUntil((async()=>{const all=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  for(const c of all){if("focus" in c)return c.focus()}return self.clients.openWindow((e.notification.data&&e.notification.data.url)||"./?src=home")})())});
