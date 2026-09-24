const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
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

io.on('connection', (socket) => {
    console.log('Player terhubung:', socket.id);

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
                isHost: true
            }],
            deck: [],
            community: [],
            pot: 0,
            currentBet: 20,
            activeTurnIndex: 0,
            gameStarted: false
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players, isHost: true });
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (!room) {
            socket.emit('errorMsg', 'Kode Room tidak ditemukan!');
            return;
        }
        if (room.players.length >= 5) {
            socket.emit('errorMsg', 'Room sudah penuh (Maksimal 5 pemain)!');
            return;
        }
        if (room.gameStarted) {
            socket.emit('errorMsg', 'Permainan sedang berjalan!');
            return;
        }

        const newPlayer = {
            id: socket.id,
            name: data.playerName || "Pemain",
            hand: [],
            chips: 1000,
            bet: 0,
            folded: false,
            isHost: false
        };

        room.players.push(newPlayer);
        socket.join(data.roomId);
        io.to(data.roomId).emit('playerJoined', { roomId: data.roomId, players: room.players });
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        room.gameStarted = true;
        room.deck = createDeck();
        room.community = [room.deck.pop(), room.deck.pop(), room.deck.pop()]; // Flop awal
        room.pot = 0;
        room.currentBet = 20;

        room.players.forEach(p => {
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.bet = 0;
            p.folded = false;
        });

        room.activeTurnIndex = 0;
        io.to(data.roomId).emit('gameStateUpdate', room);
    });

    socket.on('playerAction', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        const player = room.players[room.activeTurnIndex];
        if (!player || player.id !== socket.id) return;

        if (data.action === 'fold') {
            player.folded = true;
        } else if (data.action === 'check' || data.action === 'call') {
            let need = room.currentBet - player.bet;
            player.chips -= need;
            player.bet += need;
            room.pot += need;
        } else if (data.action === 'raise') {
            let raiseAmt = parseInt(data.amount) || 50;
            let need = (room.currentBet + raiseAmt) - player.bet;
            player.chips -= need;
            player.bet += need;
            room.pot += need;
            room.currentBet = player.bet;
        }

        do {
            room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
        } while (room.players[room.activeTurnIndex].folded && room.players.filter(p => !p.folded).length > 1);

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

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));