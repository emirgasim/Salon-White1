const REPO = "emirgasim/Salon-White1";
const BRANCH = "main";
const MAX = 12 * 1024 * 1024;
const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {"content-type":"application/json;charset=UTF-8","cache-control":"no-store"}
});

// Admin intentionally uses passwordless access. GitHub authorization stays server-side in the Cloudflare secret.
const auth = () => true;

const githubToken = (env) => env.GITHUB_TOKEN || env.GITHUB_PAT || env.GH_TOKEN || env.GITHUB_ADMIN_TOKEN || null;
const githubTokenSource = (env) => env.GITHUB_TOKEN ? "GITHUB_TOKEN" : env.GITHUB_PAT ? "GITHUB_PAT" : env.GH_TOKEN ? "GH_TOKEN" : env.GITHUB_ADMIN_TOKEN ? "GITHUB_ADMIN_TOKEN" : null;

const ext = (name) => (String(name).split(".").pop() || "").toLowerCase();

const cleanPath = (value) => {
  let p = String(value || "").trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (!p.startsWith("assets/images/")) p = "assets/images/" + p;
  if (p.includes("..") || !p.startsWith("assets/images/") || p.length > 180 || !/^[A-Za-z0-9._\/-]+$/.test(p)) return null;
  return p;
};

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(out);
}

async function github(url, options, token) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Salon-White-Admin",
      ...(options?.headers || {})
    }
  });
}

async function images(request, env) {
  if (!auth(request, env)) return json({error:"Yetkisiz erişim."},401);
  const token = githubToken(env);
  if (!token) return json({error:"GitHub token bulunamadı. Cloudflare Worker secret adı GITHUB_TOKEN olmalı (alternatif: GITHUB_PAT, GH_TOKEN, GITHUB_ADMIN_TOKEN)."},500);
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const response = await github("https://api.github.com/repos/"+repo+"/contents/assets/images?ref="+encodeURIComponent(branch)+"&v="+Date.now(), {method:"GET",headers:{"Cache-Control":"no-cache"}}, token);
  if (!response.ok) {
    const detail = await response.json().catch(()=>({}));
    return json({error:"Görsel listesi alınamadı.",githubStatus:response.status,githubMessage:detail.message||null},502);
  }
  const data = await response.json();
  const files = Array.isArray(data) ? data.filter(x=>x.type==="file" && /\.(jpe?g|png|webp|avif)$/i.test(x.name)).map(x=>({name:x.name,sha:x.sha||null,url:"/assets/images/"+encodeURIComponent(x.name)+"?v="+encodeURIComponent(x.sha||Date.now())})) : [];
  return json({files});
}

async function liveImage(request, env) {
  if (!auth(request, env)) return new Response("Yetkisiz erişim.",{status:401});
  const token = githubToken(env);
  if (!token) return null;
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const url = new URL(request.url);
  const path = cleanPath(decodeURIComponent(url.pathname));
  if (!path || !ALLOWED.has(ext(path))) return null;
  // Görseli GitHub Contents API'den oku. raw.githubusercontent.com CDN'i yerine
  // doğrudan main branch'teki güncel blob okunur; böylece yüklenen yeni fotoğrafın
  // eski CDN kopyasının geri gelmesi engellenir.
  const apiUrl = "https://api.github.com/repos/"+repo+"/contents/"+path.split("/").map(encodeURIComponent).join("/")+"?ref="+encodeURIComponent(branch)+"&v="+Date.now();
  const response = await github(apiUrl, {
    method:"GET",
    headers:{
      "Cache-Control":"no-cache, no-store",
      "Pragma":"no-cache"
    }
  }, token);
  if (!response.ok) return null;
  const data = await response.json().catch(()=>null);
  if (!data?.content || data.encoding !== "base64") return null;
  const clean = String(data.content).replace(/\s/g,"");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  const headers = new Headers({
    "content-type": "image/png",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    "pragma": "no-cache",
    "expires": "0",
    "x-salon-image-source": "github-contents-main-live",
    "x-salon-image-sha": data.sha || ""
  });
  return new Response(bytes,{status:200,headers});
}
async function upload(request, env) {
  if (!auth(request, env)) return json({error:"Yetkisiz erişim."},401);
  const token = githubToken(env);
  if (!token) return json({error:"GitHub token bulunamadı. Cloudflare Worker secret adı GITHUB_TOKEN olmalı (alternatif: GITHUB_PAT, GH_TOKEN, GITHUB_ADMIN_TOKEN)."},500);
  const form = await request.formData();
  const file = form.get("file");
  const path = cleanPath(form.get("path"));
  if (!(file instanceof File) || !path) return json({error:"Dosya veya hedef yol eksik."},400);
  if (file.size > MAX) return json({error:"Dosya 12 MB sınırını aşıyor."},413);
  if (ext(path) !== "png") return json({error:"Yalnızca PNG görseller kabul edilir. Admin paneli yüklenen görseli otomatik olarak PNG'ye dönüştürür."},415);
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const api = "https://api.github.com/repos/"+repo+"/contents/"+path.split("/").map(encodeURIComponent).join("/");
  let sha;
  const existing = await github(api+"?ref="+encodeURIComponent(branch), {method:"GET"}, token);
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) {
    const detail = await existing.json().catch(()=>({}));
    return json({error:"Mevcut dosya kontrol edilemedi.",githubStatus:existing.status,githubMessage:detail.message||null},502);
  }
  const body = {message:"Admin: görsel güncelle — "+path.split("/").pop(),content:toBase64(await file.arrayBuffer()),branch};
  if (sha) body.sha = sha;
  const saved = await github(api,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)},token);
  const result = await saved.json().catch(()=>({}));
  if (!saved.ok) return json({error:result.message||"GitHub'a kaydedilemedi."},502);
  return json({ok:true,path,sha:result.content?.sha||null,url:"/assets/images/"+path.split("/").pop()});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ok:true, githubTokenConfigured:Boolean(githubToken(env)), githubTokenSource:githubTokenSource(env), repository:env.GITHUB_REPO || REPO, branch:env.GITHUB_BRANCH || BRANCH});
    }
    if (url.pathname === "/api/images" && request.method === "GET") return images(request, env);
    if (url.pathname === "/api/upload" && request.method === "POST") return upload(request, env);
    if (request.method === "GET" && url.pathname.startsWith("/assets/images/")) {
      const imageResponse = await liveImage(request, env);
      if (imageResponse) return imageResponse;
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin.html") {
      if (!env.ASSETS) return new Response("ASSETS binding bulunamadı.", {status:503});
      const adminUrl = new URL("/admin-panel.html", url);
      const adminRequest = new Request(adminUrl, {method:"GET", headers:request.headers});
      return env.ASSETS.fetch(adminRequest);
    }
    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      const contentType = assetResponse.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        const headers = new Headers(assetResponse.headers);
        headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
        headers.set("pragma", "no-cache");
        headers.set("expires", "0");
        return new Response(assetResponse.body, {status: assetResponse.status, statusText: assetResponse.statusText, headers});
      }
      return assetResponse;
    }
    return new Response("Salon White Worker hazır. ASSETS binding bulunamadı.",{status:503,headers:{"content-type":"text/plain;charset=UTF-8"}});
  }
};
