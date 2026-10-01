"use strict";

/*
 * Python Quiz Arena - server
 * Node.js HTTP server (serves public/index.html) + WebSocket (ws) game server.
 * All scoring and validation happens here. No database, no external services.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000; // Render provides PORT
const HOST = "0.0.0.0";

const MAX_PLAYERS = 60;
const MAX_ROOMS = 200;
const QUESTION_SECONDS = 20;
const NAME_MAX = 24;
const CHAT_MAX = 250;
const COUNTDOWN_MS = 3500; // "get ready" before question 1
const INTERMISSION_MS = 2500; // pause between questions
const ANSWER_GRACE_MS = 400; // network latency allowance after the clock hits 0
const CHAT_HISTORY = 40;
const CHAT_MIN_GAP_MS = 500;

const INDEX_FILE = path.join(__dirname, "public", "index.html");

// ---------------------------------------------------------------------------
// Question bank (correct answers never leave the server until the quiz ends)
// type: "single" | "tf" | "multi"; correct = list of option indexes
// ---------------------------------------------------------------------------
const QUESTIONS = [
  {
    type: "single",
    text: "Who developed Python?",
    options: ["Guido van Rossum", "Dennis Ritchie", "James Gosling", "Bjarne Stroustrup"],
    correct: [0],
  },
  {
    type: "single",
    text: "Which is a valid Python variable name?",
    options: ["2name", "user-name", "total_score", "class"],
    correct: [2],
  },
  {
    type: "tf",
    text: "Python variable names are case-sensitive, so myVar and myvar are different names.",
    options: ["True", "False"],
    correct: [0],
  },
  {
    type: "single",
    text: "What is the output?",
    code: 'x = 10\nx = "Python"\nprint(x)',
    options: ["10", "Python", "10 Python", "Error"],
    correct: [1],
  },
  {
    type: "single",
    text: "Which data type represents a decimal value such as 5.0?",
    options: ["int", "float", "bool", "str"],
    correct: [1],
  },
  {
    type: "single",
    text: "What is the output?",
    code: "print(15 // 4)",
    options: ["3", "3.75", "4", "0"],
    correct: [0],
  },
  {
    type: "single",
    text: "Which collection is ordered and mutable?",
    options: ["Tuple", "Set", "List", "Boolean"],
    correct: [2],
  },
  {
    type: "multi",
    text: "Which of the following are Python numeric data types?",
    options: ["int", "float", "complex", "string"],
    correct: [0, 1, 2],
  },
  {
    type: "single",
    text: "What is the output?",
    code: "a = 10\nb = 4\nprint(a & b)",
    options: ["0", "14", "2", "40"],
    correct: [0],
  },
  {
    type: "single",
    text: "Which operator is used for exponentiation in Python?",
    options: ["//", "%", "**", "<<"],
    correct: [2],
  },
  {
    type: "tf",
    text: "Python's input() function returns user input as a string by default.",
    options: ["True", "False"],
    correct: [0],
  },
  {
    type: "single",
    text: "What is the output?",
    code: 'x, y, z = 1, 2.5, "Python"\nprint(y)',
    options: ["1", "2.5", "Python", "Error"],
    correct: [1],
  },
  {
    type: "single",
    text: "What is the output?",
    code: "s = [10, 20, 30]\ns.append(40)\nprint(s)",
    options: ["[10, 20, 30]", "[40, 10, 20, 30]", "[10, 20, 30, 40]", "40"],
    correct: [2],
  },
  {
    type: "single",
    text: "What is the output?",
    code: 'student = {"name": "Ravi", "age": 20}\nprint(student["name"])',
    options: ["student", "name", "Ravi", "20"],
    correct: [2],
  },
  {
    type: "single",
    text: "What is the output?",
    code: "x = True\ny = False\nprint(x and y)",
    options: ["True", "False", "1", "Error"],
    correct: [1],
  },
];

const TOTAL = QUESTIONS.length; // 15
const LETTERS = ["A", "B", "C", "D"];

// Question as sent to clients: never includes the correct answer.
function publicQuestion(index) {
  const q = QUESTIONS[index];
  return {
    index,
    total: TOTAL,
    type: q.type,
    text: q.text,
    code: q.code || null,
    options: q.options,
    duration: QUESTION_SECONDS,
  };
}

// Answer key, sent only after the quiz has finished.
function buildAnswerKey() {
  return QUESTIONS.map((q, i) => {
    let display;
    if (q.type === "multi") {
      const letters = q.correct.map((c) => LETTERS[c]).join(", ");
      const names = q.correct.map((c) => q.options[c]).join(", ");
      display = letters + " \u2014 " + names;
    } else {
      display = q.options[q.correct[0]];
    }
    return {
      n: i + 1,
      text: q.text,
      code: q.code || null,
      answer: display,
      letter: q.type === "single" ? LETTERS[q.correct[0]] : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Strip control / invisible characters, collapse whitespace, cap length (by code points).
// Clients render all user text with textContent, so no HTML can ever be injected.
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const s = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      /* socket is going away */
    }
  }
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

function makeRoomCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function uniqueName(room, base) {
  const taken = new Set();
  room.players.forEach((p) => taken.add(p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = " (" + n + ")";
    const candidate = Array.from(base).slice(0, NAME_MAX - suffix.length).join("") + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();

function createRoom(hostWs, hostName, code) {
  const room = {
    code,
    host: hostWs,
    hostName,
    players: new Map(), // id -> player
    nextId: 1,
    chatEnabled: true,
    chatLog: [],
    phase: "lobby", // lobby | countdown | question | between | ended
    qIndex: -1,
    qEndsAt: 0,
    startsAt: 0,
    timers: { question: null, next: null, board: null },
    closed: false,
  };
  rooms.set(code, room);
  return room;
}

function clearRoomTimers(room) {
  Object.keys(room.timers).forEach((k) => {
    if (room.timers[k]) clearTimeout(room.timers[k]);
    room.timers[k] = null;
  });
}

function closeRoom(room, message) {
  if (room.closed) return;
  room.closed = true;
  clearRoomTimers(room);
  rooms.delete(room.code);
  room.players.forEach((p) => {
    send(p.ws, { type: "roomClosed", message });
    p.ws.ctx = null;
    try {
      p.ws.close(1000, "room closed");
    } catch (e) {
      /* ignore */
    }
  });
  room.players.clear();
}

// Roster: names only (lobby) or just a count. Player clients never get scores.
function sendRoster(room) {
  const names = [];
  room.players.forEach((p) => names.push(p.name));
  const base = { type: "roster", count: room.players.size, max: MAX_PLAYERS };

  // Host: names (lobby list) - scores arrive separately in "board" messages.
  send(room.host, Object.assign({}, base, { names }));

  // Players: names only while waiting in the lobby, otherwise just the count.
  const playerMsg = room.phase === "lobby" ? Object.assign({}, base, { names }) : base;
  room.players.forEach((p) => send(p.ws, playerMsg));
}

function broadcast(room, obj) {
  send(room.host, obj);
  room.players.forEach((p) => send(p.ws, obj));
}

// Leaderboard rows (host only).
function leaderboardRows(room) {
  const rows = [];
  room.players.forEach((p) => rows.push({ name: p.name, score: p.score, answered: !!p.answers[room.qIndex] }));
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return rows;
}

function sendBoard(room) {
  if (room.closed) return;
  const rows = leaderboardRows(room);
  send(room.host, {
    type: "board",
    q: room.qIndex,
    rows,
    answered: room.phase === "question" || room.phase === "between" ? rows.filter((r) => r.answered).length : 0,
    total: rows.length,
  });
}

function scheduleBoard(room) {
  if (room.timers.board || room.closed) return;
  room.timers.board = setTimeout(() => {
    room.timers.board = null;
    sendBoard(room);
  }, 250);
}

// ---------------------------------------------------------------------------
// Quiz flow
// ---------------------------------------------------------------------------
function startQuiz(room) {
  room.phase = "countdown";
  const now = Date.now();
  room.startsAt = now + COUNTDOWN_MS;
  broadcast(room, { type: "starting", startsAt: room.startsAt, serverNow: now });
  sendBoard(room);
  room.timers.next = setTimeout(() => nextQuestion(room), COUNTDOWN_MS);
}

// Current question as sent to clients. endsAt is the absolute server deadline and
// serverNow lets each client compute the exact remaining time (also for late joiners).
function questionMessage(room) {
  return Object.assign(publicQuestion(room.qIndex), {
    type: "question",
    qType: QUESTIONS[room.qIndex].type,
    endsAt: room.qEndsAt,
    serverNow: Date.now(),
  });
}

function nextQuestion(room) {
  if (room.closed) return;
  room.qIndex += 1;
  if (room.qIndex >= TOTAL) {
    finishQuiz(room);
    return;
  }
  room.phase = "question";
  const now = Date.now();
  room.qEndsAt = now + QUESTION_SECONDS * 1000;
  broadcast(room, questionMessage(room));
  sendBoard(room);
  room.timers.question = setTimeout(() => endQuestion(room), QUESTION_SECONDS * 1000 + ANSWER_GRACE_MS);
}

function endQuestion(room) {
  if (room.closed) return;
  const idx = room.qIndex;
  room.phase = "between";
  room.players.forEach((p) => {
    if (!p.answers[idx]) p.answers[idx] = { choice: [], correct: false, timeout: true };
    const a = p.answers[idx];
    send(p.ws, {
      type: "questionEnd",
      q: idx,
      status: a.timeout ? "timeout" : a.correct ? "correct" : "wrong",
      score: p.score,
    });
  });
  send(room.host, { type: "questionEnd", q: idx });
  sendBoard(room);
  room.timers.next = setTimeout(() => nextQuestion(room), INTERMISSION_MS);
}

function finishQuiz(room) {
  room.phase = "ended";
  clearRoomTimers(room);
  const key = buildAnswerKey();

  // Ranked leaderboard for the host only.
  const sorted = [];
  room.players.forEach((p) => sorted.push({ name: p.name, score: p.score }));
  sorted.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const leaderboard = sorted.map((r) => ({
    rank: 1 + sorted.filter((o) => o.score > r.score).length,
    name: r.name,
    score: r.score,
  }));
  const sum = sorted.reduce((t, r) => t + r.score, 0);
  const average = sorted.length ? Math.round((sum / sorted.length) * 10) / 10 : 0;

  // Each player gets only their own result plus the answer key.
  room.players.forEach((p) => {
    send(p.ws, {
      type: "final",
      score: p.score,
      total: TOTAL,
      correct: p.score,
      wrong: TOTAL - p.score,
      accuracy: Math.round((p.score / TOTAL) * 100),
      joinedAt: p.joinedAt,
      key,
    });
  });

  send(room.host, { type: "hostFinal", total: TOTAL, leaderboard, average, key });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handleCreate(ws, msg) {
  if (ws.ctx) return send(ws, { type: "error", message: "You are already in a room." });
  const name = cleanText(msg.name, NAME_MAX);
  if (!name) return send(ws, { type: "error", message: "Enter your name." });
  if (rooms.size >= MAX_ROOMS) return send(ws, { type: "error", message: "The server is busy. Try again in a moment." });
  const code = makeRoomCode();
  if (!code) return send(ws, { type: "error", message: "The server is busy. Try again in a moment." });

  const room = createRoom(ws, name, code);
  ws.ctx = { room, role: "host", id: 0 };
  send(ws, {
    type: "joined",
    role: "host",
    code,
    name,
    max: MAX_PLAYERS,
    total: TOTAL,
    seconds: QUESTION_SECONDS,
    chatEnabled: room.chatEnabled,
    chat: room.chatLog,
  });
  sendRoster(room);
}

function handleJoin(ws, msg) {
  if (ws.ctx) return send(ws, { type: "error", message: "You are already in a room." });
  const name = cleanText(msg.name, NAME_MAX);
  if (!name) return send(ws, { type: "error", message: "Enter your name." });
  const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{4}$/.test(code)) return send(ws, { type: "error", message: "Enter a valid room code." });

  const room = rooms.get(code);
  if (!room || room.closed) return send(ws, { type: "error", message: "Room not found." });
  // Late joining: players may enter any time until the quiz is over.
  const lastQuestionDone = room.phase === "between" && room.qIndex >= TOTAL - 1;
  if (room.phase === "ended" || lastQuestionDone) return send(ws, { type: "error", message: "Quiz has ended." });
  if (room.players.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "Room is full." });

  // First question this player can answer (0 for lobby/countdown joiners).
  let joinedAt = 0;
  if (room.phase === "question") joinedAt = room.qIndex;
  else if (room.phase === "between") joinedAt = room.qIndex + 1;

  const id = room.nextId++;
  const player = { id, name: uniqueName(room, name), ws, score: 0, joinedAt, answers: new Array(TOTAL).fill(null) };
  room.players.set(id, player);
  ws.ctx = { room, role: "player", id };

  send(ws, {
    type: "joined",
    role: "player",
    code,
    name: player.name,
    max: MAX_PLAYERS,
    total: TOTAL,
    seconds: QUESTION_SECONDS,
    chatEnabled: room.chatEnabled,
    chat: room.chatLog,
    phase: room.phase,
  });
  sendRoster(room); // everyone (host included) sees the new player count immediately

  // Bring a late joiner straight into the quiz at the current moment.
  if (room.phase === "countdown") {
    send(ws, { type: "starting", startsAt: room.startsAt, serverNow: Date.now() });
  } else if (room.phase === "question") {
    send(ws, Object.assign(questionMessage(room), { late: true })); // carries the live remaining time
  } else if (room.phase === "between") {
    send(ws, { type: "waitNext", next: room.qIndex + 1, total: TOTAL });
  }
  if (room.phase !== "lobby") scheduleBoard(room); // host scoreboard gains the new row
}

function handleChat(ws, msg) {
  const ctx = ws.ctx;
  if (!ctx) return;
  const room = ctx.room;
  if (!room.chatEnabled) return send(ws, { type: "error", message: "CHAT DISABLED" });

  const now = Date.now();
  if (ws.lastChat && now - ws.lastChat < CHAT_MIN_GAP_MS) return; // silently rate-limit
  const text = cleanText(msg.text, CHAT_MAX);
  if (!text) return;
  ws.lastChat = now;

  const isHost = ctx.role === "host";
  const name = isHost ? room.hostName : room.players.get(ctx.id) ? room.players.get(ctx.id).name : null;
  if (!name) return;

  const entry = { name, text, host: isHost, ts: now };
  room.chatLog.push(entry);
  if (room.chatLog.length > CHAT_HISTORY) room.chatLog.shift();
  broadcast(room, Object.assign({ type: "chat" }, entry));
}

function handleChatToggle(ws, msg) {
  const ctx = ws.ctx;
  if (!ctx) return;
  if (ctx.role !== "host") return send(ws, { type: "error", message: "Only the host can do that." });
  ctx.room.chatEnabled = !!msg.enabled;
  broadcast(ctx.room, { type: "chatState", enabled: ctx.room.chatEnabled });
}

function handleStart(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  if (ctx.role !== "host") return send(ws, { type: "error", message: "Only the host can do that." });
  const room = ctx.room;
  if (room.phase !== "lobby") return send(ws, { type: "error", message: "Quiz already started." });
  if (room.players.size < 1) return send(ws, { type: "error", message: "Wait for at least one player to join." });
  startQuiz(room);
}

function handleAnswer(ws, msg) {
  const ctx = ws.ctx;
  if (!ctx || ctx.role !== "player") return;
  const room = ctx.room;
  const player = room.players.get(ctx.id);
  if (!player || player.ws !== ws) return; // must belong to this room

  if (room.phase !== "question" || !Number.isInteger(msg.q) || msg.q !== room.qIndex) {
    return send(ws, { type: "error", message: "Answers are locked." });
  }
  if (Date.now() > room.qEndsAt + ANSWER_GRACE_MS) {
    return send(ws, { type: "error", message: "Answers are locked." });
  }
  if (player.answers[msg.q]) return; // one answer per question

  const q = QUESTIONS[msg.q];
  const choice = msg.choice;
  if (!Array.isArray(choice) || choice.length < 1 || choice.length > q.options.length) return;
  if (!choice.every((c) => Number.isInteger(c) && c >= 0 && c < q.options.length)) return;
  if (new Set(choice).size !== choice.length) return;
  if (q.type !== "multi" && choice.length !== 1) return;

  const correct = sameSet(choice, q.correct);
  player.answers[msg.q] = { choice: choice.slice(), correct, timeout: false };
  if (correct) player.score += 1;

  send(ws, { type: "answerResult", q: msg.q, correct, score: player.score });
  scheduleBoard(room);
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "create":
      return handleCreate(ws, msg);
    case "join":
      return handleJoin(ws, msg);
    case "chat":
      return handleChat(ws, msg);
    case "chatToggle":
      return handleChatToggle(ws, msg);
    case "start":
      return handleStart(ws);
    case "answer":
      return handleAnswer(ws, msg);
    case "ping":
      return send(ws, { type: "pong" });
    default:
      return;
  }
}

function handleClose(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const room = ctx.room;
  if (room.closed) return;

  if (ctx.role === "host") {
    closeRoom(room, "The host left, so this room was closed.");
    return;
  }

  room.players.delete(ctx.id);
  sendRoster(room);
  if (room.phase !== "lobby") scheduleBoard(room);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket servers
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  if (url === "/" || url === "/index.html") {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Page unavailable.");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
    return;
  }

  if (url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const wss = new WebSocket.Server({ server, maxPayload: 4096, perMessageDeflate: false });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.lastChat = 0;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    ws.isAlive = true;
    try {
      handleMessage(ws, msg);
    } catch (e) {
      console.error("Handler error:", e && e.message);
      send(ws, { type: "error", message: "Something went wrong. Please try again." });
    }
  });

  ws.on("close", () => handleClose(ws));
  ws.on("error", () => {
    /* handled by close */
  });
});

// Keep connections alive through Render's proxy and drop dead sockets.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      /* ignore */
    }
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log("Python Quiz Arena listening on " + HOST + ":" + PORT);
});

function shutdown() {
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => {
    try {
      ws.close(1001, "server restarting");
    } catch (e) {
      /* ignore */
    }
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
