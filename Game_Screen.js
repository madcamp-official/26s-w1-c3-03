/*
  This script connects the game UI to the Socket.IO backend:
  - lobby join/start actions
  - rendering room players and turn state
  - sending guesses and final answers
  - updating personal boundaries from server feedback
  - showing guide/reveal/final/result popups
*/

const CHANNELS = ["r", "g", "b"];
const CHANNEL_META = {
  r: { label: "R", css: "is-red" },
  g: { label: "G", css: "is-green" },
  b: { label: "B", css: "is-blue" }
};
const TOTAL_ROUNDS = 5;
const ERROR_LIMIT_BY_TIER = {
  blue: 0,
  green: 10,
  yellow: 50,
  orange: 150,
  red: 255
};

const socket = typeof window.io === "function" ? window.io() : null;
const storedUserId = sessionStorage.getItem("rgbGuessUserId");
const localUserId = storedUserId || `user_${Math.random().toString(36).slice(2, 9)}`;
sessionStorage.setItem("rgbGuessUserId", localUserId);

const roomClient = {
  joined: false,
  roomCode: "",
  nickname: "",
  hostUserId: null
};

const game = {
  localPlayerId: localUserId,
  players: [],
  targetColors: [],
  targetRgb: { r: 0, g: 0, b: 0 },
  boundaries: {
    r: { low: 0, high: 255 },
    g: { low: 0, high: 255 },
    b: { low: 0, high: 255 }
  },
  currentRound: 1,
  currentPlayerIndex: 0,
  phase: "lobby",
  turnSeconds: 30,
  choiceSeconds: 10,
  currentSubmission: null,
  lastVisibleGuess: { r: "", g: "", b: "" },
  responseMarks: new Set(),
  selectedChoice: null,
  finalAnswer: { r: "", g: "", b: "" },
  score: null
};

let turnTimer = null;
let choiceTimer = null;
let responseTimers = [];

const els = {
  screenTitle: document.getElementById("screenTitle"),
  lobbyScreen: document.getElementById("lobbyScreen"),
  gameBoard: document.getElementById("gameBoard"),
  lobbyStatus: document.getElementById("lobbyStatus"),
  roomCodeInput: document.getElementById("roomCodeInput"),
  nicknameInput: document.getElementById("nicknameInput"),
  levelSelect: document.getElementById("levelSelect"),
  joinRoomButton: document.getElementById("joinRoomButton"),
  startGameButton: document.getElementById("startGameButton"),
  lobbyPlayersList: document.getElementById("lobbyPlayersList"),
  roundLabel: document.getElementById("roundLabel"),
  timerNumber: document.getElementById("timerNumber"),
  timerCaption: document.getElementById("timerCaption"),
  playersList: document.getElementById("playersList"),
  targetImage: document.getElementById("targetImage"),
  finalTargetImage: document.getElementById("finalTargetImage"),
  rgbControls: document.getElementById("rgbControls"),
  statusLine: document.getElementById("statusLine"),
  guideButton: document.getElementById("guideButton"),
  guidePopover: document.getElementById("guidePopover"),
  closeGuide: document.getElementById("closeGuide"),
  choiceLayer: document.getElementById("choiceLayer"),
  choiceButtons: document.getElementById("choiceButtons"),
  closeChoice: document.getElementById("closeChoice"),
  finalLayer: document.getElementById("finalLayer"),
  finalStatus: document.getElementById("finalStatus"),
  submitFinalButton: document.getElementById("submitFinalButton"),
  resultLayer: document.getElementById("resultLayer"),
  resultText: document.getElementById("resultText"),
  closeResult: document.getElementById("closeResult"),
  exitButton: document.getElementById("exitButton")
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function activePlayer() {
  return game.players[game.currentPlayerIndex] || { id: "", name: "Player" };
}

function isLocalTurn() {
  return activePlayer().id === game.localPlayerId;
}

function isLobbyPhase() {
  return game.phase === "lobby" || game.phase === "waiting";
}

function possessive(name) {
  return name.endsWith("s") ? name + "'" : name + "'s";
}

function rgb(color) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function targetBackground() {
  if (!game.targetColors.length) return "#d6d6d6";
  if (game.targetColors.length === 1) return rgb(game.targetColors[0]);

  const pct = 100 / game.targetColors.length;
  const stops = game.targetColors.flatMap((color, index) => {
    const colorText = rgb(color);
    return [`${colorText} ${index * pct}%`, `${colorText} ${(index + 1) * pct}%`];
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function clearAllTimers() {
  clearInterval(turnTimer);
  clearInterval(choiceTimer);
  responseTimers.forEach(clearTimeout);
  responseTimers = [];
}

function resetBoundaries() {
  game.boundaries = {
    r: { low: 0, high: 255 },
    g: { low: 0, high: 255 },
    b: { low: 0, high: 255 }
  };
}

function playersFromServer(players) {
  return players.map((player) => ({
    id: player.userId,
    name: player.nickname,
    isHost: player.isHost
  }));
}

function setLobbyStatus(message) {
  els.lobbyStatus.textContent = message;
}

function currentTitle() {
  if (game.phase === "lobby" || game.phase === "waiting") return "Waiting Room";
  if (game.phase === "final") return "Final Answer";
  if (game.phase === "score") return "Game result";

  const name = activePlayer().name;
  if (isLocalTurn()) {
    return game.phase === "guessing"
      ? "My turn (Guessing)"
      : "My turn (After Submission/Other players choose)";
  }

  return game.phase === "guessing"
    ? `${possessive(name)} turn (Guessing)`
    : `${possessive(name)} turn (After Submission/Other players choose)`;
}

function renderLobby() {
  const showLobby = isLobbyPhase();
  els.lobbyScreen.hidden = !showLobby;
  els.gameBoard.hidden = showLobby;

  const isHost = roomClient.hostUserId === game.localPlayerId;
  els.startGameButton.disabled = !roomClient.joined || !isHost || game.players.length < 1;

  els.lobbyPlayersList.innerHTML = game.players.length
    ? game.players.map((player) => `
      <div class="lobby-player-item">
        <span>${player.name}${player.id === game.localPlayerId ? " (Me)" : ""}</span>
        <span class="lobby-player-badge">${player.isHost ? "Host" : "Player"}</span>
      </div>
    `).join("")
    : `<div class="lobby-player-item"><span>No players yet</span></div>`;
}

function renderPlayers() {
  els.playersList.innerHTML = game.players.map((player, index) => {
    const active = index === game.currentPlayerIndex && game.phase !== "final" && game.phase !== "score";
    const me = player.id === game.localPlayerId;
    const checked = game.responseMarks.has(player.id);
    return `
      <div class="player-row ${active ? "is-active" : ""} ${me ? "is-me" : ""}">
        <div class="player-name">${player.name}${me ? " (Me)" : ""}</div>
        <div class="player-check" aria-hidden="true">${checked ? "&#10003;" : ""}</div>
      </div>
    `;
  }).join("");
}

function channelValue(channel) {
  if (game.currentSubmission && isLocalTurn() && game.phase === "review") {
    return game.currentSubmission.guess[channel];
  }
  return game.lastVisibleGuess[channel];
}

function renderTargetImage() {
  const background = targetBackground();
  els.targetImage.style.background = background;
  els.finalTargetImage.style.background = background;
}

function channelTier(channel) {
  const feedback = game.currentSubmission?.feedback?.[channel];
  if (!feedback || !(isLocalTurn() && game.phase === "review")) return "";
  return `tier-${feedback}`;
}

function renderChannels() {
  const editable = game.phase === "guessing" && isLocalTurn();

  const channelsHtml = CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const bounds = game.boundaries[channel];
    const value = channelValue(channel);
    const hasValue = value !== "" && value !== undefined && value !== null;
    const tier = channelTier(channel);
    const inputName = `guess-${channel}`;
    const box = editable
      ? `
        <div class="value-entry ${hasValue ? "has-value" : ""}">
          <input class="value-box ${meta.css}" id="${inputName}" data-channel="${channel}" type="number" inputmode="numeric" min="0" max="255" value="${hasValue ? value : ""}" aria-label="${meta.label} value" />
          <span class="value-label" aria-hidden="true">${meta.label}</span>
        </div>
      `
      : `<div class="value-box ${meta.css}" aria-label="${meta.label} value">${hasValue ? value : meta.label}</div>`;

    return `
      <div class="channel ${tier}" data-channel-wrap="${channel}">
        <div class="bound">${bounds.high}</div>
        <div class="chevron" aria-hidden="true">&le;</div>
        ${box}
        <div class="chevron up" aria-hidden="true">&le;</div>
        <div class="bound">${bounds.low}</div>
      </div>
    `;
  }).join("");

  els.rgbControls.innerHTML = `
    ${channelsHtml}
    <button class="submit-button" id="submitButton" type="button" ${editable ? "" : "disabled"}>Submit</button>
  `;

  document.getElementById("submitButton").addEventListener("click", () => {
    submitTurn(false);
  });

  CHANNELS.forEach((channel) => {
    const input = document.getElementById(`guess-${channel}`);
    if (!input) return;
    input.addEventListener("input", (event) => {
      const value = event.target.value.replace(/\D/g, "").slice(0, 3);
      event.target.value = value;
      event.target.closest(".value-entry")?.classList.toggle("has-value", value.length > 0);
      game.lastVisibleGuess[channel] = value;
      els.statusLine.textContent = "";
    });
  });
}

function renderChoiceModal() {
  const showChoice = game.phase === "choosing";
  els.choiceLayer.hidden = !showChoice;
  if (!showChoice) return;

  els.choiceButtons.innerHTML = CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const selected = game.selectedChoice === channel;
    const revealed = selected && game.currentSubmission?.guess?.[channel] !== undefined;
    const tier = revealed ? `tier-${game.currentSubmission.feedback[channel]}` : "";
    const label = revealed ? game.currentSubmission.guess[channel] : meta.label;
    const disabled = game.selectedChoice ? "disabled" : "";
    return `
      <button class="choice-button ${meta.css} ${tier}" data-choice="${channel}" type="button" ${disabled} aria-label="Reveal ${meta.label}">
        <span class="choice-label">${label}</span>
      </button>
    `;
  }).join("");

  document.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => chooseChannel(button.dataset.choice));
  });
}

function renderFinalModal() {
  const showFinal = game.phase === "final";
  els.finalLayer.hidden = !showFinal;
  if (!showFinal) return;

  CHANNELS.forEach((channel) => {
    const bounds = game.boundaries[channel];
    const high = document.querySelector(`[data-final-bound-high="${channel}"]`);
    const low = document.querySelector(`[data-final-bound-low="${channel}"]`);
    if (high) high.textContent = bounds.high;
    if (low) low.textContent = bounds.low;
  });
}

function resultBoxesFor(values, labelPrefix) {
  return CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    return `
      <input
        class="value-box ${meta.css}"
        type="text"
        value="${values[channel]}"
        readonly
        aria-label="${labelPrefix} ${meta.label} value"
      />
    `;
  }).join("");
}

function renderResultModal() {
  els.resultLayer.hidden = game.phase !== "score";
  if (game.phase !== "score" || !game.score) {
    els.resultText.textContent = "";
    return;
  }

  els.resultText.innerHTML = `
    <div class="result-row">
      <p class="result-row-title">Correct Result</p>
      <div class="result-boxes" aria-label="Correct RGB result">
        ${resultBoxesFor(game.targetRgb, "Correct")}
      </div>
    </div>
    <div class="result-row">
      <p class="result-row-title">Final Guess</p>
      <div class="result-boxes" aria-label="Final RGB guess">
        ${resultBoxesFor(game.finalAnswer, "Final guess")}
      </div>
    </div>
    <p class="result-total-error">Total error: ${game.score.totalError}</p>
  `;
}

function render() {
  els.screenTitle.textContent = currentTitle();
  renderLobby();
  if (isLobbyPhase()) return;

  els.roundLabel.textContent = `Round ${Math.min(game.currentRound, TOTAL_ROUNDS)}`;
  els.timerNumber.textContent = game.phase === "choosing" ? game.choiceSeconds : game.turnSeconds;
  els.timerCaption.textContent = game.phase === "choosing" ? "Choose" : "Time Left";
  renderTargetImage();
  renderPlayers();
  renderChannels();
  renderChoiceModal();
  renderFinalModal();
  renderResultModal();
}

function readGuessFromInputs() {
  const guess = {};
  for (const channel of CHANNELS) {
    const input = document.getElementById(`guess-${channel}`);
    const rawValue = input ? input.value.trim() : String(game.lastVisibleGuess[channel]).trim();
    if (rawValue === "") return null;

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    guess[channel] = value;
  }
  return guess;
}

function tightenBoundsFromFeedback(guess, feedback, channels) {
  channels.forEach((channel) => {
    const value = Number(guess[channel]);
    const tier = feedback[channel];
    const errorLimit = ERROR_LIMIT_BY_TIER[tier];
    if (!Number.isInteger(value) || errorLimit === undefined) return;

    const bounds = game.boundaries[channel];
    const revealedLow = clamp(value - errorLimit, 0, 255);
    const revealedHigh = clamp(value + errorLimit, 0, 255);
    bounds.low = Math.max(bounds.low, revealedLow);
    bounds.high = Math.min(bounds.high, revealedHigh);
  });
}

function startTurnCountdown(seconds) {
  clearInterval(turnTimer);
  game.turnSeconds = seconds;
  els.timerNumber.textContent = seconds;
  turnTimer = setInterval(() => {
    game.turnSeconds -= 1;
    els.timerNumber.textContent = game.turnSeconds;
    if (game.turnSeconds <= 0) {
      clearInterval(turnTimer);
    }
  }, 1000);
}

function startChoiceCountdown(seconds) {
  clearInterval(choiceTimer);
  game.choiceSeconds = seconds;
  els.timerNumber.textContent = seconds;
  choiceTimer = setInterval(() => {
    game.choiceSeconds -= 1;
    els.timerNumber.textContent = game.choiceSeconds;
    if (game.choiceSeconds <= 0) {
      clearInterval(choiceTimer);
    }
  }, 1000);
}

function startFinalCountdown(seconds) {
  clearInterval(turnTimer);
  game.turnSeconds = seconds;
  els.timerNumber.textContent = seconds;
  turnTimer = setInterval(() => {
    game.turnSeconds -= 1;
    els.timerNumber.textContent = game.turnSeconds;
    if (game.turnSeconds <= 0) {
      clearInterval(turnTimer);
      submitFinalAnswer(true);
    }
  }, 1000);
}

function resetFinalInputs() {
  CHANNELS.forEach((channel) => {
    const input = document.getElementById(`final-${channel}`);
    if (!input) return;
    input.value = "";
    input.closest(".value-entry")?.classList.remove("has-value");
  });
}

function joinRoom() {
  if (!socket) {
    setLobbyStatus("Open this page through the Node server to use rooms.");
    return;
  }

  roomClient.roomCode = els.roomCodeInput.value.trim().toUpperCase() || "ROOM_777";
  roomClient.nickname = els.nicknameInput.value.trim() || `Player ${localUserId.slice(-4)}`;
  roomClient.joined = true;
  socket.emit("join_room", {
    roomCode: roomClient.roomCode,
    userId: game.localPlayerId,
    nickname: roomClient.nickname
  });
  setLobbyStatus(`Joining ${roomClient.roomCode}...`);
  renderLobby();
}

function startGameFromLobby() {
  if (!socket || !roomClient.joined) return;
  socket.emit("start_game", {
    roomCode: roomClient.roomCode,
    level: Number(els.levelSelect.value)
  });
}

function submitTurn(autoSubmit) {
  if (game.phase !== "guessing" || !isLocalTurn()) return;

  const guess = readGuessFromInputs();
  if (!guess) {
    if (!autoSubmit) {
      els.statusLine.textContent = "Enter numbers from 0 to 255.";
    }
    return;
  }

  game.lastVisibleGuess = { ...guess };
  socket.emit("submit_guess", {
    roomCode: roomClient.roomCode,
    guessRGB: guess
  });
  els.statusLine.textContent = "Submitted. Waiting for reveal...";
  const submitButton = document.getElementById("submitButton");
  if (submitButton) submitButton.disabled = true;
}

function chooseChannel(channel) {
  if (game.phase !== "choosing" || game.selectedChoice) return;
  game.selectedChoice = channel;
  socket.emit("peek_color", {
    roomCode: roomClient.roomCode,
    selectedColor: channel
  });
  renderChoiceModal();
}

function submitFinalAnswer(autoSubmit = false) {
  if (game.phase !== "final") return;

  const answer = {};
  for (const channel of CHANNELS) {
    const input = document.getElementById(`final-${channel}`);
    const rawValue = input ? input.value.trim() : String(game.finalAnswer[channel]).trim();
    const value = Number(rawValue);
    if (rawValue === "" || !Number.isInteger(value) || value < 0 || value > 255) {
      if (autoSubmit) {
        const bounds = game.boundaries[channel];
        answer[channel] = clamp(Math.round((bounds.low + bounds.high) / 2), 0, 255);
        continue;
      }

      els.finalStatus.textContent = "Enter final numbers from 0 to 255.";
      return;
    }
    answer[channel] = value;
  }

  clearInterval(turnTimer);
  game.finalAnswer = { ...answer };
  socket.emit("submit_final_guess", {
    roomCode: roomClient.roomCode,
    guessRGB: answer
  });
  els.finalStatus.textContent = "Submitted. Waiting for results...";
  els.submitFinalButton.disabled = true;
}

function handleRoomUpdate(data) {
  roomClient.hostUserId = data.hostUserId;
  roomClient.roomCode = data.roomCode;
  game.players = playersFromServer(data.players || []);

  if (data.phase === "WAITING") {
    game.phase = "waiting";
    roomClient.joined = game.players.some((player) => player.id === game.localPlayerId);
    setLobbyStatus(roomClient.joined
      ? `Room ${data.roomCode} is waiting.`
      : "Join a room to play.");
  }

  render();
}

function handleRoundStart(data) {
  game.currentRound = data.round;
  game.targetColors = data.colors || [];
  if (data.round === 1) resetBoundaries();
  game.score = null;
  game.finalAnswer = { r: "", g: "", b: "" };
  game.currentSubmission = null;
  game.selectedChoice = null;
  game.responseMarks = new Set();
  render();
}

function handleTurnStart(data) {
  clearAllTimers();
  game.phase = "guessing";
  game.currentRound = data.round;
  game.players = playersFromServer(data.players || []);
  game.currentPlayerIndex = game.players.findIndex((player) => player.id === data.turnUserId);
  if (game.currentPlayerIndex < 0) game.currentPlayerIndex = 0;
  game.currentSubmission = null;
  game.selectedChoice = null;
  game.lastVisibleGuess = { r: "", g: "", b: "" };
  game.responseMarks = new Set();
  els.statusLine.textContent = isLocalTurn() ? "" : `${activePlayer().name} is guessing.`;
  render();
  startTurnCountdown(data.timeLimit || 30);
}

function handleMyGuessResult(data) {
  clearInterval(turnTimer);
  game.phase = "review";
  game.currentSubmission = {
    guess: data.guessRGB,
    feedback: data.feedback
  };
  game.lastVisibleGuess = { ...data.guessRGB };
  tightenBoundsFromFeedback(data.guessRGB, data.feedback, CHANNELS);
  els.statusLine.textContent = "";
  render();
}

function handlePeekingStart(data) {
  if (data.turnUserId === game.localPlayerId) {
    game.choiceSeconds = data.timeLimit || 10;
    return;
  }

  game.phase = "choosing";
  game.currentSubmission = { guess: {}, feedback: {} };
  game.selectedChoice = null;
  render();
  startChoiceCountdown(data.timeLimit || 10);
}

function handlePeekResult(data) {
  const channel = data.selectedColor;
  game.selectedChoice = channel;
  game.currentSubmission.guess[channel] = data.guessValue;
  game.currentSubmission.feedback[channel] = data.resultColor;
  tightenBoundsFromFeedback(
    { [channel]: data.guessValue },
    { [channel]: data.resultColor },
    [channel]
  );
  renderChoiceModal();
}

function handleFinalGuessStart(data) {
  clearAllTimers();
  game.phase = "final";
  game.turnSeconds = data.timeLimit || 30;
  game.targetColors = data.colors || game.targetColors;
  game.finalAnswer = { r: "", g: "", b: "" };
  els.finalStatus.textContent = "";
  els.submitFinalButton.disabled = false;
  resetFinalInputs();
  render();
  startFinalCountdown(game.turnSeconds);
}

function handleGameOver(data) {
  clearAllTimers();
  game.phase = "score";
  game.targetRgb = data.targetRgb;
  const myResult = (data.results || []).find((result) => result.userId === game.localPlayerId);
  game.finalAnswer = myResult?.finalGuess || game.finalAnswer;
  game.score = {
    totalError: myResult?.finalError ?? 0,
    points: myResult?.earnedPoint ?? 0
  };
  render();
}

els.nicknameInput.value = `Player ${localUserId.slice(-4)}`;

els.joinRoomButton.addEventListener("click", joinRoom);
els.startGameButton.addEventListener("click", startGameFromLobby);

els.guideButton.addEventListener("click", () => {
  els.guidePopover.hidden = false;
});

els.closeGuide.addEventListener("click", () => {
  els.guidePopover.hidden = true;
});

els.closeChoice.addEventListener("click", () => {
  els.choiceLayer.hidden = true;
});

document.querySelectorAll("[data-final-channel]").forEach((input) => {
  input.addEventListener("input", (event) => {
    const value = event.target.value.replace(/\D/g, "").slice(0, 3);
    const channel = event.target.dataset.finalChannel;
    event.target.value = value;
    event.target.closest(".value-entry")?.classList.toggle("has-value", value.length > 0);
    game.finalAnswer[channel] = value;
    els.finalStatus.textContent = "";
  });
});

els.submitFinalButton.addEventListener("click", () => {
  submitFinalAnswer();
});

els.closeResult.addEventListener("click", () => {
  els.resultLayer.hidden = true;
});

els.exitButton.addEventListener("click", () => {
  els.statusLine.textContent = "Exit action can be connected later.";
});

if (socket) {
  socket.on("connect", () => {
    setLobbyStatus("Connected. Join or create a room.");
  });

  socket.on("disconnect", () => {
    setLobbyStatus("Disconnected from server.");
  });

  socket.on("connect_error", () => {
    setLobbyStatus("Could not connect to the server.");
  });

  socket.on("game_error", (data) => {
    const message = data?.message || "Something went wrong.";
    if (isLobbyPhase()) setLobbyStatus(message);
    else els.statusLine.textContent = message;
  });

  socket.on("room_update", handleRoomUpdate);
  socket.on("round_start", handleRoundStart);
  socket.on("turn_start", handleTurnStart);
  socket.on("my_guess_result", handleMyGuessResult);
  socket.on("peeking_start", handlePeekingStart);
  socket.on("peek_result", handlePeekResult);
  socket.on("final_guess_start", handleFinalGuessStart);
  socket.on("final_guess_received", () => {
    els.finalStatus.textContent = "Submitted. Waiting for results...";
  });
  socket.on("game_over", handleGameOver);
} else {
  setLobbyStatus("Socket.IO is not loaded. Start the Node server and open http://localhost:3000.");
}

render();
