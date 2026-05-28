const DATA_KEY = "aflselector:data";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-AFL-Write-Key",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(env),
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function normalizeData(data) {
  const candidate = data && typeof data === "object" && data.record ? data.record : data;
  if (!candidate || typeof candidate !== "object" || !candidate.boards || typeof candidate.boards !== "object") {
    return null;
  }
  return candidate;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (!env.AFL_DATA) {
      return jsonResponse({ error: "Missing AFL_DATA KV binding" }, env, 500);
    }

    if (request.method === "GET") {
      const saved = await env.AFL_DATA.get(DATA_KEY, "json");
      return jsonResponse(saved || { boards: {} }, env);
    }

    if (request.method === "PUT") {
      if (env.WRITE_KEY) {
        const suppliedKey = request.headers.get("X-AFL-Write-Key") || "";
        if (suppliedKey !== env.WRITE_KEY) {
          return jsonResponse({ error: "Forbidden" }, env, 403);
        }
      }

      const text = await request.text();
      if (text.length > 1_000_000) {
        return jsonResponse({ error: "Payload too large" }, env, 413);
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return jsonResponse({ error: "Invalid JSON" }, env, 400);
      }

      const normalized = normalizeData(data);
      if (!normalized) {
        return jsonResponse({ error: "Expected { boards: ... } or { record: { boards: ... } }" }, env, 400);
      }

      await env.AFL_DATA.put(DATA_KEY, JSON.stringify(normalized));
      return jsonResponse({ ok: true }, env);
    }

    return jsonResponse({ error: "Method not allowed" }, env, 405);
  }
};
