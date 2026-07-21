const DATA_KEY = "aflselector:data";
const INDEX_KEY = "aflselector:index";
const BOARD_KEY_PREFIX = "aflselector:board:";
const PLAYHQ_API = "https://api.playhq.com/graphql";
// Version the cache whenever eligibility maths changes so an older weekly
// snapshot cannot survive a rules update.
const ELIGIBILITY_CACHE_KEY = "aflselector:eligibility:2026:v2";
const SYDNEY_TIME_ZONE = "Australia/Sydney";

// UNSW-ES Bulldogs — 2026 men's teams, ordered from highest to lowest grade.
// These IDs mirror the working SquadLogic configuration.
const ELIGIBILITY_TEAMS = [
  { shortName: "MPD", name: "Premier", teamId: "ca7314b3", rank: 0 },
  { shortName: "MD1", name: "Div 1", teamId: "a134dc97", rank: 1 },
  { shortName: "MD3", name: "Div 3", teamId: "6e4750a5", rank: 2 },
  { shortName: "MD5", name: "Div 5", teamId: "389dd281", rank: 3 }
];

const PLAYER_FRAGMENT = `
  ... on DiscoverParticipant { id profile { firstName lastName } }
  ... on DiscoverRegularFillInPlayer { id name }
  ... on DiscoverParticipantFillInPlayer { id profile { firstName lastName } }
  ... on DiscoverAnonymousParticipant { id }
  ... on DiscoverGamePermitFillInPlayer { id profile { firstName lastName } }
`;

const FIXTURE_QUERY = `
  query TeamFixture($teamId: ID!) {
    discoverTeamFixture(teamID: $teamId) {
      name
      games {
        id
        status { value }
        home { ... on DiscoverTeam { id } }
        away { ... on DiscoverTeam { id } }
        result {
          home { outcome { value } }
          away { outcome { value } }
        }
      }
    }
  }`;

const GAME_STATS_QUERY = `
  query GameStats($gameId: ID!) {
    discoverGame(gameID: $gameId) {
      date
      statistics {
        home { players { player { ${PLAYER_FRAGMENT} } } }
        away { players { player { ${PLAYER_FRAGMENT} } } }
      }
    }
  }`;

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

async function playHqQuery(query, variables) {
  const response = await fetch(PLAYHQ_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "tenant": "afl",
      "User-Agent": "Mozilla/5.0 (compatible; AFLSelector/1.0)",
      "Origin": "https://www.playhq.com",
      "Referer": "https://www.playhq.com/"
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) throw new Error(`PlayHQ returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || "PlayHQ query failed");
  return payload.data;
}

function playerName(player) {
  if (player?.profile?.firstName) {
    return `${player.profile.firstName} ${player.profile.lastName || ""}`.trim();
  }
  return player?.name?.trim() || null;
}

function playerKey(player, name) {
  return name
    ? name.toLocaleLowerCase("en-AU").replace(/[^a-z0-9]/g, "")
    : player.id;
}

function weekId(dateString, fallback) {
  if (!dateString) return fallback;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return fallback;
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day + (day === 0 ? -6 : 1));
  return date.toISOString().slice(0, 10);
}

function teamForfeited(game, side) {
  return game?.result?.[side]?.outcome?.value === "LOST_BY_FORFEIT";
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function nextSundayEvening(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23"
  });
  const cursor = new Date(now);
  cursor.setUTCMinutes(0, 0, 0);
  if (cursor <= now) cursor.setUTCHours(cursor.getUTCHours() + 1);

  // Sydney's UTC offset changes with daylight saving, so walk actual UTC hours
  // until the next local Sunday at 6 pm instead of assuming a fixed offset.
  for (let i = 0; i < 24 * 8; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(cursor).map(part => [part.type, part.value]));
    if (parts.weekday === "Sun" && Number(parts.hour) === 18) return cursor;
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  throw new Error("Could not calculate the next Sunday refresh time");
}

function calculateFinalsEligibility(games) {
  const result = {};
  ELIGIBILITY_TEAMS.forEach((team, index) => {
    if (team.shortName !== "MD3" && team.shortName !== "MD5") return;
    const higherGames = ELIGIBILITY_TEAMS
      .slice(0, index)
      .reduce((sum, higherTeam) => sum + (games[higherTeam.shortName] || 0), 0);
    const qualifyingGames = ELIGIBILITY_TEAMS
      .slice(index)
      .reduce((sum, qualifyingTeam) => sum + (games[qualifyingTeam.shortName] || 0), 0);

    let state = "building";
    if (higherGames >= 7) state = "locked";
    else if (higherGames === 6) state = "risk";
    else if (qualifyingGames >= 6) state = "qualified";
    else if (qualifyingGames === 0) state = "no-games";

    result[team.shortName] = {
      state,
      higherGames,
      qualifyingGames,
      gamesToQualify: Math.max(0, 6 - qualifyingGames)
    };
  });
  return result;
}

async function buildEligibilityPayload() {
  let forfeitedGamesExcluded = 0;
  const fixtureSets = await Promise.all(ELIGIBILITY_TEAMS.map(async team => {
    const fixtureData = await playHqQuery(FIXTURE_QUERY, { teamId: team.teamId });
    const rounds = fixtureData?.discoverTeamFixture || [];
    const games = [];
    rounds.forEach((round, roundIndex) => {
      // Finals and other special fixtures can appear in the same feed once played.
      // Only numbered home-and-away rounds contribute to the six/seven-game rules.
      if (round.name && !/^Round\s+\d+$/i.test(round.name.trim())) return;
      (round.games || []).forEach(game => {
        if (game.status?.value !== "FINAL") return;
        const side = game.home?.id === team.teamId
          ? "home"
          : game.away?.id === team.teamId ? "away" : null;
        if (!side) return;

        // A listed team sheet does not make an appearance eligible when UNSW
        // was the forfeiting side. If the opponent forfeited, UNSW's submitted
        // team sheet remains eligible and is processed normally.
        if (teamForfeited(game, side)) {
          forfeitedGamesExcluded += 1;
          return;
        }

        games.push({ gameId: game.id, side, team, fallbackWeek: `round-${roundIndex}` });
      });
    });
    return games;
  }));

  const appearancesByPlayer = new Map();
  const completedGames = fixtureSets.flat();
  await mapWithConcurrency(completedGames, 8, async game => {
    const gameData = await playHqQuery(GAME_STATS_QUERY, { gameId: game.gameId });
    const match = gameData?.discoverGame;
    const players = match?.statistics?.[game.side]?.players || [];
    const matchWeek = weekId(match?.date, game.fallbackWeek);

    players.forEach(entry => {
      let player = entry.player;
      if (player?.participant) player = player.participant;
      if (!player?.id) return;
      const name = playerName(player);
      if (!name) return;
      const key = playerKey(player, name);
      if (!appearancesByPlayer.has(key)) {
        appearancesByPlayer.set(key, { id: player.id, name, appearances: [] });
      }
      appearancesByPlayer.get(key).appearances.push({
        weekId: matchWeek,
        shortName: game.team.shortName,
        rank: game.team.rank
      });
    });
  });

  const players = [...appearancesByPlayer.values()].map(player => {
    const byWeek = new Map();
    player.appearances.forEach(appearance => {
      if (!byWeek.has(appearance.weekId)) byWeek.set(appearance.weekId, []);
      byWeek.get(appearance.weekId).push(appearance);
    });

    const games = Object.fromEntries(ELIGIBILITY_TEAMS.map(team => [team.shortName, 0]));
    let discounted = 0;
    [...byWeek.values()].forEach(week => {
      // Same-week double-ups count once, in the highest senior grade played.
      week.sort((a, b) => a.rank - b.rank);
      games[week[0].shortName] += 1;
      discounted += Math.max(0, week.length - 1);
    });

    return {
      id: player.id,
      name: player.name,
      games,
      eligibility: calculateFinalsEligibility(games),
      qualifyingTotal: Object.values(games).reduce((sum, count) => sum + count, 0),
      discounted
    };
  })
    .filter(player => (player.games.MD3 || 0) > 0 || (player.games.MD5 || 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));

  return {
    club: "UNSW-ES Bulldogs",
    season: 2026,
    generatedAt: new Date().toISOString(),
    forfeitedGamesExcluded,
    teams: ELIGIBILITY_TEAMS.map(({ shortName, name }) => ({ shortName, name })),
    players
  };
}

async function handleEligibility(request, env) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, env, 405);
  }

  if (!hasKvBinding(env)) {
    return jsonResponse({ error: "AFL_DATA KV is required for the weekly eligibility cache" }, env, 500);
  }

  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  const now = new Date();
  const cached = await getJsonValue(env, ELIGIBILITY_CACHE_KEY);
  const cacheIsFresh = cached && !cached.__invalidJson && cached.payload &&
    new Date(cached.cacheUntil).getTime() > now.getTime();

  if (cacheIsFresh) {
    const secondsRemaining = Math.max(60, Math.floor((new Date(cached.cacheUntil).getTime() - now.getTime()) / 1000));
    const response = jsonResponse(cached.payload, env);
    response.headers.set("Cache-Control", `public, max-age=${secondsRemaining}`);
    return response;
  }

  if (!forceRefresh) {
    return jsonResponse({
      error: "Weekly PlayHQ refresh required",
      refreshRequired: true,
      refreshWindow: "Sunday 6:00 pm Australia/Sydney"
    }, env, 409);
  }

  try {
    const payload = await buildEligibilityPayload();
    const cacheUntil = nextSundayEvening(now);
    payload.refreshedAt = now.toISOString();
    payload.cacheUntil = cacheUntil.toISOString();
    await env.AFL_DATA.put(ELIGIBILITY_CACHE_KEY, JSON.stringify({
      payload,
      cacheUntil: payload.cacheUntil
    }), {
      expirationTtl: Math.max(60, Math.ceil((cacheUntil.getTime() - now.getTime()) / 1000))
    });
    const response = jsonResponse(payload, env);
    response.headers.set("Cache-Control", `public, max-age=${Math.max(60, Math.floor((cacheUntil.getTime() - now.getTime()) / 1000))}`);
    return response;
  } catch (error) {
    return jsonResponse({ error: "Could not load PlayHQ eligibility data", detail: error.message }, env, 502);
  }
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

function compareBoardMeta(a, b) {
  const nameCompare = (a.name || "").localeCompare(b.name || "", undefined, {
    numeric: true,
    sensitivity: "base"
  });
  return nameCompare || (a.id || "").localeCompare(b.id || "");
}

function makeIndex(data) {
  return Object.entries(data.boards)
    .map(([id, board]) => ({
      id,
      name: typeof board?.name === "string" ? board.name : "Untitled"
    }))
    .sort(compareBoardMeta);
}

async function readFullData(env) {
  const index = await getJsonValue(env, INDEX_KEY);
  if (index && index.__invalidJson) {
    return { error: `Invalid JSON in KV key ${INDEX_KEY}: ${index.message}`, boards: {} };
  }

  if (Array.isArray(index)) {
    const boards = {};
    const orderedIndex = [...index].sort(compareBoardMeta);
    const loadedBoards = await Promise.all(orderedIndex.map(async ({ id, name }) => {
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

    const url = new URL(request.url);
    if (url.pathname === "/eligibility") {
      return handleEligibility(request, env);
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
