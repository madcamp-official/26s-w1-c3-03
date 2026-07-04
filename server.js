const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CONFIG = {
  ROUNDS: 5,
  GUESS_TIME_MS: 30000,
  PEEK_TIME_MS: 10000,
  FINAL_TIME_MS: 30000,
  MIN_PLAYERS_TO_START: 1,
  POINTS: {
    1: [5],
    2: [5, 3],
    3: [5, 3, 1],
    4: [5, 4, 2, 1],
    5: [5, 4, 3, 2, 1]
  }
};

const activeRooms = new Map();

app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "Game_Screen.html"));
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase() || "ROOM_777";
}

function normalizeNickname(nickname) {
  return String(nickname || "").trim().slice(0, 18) || "Player";
}

function sanitizeRgb(rgb) {
  if (!rgb) return null;
  const cleaned = {};
  for (const channel of ["r", "g", "b"]) {
    const value = Number(rgb[channel]);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    cleaned[channel] = value;
  }
  return cleaned;
}

function feedbackTier(target, guess) {
  const error = Math.abs(target - guess);
  if (error === 0) return "blue";
  if (error <= 10) return "green";
  if (error <= 50) return "yellow";
  if (error <= 150) return "orange";
  return "red";
}

function errorsFor(target, guess) {
  return {
    r: Math.abs(target.r - guess.r),
    g: Math.abs(target.g - guess.g),
    b: Math.abs(target.b - guess.b)
  };
}

function generateTarget(level) {
  const colorCount = clamp(Number(level) || 1, 1, 5);
  const colors = [];
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (let i = 0; i < colorCount; i += 1) {
    const color = {
      r: Math.floor(Math.random() * 256),
      g: Math.floor(Math.random() * 256),
      b: Math.floor(Math.random() * 256)
    };
    colors.push(color);
    totalR += color.r;
    totalG += color.g;
    totalB += color.b;
  }

  return {
    colors,
    average: {
      r: Math.round(totalR / colorCount),
      g: Math.round(totalG / colorCount),
      b: Math.round(totalB / colorCount)
    }
  };
}

function publicPlayers(room) {
  return room.players.map((player, index) => ({
    userId: player.userId,
    nickname: player.nickname,
    index,
    isHost: player.socketId === room.hostSocketId
  }));
}

function hostUserId(room) {
  return room.players.find((player) => player.socketId === room.hostSocketId)?.userId || null;
}

function emitRoomUpdate(room) {
  io.to(room.roomCode).emit("room_update", {
    roomCode: room.roomCode,
    phase: room.phase,
    players: publicPlayers(room),
    hostUserId: hostUserId(room)
  });
}

function sendError(socket, message) {
  socket.emit("game_error", { message });
}

function clearRoomTimer(room) {
  clearTimeout(room.timerRef);
  room.timerRef = null;
}

function createRoom(roomCode, hostSocketId) {
  return {
    roomCode,
    hostSocketId,
    phase: "WAITING",
    level: 1,
    round: 0,
    turnIndex: 0,
    players: [],
    targetData: null,
    currentTurnData: null,
    peekedUsers: new Set(),
    finalSubmissions: new Set(),
    timerRef: null
  };
}

function resetPlayerRoundState(room) {
  room.players.forEach((player) => {
    player.finalGuess = null;
    player.finalErrorSum = null;
  });
}

function startGame(room, level) {
  clearRoomTimer(room);
  room.phase = "PLAYING";
  room.level = clamp(Number(level) || 1, 1, 5);
  room.round = 0;
  room.turnIndex = 0;
  room.targetData = generateTarget(room.level);
  room.currentTurnData = null;
  room.peekedUsers = new Set();
  room.finalSubmissions = new Set();
  resetPlayerRoundState(room);
  startRound(room);
}

function startRound(room) {
  clearRoomTimer(room);
  room.round += 1;
  room.turnIndex = 0;
  room.currentTurnData = null;
  room.peekedUsers = new Set();

  io.to(room.roomCode).emit("round_start", {
    round: room.round,
    totalRounds: CONFIG.ROUNDS,
    colors: room.targetData.colors,
    players: publicPlayers(room)
  });

  startGuessingPhase(room);
}

function startGuessingPhase(room) {
  clearRoomTimer(room);
  room.phase = "GUESSING";
  room.currentTurnData = null;
  room.peekedUsers = new Set();
  emitRoomUpdate(room);

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer) {
    startFinalGuess(room);
    return;
  }

  io.to(room.roomCode).emit("turn_start", {
    round: room.round,
    turnUserId: currentPlayer.userId,
    turnNickname: currentPlayer.nickname,
    turnIndex: room.turnIndex,
    timeLimit: CONFIG.GUESS_TIME_MS / 1000,
    players: publicPlayers(room)
  });

  room.timerRef = setTimeout(() => {
    io.to(room.roomCode).emit("turn_timeout", {
      turnUserId: currentPlayer.userId
    });
    advanceTurn(room);
  }, CONFIG.GUESS_TIME_MS);
}

function startPeekingPhase(room) {
  clearRoomTimer(room);
  room.phase = "PEEKING";
  room.peekedUsers = new Set();
  emitRoomUpdate(room);

  const guesser = room.players[room.turnIndex];
  if (room.players.length <= 1) {
    room.timerRef = setTimeout(() => advanceTurn(room), 2000);
    return;
  }

  io.to(room.roomCode).emit("peeking_start", {
    round: room.round,
    turnUserId: guesser.userId,
    turnNickname: guesser.nickname,
    timeLimit: CONFIG.PEEK_TIME_MS / 1000
  });

  room.timerRef = setTimeout(() => {
    advanceTurn(room);
  }, CONFIG.PEEK_TIME_MS);
}

function advanceTurn(room) {
  clearRoomTimer(room);
  if (room.phase === "GAME_OVER") return;

  room.currentTurnData = null;
  room.peekedUsers = new Set();
  room.turnIndex += 1;

  if (room.turnIndex >= room.players.length) {
    if (room.round >= CONFIG.ROUNDS) {
      startFinalGuess(room);
    } else {
      startRound(room);
    }
    return;
  }

  startGuessingPhase(room);
}

function startFinalGuess(room) {
  clearRoomTimer(room);
  room.phase = "FINAL_GUESS";
  room.finalSubmissions = new Set();
  emitRoomUpdate(room);

  io.to(room.roomCode).emit("final_guess_start", {
    timeLimit: CONFIG.FINAL_TIME_MS / 1000,
    colors: room.targetData.colors
  });

  room.timerRef = setTimeout(() => {
    endGame(room);
  }, CONFIG.FINAL_TIME_MS);
}

function endGame(room) {
  clearRoomTimer(room);
  room.phase = "GAME_OVER";
  const target = room.targetData.average;

  room.players.forEach((player) => {
    if (!player.finalGuess) {
      player.finalGuess = { r: 0, g: 0, b: 0 };
      player.finalErrorSum = Math.abs(target.r) + Math.abs(target.g) + Math.abs(target.b);
    }
  });

  const sortedPlayers = [...room.players].sort((a, b) => a.finalErrorSum - b.finalErrorSum);
  const pointArray = CONFIG.POINTS[sortedPlayers.length] || [];
  const results = sortedPlayers.map((player, index) => ({
    userId: player.userId,
    nickname: player.nickname,
    rank: index + 1,
    earnedPoint: pointArray[index] || 0,
    finalError: player.finalErrorSum,
    finalGuess: player.finalGuess
  }));

  io.to(room.roomCode).emit("game_over", {
    targetRgb: target,
    results
  });

  activeRooms.delete(room.roomCode);
}

io.on("connection", (socket) => {
  socket.on("join_room", ({ roomCode, userId, nickname }) => {
    const cleanRoomCode = normalizeRoomCode(roomCode);
    const cleanUserId = String(userId || socket.id);
    const cleanNickname = normalizeNickname(nickname);

    if (!activeRooms.has(cleanRoomCode)) {
      activeRooms.set(cleanRoomCode, createRoom(cleanRoomCode, socket.id));
    }

    const room = activeRooms.get(cleanRoomCode);
    if (room.phase !== "WAITING") {
      sendError(socket, "This room already started.");
      return;
    }

    const existingPlayer = room.players.find((player) => player.userId === cleanUserId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.nickname = cleanNickname;
    } else {
      room.players.push({
        socketId: socket.id,
        userId: cleanUserId,
        nickname: cleanNickname,
        finalGuess: null,
        finalErrorSum: null
      });
    }

    socket.join(cleanRoomCode);
    emitRoomUpdate(room);
  });

  socket.on("start_game", ({ roomCode, level }) => {
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room) {
      sendError(socket, "Join a room first.");
      return;
    }
    if (room.hostSocketId !== socket.id) {
      sendError(socket, "Only the host can start the game.");
      return;
    }
    if (room.phase !== "WAITING") {
      sendError(socket, "The game already started.");
      return;
    }
    if (room.players.length < CONFIG.MIN_PLAYERS_TO_START) {
      sendError(socket, `Need at least ${CONFIG.MIN_PLAYERS_TO_START} player(s).`);
      return;
    }

    startGame(room, level);
  });

  socket.on("submit_guess", ({ roomCode, guessRGB }) => {
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "GUESSING") return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.socketId !== socket.id) return;

    const cleanGuess = sanitizeRgb(guessRGB);
    if (!cleanGuess) {
      sendError(socket, "Guess must use RGB numbers from 0 to 255.");
      return;
    }

    clearRoomTimer(room);
    const target = room.targetData.average;
    const errors = errorsFor(target, cleanGuess);
    const feedback = {
      r: feedbackTier(target.r, cleanGuess.r),
      g: feedbackTier(target.g, cleanGuess.g),
      b: feedbackTier(target.b, cleanGuess.b)
    };

    room.currentTurnData = {
      playerId: currentPlayer.userId,
      guessRGB: cleanGuess,
      feedback,
      errors
    };

    socket.emit("my_guess_result", {
      guessRGB: cleanGuess,
      feedback,
      errors
    });

    startPeekingPhase(room);
  });

  socket.on("peek_color", ({ roomCode, selectedColor }) => {
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "PEEKING" || !room.currentTurnData) return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.socketId === socket.id) return;
    if (room.peekedUsers.has(socket.id)) return;

    const channel = String(selectedColor || "").toLowerCase();
    if (!["r", "g", "b"].includes(channel)) return;

    room.peekedUsers.add(socket.id);
    socket.emit("peek_result", {
      selectedColor: channel,
      resultColor: room.currentTurnData.feedback[channel],
      guessValue: room.currentTurnData.guessRGB[channel]
    });

    if (room.peekedUsers.size >= room.players.length - 1) {
      clearRoomTimer(room);
      room.timerRef = setTimeout(() => advanceTurn(room), 2000);
    }
  });

  socket.on("submit_final_guess", ({ roomCode, guessRGB }) => {
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "FINAL_GUESS") return;

    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player || room.finalSubmissions.has(socket.id)) return;

    const cleanGuess = sanitizeRgb(guessRGB);
    if (!cleanGuess) {
      sendError(socket, "Final guess must use RGB numbers from 0 to 255.");
      return;
    }

    const target = room.targetData.average;
    const errors = errorsFor(target, cleanGuess);
    player.finalGuess = cleanGuess;
    player.finalErrorSum = errors.r + errors.g + errors.b;
    room.finalSubmissions.add(socket.id);

    socket.emit("final_guess_received");

    if (room.finalSubmissions.size >= room.players.length) {
      endGame(room);
    }
  });

  socket.on("disconnect", () => {
    activeRooms.forEach((room, roomCode) => {
      const index = room.players.findIndex((player) => player.socketId === socket.id);
      if (index === -1) return;

      const wasCurrentTurn = index === room.turnIndex;
      room.players.splice(index, 1);

      if (room.players.length === 0) {
        clearRoomTimer(room);
        activeRooms.delete(roomCode);
        return;
      }

      if (room.hostSocketId === socket.id) {
        room.hostSocketId = room.players[0].socketId;
      }

      if (room.phase === "WAITING") {
        emitRoomUpdate(room);
        return;
      }

      if (room.turnIndex >= room.players.length) {
        room.turnIndex = 0;
      }

      emitRoomUpdate(room);
      if (wasCurrentTurn && (room.phase === "GUESSING" || room.phase === "PEEKING")) {
        advanceTurn(room);
      }
    });
  });
});

server.listen(3000, () => {
  console.log("RGB Guess server running at http://localhost:3000");
});
