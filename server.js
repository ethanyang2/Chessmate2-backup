import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = process.env.PORT || 3001;
const rooms = new Map();
const queue = [];
const designLayoutStart = "/* DESIGN_MODE_LAYOUT_START */";
const designLayoutEnd = "/* DESIGN_MODE_LAYOUT_END */";
const designTargets = {
  title: ".hero-title",
  actions: ".home-actions",
  board: ".preview-board",
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function createRoom(id = crypto.randomUUID().slice(0, 8), options = {}) {
  const room = {
    id,
    mode: options.mode || "human",
    difficulty: options.difficulty || "easy",
    chess: new Chess(),
    clients: new Map(),
    lastMove: null,
    result: null,
    drawOffer: null,
  };
  rooms.set(id, room);
  return room;
}

function getRoom(id) {
  return rooms.get(id) || createRoom(id);
}

function getRole(room) {
  if (room.mode === "bot") return room.clients.size === 0 ? "white" : "spectator";

  const usedRoles = new Set([...room.clients.values()].map((client) => client.role));
  if (!usedRoles.has("white")) return "white";
  if (!usedRoles.has("black")) return "black";
  return "spectator";
}

function roomPayload(room) {
  const clients = [...room.clients.values()];
  const players = {
    white: clients.some((client) => client.role === "white"),
    black: room.mode === "bot" || clients.some((client) => client.role === "black"),
  };

  return {
    type: "state",
    roomId: room.id,
    mode: room.mode,
    difficulty: room.difficulty,
    fen: room.chess.fen(),
    turn: room.chess.turn(),
    status: getGameStatus(room),
    players,
    spectators: clients.filter((client) => client.role === "spectator").length,
    lastMove: room.lastMove,
    legalMoves: room.chess.moves({ verbose: true }).map((move) => ({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    })),
    history: room.chess.history(),
    drawOffer: room.drawOffer,
    result: room.result,
  };
}

function getGameStatus(room) {
  if (room.result) return room.result.type;
  if (room.chess.isCheckmate()) return "checkmate";
  if (room.chess.isStalemate()) return "stalemate";
  if (room.chess.isDraw()) return "draw";
  if (room.chess.isCheck()) return "check";
  return "playing";
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(room) {
  const state = roomPayload(room);
  for (const socket of room.clients.keys()) {
    send(socket, state);
  }
}

function safeRoomId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48);
}

function removeFromQueue(socket) {
  const index = queue.indexOf(socket);
  if (index !== -1) queue.splice(index, 1);
}

function attachToRoom(socket, room, forcedRole) {
  removeFromQueue(socket);
  room.clients.set(socket, { role: forcedRole || getRole(room) });
  socket.roomId = room.id;
  send(socket, { type: "role", role: room.clients.get(socket).role });
  send(socket, { type: "match_found", roomId: room.id });
  broadcast(room);
}

function applyMove(room, move) {
  const played = room.chess.move(move);
  if (!played) return null;
  room.lastMove = { from: played.from, to: played.to, san: played.san };
  room.drawOffer = null;
  return played;
}

function botShouldMove(room) {
  return room.mode === "bot" && room.chess.turn() === "b" && !room.result && !room.chess.isGameOver();
}

function scheduleBotMove(room) {
  if (!botShouldMove(room)) return;
  setTimeout(() => {
    if (!rooms.has(room.id) || !botShouldMove(room)) return;
    const move = chooseBotMove(room.chess, room.difficulty);
    if (move) applyMove(room, move);
    broadcast(room);
  }, 420);
}

function chooseBotMove(chess, difficulty) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  if (difficulty === "easy") return moves[Math.floor(Math.random() * moves.length)];

  const scored = moves.map((move) => ({ move, score: scoreMove(chess, move, difficulty) }));
  scored.sort((a, b) => b.score - a.score);
  const poolSize = difficulty === "medium" ? Math.min(4, scored.length) : 1;
  return scored[Math.floor(Math.random() * poolSize)].move;
}

function scoreMove(chess, move, difficulty) {
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;
  if (move.captured) score += values[move.captured] * 10;
  if (move.promotion) score += values[move.promotion] * 8;

  chess.move(move);
  if (chess.isCheckmate()) score += 1000;
  if (chess.isCheck()) score += difficulty === "hard" ? 6 : 2;
  const replies = chess.moves({ verbose: true });
  if (difficulty === "hard" && replies.some((reply) => reply.captured === move.piece)) {
    score -= values[move.piece] * 8;
  }
  chess.undo();

  return score + Math.random();
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20000) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

function safeRect(rect) {
  const keys = ["top", "left", "width", "height"];
  const clean = {};
  for (const key of keys) {
    const value = Number(rect?.[key]);
    if (!Number.isFinite(value)) throw new Error("Invalid layout value");
    clean[key] = Math.max(0, Math.round(value));
  }
  return clean;
}

function designCss(layout) {
  const rules = Object.entries(layout)
    .filter(([key]) => designTargets[key])
    .map(([key, rect]) => {
      const clean = safeRect(rect);
      return `${designTargets[key]} {
  position: fixed !important;
  top: ${clean.top}px !important;
  left: ${clean.left}px !important;
  width: ${clean.width}px !important;
  height: ${clean.height}px !important;
  max-width: none !important;
  z-index: 2;
}`;
    })
    .join("\n\n");

  return `${designLayoutStart}
@media (min-width: 768px) {
${rules}
}
${designLayoutEnd}`;
}

async function saveDesignLayout(layout) {
  const cssPath = join(publicDir, "styles.css");
  const css = await readFile(cssPath, "utf8");
  const generated = designCss(layout);
  const start = css.indexOf(designLayoutStart);
  const end = css.indexOf(designLayoutEnd);

  if (start !== -1 && end !== -1 && end > start) {
    const nextCss = `${css.slice(0, start).trimEnd()}\n\n${generated}\n${css.slice(end + designLayoutEnd.length).trimStart()}`;
    await writeFile(cssPath, nextCss);
    return;
  }

  await writeFile(cssPath, `${css.trimEnd()}\n\n${generated}\n`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/design-layout" && req.method === "POST") {
    try {
      const { layout } = await readJsonBody(req);
      await saveDesignLayout(layout || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (url.pathname === "/api/new-room") {
    const mode = url.searchParams.get("mode") === "bot" ? "bot" : "human";
    const difficulty = ["easy", "medium", "hard"].includes(url.searchParams.get("difficulty"))
      ? url.searchParams.get("difficulty")
      : "easy";
    const room = createRoom(undefined, { mode, difficulty });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ roomId: room.id }));
    return;
  }

  const requestedPath = url.pathname === "/" || url.pathname.startsWith("/room/")
    ? "/index.html"
    : url.pathname;
  const filePath = normalize(join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      send(socket, { type: "error", message: "Invalid message." });
      return;
    }

    if (message.type === "join_queue") {
      removeFromQueue(socket);
      const opponent = queue.shift();
      if (!opponent || opponent.readyState !== opponent.OPEN) {
        queue.push(socket);
        send(socket, { type: "queue_waiting" });
        return;
      }

      const room = createRoom(undefined, { mode: "human" });
      attachToRoom(opponent, room, "white");
      attachToRoom(socket, room, "black");
      return;
    }

    if (message.type === "join_room") {
      const roomId = safeRoomId(message.roomId);
      if (!roomId) {
        send(socket, { type: "error", message: "Missing room." });
        return;
      }

      attachToRoom(socket, getRoom(roomId));
      return;
    }

    const room = rooms.get(socket.roomId);
    if (!room || !room.clients.has(socket)) {
      send(socket, { type: "error", message: "Join a room first." });
      return;
    }

    const client = room.clients.get(socket);

    if (message.type === "move") {
      if (room.result || room.chess.isGameOver()) {
        send(socket, { type: "error", message: "This game has finished." });
        return;
      }
      if (client.role === "spectator") {
        send(socket, { type: "error", message: "Spectators cannot move." });
        return;
      }

      const expectedRole = room.chess.turn() === "w" ? "white" : "black";
      if (client.role !== expectedRole) {
        send(socket, { type: "error", message: "It is not your turn." });
        return;
      }

      try {
        const move = applyMove(room, {
          from: message.from,
          to: message.to,
          promotion: message.promotion || "q",
        });

        if (!move) {
          send(socket, { type: "error", message: "Illegal move." });
          return;
        }

        broadcast(room);
        scheduleBotMove(room);
      } catch {
        send(socket, { type: "error", message: "Illegal move." });
      }
      return;
    }

    if (message.type === "reset") {
      if (client.role === "spectator") {
        send(socket, { type: "error", message: "Spectators cannot reset the game." });
        return;
      }

      room.chess.reset();
      room.lastMove = null;
      room.result = null;
      room.drawOffer = null;
      broadcast(room);
      scheduleBotMove(room);
      return;
    }

    if (message.type === "offer_draw") {
      if (client.role === "spectator" || room.result) return;
      if (room.mode === "bot") {
        room.result = { type: "draw", reason: "Agreed draw" };
        room.drawOffer = null;
      } else if (room.drawOffer && room.drawOffer !== client.role) {
        room.result = { type: "draw", reason: "Agreed draw" };
        room.drawOffer = null;
      } else {
        room.drawOffer = client.role;
      }
      broadcast(room);
      return;
    }

    if (message.type === "resign") {
      if (client.role === "spectator" || room.result) return;
      room.result = {
        type: "resigned",
        winner: client.role === "white" ? "black" : "white",
        reason: `${client.role === "white" ? "White" : "Black"} resigned`,
      };
      room.drawOffer = null;
      broadcast(room);
    }
  });

  socket.on("close", () => {
    removeFromQueue(socket);
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.clients.delete(socket);
    if (room.clients.size === 0) {
      rooms.delete(room.id);
      return;
    }
    broadcast(room);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chessmate running on port ${PORT}`);
});
