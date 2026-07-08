/*
  Color Master backend server.

  The browser code in Public/common.js, Public/lobby.js, and Public/game.js
  controls the screens that each player sees. This file controls the shared
  multiplayer state:
  - which rooms exist
  - who is in each room
  - whose turn it is
  - what the hidden target color is
  - when each phase starts and ends
  - what Socket.IO messages are sent to browsers

  Important idea:
  The server is the source of truth. A browser may display a timer or input UI,
  but this file decides whether a guess is accepted and when the game advances.
*/

// path is a built-in Node.js module for safely building file paths.
const path = require("path");

// fs reads the Firebase service-account JSON file from disk.
const fs = require("fs");

// crypto creates a random download token for uploaded profile images.
const crypto = require("crypto");

// express serves the HTML/CSS/JS/image files to the browser.
const express = require("express");

// http creates the actual web server that Express and Socket.IO share.
const http = require("http");

// firebase-admin lets this trusted Node server write to Firestore/Storage.
const { initializeApp, cert } = require("firebase-admin/app");
// const { getFirestore } = require("firebase-admin/firestore");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");

// multer parses multipart/form-data file uploads from the browser.
const multer = require("multer");

// Socket.IO provides real-time browser <-> server events.
const { Server } = require("socket.io");

// app is the Express application. It handles normal web requests.
const app = express();

// server is the lower-level HTTP server. Socket.IO attaches to this too.
const server = http.createServer(app);

// io is the Socket.IO server. Use it to listen for connections and emit events.
const io = new Server(server);

app.use(express.json({ limit: "32kb" }));
app.use(express.text({ type: "text/plain", limit: "32kb" }));

const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "colormaster-madcamp.firebasestorage.app";
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  || path.join(__dirname, "secrets", "firebase-service-account.json");

let adminDb = null;
let adminBucket = null;
let adminAuth = null;

function initializeFirebaseAdmin() {
  /*
    This server-side Firebase connection is used only for trusted backend work.
    The service account file must stay out of Git because it is a private key.
  */
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn(`Firebase service account not found: ${SERVICE_ACCOUNT_PATH}`);
    console.warn("Profile image upload API will return 503 until it is configured.");
    return;
  }

  const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
  const firebaseApp = initializeApp({
    credential: cert(serviceAccount),
    storageBucket: FIREBASE_STORAGE_BUCKET
  });

  adminDb = getFirestore(firebaseApp);
  adminBucket = getStorage(firebaseApp).bucket();
  adminAuth = getAuth(firebaseApp);
}

initializeFirebaseAdmin();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

function profileImageProxyUrl(filePath) {
  // Store and return an app-local URL so browsers load images through EC2.
  return `/api/profile-image-file?path=${encodeURIComponent(filePath)}`;
}

function cleanProfileImagePath(rawPath) {
  /*
    Only allow files inside the profile_images folder.
    This prevents the image proxy from becoming a general Firebase file reader.
  */
  const filePath = String(rawPath || "").trim();
  if (!filePath.startsWith("profile_images/") || filePath.includes("..")) return "";
  return filePath;
}

async function deleteUserSubcollectionAdmin(userId, subcollectionName) {
  const snapshot = await adminDb.collection("User").doc(userId).collection(subcollectionName).get();
  await Promise.all(snapshot.docs.map((itemDoc) => itemDoc.ref.delete()));
}

async function deleteGuestAccountAdmin(userId) {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId || !adminDb) return false;

  const userDocRef = adminDb.collection("User").doc(cleanUserId);
  const userDoc = await userDocRef.get();
  if (!userDoc.exists) return false;

  const userData = userDoc.data() || {};
  if (!userData.isGuest) return false;

  const friendsSnapshot = await userDocRef.collection("Friends").get();
  await Promise.all(friendsSnapshot.docs.map((friendDoc) => {
    const friendData = friendDoc.data() || {};
    const friendUserId = friendData.fd_id || friendData.userId || friendDoc.id;
    return adminDb.collection("User").doc(friendUserId).collection("Friends").doc(cleanUserId).delete();
  }));

  await Promise.all([
    deleteUserSubcollectionAdmin(cleanUserId, "Friends"),
    deleteUserSubcollectionAdmin(cleanUserId, "Mailbox")
  ]);

  await userDocRef.delete();
  if (adminAuth) {
    await adminAuth.deleteUser(cleanUserId).catch((error) => {
      if (error?.code !== "auth/user-not-found") throw error;
    });
  }
  return true;
}

/*
  Central game settings.

  Times are stored in milliseconds because setTimeout uses milliseconds.
  When sending time limits to the browser, this file divides by 1000 so the
  frontend can display seconds.
*/
const CONFIG = {
  ROUNDS: 5,
  GUESS_TIME_MS: 30000,
  PEEK_TIME_MS: 10000,
  FINAL_TIME_MS: 30000,
  MIN_PLAYERS_TO_START: 2,
  MAX_PLAYERS_PER_ROOM: 5,

  /*
    POINTS maps player count -> points by final rank.
    Example with 3 players:
    rank 1 earns 5, rank 2 earns 3, rank 3 earns 1.
  */
  POINTS: {
    // 1: [5],
    2: [10, -10],
    3: [10, 0, -10],
    4: [10, 5, -5, -10],
    5: [10, 5, 0, -5, -10]
  }
};

/*
  activeRooms stores every currently running/waiting room.

  A Map is like an object/dictionary, but it is designed for key-value storage.
  Key: room code string, such as "ROOM_777"
  Value: room object created by createRoom(...)
*/
const activeRooms = new Map();

/*
  Static file folders after the project hierarchy change:
  - Public contains browser files such as HTML, CSS, and frontend JS.
  - Images contains PNG assets used by the HTML.

  app.use(express.static(PUBLIC_DIR)) lets the browser request:
  /auth.js
  /lobby.js
  /game.js

  app.use("/Images", express.static(IMAGE_DIR)) lets the browser request:
  /Images/exit_icon.png
*/
const PUBLIC_DIR = path.join(__dirname, "Public");
const IMAGE_DIR = path.join(__dirname, "Images");
const BGM_DIR = path.join(__dirname, "BGM");
const AUTH_HTML = path.join(PUBLIC_DIR, "auth.html");
const LOBBY_HTML = path.join(PUBLIC_DIR, "lobby.html");
const GAME_HTML = path.join(PUBLIC_DIR, "game.html");

// Split top-level pages.
app.get(["/", "/login", "/auth.html", "/index.html"], (_req, res) => {
  res.sendFile(AUTH_HTML);
});

app.get("/lobby.html", (_req, res) => {
  res.sendFile(LOBBY_HTML);
});

app.get("/game.html", (_req, res) => {
  res.sendFile(GAME_HTML);
});

app.get("/login.js", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "login.js"));
});

app.get("/auth.css", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "auth.css"));
});

app.get("/common.css", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "common.css"));
});

app.get("/lobby.css", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "lobby.css"));
});

app.get("/game.css", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "game.css"));
});

app.post("/api/guest-logout", async (req, res) => {
  try {
    if (!adminDb) {
      return res.status(503).json({ error: "Firebase Admin is not configured on the server." });
    }

    let body = {};
    if (typeof req.body === "string") {
      try {
        body = JSON.parse(req.body || "{}");
      } catch (_error) {
        body = {};
      }
    } else {
      body = req.body || {};
    }

    const deleted = await deleteGuestAccountAdmin(body.userId || req.query.userId);
    res.json({ deleted });
  } catch (error) {
    console.error("Guest logout cleanup failed:", error);
    res.status(500).json({ error: "Guest logout cleanup failed." });
  }
});

app.post("/api/profile-image", upload.single("profileImage"), async (req, res) => {
  /*
    Profile image upload proxy:
    Browser -> this Express server -> Firebase Storage + Firestore.

    This avoids uploading directly from the browser to Firebase Storage. On EC2,
    this same route will run on the Ubuntu server and the upload traffic to
    Firebase will originate from EC2.
  */
  try {
    if (!adminDb || !adminBucket) {
      return res.status(503).json({ error: "Firebase Admin is not configured on the server." });
    }

    const userId = String(req.body.userId || "").trim();
    const file = req.file;
    const allowedTypes = new Map([
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
      ["image/gif", "gif"]
    ]);

    if (!userId) {
      return res.status(400).json({ error: "Missing userId." });
    }

    if (!file || !allowedTypes.has(file.mimetype)) {
      return res.status(400).json({ error: "Please upload a JPG, PNG, WEBP, or GIF image." });
    }

    const extension = allowedTypes.get(file.mimetype);
    const token = crypto.randomUUID();
    const filePath = `profile_images/${userId}_${Date.now()}.${extension}`;
    const storageFile = adminBucket.file(filePath);

    await storageFile.save(file.buffer, {
      resumable: false,
      metadata: {
        contentType: file.mimetype,
        metadata: {
          firebaseStorageDownloadTokens: token
        }
      }
    });

    const profileImageUrl = profileImageProxyUrl(filePath);

    await adminDb.collection("User").doc(userId).update({
      profile_image: profileImageUrl
    });

    res.json({
      profileImage: profileImageUrl
    });
  } catch (error) {
    console.error("Profile image upload failed:", error);
    res.status(500).json({ error: "Profile image upload failed." });
  }
});

app.get("/api/profile-image-file", async (req, res) => {
  /*
    Profile image display proxy:
    Browser -> this Express server -> Firebase Storage.

    This solves the remaining ERR_SSL_PROTOCOL_ERROR case where the browser
    could upload through EC2, but then tried to display the image directly from
    firebasestorage.googleapis.com.
  */
  try {
    if (!adminBucket) {
      return res.status(503).send("Firebase Admin is not configured on the server.");
    }

    const filePath = cleanProfileImagePath(req.query.path);
    if (!filePath) {
      return res.status(400).send("Invalid profile image path.");
    }

    const storageFile = adminBucket.file(filePath);
    const [metadata] = await storageFile.getMetadata();
    res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");

    storageFile.createReadStream()
      .on("error", (error) => {
        console.error("Profile image proxy failed:", error);
        if (!res.headersSent) res.status(404).send("Profile image not found.");
        else res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    console.error("Profile image proxy failed:", error);
    res.status(500).send("Profile image proxy failed.");
  }
});

app.use(express.static(PUBLIC_DIR));
app.use("/Images", express.static(IMAGE_DIR));
app.use("/BGM", express.static(BGM_DIR));

function clamp(value, min, max) {
  // Restrict a number so it cannot go below min or above max.
  return Math.max(min, Math.min(max, value));
}

function normalizeRoomCode(roomCode) {
  /*
    Room codes should be consistent even if the user types lowercase text or
    extra spaces.
  */
  return String(roomCode || "").trim().toUpperCase();
}

// 수정 필요, 나중에 필요없을 수도?
function normalizeNickname(nickname) {
  // Keep names short enough for the UI and provide a fallback for empty names.
  return String(nickname || "").trim().slice(0, 18) || "Player";
}

function normalizeRoomName(roomName, fallbackName) {
  // Keep room names short enough for the lobby list.
  return String(roomName || "").trim().slice(0, 32) || fallbackName;
}

function normalizeOptionalRoomCode(roomCode) {
  /*
    The optional create-room code is the private-room password.
    Empty string means the room is public.
  */
  return String(roomCode || "").trim().toUpperCase().slice(0, 18);
}

function normalizeLevel(level) {
  // Level is currently the number of colors shown in the target image.
  return clamp(Math.floor(Number(level)) || 1, 1, 4);
}

function normalizeMaxPlayers(maxPlayers) {
  // Scoring is configured for 2 to 5 players, so room capacity stays there.
  return clamp(Math.floor(Number(maxPlayers)) || CONFIG.MAX_PLAYERS_PER_ROOM, CONFIG.MIN_PLAYERS_TO_START, CONFIG.MAX_PLAYERS_PER_ROOM);
}

function generateRoomCode() {
  /*
    Generate a public room id used internally by Socket.IO and the Join button.
    For private rooms, this id is not the secret code; the secret is joinCode.
  */
  let roomCode = "";
  do {
    roomCode = `ROOM_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  } while (activeRooms.has(roomCode));
  return roomCode;
}

function sanitizeRgb(rgb) {
  /*
    Validate an RGB object coming from a browser.

    Browsers are not trusted automatically. Even if the frontend prevents bad
    input, a user could still send a custom socket event manually. The server
    re-checks that R/G/B are integers from 0 to 255.
  */
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
  /*
    Convert the distance between target and guess into a feedback color.

    Smaller error means better feedback:
    - blue: exact
    - green/yellow/orange/red: increasingly far away
  */
  const error = Math.abs(target - guess);
  if (error === 0) return "blue";
  if (error <= 10) return "green";
  if (error <= 50) return "yellow";
  if (error <= 150) return "orange";
  return "red";
}

function errorsFor(target, guess) {
  // Return the absolute error for each RGB channel.
  return {
    r: Math.abs(target.r - guess.r),
    g: Math.abs(target.g - guess.g),
    b: Math.abs(target.b - guess.b)
  };
}

function createBoundaries() {
  return {
    r: { low: 0, high: 255 },
    g: { low: 0, high: 255 },
    b: { low: 0, high: 255 }
  };
}

function midpointGuess(boundaries = createBoundaries()) {
  return {
    r: Math.round((boundaries.r.low + boundaries.r.high) / 2),
    g: Math.round((boundaries.g.low + boundaries.g.high) / 2),
    b: Math.round((boundaries.b.low + boundaries.b.high) / 2)
  };
}

function tightenPlayerBoundaries(player, guess, feedback, channels = ["r", "g", "b"]) {
  if (!player.boundaries) player.boundaries = createBoundaries();
  const errorLimitByTier = {
    blue: 0,
    green: 10,
    yellow: 50,
    orange: 150,
    red: 255
  };

  channels.forEach((channel) => {
    const value = Number(guess?.[channel]);
    const tier = feedback?.[channel];
    const errorLimit = errorLimitByTier[tier];
    if (!Number.isInteger(value) || errorLimit === undefined) return;

    const bounds = player.boundaries[channel];
    bounds.low = Math.max(bounds.low, clamp(value - errorLimit, 0, 255));
    bounds.high = Math.min(bounds.high, clamp(value + errorLimit, 0, 255));
  });
}

function generateTarget(level) {
  /*
    Create the hidden target for the game.

    The visible target image can contain 1 to 4 random colors. The actual answer
    players are trying to guess is the average RGB value of those colors.
  */
  const colorCount = clamp(Number(level) || 1, 1, 4);
  const colors = [];
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (let i = 0; i < colorCount; i += 1) {
    // Math.random() gives 0 <= x < 1, so multiplying by 256 gives 0..255.xxx.
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
      // Round the average so the answer is still an integer RGB value.
      r: Math.round(totalR / colorCount),
      g: Math.round(totalG / colorCount),
      b: Math.round(totalB / colorCount)
    }
  };
}

function publicPlayers(room) {
  /*
    Create a browser-safe version of the player list.

    The room's internal player objects include socket ids. The frontend does
    not need every internal detail, so this function sends only display/state
    fields that the UI needs.
  */
  return room.players.map((player, index) => ({
    userId: player.userId,
    nickname: player.nickname,
    index,
    point: Number(player.point) || 0,
    profile_image: player.profileImage || "profile.png",
    isHost: player.socketId === room.hostSocketId,
    hasPeeked: room.peekedUsers.has(player.userId),
    isReady: player.isReady || false,
    disconnected: Boolean(player.disconnected)
  }));
}

async function loadUserPublicData(userId, fallbackPoint = 0, fallbackProfileImage = "profile.png") {
  if (!userId || !adminDb) {
    return {
      point: Number(fallbackPoint) || 0,
      profileImage: fallbackProfileImage || "profile.png"
    };
  }

  try {
    const userDoc = await adminDb.collection("User").doc(String(userId)).get();
    if (!userDoc.exists) {
      return {
        point: Number(fallbackPoint) || 0,
        profileImage: fallbackProfileImage || "profile.png"
      };
    }
    return {
      point: Number(userDoc.data()?.point) || 0,
      profileImage: String(userDoc.data()?.profile_image || fallbackProfileImage || "profile.png")
    };
  } catch (error) {
    console.error("Failed to load user public data:", error);
    return {
      point: Number(fallbackPoint) || 0,
      profileImage: fallbackProfileImage || "profile.png"
    };
  }
}

function hostUserId(room) {
  // Convert the host socket id into the host user's stable browser user id.
  return room.players.find((player) => player.socketId === room.hostSocketId)?.userId || null;
}

function publicRoomList() {
  /*
    Create the main-lobby room list.
    Only WAITING rooms appear here. Private rooms are listed, but their secret
    joinCode is never sent to browsers.
  */
  return [...activeRooms.values()]
    .filter((room) => room.phase === "WAITING")
    .map((room) => ({
      roomCode: room.roomCode,
      roomName: room.roomName,
      isPrivate: room.isPrivate,
      level: room.level,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers
    }));
}

function emitRoomList() {
  // Broadcast the refreshed main-lobby list to every connected browser.
  io.emit("room_list", {
    rooms: publicRoomList()
  });
}

function emitRoomUpdate(room) {
  /*
    Send current room status to everyone in the Socket.IO room.

    The frontend listens for "room_update" and redraws lobby/player UI from it.
  */
  io.to(room.roomCode).emit("room_update", {
    roomCode: room.roomCode,
    roomName: room.roomName,
    isPrivate: room.isPrivate,
    level: room.level,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    players: publicPlayers(room),
    hostUserId: hostUserId(room)
  });
}

function sendError(socket, message) {
  // Send an error only to one browser connection.
  socket.emit("game_error", { message });
}

function clearRoomTimer(room) {
  /*
    Stop the current server-side phase timer for this room.
    Safe to call even when timerRef is already null.
  */
  clearTimeout(room.timerRef);
  room.timerRef = null;
}

function createRoom(roomCode, hostSocketId, options = {}) {
  /*
    Build the initial state object for one game room.

    phase starts as WAITING because players can join before the game begins.
    turnIndex points to the player whose turn it currently is.
  */
  return {
    roomCode,
    roomName: options.roomName || "Untitled Room",
    isPrivate: Boolean(options.joinCode),
    joinCode: options.joinCode || "",
    hostSocketId,
    phase: "WAITING",
    level: options.level || 1,
    maxPlayers: options.maxPlayers || CONFIG.MAX_PLAYERS_PER_ROOM,
    round: 0,
    turnIndex: 0,
    players: [],
    targetData: null,
    currentTurnData: null,
    peekedUsers: new Set(),
    finalSubmissions: new Set(),
    finalSubmissionCounter: 0,
    disconnectedUserIds: new Set(),
    timerRef: null
  };
}

function addOrUpdatePlayer(room, socket, userId, nickname, point = 0, profileImage = "profile.png") {
  /*
    Add a new player to a waiting room, or update the socket id if the same
    browser joins again before the game starts.
  */
  const existingPlayer = room.players.find((player) => player.userId === userId);
  if (existingPlayer) {
    existingPlayer.socketId = socket.id;
    existingPlayer.nickname = nickname;
    existingPlayer.point = Number(point) || 0;
    existingPlayer.profileImage = profileImage || "profile.png";
    return true;
  }

  if (room.players.length >= room.maxPlayers) {
    return false;
  }

  room.players.push({
    socketId: socket.id,
    userId,
    nickname,
    point: Number(point) || 0,
    profileImage: profileImage || "profile.png",
    isReady: false,
    disconnected: false,
    boundaries: createBoundaries(),
    finalGuess: null,
    finalErrorSum: null,
    finalSubmitted: false,
    finalSubmittedOrder: null
  });
  return true;
}

function resetPlayerRoundState(room) {
  // Clear final-guess result data before a new game starts.
  room.players.forEach((player) => {
    player.disconnected = false;
    player.boundaries = createBoundaries();
    player.finalGuess = null;
    player.finalErrorSum = null;
    player.finalSubmitted = false;
    player.finalSubmittedOrder = null;
  });
}

function startGame(room, level) {
  /*
    Start a room's game from the lobby.

    This resets game-level state, generates the hidden target, and immediately
    starts round 1.
  */
  clearRoomTimer(room);
  room.phase = "PLAYING";
  room.level = normalizeLevel(level || room.level);
  room.round = 0;
  room.turnIndex = 0;
  room.targetData = generateTarget(room.level);
  room.currentTurnData = null;
  room.peekedUsers = new Set();
  room.finalSubmissions = new Set();
  resetPlayerRoundState(room);
  emitRoomList();
  startRound(room);
}

function startRound(room) {
  /*
    Start one round.

    Every round gives each player one guessing turn. The target colors stay the
    same across all rounds in this game.
  */
  clearRoomTimer(room);
  room.round += 1;
  room.turnIndex = 0;
  room.currentTurnData = null;
  room.peekedUsers = new Set();

  io.to(room.roomCode).emit("round_start", {
    // Tell browsers which round and target colors to display.
    round: room.round,
    totalRounds: CONFIG.ROUNDS,
    colors: room.targetData.colors,
    players: publicPlayers(room)
  });

  startGuessingPhase(room);
}

function submitTurnGuessForPlayer(room, currentPlayer, cleanGuess, sourceSocket = null) {
  clearRoomTimer(room);

  const target = room.targetData.average;
  const errors = errorsFor(target, cleanGuess);
  const feedback = {
    r: feedbackTier(target.r, cleanGuess.r),
    g: feedbackTier(target.g, cleanGuess.g),
    b: feedbackTier(target.b, cleanGuess.b)
  };

  tightenPlayerBoundaries(currentPlayer, cleanGuess, feedback);

  room.currentTurnData = {
    playerId: currentPlayer.userId,
    guessRGB: cleanGuess,
    feedback,
    errors
  };

  if (sourceSocket) {
    sourceSocket.emit("my_guess_result", {
      guessRGB: cleanGuess,
      feedback,
      errors
    });
  }

  startPeekingPhase(room);
}

function activePlayerCount(room) {
  return room.players.filter((player) => !player.disconnected).length;
}

function autoPeekForDisconnectedPlayers(room) {
  const guesser = room.players[room.turnIndex];
  if (!guesser || !room.currentTurnData) return;

  room.players.forEach((player) => {
    if (!player.disconnected || player.userId === guesser.userId || room.peekedUsers.has(player.userId)) return;
    const selectedColor = ["r", "g", "b"][Math.floor(Math.random() * 3)];
    tightenPlayerBoundaries(
      player,
      room.currentTurnData.guessRGB,
      room.currentTurnData.feedback,
      [selectedColor]
    );
    room.peekedUsers.add(player.userId);
    io.to(room.roomCode).emit("player_peeked", {
      userId: player.userId
    });
  });
}

function startGuessingPhase(room) {
  /*
    Start the normal guessing phase for the player at room.turnIndex.

    During this phase, only the current player is allowed to submit a full RGB
    guess. The server timer advances the game if they do not submit in time.
  */
  clearRoomTimer(room);
  room.phase = "GUESSING";
  room.currentTurnData = null;
  room.peekedUsers = new Set();
  emitRoomUpdate(room);

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer) {
    // If there is no current player, skip to the final guess phase.
    startFinalGuess(room);
    return;
  }

  if (currentPlayer.disconnected) {
    submitTurnGuessForPlayer(room, currentPlayer, midpointGuess(currentPlayer.boundaries));
    return;
  }

  io.to(room.roomCode).emit("turn_start", {
    // Browsers use turnUserId to decide whether this is "my turn."
    round: room.round,
    turnUserId: currentPlayer.userId,
    turnNickname: currentPlayer.nickname,
    turnIndex: room.turnIndex,
    timeLimit: CONFIG.GUESS_TIME_MS / 1000,
    players: publicPlayers(room)
  });

  room.timerRef = setTimeout(() => {
    // This is the authoritative timeout for the turn.
    io.to(room.roomCode).emit("turn_timeout", {
      turnUserId: currentPlayer.userId
    });
    advanceTurn(room);
  }, CONFIG.GUESS_TIME_MS);
}

function startPeekingPhase(room) {
  /*
    Start the peek phase after the current player submits a guess.

    Other players may choose one channel, R/G/B, to reveal from the submitted
    guess and its feedback. The current player does not peek because they
    already receive full feedback for their own guess.
  */
  clearRoomTimer(room);
  room.phase = "PEEKING";
  room.peekedUsers = new Set();
  emitRoomUpdate(room);

  const guesser = room.players[room.turnIndex];
  if (room.players.length <= 1) {
    // Defensive fallback. The game now requires 2+ players, but this keeps old state safe.
    room.timerRef = setTimeout(() => advanceTurn(room), 2000);
    return;
  }

  io.to(room.roomCode).emit("peeking_start", {
    round: room.round,
    turnUserId: guesser.userId,
    turnNickname: guesser.nickname,
    timeLimit: CONFIG.PEEK_TIME_MS / 1000
  });

  autoPeekForDisconnectedPlayers(room);
  if (room.peekedUsers.size >= room.players.length - 1) {
    room.timerRef = setTimeout(() => advanceTurn(room), 2000);
    return;
  }

  room.timerRef = setTimeout(() => {
    // If not everyone chooses in time, continue anyway.
    advanceTurn(room);
  }, CONFIG.PEEK_TIME_MS);
}

function advanceTurn(room) {
  /*
    Move from the current turn to the next turn/round/final phase.

    This function is called after:
    - a guess times out
    - the peek phase times out
    - every eligible player has peeked
    - the current player disconnects during their active phase
  */
  clearRoomTimer(room);
  if (room.phase === "GAME_OVER") return;

  room.currentTurnData = null;
  room.peekedUsers = new Set();
  room.turnIndex += 1;

  if (room.turnIndex >= room.players.length) {
    // All players had a turn this round.
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
  /*
    Start the final answer phase.

    Every remaining player submits one final RGB guess. The server ends the
    game either when everyone submits or when the final timer expires.
  */
  clearRoomTimer(room);
  room.phase = "FINAL_GUESS";
  room.finalSubmissions = new Set();
  room.finalSubmissionCounter = 0;
  room.players.forEach((player) => {
    if (!player.disconnected) return;
    const cleanGuess = midpointGuess(player.boundaries);
    const target = room.targetData.average;
    const errors = errorsFor(target, cleanGuess);
    player.finalGuess = cleanGuess;
    player.finalErrorSum = errors.r + errors.g + errors.b;
    player.finalSubmitted = true;
    player.finalSubmittedOrder = room.finalSubmissionCounter += 1;
    room.finalSubmissions.add(player.userId);
  });
  emitRoomUpdate(room);

  io.to(room.roomCode).emit("final_guess_start", {
    timeLimit: CONFIG.FINAL_TIME_MS / 1000,
    colors: room.targetData.colors
  });

  room.timerRef = setTimeout(() => {
    // End the game even if some players never submit.
    endGame(room);
  }, CONFIG.FINAL_TIME_MS);

  if (room.finalSubmissions.size >= room.players.length) {
    endGame(room);
  }
}

// 수정 필요함 
async function endGame(room) {
  /*
    Calculate final rankings and send results to all players.

    The target is the average RGB generated at game start. Lower total RGB error
    is better.
  */
  if (!room || room.phase === "GAME_OVER") return;
  clearRoomTimer(room);
  room.phase = "GAME_OVER";
  const target = room.targetData.average;

  room.players.forEach((player) => {
    if (!player.finalSubmitted) {
      // Players who never submitted are kept in the ranking but always placed last.
      player.finalGuess = null;
      player.finalErrorSum = Number.MAX_SAFE_INTEGER;
      player.finalSubmittedOrder = Number.MAX_SAFE_INTEGER;
    }
  });

  // Sort connected players only. Disconnected players are not included in final ranking.
  const sortedPlayers = room.players
    .filter((player) => !player.disconnected)
    .sort((a, b) => {
      if (a.finalSubmitted !== b.finalSubmitted) return a.finalSubmitted ? -1 : 1;
      if (a.finalErrorSum !== b.finalErrorSum) return a.finalErrorSum - b.finalErrorSum;
      return (a.finalSubmittedOrder ?? Number.MAX_SAFE_INTEGER) - (b.finalSubmittedOrder ?? Number.MAX_SAFE_INTEGER);
    });
  const pointArray = CONFIG.POINTS[sortedPlayers.length] || [];
  const results = sortedPlayers.map((player, index) => ({
    userId: player.userId,
    nickname: player.nickname,
    profile_image: player.profileImage || "profile.png",
    rank: index + 1,
    earnedPoint: pointArray[index] || 0,
    finalError: player.finalSubmitted ? player.finalErrorSum : null,
    finalGuess: player.finalSubmitted ? player.finalGuess : null,
    submittedFinalGuess: player.finalSubmitted,
    finalSubmittedOrder: player.finalSubmittedOrder ?? null
  }));

  if (adminDb) {
    await Promise.all(results.map(async (result) => {
      if (!result.userId || result.userId.startsWith("preview_")) return;
      try {
        await adminDb.collection("User").doc(result.userId).update({
          point: FieldValue.increment(result.earnedPoint)
        });
      } catch (error) {
        console.error("RP update failed:", error);
      }
    }));
  }

  io.to(room.roomCode).emit("game_over", {
    targetRgb: target,
    results
  });

  // The room is finished, so remove it from memory.
  activeRooms.delete(room.roomCode);
  emitRoomList();
}

function removeSocketFromRoom(socket, room, notifyLeavingSocket = false) {
  /*
    Remove one socket/player from a room.
    This is used by both the explicit Leave button and automatic disconnect.
  */
  const index = room.players.findIndex((player) => player.socketId === socket.id);
  if (index === -1) return false;

  if (room.phase !== "WAITING") {
    const player = room.players[index];
    player.disconnected = true;
    player.socketId = null;
    room.disconnectedUserIds.add(player.userId);
    socket.leave(room.roomCode);

    if (activePlayerCount(room) === 0) {
      clearRoomTimer(room);
      activeRooms.delete(room.roomCode);
      emitRoomList();
      return true;
    }

    emitRoomUpdate(room);
    if (room.phase === "GUESSING" && room.turnIndex === index) {
      submitTurnGuessForPlayer(room, player, midpointGuess(player.boundaries));
    } else if (room.phase === "PEEKING") {
      autoPeekForDisconnectedPlayers(room);
      if (room.peekedUsers.size >= room.players.length - 1) {
        clearRoomTimer(room);
        room.timerRef = setTimeout(() => advanceTurn(room), 2000);
      }
    } else if (room.phase === "FINAL_GUESS") {
      const cleanGuess = midpointGuess(player.boundaries);
      const target = room.targetData.average;
      const errors = errorsFor(target, cleanGuess);
      player.finalGuess = cleanGuess;
      player.finalErrorSum = errors.r + errors.g + errors.b;
      player.finalSubmitted = true;
      player.finalSubmittedOrder = room.finalSubmissionCounter += 1;
      room.finalSubmissions.add(player.userId);
      if (room.finalSubmissions.size >= room.players.length) {
        endGame(room);
      }
    }

    return true;
  }

  const wasCurrentTurn = index === room.turnIndex;
  room.players.splice(index, 1);
  socket.leave(room.roomCode);
  if (notifyLeavingSocket) socket.emit("left_room");

  if (room.players.length === 0) {
    clearRoomTimer(room);
    activeRooms.delete(room.roomCode);
    emitRoomList();
    return true;
  }

  if (room.hostSocketId === socket.id) {
    room.hostSocketId = room.players[0].socketId;
  }

  if (room.turnIndex >= room.players.length) {
    room.turnIndex = 0;
  }

  emitRoomUpdate(room);
  emitRoomList();

  if (wasCurrentTurn && (room.phase === "GUESSING" || room.phase === "PEEKING")) {
    advanceTurn(room);
  }

  return true;
}

io.on("connection", (socket) => {
  /*
    This callback runs once for each browser connection.

    socket represents one connected browser tab. Inside this callback, we define
    every event that this browser is allowed to send to the server.
  */
  socket.emit("room_list", {
    rooms: publicRoomList()
  });

  socket.on("request_room_list", () => {
    socket.emit("room_list", {
      rooms: publicRoomList()
    });
  });

  socket.on("validate_join_room", ({ roomCode, privateCode }, respond = () => {}) => {
    /*
      Lightweight join pre-check used by the lobby before moving to game.html.
      This validates room existence, state, capacity, and private-room code
      without actually adding the player to the room yet.
    */
    const cleanRoomCode = normalizeRoomCode(roomCode);
    const room = activeRooms.get(cleanRoomCode);
    if (!room) {
      respond({ ok: false, message: "방을 찾을 수 없습니다." });
      return;
    }
    if (room.phase !== "WAITING") {
      respond({ ok: false, message: "게임이 이미 시작되었습니다." });
      return;
    }
    if (room.isPrivate && normalizeOptionalRoomCode(privateCode) !== room.joinCode) {
      respond({ ok: false, message: "올바르지 않은 방 코드입니다." });
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      respond({ ok: false, message: "방 인원이 다 찼습니다." });
      return;
    }

    respond({ ok: true });
  });

  socket.on("create_room", async ({ roomName, roomCode, level, maxPlayers, userId, nickname, point, profileImage }) => {
    /*
      create_room is sent from the create-room popup.
      The creator is automatically added to the new waiting room and becomes host.
    */
    const cleanUserId = String(userId || socket.id);
    const cleanNickname = normalizeNickname(nickname);
    const joinCode = normalizeOptionalRoomCode(roomCode);
    const generatedRoomCode = generateRoomCode();
    const cleanRoomName = normalizeRoomName(roomName, `${cleanNickname}'s room`);
    const room = createRoom(generatedRoomCode, socket.id, {
      roomName: cleanRoomName,
      joinCode,
      level: normalizeLevel(level),
      maxPlayers: normalizeMaxPlayers(maxPlayers)
    });

    activeRooms.set(generatedRoomCode, room);
    const userPublicData = await loadUserPublicData(cleanUserId, point, profileImage);
    addOrUpdatePlayer(room, socket, cleanUserId, cleanNickname, userPublicData.point, userPublicData.profileImage);
    socket.join(generatedRoomCode);
    emitRoomUpdate(room);
    emitRoomList();
  });

  socket.on("join_room", async ({ roomCode, privateCode, userId, nickname, point, profileImage }) => {
    /*
      join_room is sent from the lobby.

      userId comes from browser sessionStorage. socket.id can change on refresh,
      but userId lets the same browser be recognized as the same player while
      the room is still waiting.
    */
    const cleanRoomCode = normalizeRoomCode(roomCode);
    const cleanUserId = String(userId || socket.id);
    const cleanNickname = normalizeNickname(nickname);

    const room = activeRooms.get(cleanRoomCode);
    if (!room) {
      sendError(socket, "방을 찾을 수 없습니다.");
      return;
    }
    if (room.phase !== "WAITING") {
      sendError(socket, "게임이 이미 시작되었습니다.");
      return;
    }
    if (room.isPrivate && normalizeOptionalRoomCode(privateCode) !== room.joinCode) {
      sendError(socket, "올바르지 않은 방 코드입니다.");
      return;
    }
    const userPublicData = await loadUserPublicData(cleanUserId, point, profileImage);
    if (!addOrUpdatePlayer(room, socket, cleanUserId, cleanNickname, userPublicData.point, userPublicData.profileImage)) {
      sendError(socket, "방 인원이 다 찼습니다.");
      return;
    }

    // Join the Socket.IO broadcast group named after the room code.
    socket.join(cleanRoomCode);

    // Tell everyone in the room about the updated player list.
    emitRoomUpdate(room);
    emitRoomList();
  });

  // 수정 예정
  socket.on("leave_room", ({ roomCode }) => {
    // leave_room is sent by the Leave button in the waiting lobby.
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room) {
      socket.emit("left_room");
      emitRoomList();
      return;
    }
    if (room.phase !== "WAITING") {
      sendError(socket, "You cannot leave from here after the game starts.");
      return;
    }

    removeSocketFromRoom(socket, room, true);
  });

  socket.on("toggle_ready", ({ roomCode }) => {
    // 1. 방을 찾고 상태가 대기 중(WAITING)인지 확인
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "WAITING") return;

    // 2. 이벤트를 보낸 플레이어 찾기
    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return;

    // 3. 준비 상태 반전 (true -> false / false -> true)
    player.isReady = !player.isReady;

    // 4. 방에 있는 모든 사람에게 업데이트된 정보 전송
    emitRoomUpdate(room);
  });

  socket.on("start_game", ({ roomCode, level }) => {
    /*
      start_game is sent when the host clicks Start Game.

      The server checks all permissions here. The frontend disables the button
      for non-hosts, but the backend must still reject invalid attempts.
    */
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
    if (!room.players.every((player) => player.isReady)) {
      sendError(socket, "All players must be ready before starting.");
      return;
    }

    startGame(room, level || room.level);
  });

  socket.on("submit_guess", ({ roomCode, guessRGB }) => {
    /*
      submit_guess is sent by the current player during GUESSING.

      The server accepts it only from the active turn player's socket and only
      while the room is actually in GUESSING phase.
    */
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "GUESSING") return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.socketId !== socket.id) return;

    const cleanGuess = sanitizeRgb(guessRGB);
    if (!cleanGuess) {
      sendError(socket, "Guess must use RGB numbers from 0 to 255.");
      return;
    }

    submitTurnGuessForPlayer(room, currentPlayer, cleanGuess, socket);
  });

  socket.on("peek_color", ({ roomCode, selectedColor }) => {
    /*
      peek_color is sent by non-current players during PEEKING.

      Each non-current player may choose exactly one channel. They receive only
      that channel's guessed value and feedback color.
    */
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "PEEKING" || !room.currentTurnData) return;

    const currentPlayer = room.players[room.turnIndex];
    const peekingPlayer = room.players.find((player) => player.socketId === socket.id);
    if (!currentPlayer || !peekingPlayer || currentPlayer.socketId === socket.id) return;
    if (room.peekedUsers.has(peekingPlayer.userId)) return;

    const channel = String(selectedColor || "").toLowerCase();
    if (!["r", "g", "b"].includes(channel)) return;

    tightenPlayerBoundaries(
      peekingPlayer,
      room.currentTurnData.guessRGB,
      room.currentTurnData.feedback,
      [channel]
    );

    // Track by stable user id so the UI can show a check mark by player.
    room.peekedUsers.add(peekingPlayer.userId);

    // Send the chosen channel result only to the player who requested it.
    socket.emit("peek_result", {
      selectedColor: channel,
      resultColor: room.currentTurnData.feedback[channel],
      guessValue: room.currentTurnData.guessRGB[channel]
    });

    // Broadcast updated player hasPeeked state so everyone sees the check mark.
    emitRoomUpdate(room);
    io.to(room.roomCode).emit("player_peeked", {
      userId: peekingPlayer.userId
    });

    if (room.peekedUsers.size >= room.players.length - 1) {
      // Everyone except the current guesser has peeked, so move on soon.
      clearRoomTimer(room);
      room.timerRef = setTimeout(() => advanceTurn(room), 2000);
    }
  });

  socket.on("submit_final_guess", ({ roomCode, guessRGB }) => {
    /*
      submit_final_guess is sent during FINAL_GUESS.

      Each player can submit once. Their final score is the sum of R/G/B errors
      compared with the hidden target average.
    */
    const room = activeRooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "FINAL_GUESS") return;

    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player || room.finalSubmissions.has(player.userId)) return;

    const cleanGuess = sanitizeRgb(guessRGB);
    if (!cleanGuess) {
      sendError(socket, "Final guess must use RGB numbers from 0 to 255.");
      return;
    }

    const target = room.targetData.average;
    const errors = errorsFor(target, cleanGuess);
    player.finalGuess = cleanGuess;
    player.finalErrorSum = errors.r + errors.g + errors.b;
    player.finalSubmitted = true;
    player.finalSubmittedOrder = room.finalSubmissionCounter += 1;

    room.finalSubmissions.add(player.userId);

    // Confirm to this browser that the server accepted its final answer.
    socket.emit("final_guess_received");

    if (room.finalSubmissions.size >= room.players.length) {
      // No need to wait for the final timer if everyone has submitted.
      endGame(room);
    }
  });

  socket.on("disconnect", () => {
    /*
      disconnect runs automatically when a browser tab closes, refreshes, loses
      connection, or otherwise disconnects from Socket.IO.

      The server removes that socket's player from any room they were in and
      keeps the room moving if the disconnect happened mid-game.
    */
    [...activeRooms.values()].forEach((room) => {
      removeSocketFromRoom(socket, room);
    });
  });
});

const PORT = Number(process.env.PORT) || 3000;

server.listen(PORT, "0.0.0.0", () => {
  // 0.0.0.0 allows other devices on the same network to connect to this server.
  console.log(`RGB Guess server running at http://localhost:${PORT}`);
  console.log(`Same-network devices can connect with http://YOUR_PC_IPV4:${PORT}`);
});
