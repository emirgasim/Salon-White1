const REPO = "emirgasim/Salon-White1";
const BRANCH = "main";
const MAX = 12 * 1024 * 1024;
const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {"content-type":"application/json;charset=UTF-8","cache-control":"no-store"}
});

const auth = (request, env) => {
  const expected = env.ADMIN_PASSWORD;
  const supplied = request.headers.get("X-Admin-Password");
  return Boolean(expected && supplied && supplied === expected);
};

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
      ...(options?.headers || {})
    }
  });
}

async function images(request, env) {
  if (!auth(request, env)) return json({error:"Yetkisiz erişim."},401);
  const token = env.GITHUB_TOKEN;
  if (!token) return json({error:"GITHUB_TOKEN Cloudflare secret olarak tanımlanmamış."},500);
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const response = await github("https://api.github.com/repos/"+repo+"/contents/assets/images?ref="+encodeURIComponent(branch), {method:"GET"}, token);
  if (!response.ok) return json({error:"Görsel listesi alınamadı."},502);
  const data = await response.json();
  const files = Array.isArray(data) ? data.filter(x=>x.type==="file" && /\.(jpe?g|png|webp|avif)$/i.test(x.name)).map(x=>({name:x.name,url:x.download_url||x.html_url})) : [];
  return json({files});
}

async function upload(request, env) {
  if (!auth(request, env)) return json({error:"Yetkisiz erişim."},401);
  const token = env.GITHUB_TOKEN;
  if (!token) return json({error:"GITHUB_TOKEN Cloudflare secret olarak tanımlanmamış."},500);
  const form = await request.formData();
  const file = form.get("file");
  const path = cleanPath(form.get("path"));
  if (!(file instanceof File) || !path) return json({error:"Dosya veya hedef yol eksik."},400);
  if (file.size > MAX) return json({error:"Dosya 12 MB sınırını aşıyor."},413);
  if (!ALLOWED.has(ext(path))) return json({error:"Desteklenmeyen görsel formatı."},415);
  const repo = env.GITHUB_REPO || REPO;
  const branch = env.GITHUB_BRANCH || BRANCH;
  const api = "https://api.github.com/repos/"+repo+"/contents/"+path.split("/").map(encodeURIComponent).join("/");
  let sha;
  const existing = await github(api+"?ref="+encodeURIComponent(branch), {method:"GET"}, token);
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) return json({error:"Mevcut dosya kontrol edilemedi."},502);
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
    if (url.pathname === "/api/images" && request.method === "GET") return images(request, env);
    if (url.pathname === "/api/upload" && request.method === "POST") return upload(request, env);
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return env.ASSETS ? env.ASSETS.fetch(new Request(new URL("/admin.html", url), request)) : new Response("ASSETS binding bulunamadı.", {status:503});
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
