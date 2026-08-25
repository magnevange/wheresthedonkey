// Where's the Donkey: API worker.
// Routes /api/* and /img/*, hands everything else to the static assets.

const PREFIX = "photos/";
const MAX_BYTES = 12 * 1024 * 1024;
const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const toPhoto = (obj) => {
  const m = obj.customMetadata || {};
  return {
    id: m.id || obj.key.slice(PREFIX.length).replace(/\.[^.]+$/, ""),
    url: "/img/" + obj.key,
    w: Number(m.w) || null,
    h: Number(m.h) || null,
    color: m.color || null,
    caption: m.caption || "",
    createdAt: Number(m.createdAt) || Date.parse(obj.uploaded) || 0
  };
};

async function listPhotos(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.PHOTOS.list({
      prefix: PREFIX,
      limit: 1000,
      cursor,
      include: ["customMetadata"]
    });
    out.push(...page.objects.map(toPhoto));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

async function addPhoto(request, env) {
  // Optional write lock: set LOCK_UPLOADS=true and ADMIN_TOKEN to make the log read-only.
  if (env.LOCK_UPLOADS === "true") {
    if (!env.ADMIN_TOKEN || request.headers.get("x-donkey-key") !== env.ADMIN_TOKEN) {
      return json({ error: "Uploads are locked on this log." }, 401);
    }
  }

  let form;
  try { form = await request.formData(); }
  catch { return json({ error: "Could not read the upload." }, 400); }

  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "No file in the upload." }, 400);
  if (file.size > MAX_BYTES) return json({ error: "That file is too large." }, 413);
  if (!EXT[file.type]) return json({ error: "Only image files can be added." }, 415);

  const id = crypto.randomUUID();
  const key = `${PREFIX}${id}.${EXT[file.type]}`;
  const createdAt = String(Date.now());
  const caption = String(form.get("caption") || "").slice(0, 140);

  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: {
      id,
      createdAt,
      caption,
      w: String(form.get("w") || ""),
      h: String(form.get("h") || ""),
      color: String(form.get("color") || "")
    }
  });

  return json({
    id,
    url: "/img/" + key,
    w: Number(form.get("w")) || null,
    h: Number(form.get("h")) || null,
    color: String(form.get("color") || "") || null,
    caption,
    createdAt: Number(createdAt)
  }, 201);
}

async function removePhoto(rawId, request, env) {
  // If ADMIN_TOKEN is set, removal needs the key. If it is unset, anyone can remove.
  if (env.ADMIN_TOKEN && request.headers.get("x-donkey-key") !== env.ADMIN_TOKEN) {
    return json({ error: "Wrong key." }, 401);
  }
  const id = String(rawId || "").replace(/[^a-zA-Z0-9-]/g, "");
  if (!id) return json({ error: "No photo id." }, 400);

  const page = await env.PHOTOS.list({ prefix: PREFIX + id, limit: 5 });
  if (!page.objects.length) return json({ error: "No photo with that id." }, 404);

  await env.PHOTOS.delete(page.objects.map((o) => o.key));
  return json({ ok: true, id });
}

async function serveImage(key, request, env) {
  if (!key.startsWith(PREFIX) || key.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  if (request.headers.get("if-none-match") === obj.httpEtag) {
    return new Response(null, { status: 304, headers: { etag: obj.httpEtag } });
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const api = path === "/api/photos" || path.startsWith("/api/photos/");
    const img = path.startsWith("/img/");

    if (!api && !img) return env.ASSETS.fetch(request);

    if (!env.PHOTOS) {
      // No bucket bound yet. Report it honestly so the site falls back to device-only mode.
      return json({ error: "No R2 bucket bound as PHOTOS." }, 503);
    }

    try {
      if (img) return await serveImage(decodeURIComponent(path.slice("/img/".length)), request, env);

      if (path === "/api/photos") {
        if (request.method === "GET") return json(await listPhotos(env));
        if (request.method === "POST") return await addPhoto(request, env);
        return json({ error: "Method not allowed." }, 405);
      }

      const id = decodeURIComponent(path.slice("/api/photos/".length));
      if (request.method === "DELETE") return await removePhoto(id, request, env);
      return json({ error: "Method not allowed." }, 405);
    } catch (err) {
      return json({ error: "Something broke on the server.", detail: String(err && err.message) }, 500);
    }
  }
};
