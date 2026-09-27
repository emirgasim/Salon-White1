const REPO="emirgasim/Salon-White1",BRANCH="main",MAX=12*1024*1024,ALLOWED=new Set(["jpg","jpeg","png","webp","avif"]);
const json=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json;charset=UTF-8","cache-control":"no-store"}});
const auth=c=>{const e=c.env.ADMIN_PASSWORD,g=c.request.headers.get("X-Admin-Password");return Boolean(e&&g&&g===e)};
const clean=x=>{let p=String(x||"").trim().replace(/^\/+|\\/g,"").replace(/\\/g,"/");if(!p.startsWith("assets/images/"))p="assets/images/"+p;if(p.includes("..")||!p.startsWith("assets/images/")||p.length>180)return null;return p};
const ext=x=>(x.split(".").pop()||"").toLowerCase();
function b64(a){const u=new Uint8Array(a);let s="",n=0x8000;for(let i=0;i<u.length;i+=n)s+=String.fromCharCode(...u.subarray(i,Math.min(i+n,u.length)));return btoa(s)}
async function gh(url,o,t){return fetch(url,{...o,headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+t,"X-GitHub-Api-Version":"2022-11-28",...(o?.headers||{})}})}
export async function onRequestPost(c){
 if(!auth(c))return json({error:"Yetkisiz erişim."},401);
 const t=c.env.GITHUB_TOKEN;if(!t)return json({error:"GITHUB_TOKEN Cloudflare secret olarak tanımlanmamış."},500);
 const f=await c.request.formData(),file=f.get("file"),path=clean(f.get("path"));
 if(!(file instanceof File)||!path)return json({error:"Dosya veya hedef yol eksik."},400);
 if(file.size>MAX)return json({error:"Dosya 12 MB sınırını aşıyor."},413);
 if(!ALLOWED.has(ext(path)))return json({error:"Desteklenmeyen görsel formatı."},415);
 const repo=c.env.GITHUB_REPO||REPO,branch=c.env.GITHUB_BRANCH||BRANCH;
 const api="https://api.github.com/repos/"+repo+"/contents/"+path.split("/").map(encodeURIComponent).join("/");
 let sha;const old=await gh(api+"?ref="+encodeURIComponent(branch),{method:"GET"},t);
 if(old.ok)sha=(await old.json()).sha;else if(old.status!==404)return json({error:"Mevcut dosya kontrol edilemedi."},502);
 const body={message:"Admin: görsel güncelle — "+path.split("/").pop(),content:b64(await file.arrayBuffer()),branch};if(sha)body.sha=sha;
 const saved=await gh(api,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)},t),d=await saved.json().catch(()=>({}));
 if(!saved.ok)return json({error:d.message||"GitHub'a kaydedilemedi."},502);
 return json({ok:true,path,sha:d.content?.sha||null,url:"/assets/images/"+path.split("/").pop()});
}