const DATA_KEY = "aflselector:data";
const INDEX_KEY = "aflselector:index";
const BOARD_KEY_PREFIX = "aflselector:board:";

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

function hasKvBinding(env) {
  return !!env.AFL_DATA && typeof env.AFL_DATA.get === "function" && typeof env.AFL_DATA.put === "function";
}

async function getJsonValue(env, key) {
  const text = await env.AFL_DATA.get(key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return { __invalidJson: true, key, message: e.message };
  }
}

function normalizeBoard(data) {
  if (!data || typeof data !== "object" || typeof data.name !== "string") return null;
  return {
    name: data.name,
    roster: data.roster && typeof data.roster === "object" ? data.roster : {},
    inventory: data.inventory && typeof data.inventory === "object" ? data.inventory : {}
  };
}

function makeIndex(data) {
  return Object.entries(data.boards).map(([id, board]) => ({
    id,
    name: typeof board?.name === "string" ? board.name : "Untitled"
  }));
}

async function readFullData(env) {
  const index = await getJsonValue(env, INDEX_KEY);
  if (index && index.__invalidJson) {
    return { error: `Invalid JSON in KV key ${INDEX_KEY}: ${index.message}`, boards: {} };
  }

  if (Array.isArray(index)) {
    const boards = {};
    const loadedBoards = await Promise.all(index.map(async ({ id, name }) => {
      const board = await getJsonValue(env, BOARD_KEY_PREFIX + id);
      return [id, normalizeBoard(board) || { name: name || "Untitled", roster: {}, inventory: {} }];
    }));
    loadedBoards.forEach(([id, board]) => {
      boards[id] = board;
    });
    return { boards };
  }

  const saved = await getJsonValue(env, DATA_KEY);
  if (saved && saved.__invalidJson) {
    return { error: `Invalid JSON in KV key ${DATA_KEY}: ${saved.message}`, boards: {} };
  }

  return normalizeData(saved) || { boards: {} };
}

async function writeFullData(env, data) {
  const index = makeIndex(data);
  await Promise.all([
    env.AFL_DATA.put(INDEX_KEY, JSON.stringify(index)),
    env.AFL_DATA.put(DATA_KEY, JSON.stringify(data)),
    ...Object.entries(data.boards).map(([id, board]) =>
      env.AFL_DATA.put(BOARD_KEY_PREFIX + id, JSON.stringify(normalizeBoard(board) || {
        name: "Untitled",
        roster: {},
        inventory: {}
      }))
    )
  ]);
}

async function writeBoard(env, id, board) {
  const current = await readFullData(env);
  current.boards[id] = board;
  const existingIndex = await getJsonValue(env, INDEX_KEY);
  if (!Array.isArray(existingIndex)) {
    await writeFullData(env, current);
    return;
  }
  const index = makeIndex(current);
  const existingEntry = Array.isArray(existingIndex) && existingIndex.find(entry => entry.id === id);
  const indexChanged = !existingEntry || existingEntry.name !== board.name || existingIndex.length !== index.length;
  const writes = [env.AFL_DATA.put(BOARD_KEY_PREFIX + id, JSON.stringify(board))];
  if (indexChanged) writes.push(env.AFL_DATA.put(INDEX_KEY, JSON.stringify(index)));
  await Promise.all(writes);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (!hasKvBinding(env)) {
      return jsonResponse({
        error: "AFL_DATA must be a KV namespace binding, not a text variable or secret"
      }, env, 500);
    }

    if (request.method === "GET") {
      return jsonResponse(await readFullData(env), env);
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

      const url = new URL(request.url);
      const boardId = url.searchParams.get("board");
      if (boardId) {
        const board = normalizeBoard(data.board || data);
        if (!board) {
          return jsonResponse({ error: "Expected board data" }, env, 400);
        }
        await writeBoard(env, boardId, board);
        return jsonResponse({ ok: true, mode: "board" }, env);
      }

      const normalized = normalizeData(data);
      if (!normalized) {
        return jsonResponse({ error: "Expected { boards: ... } or { record: { boards: ... } }" }, env, 400);
      }

      await writeFullData(env, normalized);
      return jsonResponse({ ok: true, mode: "full" }, env);
    }

    return jsonResponse({ error: "Method not allowed" }, env, 405);
  }
};
