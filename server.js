const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

const suits = ["♠", "♥", "♦", "♣"];
const ranks = [
    {name:"2", value:2}, {name:"3", value:3}, {name:"4", value:4}, {name:"5", value:5},
    {name:"6", value:6}, {name:"7", value:7}, {name:"8", value:8}, {name:"9", value:9},
    {name:"10", value:10}, {name:"J", value:11}, {name:"Q", value:12}, {name:"K", value:13}, {name:"A", value:14}
];

function createDeck() {
    let d = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            d.push({ suit, rank: rank.name, value: rank.value });
        }
    }
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

function startRound(room) {
    room.gameStarted = true;
    room.deck = createDeck();
    room.community = [];
    room.pot = 0;
    room.currentBet = 20; // Big Blind Awal
    room.stage = "preflop";

    room.players.forEach((p, idx) => {
        p.hand = [room.deck.pop(), room.deck.pop()];
        p.bet = 0;
        p.folded = false;
        p.isAllIn = false;
        
        // Auto-post Blind Awal
        let blind = (idx === 0) ? 10 : 20; // Player 0 Small Blind ($10), Player 1 Big Blind ($20)
        let actual = Math.min(p.chips, blind);
        p.chips -= actual;
        p.bet = actual;
        room.pot += actual;
    });

    room.activeTurnIndex = 0;
    io.to(room.id).emit('gameStateUpdate', room);
}

io.on('connection', (socket) => {
    // 1. Buat Room
    socket.on('createRoom', (data) => {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomId] = {
            id: roomId,
            players: [{
                id: socket.id,
                name: data.playerName || "Pemain 1",
                hand: [],
                chips: 1000,
                bet: 0,
                folded: false,
                isAllIn: false,
                isHost: true
            }],
            deck: [],
            community: [],
            pot: 0,
            currentBet: 20,
            activeTurnIndex: 0,
            stage: "preflop",
            gameStarted: false
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players, isHost: true });
    });

    // 2. Join Room & Otomatis Mulai Game
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (!room) return socket.emit('errorMsg', 'Kode Room tidak ditemukan!');
        if (room.players.length >= 5) return socket.emit('errorMsg', 'Room penuh (Maksimal 5 pemain)!');
        if (room.gameStarted) return socket.emit('errorMsg', 'Permainan sedang berjalan!');

        const newPlayer = {
            id: socket.id,
            name: data.playerName || `Pemain ${room.players.length + 1}`,
            hand: [],
            chips: 1000,
            bet: 0,
            folded: false,
            isAllIn: false,
            isHost: false
        };

        room.players.push(newPlayer);
        socket.join(data.roomId);
        
        io.to(data.roomId).emit('playerJoined', { roomId: data.roomId, players: room.players });

        // OTOMATIS MULAI GAME begitu ada pemain ke-2 bergabung
        if (room.players.length >= 2 && !room.gameStarted) {
            io.to(data.roomId).emit('autoStartNotice', { msg: "Pemain lengkap! Permainan dimulai dalam 2 detik..." });
            setTimeout(() => {
                if (rooms[data.roomId] && !rooms[data.roomId].gameStarted) {
                    startRound(rooms[data.roomId]);
                }
            }, 2000);
        }
    });

    // 3. Aksi Pemain (Fold, Check/Call, Raise, All-in)
    socket.on('playerAction', (data) => {
        const room = rooms[data.roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players[room.activeTurnIndex];
        if (!player || player.id !== socket.id) return;

        const action = data.action;

        if (action === 'fold') {
            player.folded = true;
        } else if (action === 'check' || action === 'call') {
            let need = room.currentBet - player.bet;
            if (need > player.chips) need = player.chips;
            player.chips -= need;
            player.bet += need;
            room.pot += need;
            if (player.chips === 0) player.isAllIn = true;
        } else if (action === 'raise') {
            let raiseAmt = parseInt(data.amount) || 50;
            let targetBet = room.currentBet + raiseAmt;
            let need = targetBet - player.bet;

            if (need > player.chips) {
                need = player.chips;
                targetBet = player.bet + need;
            }

            player.chips -= need;
            player.bet += need;
            room.pot += need;
            room.currentBet = targetBet;
            if (player.chips === 0) player.isAllIn = true;
        } else if (action === 'allin') {
            let amt = player.chips;
            player.bet += amt;
            room.pot += amt;
            player.chips = 0;
            player.isAllIn = true;
            if (player.bet > room.currentBet) room.currentBet = player.bet;
        }

        // Cek jika tersisa 1 pemain aktif yang tidak Fold
        const activePlayers = room.players.filter(p => !p.folded);
        if (activePlayers.length <= 1) {
            const winner = activePlayers[0];
            if (winner) winner.chips += room.pot;
            room.gameStarted = false;
            io.to(data.roomId).emit('gameOver', { winner: winner ? winner.name : "Pemain", pot: room.pot });
            return;
        }

        // Cek ronde taruhan selesai
        const isRoundComplete = activePlayers.every(p => p.bet === room.currentBet || p.isAllIn);

        if (isRoundComplete) {
            advanceStage(room);
        } else {
            do {
                room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
            } while (room.players[room.activeTurnIndex].folded || room.players[room.activeTurnIndex].isAllIn);
        }

        io.to(data.roomId).emit('gameStateUpdate', room);
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    io.to(roomId).emit('playerLeft', { players: room.players });
                }
                break;
            }
        }
    });
});

function advanceStage(room) {
    room.players.forEach(p => p.bet = 0);
    room.currentBet = 0;

    if (room.stage === "preflop") {
        room.stage = "flop";
        room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    } else if (room.stage === "flop") {
        room.stage = "turn";
        room.community.push(room.deck.pop());
    } else if (room.stage === "turn") {
        room.stage = "river";
        room.community.push(room.deck.pop());
    } else {
        // Showdown
        const active = room.players.filter(p => !p.folded);
        const winner = active[Math.floor(Math.random() * active.length)];
        if (winner) winner.chips += room.pot;
        room.gameStarted = false;
        io.to(room.id).emit('gameOver', { winner: winner.name, pot: room.pot });
        return;
    }

    room.activeTurnIndex = 0;
    while (room.players[room.activeTurnIndex].folded || room.players[room.activeTurnIndex].isAllIn) {
        room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
    }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
