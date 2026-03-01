// ===== 바둑이 온라인 멀티플레이어 서버 =====
// 실행: node server.js
// 접속: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ===== GAME STATE =====
const rooms = new Map(); // roomCode -> Room

class Room {
  constructor(code, maxPlayers) {
    this.code = code;
    this.maxPlayers = maxPlayers;
    this.players = []; // [{ws, name, chips, hand, bet, totalBet, folded, id}]
    this.state = 'waiting'; // waiting | buyin | playing
    this.pot = 0;
    this.currentBet = 0;
    this.currentPlayer = 0;
    this.exchangeRound = 0;
    this.phase = 'betting';
    this.deck = [];
    this.sb = 50;
    this.bb = 100;
    this.round = 1;
    this.dealerIdx = 0;
    this.lastRaiser = -1;
    this.acted = new Set();
    this.exHist = {};
    this.buyinAmount = 10000;
    this.buyinTotals = {};
  }

  addPlayer(ws, name) {
    const id = crypto.randomBytes(4).toString('hex');
    const player = { ws, name, chips: 0, hand: [], bet: 0, totalBet: 0, folded: false, id };
    this.players.push(player);
    this.buyinTotals[this.players.length - 1] = 0;
    this.exHist[this.players.length - 1] = [null, null, null];
    return player;
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx >= 0) {
      this.players.splice(idx, 1);
      // Rebuild indices
      this.buyinTotals = {};
      this.exHist = {};
      this.players.forEach((_, i) => {
        this.buyinTotals[i] = 0;
        this.exHist[i] = [null, null, null];
      });
    }
    return this.players.length;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    this.players.forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    });
  }

  sendTo(playerIdx, msg) {
    const p = this.players[playerIdx];
    if (p && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
  }

  getPublicState(forPlayerIdx) {
    return {
      type: 'state',
      roomCode: this.code,
      phase: this.phase,
      pot: this.pot,
      currentBet: this.currentBet,
      currentPlayer: this.currentPlayer,
      exchangeRound: this.exchangeRound,
      round: this.round,
      dealerIdx: this.dealerIdx,
      sb: this.sb,
      bb: this.bb,
      buyinAmount: this.buyinAmount,
      state: this.state,
      myIndex: forPlayerIdx,
      players: this.players.map((p, i) => ({
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        totalBet: p.totalBet,
        folded: p.folded,
        isDealer: i === this.dealerIdx,
        handCount: p.hand.length,
        // Only show own cards or showdown cards
        hand: (i === forPlayerIdx || this.phase === 'showdown') ? p.hand : null,
        buyinTotal: this.buyinTotals[i] || 0,
      })),
      exHist: this.exHist,
    };
  }

  // ===== GAME LOGIC =====
  startRound() {
    this.deck = this.createDeck();
    this.pot = 0; this.currentBet = 0; this.exchangeRound = 0;
    this.phase = 'betting'; this.lastRaiser = -1; this.acted = new Set();
    this.players.forEach((p, i) => {
      p.hand = []; p.bet = 0; p.totalBet = 0; p.folded = false;
      this.exHist[i] = [null, null, null];
    });
    this.dealerIdx = this.dealerIdx % this.players.length;

    // Deal 4 cards
    for (let c = 0; c < 4; c++) {
      for (let p = 0; p < this.players.length; p++) {
        this.players[p].hand.push(this.deck.pop());
      }
    }

    // Blinds
    const sbIdx = (this.dealerIdx + 1) % this.players.length;
    const bbIdx = (this.dealerIdx + 2) % this.players.length;
    this.postBlind(sbIdx, this.sb);
    this.postBlind(bbIdx, this.bb);
    this.currentBet = this.bb;
    this.currentPlayer = (bbIdx + 1) % this.players.length;
    this.state = 'playing';

    this.broadcastState();
    this.broadcast({ type: 'toast', msg: `라운드 ${this.round} 시작!` });
    this.broadcast({ type: 'sound', sound: 'deal' });
  }

  postBlind(i, amt) {
    const a = Math.min(amt, this.players[i].chips);
    this.players[i].chips -= a;
    this.players[i].bet = a;
    this.players[i].totalBet = a;
    this.pot += a;
  }

  applyBuyin(amount) {
    this.buyinAmount = amount;
    this.players.forEach((p, i) => {
      p.chips = amount;
      this.buyinTotals[i] = (this.buyinTotals[i] || 0) + amount;
    });
  }

  createDeck() {
    const SUITS = ['♠','♥','♦','♣'];
    const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    let d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  handleAction(playerIdx, action) {
    if (this.currentPlayer !== playerIdx) return;
    const p = this.players[playerIdx];

    if (this.phase === 'exchange') {
      if (action.type === 'exchange') {
        const indices = action.indices || [];
        this.exHist[playerIdx][this.exchangeRound - 1] = indices.length === 0 ? 'S' : indices.length;
        this.exchangeCards(playerIdx, indices);
        this.broadcast({ type: 'toast', msg: `${p.name} ${indices.length ? indices.length + '장 교환' : '스테이'}` });
        this.broadcast({ type: 'sound', sound: indices.length ? 'exchange' : 'check' });
      }
      return;
    }

    // Betting
    if (action.type === 'fold') {
      p.folded = true;
      this.broadcast({ type: 'toast', msg: `${p.name} 폴드` });
      this.broadcast({ type: 'sound', sound: 'fold' });
    } else if (action.type === 'check') {
      if (this.currentBet > p.bet) return;
      this.broadcast({ type: 'toast', msg: `${p.name} 체크` });
      this.broadcast({ type: 'sound', sound: 'check' });
    } else if (action.type === 'call') {
      const need = this.currentBet - p.bet;
      const a = Math.min(need, p.chips);
      p.chips -= a; p.bet += a; p.totalBet += a; this.pot += a;
      this.broadcast({ type: 'toast', msg: `${p.name} 콜 ${a.toLocaleString()}` });
      this.broadcast({ type: 'sound', sound: 'chip' });
    } else if (action.type === 'raise') {
      const raiseAmt = action.amount || this.bb;
      const need = (this.currentBet - p.bet) + raiseAmt;
      const a = Math.min(need, p.chips);
      p.chips -= a; p.bet += a; p.totalBet += a; this.pot += a;
      this.currentBet = p.bet; this.lastRaiser = playerIdx;
      this.acted = new Set([playerIdx]);
      this.broadcast({ type: 'toast', msg: `${p.name} 레이즈 → ${p.bet.toLocaleString()}` });
      this.broadcast({ type: 'sound', sound: 'raise' });
      this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
      this.processTurn();
      return;
    }

    this.acted.add(playerIdx);
    this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
    this.processTurn();
  }

  exchangeCards(pi, indices) {
    indices.sort((a, b) => b - a);
    for (const idx of indices) {
      this.players[pi].hand.splice(idx, 1);
      if (this.deck.length) this.players[pi].hand.push(this.deck.pop());
    }
    this.acted.add(pi);
    this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
    this.processExchangeTurn();
  }

  processTurn() {
    // Skip folded
    let safe = 0;
    while (this.players[this.currentPlayer].folded && safe < 10) {
      this.currentPlayer = (this.currentPlayer + 1) % this.players.length; safe++;
    }

    const active = this.players.filter(p => !p.folded);
    if (active.length === 1) { this.endRound(active[0]); return; }
    if (this.isBettingComplete()) { this.endBettingRound(); return; }

    this.broadcastState();
    // Notify whose turn
    this.broadcast({ type: 'turn', player: this.currentPlayer });
  }

  isBettingComplete() {
    const active = this.players.filter(p => !p.folded);
    if (active.length <= 1) return true;
    return active.every(p => this.acted.has(this.players.indexOf(p)))
      && active.every(p => p.bet === this.currentBet || p.chips === 0);
  }

  endBettingRound() {
    this.players.forEach(p => { p.bet = 0; });
    this.currentBet = 0; this.acted = new Set(); this.lastRaiser = -1;

    if (this.exchangeRound >= 3 || this.phase === 'final-bet') {
      this.phase = 'showdown';
      this.broadcastState();
      setTimeout(() => this.showdown(), 1000);
    } else {
      this.exchangeRound++;
      this.phase = 'exchange';
      this.currentPlayer = (this.dealerIdx + 1) % this.players.length;
      let s = 0;
      while (this.players[this.currentPlayer].folded && s < 10) {
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length; s++;
      }
      const names = ['🌅 아침','☀️ 점심','🌙 저녁'];
      this.broadcast({ type: 'toast', msg: `${names[this.exchangeRound-1]} - ${this.exchangeRound}차 교환` });
      this.broadcastState();
      this.processExchangeTurn();
    }
  }

  processExchangeTurn() {
    if (this.phase !== 'exchange') return;
    const active = this.players.filter(p => !p.folded);
    if (this.acted.size >= active.length) {
      this.phase = this.exchangeRound >= 3 ? 'final-bet' : 'betting';
      this.acted = new Set();
      this.currentPlayer = (this.dealerIdx + 1) % this.players.length;
      let s = 0;
      while (this.players[this.currentPlayer].folded && s < 10) {
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length; s++;
      }
      this.broadcastState();
      this.processTurn();
      return;
    }
    let s = 0;
    while (this.players[this.currentPlayer].folded && s < 10) {
      this.currentPlayer = (this.currentPlayer + 1) % this.players.length; s++;
    }
    this.broadcastState();
    this.broadcast({ type: 'turn', player: this.currentPlayer });
  }

  showdown() {
    const active = this.players.filter(p => !p.folded);
    if (active.length === 1) { this.endRound(active[0]); return; }
    let best = null, bestScore = -1;
    active.forEach(p => {
      const ev = evalBadugi(p.hand);
      p._eval = ev;
      if (ev.score > bestScore) { bestScore = ev.score; best = p; }
    });
    this.endRound(best);
  }

  endRound(winner) {
    winner.chips += this.pot;
    this.phase = 'showdown';
    this.broadcast({ type: 'sound', sound: 'win' });
    this.broadcastState();

    const winnerEval = evalBadugi(winner.hand);
    const results = this.players.map((p, i) => ({
      name: p.name,
      hand: p.hand,
      folded: p.folded,
      eval: p.folded ? { name: '폴드' } : evalBadugi(p.hand),
      isWinner: p === winner,
      exHist: this.exHist[i],
    }));

    this.broadcast({
      type: 'roundEnd',
      winner: winner.name,
      pot: this.pot,
      winnerEval: winnerEval.name,
      results,
    });

    this.state = 'waiting-next';
  }

  nextRound() {
    this.round++;
    this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
    // 칩 0인 사람만 리바인
    let rebuyNames = [];
    this.players.forEach((p, i) => {
      if (p.chips <= 0) {
        p.chips = this.buyinAmount;
        this.buyinTotals[i] = (this.buyinTotals[i] || 0) + this.buyinAmount;
        rebuyNames.push(p.name);
      }
    });
    if (rebuyNames.length > 0) {
      this.broadcast({ type: 'toast', msg: `${rebuyNames.join(', ')} 리바인` });
      this.broadcast({ type: 'sound', sound: 'chip' });
    }
    this.startRound();
  }

  broadcastState() {
    this.players.forEach((_, i) => {
      this.sendTo(i, this.getPublicState(i));
    });
  }
}

// ===== BADUGI EVAL (server-side) =====
const RV = {A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13};

function evalBadugi(hand) {
  const best = getBest(hand);
  const cnt = best.length;
  const v = best.map(c => RV[c.rank]).sort((a,b) => a-b);
  let name = '', score = 0;
  if (cnt === 4) {
    score = 40000 - v.reduce((a,x) => a*14+x, 0);
    if (v[0]===1&&v[1]===2&&v[2]===3&&v[3]===4) { name='🏆 골프 (A-2-3-4)'; score=50000; }
    else if (v[0]===1&&v[1]===2&&v[2]===3&&v[3]===5) { name='세컨드 (A-2-3-5)'; score=49000; }
    else name = `바둑이 (${best.map(c=>c.rank).join('-')})`;
  } else if (cnt === 3) { score=30000-v.reduce((a,x)=>a*14+x,0); name=`베이스 (${best.map(c=>c.rank).join('-')})`; }
  else if (cnt === 2) { score=20000-v.reduce((a,x)=>a*14+x,0); name=`투베이스 (${best.map(c=>c.rank).join('-')})`; }
  else { score=10000-v[0]; name='원카드'; }
  return { name, score, cards: best };
}

function getBest(hand) {
  for (let sz = 4; sz >= 1; sz--) {
    const combos = getCombos(hand, sz);
    let best = null, bs = Infinity;
    for (const co of combos) {
      const su = new Set(co.map(c=>c.suit)), ra = new Set(co.map(c=>RV[c.rank]));
      if (su.size===co.length && ra.size===co.length) {
        const sc = co.reduce((a,c) => a+RV[c.rank], 0);
        if (sc < bs) { best=co; bs=sc; }
      }
    }
    if (best) return best;
  }
  return [hand.reduce((a,c) => RV[c.rank]<RV[a.rank]?c:a)];
}

function getCombos(a, s) {
  if (s===1) return a.map(x=>[x]);
  const r = [];
  for (let i=0; i<=a.length-s; i++) for (const c of getCombos(a.slice(i+1),s-1)) r.push([a[i],...c]);
  return r;
}

// ===== GENERATE ROOM CODE =====
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genRoomCode() : code;
}

// ===== HTTP SERVER =====
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Server Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

// ===== WEBSOCKET SERVER (ws library) =====
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  handleConnection(ws);
});

// ===== CONNECTION HANDLER =====
function handleConnection(ws) {
  let playerRoom = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'create': {
        const code = genRoomCode();
        const room = new Room(code, msg.maxPlayers || 4);
        rooms.set(code, room);
        const player = room.addPlayer(ws, msg.name);
        playerRoom = room;
        playerId = player.id;
        ws.send(JSON.stringify({ type: 'created', roomCode: code, playerId: player.id }));
        room.broadcastState();
        console.log(`[${code}] Room created by ${msg.name}`);
        break;
      }

      case 'join': {
        const code = (msg.roomCode || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: '방을 찾을 수 없습니다' })); return; }
        if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: '방이 가득 찼습니다' })); return; }
        if (room.state !== 'waiting') { ws.send(JSON.stringify({ type: 'error', msg: '이미 게임이 진행 중입니다' })); return; }
        const player = room.addPlayer(ws, msg.name);
        playerRoom = room;
        playerId = player.id;
        ws.send(JSON.stringify({ type: 'joined', roomCode: code, playerId: player.id }));
        room.broadcast({ type: 'toast', msg: `${msg.name} 입장!` });
        room.broadcastState();
        console.log(`[${code}] ${msg.name} joined (${room.players.length}/${room.maxPlayers})`);
        break;
      }

      case 'buyin': {
        if (!playerRoom) return;
        const hostIdx = playerRoom.players.findIndex(p => p.id === playerId);
        if (hostIdx !== 0) return; // Only host can start
        playerRoom.applyBuyin(msg.amount || 10000);
        playerRoom.startRound();
        console.log(`[${playerRoom.code}] Round ${playerRoom.round} started (buyin: ${msg.amount})`);
        break;
      }

      case 'action': {
        if (!playerRoom || playerRoom.state !== 'playing') return;
        const idx = playerRoom.players.findIndex(p => p.id === playerId);
        if (idx < 0) return;
        playerRoom.handleAction(idx, msg.action);
        break;
      }

      case 'nextRound': {
        if (!playerRoom) return;
        const idx = playerRoom.players.findIndex(p => p.id === playerId);
        if (idx !== 0) return; // Only host
        playerRoom.nextRound();
        console.log(`[${playerRoom.code}] Round ${playerRoom.round} (re-buyin)`);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerRoom && playerId) {
      const name = playerRoom.players.find(p => p.id === playerId)?.name || '?';
      const remaining = playerRoom.removePlayer(playerId);
      if (remaining === 0) {
        rooms.delete(playerRoom.code);
        console.log(`[${playerRoom.code}] Room closed`);
      } else {
        playerRoom.broadcast({ type: 'toast', msg: `${name} 퇴장` });
        playerRoom.broadcastState();
      }
    }
  });
}

// ===== START =====
server.listen(PORT, () => {
  console.log(`\n  🎴 바둑이 온라인 서버`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  로컬:  http://localhost:${PORT}`);
  console.log(`  \n  친구에게 공유하려면:`);
  console.log(`  1. ngrok http ${PORT}`);
  console.log(`  2. 또는 같은 네트워크: http://<내IP>:${PORT}\n`);
});
