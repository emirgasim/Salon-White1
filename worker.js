const REPO = "emirgasim/Salon-White1";
const BRANCH = "main";
const MAX = 12 * 1024 * 1024;
const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {"content-type":"application/json;charset=UTF-8","cache-control":"no-store"}
});

// Admin API is protected with HTTP Basic Auth. Credentials are kept only in
// Cloudflare Worker secrets (ADMIN_USER / ADMIN_PASSWORD); never in the repo.
const auth = (request, env) => {
  const expectedUser = env.ADMIN_USER || "admin";
  const expectedPassword = env.ADMIN_PASSWORD || "";
  if (!expectedPassword) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const split = decoded.indexOf(":");
    if (split < 0) return false;
    return decoded.slice(0, split) === expectedUser && decoded.slice(split + 1) === expectedPassword;
  } catch { return false; }
};
const authRequired = () => json({error:"Admin authentication required.",code:"ADMIN_AUTH_REQUIRED"},401);

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
  if (!auth(request, env)) return authRequired();
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
  if (!auth(request, env)) return new Response("Admin authentication required.",{status:401,headers:{"WWW-Authenticate":'Basic realm="Salon White Admin"', "content-type":"text/plain;charset=UTF-8"}});
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
  let data = await response.json().catch(()=>null);
  // GitHub Contents API may omit base64 content for larger binary files.
  // In that case read the exact Git blob by SHA so gallery images load reliably.
  if (!data?.content || data.encoding !== "base64") {
    if (!data?.sha) return null;
    const blobUrl = "https://api.github.com/repos/"+repo+"/git/blobs/"+encodeURIComponent(data.sha)+"?v="+Date.now();
    const blobResponse = await github(blobUrl, {
      method:"GET",
      headers:{
        "Cache-Control":"no-cache, no-store",
        "Pragma":"no-cache"
      }
    }, token);
    if (!blobResponse.ok) return null;
    data = await blobResponse.json().catch(()=>null);
  }
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
async function readRepoJson(env, path) {
  const token = githubToken(env);
  if (!token) return null;
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const api = "https://api.github.com/repos/"+repo+"/contents/"+path.split("/").map(encodeURIComponent).join("/")+"?ref="+encodeURIComponent(branch)+"&v="+Date.now();
  const response = await github(api,{method:"GET",headers:{"Cache-Control":"no-cache, no-store"}},token);
  if (!response.ok) return null;
  const data = await response.json().catch(()=>null);
  if (!data?.content || data.encoding !== "base64") return null;
  try {
    const text = atob(String(data.content).replace(/\s/g,""));
    return {value:JSON.parse(text),sha:data.sha||null};
  } catch { return null; }
}

async function reels(request, env) {
  const path = "data/instagram-reels.json";
  if (request.method === "GET") {
    const data = await readRepoJson(env,path);
    return json({reels:Array.isArray(data?.value)?data.value:[]});
  }
  if (!auth(request, env)) return authRequired();
  const token = githubToken(env);
  if (!token) return json({error:"GitHub token bulunamadı."},500);
  let payload;
  try { payload = await request.json(); } catch { return json({error:"Geçersiz JSON."},400); }
  const incoming = Array.isArray(payload?.reels) ? payload.reels : [];
  if (incoming.length !== 5) return json({error:"Tam olarak 5 Reel bağlantısı gönderilmelidir."},400);
  const reels = incoming.map((x,i)=>({id:String(i+1).padStart(2,"0"),url:String(x?.url||"").trim(),title:String(x?.title||("Instagram Reel "+(i+1))).trim()}));
  if (reels.some(x=>!/^https:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+/i.test(x.url))) return json({error:"Geçerli Instagram Reel bağlantısı girin."},400);
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const api = "https://api.github.com/repos/"+repo+"/contents/"+path.split("/").map(encodeURIComponent).join("/");
  const existing = await github(api+"?ref="+encodeURIComponent(branch),{method:"GET"},token);
  if (!existing.ok && existing.status !== 404) return json({error:"Mevcut Reel ayarı okunamadı."},502);
  const existingData = existing.ok ? await existing.json().catch(()=>null) : null;
  const body = {message:"Admin: Instagram Reels bağlantıları güncellendi",content:toBase64(new TextEncoder().encode(JSON.stringify(reels,null,2)+"\n").buffer),branch};
  if (existingData?.sha) body.sha=existingData.sha;
  const saved = await github(api,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)},token);
  const result = await saved.json().catch(()=>({}));
  if (!saved.ok) return json({error:result.message||"Reel bağlantıları kaydedilemedi."},502);
  return json({ok:true,reels});
}

async function reelCover(request, env) {
  const reelUrl = new URL(request.url).searchParams.get("url");
  if (!reelUrl || !/^https:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+/i.test(reelUrl)) {
    return json({error:"Geçerli Instagram Reel URL'si gerekli."},400);
  }

  const fallback = async () => {
    try {
      const fallbackUrl = new URL("/assets/images/admin-slider-03-collage.png", request.url);
      const response = await fetch(fallbackUrl.toString(), {headers:{"Accept":"image/avif,image/webp,image/png,image/*"}});
      if (response.ok) {
        const headers = new Headers(response.headers);
        headers.set("cache-control","public, max-age=300");
        return new Response(response.body,{status:200,headers});
      }
    } catch {}
    return new Response(null,{status:404});
  };

  try {
    const response = await fetch(reelUrl,{
      headers:{
        "User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept":"text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language":"tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      redirect:"follow"
    });
    if (!response.ok) return fallback();

    const html = await response.text();
    const candidates = [];
    const add = value => {
      if (!value) return;
      let v = String(value).trim()
        .replace(/&amp;/g,"&")
        .replace(/\\u0026/g,"&")
        .replace(/\\u003D/g,"=")
        .replace(/\\\//g,"/");
      if (/^https?:\/\//i.test(v)) candidates.push(v);
    };

    const metaPatterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
    ];
    for (const re of metaPatterns) add(html.match(re)?.[1]);

    const dataPatterns = [
      /"display_url"\s*:\s*"([^"]+)"/i,
      /"thumbnail_src"\s*:\s*"([^"]+)"/i,
      /"image_url"\s*:\s*"([^"]+)"/i
    ];
    for (const re of dataPatterns) add(html.match(re)?.[1]);

    if (!candidates.length) return fallback();

    for (const imageUrl of candidates) {
      try {
        const imageResponse = await fetch(imageUrl,{
          headers:{
            "User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15",
            "Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer":"https://www.instagram.com/"
          },
          redirect:"follow"
        });
        if (!imageResponse.ok) continue;
        const contentType=imageResponse.headers.get("content-type")||"";
        if (!contentType.startsWith("image/")) continue;
        const headers=new Headers(imageResponse.headers);
        headers.set("cache-control","public, max-age=900, s-maxage=3600");
        headers.delete("set-cookie");
        return new Response(imageResponse.body,{status:200,headers});
      } catch {}
    }

    return fallback();
  } catch {
    return fallback();
  }
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
    if (url.pathname === "/api/reels" && (request.method === "GET" || request.method === "POST")) return reels(request, env);
    if (url.pathname === "/api/reel-cover" && request.method === "GET") return reelCover(request, env);
    if (url.pathname === "/api/upload" && request.method === "POST") return upload(request, env);
    if (request.method === "GET" && url.pathname.startsWith("/assets/images/")) {
      // Önce Cloudflare Assets/CDN: mevcut site görselleri GitHub API'ye gitmeden hızlıca sunulur.
      if (env.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.ok) {
          const headers = new Headers(assetResponse.headers);
          headers.set("cache-control","public, max-age=86400, s-maxage=604800");
          headers.set("x-salon-image-source","cloudflare-assets");
          return new Response(assetResponse.body,{status:assetResponse.status,statusText:assetResponse.statusText,headers});
        }
      }
      // Yalnızca deploy edilmiş Assets'ta bulunmayan yeni admin görsellerinde GitHub fallback.
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
