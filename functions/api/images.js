const REPO="emirgasim/Salon-White1",BRANCH="main";
const json=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json;charset=UTF-8","cache-control":"no-store"}});
const auth=c=>{const e=c.env.ADMIN_PASSWORD,g=c.request.headers.get("X-Admin-Password");return Boolean(e&&g&&g===e)};
export async function onRequestGet(c){
 if(!auth(c))return json({error:"Yetkisiz erişim."},401);
 const t=c.env.GITHUB_TOKEN;if(!t)return json({error:"GITHUB_TOKEN Cloudflare secret olarak tanımlanmamış."},500);
 const repo=c.env.GITHUB_REPO||REPO,branch=c.env.GITHUB_BRANCH||BRANCH;
 const u="https://api.github.com/repos/"+repo+"/contents/assets/images?ref="+encodeURIComponent(branch);
 const r=await fetch(u,{headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+t,"X-GitHub-Api-Version":"2022-11-28"}});
 if(!r.ok)return json({error:"Görsel listesi alınamadı."},502);
 const a=await r.json();
 return json({files:Array.isArray(a)?a.filter(x=>x.type==="file"&&/\.(jpe?g|png|webp|avif)$/i.test(x.name)).map(x=>({name:x.name,url:x.download_url||x.html_url})):[]});
}