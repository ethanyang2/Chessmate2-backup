const pieceGlyphs = {
  wp: "♙",
  wn: "♘",
  wb: "♗",
  wr: "♖",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

const pieceNames = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const startButton = document.querySelector("#startButton");
const searchGameButton = document.querySelector("#searchGameButton");
const menuButtons = document.querySelectorAll(".menu-button");
const homeMenus = document.querySelectorAll(".home-menu");
const previewBoard = document.querySelector("#previewBoard");
const joinForm = document.querySelector("#joinForm");
const roomCodeInput = document.querySelector("#roomCodeInput");
const botButtons = document.querySelectorAll(".bot-button");
const copyLinkButtons = [document.querySelector("#copyLinkButton"), document.querySelector("#copyLinkButtonPanel")];
const resetButton = document.querySelector("#resetButton");
const drawButton = document.querySelector("#drawButton");
const resignButton = document.querySelector("#resignButton");
const homeView = document.querySelector("#homeView");
const gameView = document.querySelector("#gameView");
const boardEl = document.querySelector("#board");
const turnPill = document.querySelector("#turnPill");
const roomName = document.querySelector("#roomName");
const roleLabel = document.querySelector("#roleLabel");
const statusBox = document.querySelector("#statusBox");
const whiteStatus = document.querySelector("#whiteStatus");
const blackStatus = document.querySelector("#blackStatus");
const movesList = document.querySelector("#movesList");
const toast = document.querySelector("#toast");
const whiteCaptures = document.querySelector("#whiteCaptures");
const blackCaptures = document.querySelector("#blackCaptures");

let socket;
let currentState;
let role = "spectator";
let selectedSquare = null;
let board = {};
let dragState = null;
let ignoreClickUntil = 0;

function currentRoomId() {
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)/);
  return match?.[1] || null;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2200);
}

async function createRoom(mode = "human", difficulty = "easy") {
  const response = await fetch(`/api/new-room?mode=${mode}&difficulty=${difficulty}`);
  const { roomId } = await response.json();
  window.location.href = `/room/${roomId}`;
}

function webSocketUrl() {
  return window.location.hostname === "localhost"
    ? "ws://localhost:3001"
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

function createLobbySocket() {
  const lobbySocket = new WebSocket(webSocketUrl());
  lobbySocket.addEventListener("open", () => lobbySocket.send(JSON.stringify({ type: "join_queue" })));
  lobbySocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "queue_waiting") showToast("Searching for an opponent...");
    if (message.type === "match_found") window.location.href = `/room/${message.roomId}`;
    if (message.type === "error") showToast(message.message);
  });
  lobbySocket.addEventListener("close", () => showToast("Search stopped."));
}

function connect(roomId) {
  socket = new WebSocket(webSocketUrl());
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join_room", roomId }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "role") {
      role = message.role;
      roleLabel.textContent = role[0].toUpperCase() + role.slice(1);
      return;
    }
    if (message.type === "match_found") return;
    if (message.type === "state") {
      currentState = message;
      board = fenToBoard(message.fen);
      render();
      return;
    }
    if (message.type === "error") {
      showToast(message.message);
    }
  });
  socket.addEventListener("close", () => {
    turnPill.textContent = "Offline";
    statusBox.textContent = "Connection lost. Refresh the room to reconnect.";
  });
}

function fenToBoard(fen) {
  const squares = {};
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, rowIndex) => {
    let fileIndex = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
      } else {
        const color = char === char.toUpperCase() ? "w" : "b";
        const type = char.toLowerCase();
        squares[`${files[fileIndex]}${8 - rowIndex}`] = { color, type };
        fileIndex += 1;
      }
    }
  });
  return squares;
}

function orientedSquares() {
  const ranks = role === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const orientedFiles = role === "black" ? [...files].reverse() : files;
  return ranks.flatMap((rank) => orientedFiles.map((file) => `${file}${rank}`));
}

function isOwnPiece(square) {
  const piece = board[square];
  if (!piece || role === "spectator") return false;
  return (role === "white" && piece.color === "w") || (role === "black" && piece.color === "b");
}

function canMoveNow() {
  if (!currentState) return false;
  return (currentState.turn === "w" && role === "white") || (currentState.turn === "b" && role === "black");
}

function targetsFrom(from) {
  if (!from || !canMoveNow()) return new Set();
  return new Set(currentState.legalMoves.filter((move) => move.from === from).map((move) => move.to));
}

function canPlay() {
  return currentState && ["playing", "check"].includes(currentState.status);
}

function requestMove(from, to) {
  if (!from || !to || from === to) return;
  socket.send(JSON.stringify({ type: "move", from, to, promotion: "q" }));
}

function handleSquareClick(square) {
  if (Date.now() < ignoreClickUntil) return;
  if (!canPlay()) return;

  if (!selectedSquare) {
    if (isOwnPiece(square) && canMoveNow()) selectedSquare = square;
    renderBoard();
    return;
  }

  if (selectedSquare === square) {
    selectedSquare = null;
    renderBoard();
    return;
  }

  if (isOwnPiece(square)) {
    selectedSquare = square;
    renderBoard();
    return;
  }

  requestMove(selectedSquare, square);
  selectedSquare = null;
  renderBoard();
}

function startDrag(event, square) {
  if (!canPlay() || !isOwnPiece(square) || !canMoveNow()) return;
  const piece = board[square];
  selectedSquare = square;
  dragState = {
    from: square,
    ghost: createDragGhost(piece, event.clientX, event.clientY),
    moved: false,
  };
  boardEl.classList.add("dragging-board");
  event.currentTarget.setPointerCapture?.(event.pointerId);
  event.preventDefault();
  renderBoard();
}

function moveDrag(event) {
  if (!dragState) return;
  dragState.moved = true;
  dragState.ghost.style.transform = `translate(${event.clientX}px, ${event.clientY}px) translate(-50%, -50%)`;
}

function endDrag(event) {
  if (!dragState) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".square")?.dataset.square;
  const from = dragState.from;
  dragState.ghost.remove();
  dragState = null;
  ignoreClickUntil = Date.now() + 120;
  boardEl.classList.remove("dragging-board");

  if (target && targetsFrom(from).has(target)) {
    requestMove(from, target);
    selectedSquare = null;
  } else if (!target) {
    selectedSquare = null;
  }
  renderBoard();
}

function createDragGhost(piece, x, y) {
  const ghost = document.createElement("div");
  ghost.className = `drag-ghost piece ${piece.color === "w" ? "white" : "black"}`;
  ghost.innerHTML = pieceMarkup(piece);
  ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  document.body.append(ghost);
  return ghost;
}

function render() {
  const roomId = currentRoomId();
  roomName.textContent = roomId;
  turnPill.textContent = statusLabel(currentState);
  whiteStatus.textContent = currentState.players.white ? "At board" : "Waiting";
  blackStatus.textContent = currentState.mode === "bot"
    ? `${capitalize(currentState.difficulty)} bot`
    : currentState.players.black ? "At board" : "Waiting";
  statusBox.textContent = detailStatus(currentState);
  movesList.textContent = formatMoves(currentState.history);
  drawButton.textContent = currentState.drawOffer && currentState.drawOffer !== role ? "Accept Draw" : "Offer Draw";
  renderCaptures();
  renderBoard();
}

function renderBoard() {
  const targets = targetsFrom(selectedSquare);
  boardEl.innerHTML = "";
  for (const square of orientedSquares()) {
    const button = document.createElement("button");
    const rank = Number(square[1]);
    const fileIndex = files.indexOf(square[0]);
    const piece = board[square];
    button.className = `square ${(rank + fileIndex) % 2 === 0 ? "dark" : "light"}`;
    button.dataset.square = square;
    button.setAttribute("aria-label", square);

    if (selectedSquare === square) button.classList.add("selected");
    if (currentState?.lastMove && (currentState.lastMove.from === square || currentState.lastMove.to === square)) {
      button.classList.add("last");
    }
    if (targets.has(square)) {
      button.classList.add("target");
      if (piece) button.classList.add("has-piece");
    }
    if (piece) {
      const span = document.createElement("span");
      span.className = `piece ${piece.color === "w" ? "white" : "black"}`;
      span.innerHTML = pieceMarkup(piece);
      span.setAttribute("aria-hidden", "true");
      button.append(span);
    }
    button.addEventListener("click", () => {
      if (!dragState?.moved) handleSquareClick(square);
    });
    button.addEventListener("pointerdown", (event) => startDrag(event, square));
    button.addEventListener("pointermove", moveDrag);
    button.addEventListener("pointerup", endDrag);
    button.addEventListener("pointercancel", endDrag);
    boardEl.append(button);
  }
}

function pieceMarkup(piece) {
  return pieceGlyphs[`${piece.color}${piece.type}`];
}

function renderCaptures() {
  const starting = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
  const counts = { w: { ...starting }, b: { ...starting } };
  Object.values(board).forEach((piece) => {
    counts[piece.color][piece.type] -= 1;
  });
  whiteCaptures.innerHTML = capturedText(counts.w, "w");
  blackCaptures.innerHTML = capturedText(counts.b, "b");
}

function capturedText(counts, color) {
  return Object.entries(counts)
    .flatMap(([type, count]) => Array.from({ length: Math.max(0, count) }, () => {
      const piece = { color, type };
      return `<span title="${color === "w" ? "White" : "Black"} ${pieceNames[type]}">${pieceGlyphs[`${piece.color}${piece.type}`]}</span>`;
    }))
    .join(" ");
}

function formatMoves(history) {
  if (!history?.length) return "Moves will appear here.";
  const rows = [];
  for (let index = 0; index < history.length; index += 2) {
    rows.push(`${index / 2 + 1}. ${history[index]} ${history[index + 1] || ""}`.trim());
  }
  return rows.join("\n");
}

function statusLabel(state) {
  if (state.status === "checkmate") return "Checkmate";
  if (state.status === "resigned") return "Resigned";
  if (state.status === "stalemate") return "Stalemate";
  if (state.status === "draw") return "Draw";
  if (state.status === "check") return `${state.turn === "w" ? "White" : "Black"} check`;
  return `${state.turn === "w" ? "White" : "Black"} to move`;
}

function detailStatus(state) {
  if (state.result?.reason) return state.result.winner ? `${capitalize(state.result.winner)} wins. ${state.result.reason}.` : state.result.reason;
  if (state.status === "checkmate") return `${state.turn === "w" ? "Black" : "White"} wins by checkmate.`;
  if (state.status === "stalemate") return "The game is drawn by stalemate.";
  if (state.status === "draw") return "The game is drawn.";
  if (state.drawOffer && state.drawOffer !== role) return `${capitalize(state.drawOffer)} offered a draw.`;
  if (state.drawOffer === role) return "Draw offer sent.";
  if (role === "spectator") return `Spectating ${state.players.white && state.players.black ? "a live game" : "while players join"}.`;
  if (state.mode === "bot" && role === "white" && state.turn === "b") return `${capitalize(state.difficulty)} bot is thinking.`;
  if (!state.players.white || !state.players.black) return "Share the room link or search for a queued match.";
  if (canMoveNow()) return "Your move. Tap or drag a piece.";
  return "Waiting for your opponent.";
}

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

async function copyLink() {
  await navigator.clipboard.writeText(window.location.href);
  showToast("Room link copied.");
}

startButton?.addEventListener("click", () => createRoom());
searchGameButton?.addEventListener("click", createLobbySocket);
menuButtons.forEach((button) => {
  button.addEventListener("click", () => {
    homeMenus.forEach((menu) => menu.classList.toggle("hidden", menu.id !== button.dataset.menu));
  });
});
resetButton?.addEventListener("click", () => socket?.send(JSON.stringify({ type: "reset" })));
drawButton?.addEventListener("click", () => socket?.send(JSON.stringify({ type: "offer_draw" })));
resignButton?.addEventListener("click", () => socket?.send(JSON.stringify({ type: "resign" })));
copyLinkButtons.forEach((button) => button?.addEventListener("click", copyLink));
botButtons.forEach((button) => {
  button.addEventListener("click", () => createRoom("bot", button.dataset.difficulty));
});
joinForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomId = roomCodeInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!roomId) {
    showToast("Enter a room code.");
    return;
  }
  window.location.href = `/room/${roomId}`;
});
document.addEventListener("pointermove", moveDrag);
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

function renderPreviewBoard() {
  if (!previewBoard) return;
  const setup = [
    ["br", "bn", "bb", "bq", "bk", "bb", "bn", "br"],
    ["bp", "bp", "bp", "bp", "bp", "bp", "bp", "bp"],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ["wp", "wp", "wp", "wp", "wp", "wp", "wp", "wp"],
    ["wr", "wn", "wb", "wq", "wk", "wb", "wn", "wr"],
  ];
  previewBoard.innerHTML = "";
  setup.flat().forEach((piece, index) => {
    const square = document.createElement("span");
    square.className = `preview-square ${Math.floor(index / 8 + index % 8) % 2 === 0 ? "dark" : "light"} ${piece?.startsWith("w") ? "white-piece" : ""} ${piece?.startsWith("b") ? "black-piece" : ""}`;
    square.textContent = piece ? pieceGlyphs[piece] : "";
    previewBoard.append(square);
  });
}

const roomId = currentRoomId();
if (roomId) {
  homeView.classList.add("hidden");
  gameView.classList.remove("hidden");
  connect(roomId);
} else {
  homeView.classList.remove("hidden");
  gameView.classList.add("hidden");
  renderPreviewBoard();
}

const designTargets = {
  title: document.querySelector(".hero-title"),
  actions: document.querySelector(".home-actions"),
  board: document.querySelector(".preview-board"),
};
let designMode = false;
let designAction = null;
let designLayout = {};

function toggleDesignMode() {
  if (roomId) return;
  designMode = !designMode;
  document.body.classList.toggle("design-mode", designMode);

  if (designMode) {
    Object.entries(designTargets).forEach(([key, element]) => {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      designLayout[key] = designLayout[key] || rectToLayout(rect);
      element.classList.add("design-target");
      element.dataset.designKey = key;
      element.style.position = "fixed";
      element.style.top = `${rect.top}px`;
      element.style.left = `${rect.left}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.zIndex = "10";
      addDesignHandles(element);
    });
    showToast("Design Mode on. Drag or resize, then release to save.");
  } else {
    Object.values(designTargets).forEach((element) => {
      element?.classList.remove("design-target");
      element?.querySelectorAll(".design-handle").forEach((handle) => handle.remove());
    });
    showToast("Design Mode off.");
  }
}

function rectToLayout(rect) {
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function addDesignHandles(element) {
  if (element.querySelector(".design-handle")) return;
  ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach((side) => {
    const handle = document.createElement("span");
    handle.className = `design-handle design-handle-${side}`;
    handle.dataset.resize = side;
    element.append(handle);
  });
}

function startDesignAction(event) {
  if (!designMode) return;
  const handle = event.target.closest(".design-handle");
  const target = event.target.closest(".design-target");
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();

  const rect = target.getBoundingClientRect();
  designAction = {
    element: target,
    key: target.dataset.designKey,
    resize: handle?.dataset.resize || null,
    startX: event.clientX,
    startY: event.clientY,
    startRect: rectToLayout(rect),
  };
  target.classList.add("is-designing");
}

function moveDesignAction(event) {
  if (!designAction) return;
  event.preventDefault();
  const dx = event.clientX - designAction.startX;
  const dy = event.clientY - designAction.startY;
  const next = { ...designAction.startRect };

  if (!designAction.resize) {
    next.left += dx;
    next.top += dy;
  } else {
    if (designAction.resize.includes("e")) next.width += dx;
    if (designAction.resize.includes("s")) next.height += dy;
    if (designAction.resize.includes("w")) {
      next.left += dx;
      next.width -= dx;
    }
    if (designAction.resize.includes("n")) {
      next.top += dy;
      next.height -= dy;
    }
  }

  next.width = Math.max(80, next.width);
  next.height = Math.max(38, next.height);
  next.left = Math.max(0, next.left);
  next.top = Math.max(0, next.top);
  applyDesignLayout(designAction.element, next);
  designLayout[designAction.key] = next;
}

async function endDesignAction() {
  if (!designAction) return;
  designAction.element.classList.remove("is-designing");
  designAction = null;
  await saveDesignLayout();
}

function applyDesignLayout(element, layout) {
  element.style.left = `${layout.left}px`;
  element.style.top = `${layout.top}px`;
  element.style.width = `${layout.width}px`;
  element.style.height = `${layout.height}px`;
}

async function saveDesignLayout() {
  try {
    const response = await fetch("/api/design-layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout: designLayout }),
    });
    if (!response.ok) throw new Error("Save failed");
    showToast("Design saved to styles.css.");
  } catch {
    showToast("Design save failed. Restart the local server if needed.");
  }
}

document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
    event.preventDefault();
    toggleDesignMode();
  }
});
document.addEventListener("pointerdown", startDesignAction);
document.addEventListener("pointermove", moveDesignAction);
document.addEventListener("pointerup", endDesignAction);
document.addEventListener("pointercancel", endDesignAction);
