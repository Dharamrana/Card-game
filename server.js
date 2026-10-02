"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const TURN_MS = Number(process.env.TURN_MS) || 60_000;
const TRICK_PAUSE_MS = Number(process.env.TRICK_PAUSE_MS) || 2_000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const MAX_MSGS_PER_WINDOW = 30;
const MSG_WINDOW_MS = 2_000;
const GHOST_SEAT_MS = Number(process.env.GHOST_SEAT_MS) || 60_000;
const rootGameFile = path.join(__dirname, "Kaat Card Game.html");
const GAME_FILE = fs.existsSync(rootGameFile) ? rootGameFile : path.join(__dirname, "outputs", "Kaat Card Game.html");
const rooms = new Map();
const suits = ["S", "H", "C", "D"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const rankValue = Object.fromEntries(ranks.map((rank, index) => [rank, index + 2]));

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  if (pathname !== "/" && pathname !== "/Kaat%20Card%20Game.html" && pathname !== "/Kaat%20Card%20Game.html/") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  fs.readFile(GAME_FILE, (error, content) => {
    if (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("The game page could not be loaded.");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(content);
  });
});

const wss = new WebSocket.Server({ server, maxPayload: 4096 });

function send(socket, type, extra = {}) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...extra }));
}

function tell(socket, message) { send(socket, "notice", { message }); }

function broadcast(room) {
  room.players.forEach((player, seat) => {
    if (!player || !player.ws || player.ws.readyState !== WebSocket.OPEN) return;
    const state = {
      code: room.code,
      players: room.players.map(p => p ? { name: p.name, online: Boolean(p.ws && p.ws.readyState === WebSocket.OPEN) } : null),
      hostSeat: room.hostSeat,
      scores: room.scores,
      handNo: room.handNo,
      caller: room.caller,
      phase: room.phase,
      trump: room.trump,
      bids: room.phase === "play" || room.phase === "trickEnd" || room.phase === "summary" || room.phase === "gameover" ? room.bids : null,
      bidSubmitted: room.bids.map(value => value !== null),
      tricks: room.tricks,
      trick: room.trick,
      turn: room.turn,
      deadline: room.deadline,
      lastWinner: room.lastWinner,
      message: room.message,
      hand: room.hands ? room.hands[seat] : [],
      handCounts: room.hands ? room.hands.map(h => h.length) : null,
      serverTime: Date.now(),
      chat: room.chat.slice(-30),
      matchWinner: room.matchWinner
    };
    send(player.ws, "room_state", { state });
  });
}

function sendError(socket, message) { send(socket, "error", { message }); }

function createRoom(socket, name) {
  if (socket.roomCode && rooms.has(socket.roomCode)) return sendError(socket, "Leave your current room before creating another one.");
  if (rooms.size >= MAX_ROOMS) return sendError(socket, "The server is full right now. Try again in a little while.");
  let code;
  do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(code));
  const token = randomUUID();
  const room = {
    code,
    hostSeat: 0,
    players: [{ id: token, name: cleanName(name), ws: socket }, null, null, null],
    scores: [0, 0, 0, 0], handNo: 0, caller: 0, phase: "waiting",
    hands: null, trump: null, bids: [null, null, null, null], tricks: [0, 0, 0, 0],
    trick: [], turn: null, deadline: null, timer: null, lastWinner: null,
    message: "Waiting for friends to join.", matchWinner: null, cleanupTimer: null, chat: []
  };
  rooms.set(code, room);
  socket.playerToken = token;
  socket.roomCode = code;
  send(socket, "joined", { code, token, seat: 0, created: true });
  broadcast(room);
}

function cleanName(name) {
  const value = String(name || "").trim().replace(/[<>]/g, "").slice(0, 18);
  return value || "Player";
}

function attachPlayer(socket, room, seat, token) {
  const player = room.players[seat];
  if (player.ws && player.ws !== socket && player.ws.readyState === WebSocket.OPEN) {
    player.ws.close(4001, "Reconnected elsewhere");
  }
  player.ws = socket;
  socket.playerToken = token;
  socket.roomCode = room.code;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
  send(socket, "joined", { code: room.code, token, seat, created: false });
  broadcast(room);
}

function claimSeat(room) {
  const empty = room.players.findIndex(player => !player);
  if (empty >= 0) return { seat: empty, reclaimed: false };
  // No empty seat: recycle one whose player has been disconnected a while.
  // The current host seat is never recycled out from under an active host
  // (joinRoom migrates the host role first if the host is long gone).
  const now = Date.now();
  const ghost = room.players.findIndex((player, index) =>
    index !== room.hostSeat && player && !seatConnected(room, index) &&
    now - (player.disconnectedAt || 0) > GHOST_SEAT_MS);
  return ghost >= 0 ? { seat: ghost, reclaimed: true } : null;
}

function seatConnected(room, index) {
  const p = room.players[index];
  return Boolean(p && p.ws && p.ws.readyState === WebSocket.OPEN);
}

// A seat is playable if its player is connected, or has been gone long enough
// that the phase timers cover for them (auto kaat / auto bid / auto play).
function seatPlayable(room, index) {
  const p = room.players[index];
  if (!p) return false;
  if (seatConnected(room, index)) return true;
  return Date.now() - (p.disconnectedAt || 0) > GHOST_SEAT_MS;
}

function maybeMigrateHost(room) {
  const host = room.players[room.hostSeat];
  const gone = !host || !host.ws || host.ws.readyState !== WebSocket.OPEN;
  if (!gone || Date.now() - ((host && host.disconnectedAt) || 0) <= GHOST_SEAT_MS) return;
  const next = [0, 1, 2, 3].find(i => {
    const p = room.players[i];
    return p && p.ws && p.ws.readyState === WebSocket.OPEN;
  });
  if (next === undefined || next === room.hostSeat) return;
  room.hostSeat = next;
  room.message = `${room.players[next].name} is now the host.`;
}

function joinRoom(socket, data) {
  if (socket.roomCode && rooms.has(socket.roomCode)) return sendError(socket, "Leave your current room before joining another one.");
  const code = String(data.code || "").trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(socket, "That room code was not found. Check it and try again.");
  maybeMigrateHost(room);
  if (data.token) {
    const existingSeat = room.players.findIndex(player => player && player.id === data.token);
    if (existingSeat >= 0) return attachPlayer(socket, room, existingSeat, data.token);
  }
  const claimed = claimSeat(room);
  if (!claimed) return sendError(socket, "This room already has four players.");
  const token = randomUUID();
  const seat = claimed.seat;
  const name = cleanName(data.name);
  room.players[seat] = { id: token, name, ws: socket };
  room.message = claimed.reclaimed ? `${name} took over a disconnected seat.` : `${name} joined the room.`;
  attachPlayer(socket, room, seat, token);
}

function deck() {
  const cards = suits.flatMap(suit => ranks.map(rank => ({ suit, rank })));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function dealValidHands() {
  let hands;
  do {
    const cards = deck();
    hands = Array.from({ length: 4 }, (_, seat) => cards.slice(seat * 13, (seat + 1) * 13));
  } while (!hands.every(hand => suits.every(suit => hand.some(card => card.suit === suit))));
  return hands;
}

function startHand(room, caller) {
  clearTimeout(room.timer);
  clearPhaseTimer(room);
  room.handNo += 1;
  room.caller = caller;
  room.hands = dealValidHands();
  room.trump = null;
  room.bids = [null, null, null, null];
  room.tricks = [0, 0, 0, 0];
  room.trick = [];
  room.turn = caller;
  room.deadline = null;
  room.lastWinner = null;
  room.matchWinner = null;
  room.phase = "call";
  room.message = `Hand ${room.handNo}: ${room.players[caller].name} chooses the kaat suit.`;
  broadcast(room);
  schedulePhaseTimer(room);
}

function legalCards(room, seat) {
  const hand = room.hands[seat];
  if (!room.trick.length) return hand;
  const leadSuit = room.trick[0].card.suit;
  const following = hand.filter(card => card.suit === leadSuit);
  return following.length ? following : hand;
}

function winningPlay(room) {
  const leadSuit = room.trick[0].card.suit;
  const trumpCards = room.trick.filter(play => play.card.suit === room.trump);
  const eligible = trumpCards.length ? trumpCards : room.trick.filter(play => play.card.suit === leadSuit);
  return eligible.reduce((best, play) => rankValue[play.card.rank] > rankValue[best.card.rank] ? play : best);
}

function clearPhaseTimer(room) {
  if (room.phaseTimer) { clearTimeout(room.phaseTimer); room.phaseTimer = null; }
}

function autoTrumpFor(room, seat) {
  const hand = room.hands[seat];
  let best = suits[0], bestScore = -1;
  for (const suit of suits) {
    const cards = hand.filter(card => card.suit === suit);
    const score = cards.length * 100 + cards.reduce((sum, card) => sum + rankValue[card.rank], 0);
    if (score > bestScore) { bestScore = score; best = suit; }
  }
  return best;
}

function beginPlay(room) {
  clearPhaseTimer(room);
  const before = room.bids.reduce((sum, value) => sum + value, 0);
  while (room.bids.reduce((sum, value) => sum + value, 0) < 14) {
    for (let p = 0; p < 4 && room.bids.reduce((sum, value) => sum + value, 0) < 14; p++) room.bids[p] += 1;
  }
  room.phase = "play";
  room.turn = room.caller;
  room.message = before < 14
    ? `Combined bids were ${before}; bids were raised in seat order to reach ${room.bids.reduce((sum, value) => sum + value, 0)}. ${room.players[room.caller].name} leads.`
    : `Bids locked at ${before}. ${room.players[room.caller].name} leads.`;
  scheduleTurn(room);
  broadcast(room);
}

// Call and bid phases get the same deadline as turns: if a player idles or
// disconnects mid-phase, the game moves on instead of stalling forever.
function schedulePhaseTimer(room) {
  clearPhaseTimer(room);
  room.phaseTimer = setTimeout(() => {
    if (room.phase === "call") {
      const seat = room.caller;
      const suit = autoTrumpFor(room, seat);
      room.trump = suit;
      room.phase = "bid";
      room.message = `${room.players[seat].name} took too long; ${suit} was called as kaat automatically. Everyone bids now.`;
      broadcast(room);
      schedulePhaseTimer(room);
    } else if (room.phase === "bid") {
      let filled = false;
      room.bids.forEach((bid, seat) => {
        if (bid === null) { room.bids[seat] = seat === room.caller ? 6 : 2; filled = true; }
      });
      if (filled) room.message = "Ran out of time: missing bids were set to the minimum.";
      beginPlay(room);
    }
  }, TURN_MS);
}

function scheduleTurn(room) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => {
    if (room.phase !== "play" || room.turn === null) return;
    const seat = room.turn;
    const legal = legalCards(room, seat);
    const card = legal.slice().sort((a, b) => rankValue[a.rank] - rankValue[b.rank] || Number(a.suit === room.trump) - Number(b.suit === room.trump))[0];
    room.message = `Time ran out for ${room.players[seat].name}; ${card.rank}${card.suit} was played automatically.`;
    playCard(room, seat, card, true);
  }, TURN_MS);
}

function finishHand(room) {
  clearTimeout(room.timer);
  clearPhaseTimer(room);
  room.deadline = null;
  room.scores = room.scores.map((score, seat) => score + (room.tricks[seat] >= room.bids[seat] ? room.bids[seat] : -room.bids[seat]));
  let winner = -1, best = -Infinity;
  room.scores.forEach((score, seat) => { if (score >= 21 && score > best) { best = score; winner = seat; } });
  room.matchWinner = winner >= 0 ? winner : null;
  room.phase = winner >= 0 ? "gameover" : "summary";
  room.message = winner >= 0 ? `${room.players[winner].name} reached +21 and won the match!` : "Hand complete. Scores have been added.";
  broadcast(room);
}

function playCard(room, seat, card, automatic = false) {
  clearTimeout(room.timer);
  room.deadline = null;
  const hand = room.hands[seat];
  const index = hand.findIndex(item => item.suit === card.suit && item.rank === card.rank);
  if (index < 0) return;
  const [played] = hand.splice(index, 1);
  room.trick.push({ seat, card: played });
  if (!automatic) room.message = `${room.players[seat].name} played ${played.rank}${played.suit}.`;
  if (room.trick.length === 4) {
    room.lastWinner = winningPlay(room).seat;
    room.tricks[room.lastWinner] += 1;
    room.phase = "trickEnd";
    room.turn = null;
    room.message = `${room.players[room.lastWinner].name} won this ghar and leads next.`;
    broadcast(room);
    room.timer = setTimeout(() => {
      if (room.hands.every(playerHand => playerHand.length === 0)) return finishHand(room);
      room.trick = [];
      room.turn = room.lastWinner;
      room.phase = "play";
      room.message = `${room.players[room.turn].name} leads the next baari.`;
      scheduleTurn(room);
      broadcast(room);
    }, TRICK_PAUSE_MS);
    return;
  }
  room.turn = (seat + 1) % 4;
  room.phase = "play";
  scheduleTurn(room);
  broadcast(room);
}

function handleMessage(socket, data) {
  if (!data || typeof data.type !== "string") return;
  if (data.type === "create_room") return createRoom(socket, data.name);
  if (data.type === "join_room") return joinRoom(socket, data);
  const room = rooms.get(socket.roomCode);
  if (!room) return sendError(socket, "Join a room before sending game actions.");
  const seat = room.players.findIndex(player => player && player.id === socket.playerToken);
  if (seat < 0) return sendError(socket, "Your seat is no longer in this room.");

  if (data.type === "leave_room") {
    const leaverName = room.players[seat].name;
    if (seat === room.hostSeat) {
      const remaining = [0, 1, 2, 3].filter(i => i !== seat && room.players[i]);
      if (!remaining.length) {
        clearTimeout(room.timer);
        clearPhaseTimer(room);
        clearTimeout(room.cleanupTimer);
        room.players.forEach(player => {
          if (player && player.ws) {
            send(player.ws, "room_closed", { bySeat: seat });
            player.ws.roomCode = "";
            player.ws.playerToken = "";
          }
        });
        rooms.delete(room.code);
      } else {
        room.players[seat] = null;
        socket.roomCode = "";
        socket.playerToken = "";
        send(socket, "left_room");
        room.hostSeat = remaining[0];
        room.message = `${leaverName} left. ${room.players[room.hostSeat].name} is now the host.`;
        broadcast(room);
      }
    } else {
      room.players[seat] = null;
      socket.roomCode = "";
      socket.playerToken = "";
      send(socket, "left_room");
      room.message = "A player left the room.";
      broadcast(room);
    }
    return;
  }

  if (data.type === "start_hand") {
    maybeMigrateHost(room);
    if (seat !== room.hostSeat) return sendError(socket, "Only the room creator can start the hand.");
    if (room.players.some((player, i) => !seatPlayable(room, i))) return sendError(socket, "Wait until all four players are connected.");
    if (room.phase !== "waiting" && room.phase !== "summary") return sendError(socket, "This hand is already in progress.");
    startHand(room, room.phase === "summary" ? (room.caller + 1) % 4 : room.caller);
    return;
  }
  if (data.type === "call_trump") {
    if (room.phase !== "call" || seat !== room.caller || !suits.includes(data.suit)) return sendError(socket, "Only the caller can choose one kaat suit now.");
    room.trump = data.suit;
    room.phase = "bid";
    room.message = `${room.players[seat].name} called ${data.suit} as kaat. All players, including the caller, now bid.`;
    broadcast(room);
    schedulePhaseTimer(room);
    return;
  }
  if (data.type === "submit_bid") {
    if (room.phase !== "bid" || room.bids[seat] !== null) return sendError(socket, "Your bid is already locked or bidding is closed.");
    const min = seat === room.caller ? 6 : 2;
    const bid = Number(data.bid);
    if (!Number.isInteger(bid) || bid < min || bid > 13) return sendError(socket, `Your bid must be a whole number from ${min} to 13.`);
    room.bids[seat] = bid;
    if (room.bids.every(value => value !== null)) {
      beginPlay(room);
    } else {
      room.message = `${room.players[seat].name} locked a bid. Waiting for the other players.`;
      broadcast(room);
    }
    return;
  }
  if (data.type === "play_card") {
    if (room.phase !== "play" || seat !== room.turn) return sendError(socket, "It is not your turn.");
    if (!data.card || typeof data.card.suit !== "string" || typeof data.card.rank !== "string") return sendError(socket, "That card could not be played.");
    if (!legalCards(room, seat).some(card => card.suit === data.card.suit && card.rank === data.card.rank)) return sendError(socket, "Follow suit when you can.");
    playCard(room, seat, data.card);
    return;
  }
  if (data.type === "new_hand") {
    maybeMigrateHost(room);
    if (seat !== room.hostSeat || room.phase !== "summary") return sendError(socket, "Only the room creator can deal the next hand.");
    if (room.players.some((player, i) => !seatPlayable(room, i))) return sendError(socket, "Wait until all four players are connected.");
    startHand(room, (room.caller + 1) % 4);
    return;
  }
  if (data.type === "rematch") {
    maybeMigrateHost(room);
    if (seat !== room.hostSeat || room.phase !== "gameover") return sendError(socket, "Only the room creator can start a rematch.");
    room.scores = [0, 0, 0, 0];
    room.handNo = 0;
    startHand(room, room.hostSeat);
    return;
  }
  if (data.type === "kick") {
    if (seat !== room.hostSeat) return sendError(socket, "Only the host can remove players.");
    const target = Number(data.seat);
    if (!Number.isInteger(target) || target < 0 || target > 3 || target === seat) return sendError(socket, "You cannot remove that seat.");
    const victim = room.players[target];
    if (!victim) return sendError(socket, "That seat is already empty.");
    if (victim.ws && victim.ws.readyState === WebSocket.OPEN) return sendError(socket, "That player is still connected.");
    if (room.phase !== "waiting" && room.phase !== "summary") return sendError(socket, "Players can only be removed between hands.");
    if (victim.ws) { try { victim.ws.close(4001, "Removed by host"); } catch {} }
    room.players[target] = null;
    room.message = `${victim.name} was removed by the host.`;
    broadcast(room);
    return;
  }
  if (data.type === "chat") {
    const text = String(data.text || "").replace(/[<>&]/g, "").trim().slice(0, 200);
    if (!text) return;
    const entry = { seat, name: room.players[seat].name, text, at: Date.now() };
    room.chat.push(entry);
    if (room.chat.length > 50) room.chat.splice(0, room.chat.length - 50);
    room.players.forEach(player => {
      if (player && player.ws && player.ws.readyState === WebSocket.OPEN) send(player.ws, "chat", { message: entry });
    });
    return;
  }
  sendError(socket, "Unknown game action.");
}

wss.on("connection", socket => {
  socket.on("error", () => {});
  socket.on("message", raw => {
    const now = Date.now();
    socket.msgTimes = (socket.msgTimes || []).filter(t => now - t < MSG_WINDOW_MS);
    if (socket.msgTimes.length >= MAX_MSGS_PER_WINDOW) {
      try { socket.close(4002, "Too many messages"); } catch {}
      return;
    }
    socket.msgTimes.push(now);
    try {
      handleMessage(socket, JSON.parse(raw.toString()));
    } catch {
      sendError(socket, "That message could not be understood.");
    }
  });
  socket.on("close", () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(item => item && item.id === socket.playerToken);
    if (!player || player.ws !== socket) return;
    player.ws = null;
    player.disconnectedAt = Date.now();
    room.message = `${player.name} disconnected. They can rejoin with the same room code.`;
    broadcast(room);
    if (room.players.every(item => !item || !item.ws)) {
      room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 10 * 60_000);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Kaat game server listening on ${PORT}`));
