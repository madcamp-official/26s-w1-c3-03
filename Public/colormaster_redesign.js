/*
  Color Master frontend controller.

  Think of this file as the "brain" of the browser page:
  - HTML creates placeholders such as #playersList, #targetImage, and #rgbControls.
  - CSS decides how those placeholders look.
  - This JavaScript file reads server events, updates local state, and redraws the UI.

  This file connects the redesigned UI to the Socket.IO backend:
  - lobby join/start flow
  - server-driven rounds and turns
  - RGB input validation
  - personal boundary updates
  - peek/final/result popups
*/

/*
  The game works with three color channels.
  Keeping them in one array lets the code loop over R/G/B instead of writing
  nearly identical logic three times.
*/
const CHANNELS = ["r", "g", "b"];

/*
  Metadata for each RGB channel.
  label is what the user sees; css is the color-specific CSS class used by
  input boxes and choice buttons.
*/
const CHANNEL_META = {
  r: { label: "R", css: "is-red" },
  g: { label: "G", css: "is-green" },
  b: { label: "B", css: "is-blue" }
};

/*
  The frontend displays round numbers, while the backend owns the real game
  rules. This value should match the server configuration.
*/
const TOTAL_ROUNDS = 5;

/*
  Server feedback comes back as color tiers.
  Each tier means "the true value is within this many units of the guess."
  Example: green means the channel is within +/- 10.
*/
const ERROR_LIMIT_BY_TIER = {
  blue: 0,
  green: 10,
  yellow: 50,
  orange: 150,
  red: 255
};

/*
  Preview mode lets the UI render without joining a real Socket.IO room.
  When true, the page uses fake players and fake target colors, and skips most
  server event wiring at the bottom of this file.
  For the real multiplayer flow, set this to false.
*/
const PREVIEW_GAME_SCREEN = false;

/*
  Socket.IO is loaded from /socket.io/socket.io.js by the HTML file.
  window.io is created by that library. If the page is opened without the Node
  server, window.io may not exist, so this code safely falls back to null.
*/
/* 
  window 라는 브라우저의 오브젝트에 글로벌함수 .io 를 불러옴
  브라우저와 서버 간의 커넥션 셋업
  나중에 socket.emit 이나 socket.on 등을 써서 서버와 통신할 수 있음 
*/
const socket = typeof window.io === "function" ? window.io() : null;

/*
  sessionStorage stores data only for this browser tab/session.
  We use it to keep the same local user id after refreshes, so the server can
  recognize the same browser as the same player.

  if storedUserId exists, use it; else, make a new random user id 

  왜 필요한지?? 
*/
const storedUserId = sessionStorage.getItem("colorMasterUserId");
const localUserId = storedUserId || `user_${Math.random().toString(36).slice(2, 9)}`;
sessionStorage.setItem("colorMasterUserId", localUserId);

/*
  roomClient stores lobby-only information from this browser's point of view.
  It is separate from game state because joining a room and playing a game are
  related, but not the same thing.
*/
const roomClient = {
  joined: false,
  roomCode: "",
  roomName: "",
  rooms: [],
  level: 1,
  maxPlayers: 5,
  isPrivate: false,
  nickname: "",
  hostUserId: null
};

/*
  game is the main local state object for the UI.
  Rendering functions read from this object and paint the HTML accordingly.

  Important idea:
  The server is still the source of truth for the real multiplayer game.
  This object is the browser's local copy plus UI-only values like input text,
  countdown seconds, and narrowed RGB boundaries.
*/
const game = {
  // The id for this browser/player.
  localPlayerId: localUserId,

  // Players currently known to this browser. Preview mode seeds fake players.
  players: PREVIEW_GAME_SCREEN
    ? [
      { id: localUserId, name: "Player 1", isHost: true },
      { id: "preview_2", name: "Player 2", isHost: false },
      { id: "preview_3", name: "Player 3", isHost: false },
      { id: "preview_4", name: "Player 4", isHost: false },
      { id: "preview_5", name: "Player 5", isHost: false }
    ]
    : [],

  // The target image is drawn with CSS backgrounds, not with an <img> tag.
  targetColors: PREVIEW_GAME_SCREEN
    ? [
      { r: 238, g: 68, b: 88 },
      { r: 52, g: 231, b: 145 },
      { r: 82, g: 124, b: 255 }
    ]
    : [],

  // Filled when the final result arrives from the server.
  targetRgb: { r: 0, g: 0, b: 0 },

  /*
    Each channel starts with the full possible range 0..255.
    As the player receives feedback, these ranges are narrowed.
  */
  boundaries: {
    r: { low: 0, high: 255 },
    g: { low: 0, high: 255 },
    b: { low: 0, high: 255 }
  },

  currentRound: 1,
  currentPlayerIndex: PREVIEW_GAME_SCREEN ? 0 : 0,

  /*
    phase controls which screen/modal is visible.
    Common values:
    - lobby: initial lobby screen
    - waiting: joined room, waiting for host start
    - guessing: current player can submit RGB
    - review: current player sees feedback after submitting
    - choosing: other players can peek one channel
    - final: final guess modal
    - score: result modal
  */
  phase: "lobby",

  turnSeconds: 30,
  choiceSeconds: 10,

  // Stores the most recent submitted guess and feedback for review/peek UI.
  currentSubmission: null,

  // Prevents a user from submitting multiple times during one turn.
  turnSubmitted: false,

  // Keeps typed values visible between re-renders.
  lastVisibleGuess: { r: "", g: "", b: "" },

  // Marks which players have responded or are done in the player list.
  responseMarks: new Set(),

  // Which channel the user selected during the peek phase.
  selectedChoice: null,

  // Typed final answer values.
  finalAnswer: { r: "", g: "", b: "" },

  // Prevents multiple final submissions.
  finalSubmitted: false,

  // Filled after game_over.
  score: null,
  results: []
};

/*
  setInterval returns timer ids. We store them so we can stop old countdowns
  before starting a new phase.
*/
let turnTimer = null;
let choiceTimer = null;

/*
  Frequently used DOM nodes.
  document.getElementById("...") finds an element from the HTML by id.
  Storing them in els avoids repeating long DOM lookup code everywhere.
  If an id changes in the HTML, the matching name here must be updated too.
*/
const els = {
  screenTitle: document.getElementById("screenTitle"),
  lobbyScreen: document.getElementById("lobbyScreen"),
  gameBoard: document.getElementById("gameBoard"),
  lobbyStatus: document.getElementById("lobbyStatus"),
  mainLobbyPanel: document.getElementById("mainLobbyPanel"),
  waitingLobbyPanel: document.getElementById("waitingLobbyPanel"),
  roomList: document.getElementById("roomList"),
  openCreateRoomButton: document.getElementById("openCreateRoomButton"),
  createRoomLayer: document.getElementById("createRoomLayer"),
  closeCreateRoomButton: document.getElementById("closeCreateRoomButton"),
  cancelCreateRoomButton: document.getElementById("cancelCreateRoomButton"),
  createRoomButton: document.getElementById("createRoomButton"),
  createRoomNameInput: document.getElementById("createRoomNameInput"),
  createRoomCodeInput: document.getElementById("createRoomCodeInput"),
  createLevelSelect: document.getElementById("createLevelSelect"),
  maxPlayersSelect: document.getElementById("maxPlayersSelect"),
  nicknameInput: document.getElementById("nicknameInput"),
  waitingRoomTitle: document.getElementById("waitingRoomTitle"),
  waitingRoomMeta: document.getElementById("waitingRoomMeta"),
  leaveRoomButton: document.getElementById("leaveRoomButton"),
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
  choicePopupTime: document.getElementById("choicePopupTime"),
  closeChoice: document.getElementById("closeChoice"),
  finalLayer: document.getElementById("finalLayer"),
  finalPopupTime: document.getElementById("finalPopupTime"),
  finalStatus: document.getElementById("finalStatus"),
  submitFinalButton: document.getElementById("submitFinalButton"),
  resultLayer: document.getElementById("resultLayer"),
  resultText: document.getElementById("resultText"),
  closeResult: document.getElementById("closeResult"),
  exitButton: document.getElementById("exitButton"),
  volumeButton: document.getElementById("volumeButton"),
  volumeSliderWrap: document.getElementById("volumeSliderWrap"),
  volumeSlider: document.getElementById("volumeSlider")
};

function clamp(value, min, max) {
  // Restrict value so it never goes below min or above max.
  return Math.max(min, Math.min(max, value));
}

function activePlayer() {
  // currentPlayerIndex points into game.players. If it is invalid, return a safe fallback.
  return game.players[game.currentPlayerIndex] || { id: "", name: "Player" };
}

function isLocalTurn() {
  // True only when the active turn player is this browser's player id.
  return activePlayer().id === game.localPlayerId;
}

function isLobbyPhase() {
  // Lobby and waiting both show the lobby screen instead of the main game board.
  // 왜 필요함?
  return game.phase === "lobby" || game.phase === "waiting";
}

function setLobbyStatus(message) {
  // Updates the small lobby status text. The HTML has aria-live, so changes can be announced.
  els.lobbyStatus.textContent = message;
}

function escapeHtml(value) {
  /*
    Text typed by users, such as room names and nicknames, should be displayed
    as text only. This replaces HTML-sensitive characters so a typed name cannot
    accidentally become real HTML inside innerHTML.
  */
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[character]));
}

function rgb(color) {
  // Converts an object like { r: 255, g: 0, b: 0 } into CSS text: rgb(255, 0, 0).
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/*
  Build the CSS background for the target image.

  If there is one color, the target is a solid color.
  If there are multiple colors, we create a hard-edged linear-gradient so the
  target appears as vertical color slices.
*/
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
  // Stop both countdown types. Safe to call even when a timer is not running.
  clearInterval(turnTimer);
  clearInterval(choiceTimer);
}

function resetBoundaries() {
  // Reset all RGB clues to the widest possible range at the start of a new game.
  game.boundaries = {
    r: { low: 0, high: 255 },
    g: { low: 0, high: 255 },
    b: { low: 0, high: 255 }
  };
}

function playersFromServer(players) {
  /*
    Server player objects use backend field names such as userId/nickname.
    The frontend prefers id/name, so this normalizes the shape.
  */
  return players.map((player) => ({
    id: player.userId,
    name: player.nickname,
    isHost: player.isHost,
    hasPeeked: Boolean(player.hasPeeked)
  }));
}

// 아마 안 필요할 듯? 
function currentTitle() {
  // Computes the top screen title based on current phase and active player.
  if (isLobbyPhase()) return "Color Master Lobby";
  if (game.phase === "final") return "Final Guess";
  if (game.phase === "score") return "Game Result";
  if (isLocalTurn()) return game.phase === "guessing" ? "My Turn" : "My Result";
  return `${activePlayer().name}'s Turn`;
}

function roomLevelLabel(level) {
  const count = Number(level) || 1;
  return `${count} color${count === 1 ? "" : "s"}`;
}

function renderRoomList() {
  /*
    Main lobby room list.
    The server sends only rooms that are still waiting. Each row gets a Join
    button; private rooms ask for their room code before emitting join_room.
  */
  const rooms = roomClient.rooms || [];
  if (!rooms.length) {
    els.roomList.innerHTML = `<div class="room-empty">No waiting rooms yet.</div>`;
    return;
  }

  els.roomList.innerHTML = `
    <div class="room-list-header" aria-hidden="true">
      <span>No.</span>
      <span>Name</span>
      <span>Level</span>
      <span>Players</span>
      <span></span>
    </div>
    ${rooms.map((room, index) => {
      const isFull = room.playerCount >= room.maxPlayers;
      return `
        <div class="room-row">
          <span>${index + 1}</span>
          <span class="room-name">${escapeHtml(room.roomName)}${room.isPrivate ? `<span class="room-private-mark">(P)</span>` : ""}</span>
          <span>${roomLevelLabel(room.level)}</span>
          <span>${room.playerCount}/${room.maxPlayers}</span>
          <button class="room-join-button" type="button" data-join-room="${escapeHtml(room.roomCode)}" data-private="${room.isPrivate ? "true" : "false"}" ${isFull ? "disabled" : ""}>Join</button>
        </div>
      `;
    }).join("")}
  `;

  document.querySelectorAll("[data-join-room]").forEach((button) => {
    button.addEventListener("click", () => {
      const privateRoom = button.dataset.private === "true";
      const roomCode = privateRoom ? window.prompt("Enter room code") : "";
      if (privateRoom && !roomCode) return;
      joinRoom(button.dataset.joinRoom, roomCode || "");
    });
  });
}

function renderLobby() {
  /*
    Show or hide the lobby and game board.
    The lobby itself now has two sub-screens:
    - main lobby: list of waiting rooms
    - waiting lobby: players inside one joined room
  */
  const showLobby = isLobbyPhase();
  els.lobbyScreen.hidden = !showLobby;
  els.gameBoard.hidden = showLobby;
  if (!showLobby) return;

  const showWaitingLobby = game.phase === "waiting" && roomClient.joined;
  els.mainLobbyPanel.hidden = showWaitingLobby;
  els.waitingLobbyPanel.hidden = !showWaitingLobby;

  if (!showWaitingLobby) {
    renderRoomList();
    return;
  }

  const isHost = roomClient.hostUserId === game.localPlayerId;
  const privateMark = roomClient.isPrivate ? " (P)" : "";
  els.waitingRoomTitle.textContent = `${roomClient.roomName || "Waiting Room"}${privateMark}`;
  els.waitingRoomMeta.textContent = `${roomLevelLabel(roomClient.level)} | ${game.players.length}/${roomClient.maxPlayers} players`;
  els.startGameButton.hidden = !isHost;
  els.startGameButton.disabled = !roomClient.joined || !isHost || game.players.length < 2;

  /*
    innerHTML replaces the whole player-list container with newly generated HTML.
    map(...) creates one HTML string per player; join("") combines them into one string.
  */
  els.lobbyPlayersList.innerHTML = game.players.length
    ? game.players.map((player) => `
      <div class="lobby-player-item">
        <span>${escapeHtml(player.name)}</span>
        <span class="lobby-player-badge">${player.isHost ? "Host" : "Player"}</span>
      </div>
    `).join("")
    : `<div class="lobby-player-item"><span>No players yet</span></div>`;
}

function renderPlayers() {
  /*
    Paint the sidebar player list.
    CSS classes such as is-active, is-me, and is-checked control visual states.
  */
  els.playersList.innerHTML = game.players.map((player, index) => {
    const active = index === game.currentPlayerIndex && game.phase !== "final" && game.phase !== "score";
    const me = player.id === game.localPlayerId;
    const checked = player.hasPeeked || game.responseMarks.has(player.id);
    return `
      <div class="player-row ${active ? "is-active" : ""} ${me ? "is-me" : ""} ${checked ? "is-checked" : ""}">
        <div class="player-name">${player.name}</div>
        <div class="player-check" aria-hidden="true">${checked ? "&#10003;" : ""}</div>
      </div>
    `;
  }).join("");
}


function channelValue(channel) {
  /*
    During review, the current player should see the submitted answer.
    Otherwise, show whatever is currently typed or remembered locally.
  */
  if (game.currentSubmission && isLocalTurn() && game.phase === "review") {
    return game.currentSubmission.guess[channel];
  }
  return game.lastVisibleGuess[channel];
}

function renderTargetImage() {
  // The target image areas are divs; changing their background makes them look like images.
  const background = targetBackground();
  els.targetImage.style.background = background;
  els.finalTargetImage.style.background = background;
}

function channelTier(channel) {
  /*
    Feedback tier becomes a CSS class like tier-green or tier-orange.
    The CSS then colors the channel box to show feedback.
  */
  const feedback = game.currentSubmission?.feedback?.[channel];
  if (!feedback || !(isLocalTurn() && game.phase === "review")) return "";
  return `tier-${feedback}`;
}

/*
  Builds the main RGB control stacks from current boundaries and turn editability.

  This is one of the most important render functions:
  - If it is your turn, it creates <input> elements for R/G/B.
  - If it is not your turn, it creates read-only-looking divs instead.
  - It also creates the Submit button and attaches event listeners.

  Note: because this function replaces innerHTML, old elements are destroyed and
  new elements are created each render. That is why event listeners are added
  again inside this function after the new HTML exists.
*/
function renderChannels() {
  const editable = game.phase === "guessing" && isLocalTurn();

  const channelsHtml = CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const bounds = game.boundaries[channel];
    const value = channelValue(channel);
    const hasValue = value !== "" && value !== undefined && value !== null;
    const tier = channelTier(channel);
    const inputName = `guess-${channel}`;

    // Editable mode uses a real input. Non-editable mode uses a div for display only.
    const box = editable
      ? `
        <div class="value-entry ${hasValue ? "has-value" : ""}">
          <input class="value-box ${meta.css}" id="${inputName}" data-channel="${channel}" type="number" inputmode="numeric" min="0" max="255" value="${hasValue ? value : ""}" aria-label="${meta.label} value" />
          <span class="value-label" aria-hidden="true">${meta.label}</span>
        </div>
      `
      : `<div class="value-box ${meta.css}" aria-label="${meta.label} value">${hasValue ? value : meta.label}</div>`;

    /*
      Each channel visually looks like:
      high bound
      <=
      value box
      <=
      low bound
    */
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
    <button class="submit-button" id="submitButton" type="button" disabled>Submit</button>
  `;

  // innerHTML = ... creates a new button every time -> code must attach the click behavior again
  document.getElementById("submitButton").addEventListener("click", () => {
    submitTurn(false);
  });

  // Input listeners sanitize user typing and re-check whether Submit can be enabled.
  CHANNELS.forEach((channel) => {
    const input = document.getElementById(`guess-${channel}`);
    if (!input) return;
    input.addEventListener("input", (event) => {
      // Keep only digits, and limit length to 3 because RGB values are 0..255.
      const value = event.target.value.replace(/\D/g, "").slice(0, 3);
      event.target.value = value;
      event.target.closest(".value-entry")?.classList.toggle("has-value", value.length > 0);
      game.lastVisibleGuess[channel] = value;
      els.statusLine.textContent = "";
      updateTurnSubmitButtonState();
    });
  });

  updateTurnSubmitButtonState();
}

function renderChoiceModal() {
  /*
    The choice modal appears during the peek phase.
    Non-current players can choose one channel to inspect from the current
    player's submitted guess.
  */
  const showChoice = game.phase === "choosing";
  els.choiceLayer.hidden = !showChoice;
  if (!showChoice) return;

  els.choiceButtons.innerHTML = CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const bounds = game.boundaries[channel];
    const selected = game.selectedChoice === channel;
    const revealed = selected && game.currentSubmission?.guess?.[channel] !== undefined;
    const tier = revealed ? `tier-${game.currentSubmission.feedback[channel]}` : "";
    const label = revealed ? game.currentSubmission.guess[channel] : meta.label;

    // Once a player has selected a channel, all choice buttons are disabled.
    const disabled = game.selectedChoice ? "disabled" : "";
    return `
      <div class="choice-channel">
        <div class="choice-bound">${bounds.high}</div>
        <div class="choice-chevron" aria-hidden="true">&le;</div>
        <button class="choice-button ${meta.css} ${tier}" data-choice="${channel}" type="button" ${disabled} aria-label="Reveal ${meta.label}">
          <span class="choice-label">${label}</span>
        </button>
        <div class="choice-chevron choice-chevron-up" aria-hidden="true">&le;</div>
        <div class="choice-bound">${bounds.low}</div>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => chooseChannel(button.dataset.choice));
  });
}

function renderFinalModal() {
  // Show the final modal only during the final phase.
  const showFinal = game.phase === "final";
  els.finalLayer.hidden = !showFinal;
  if (!showFinal) return;

  /*
    The final input fields already exist in the HTML.
    Here we only update the displayed low/high boundaries for each channel.
  */
  CHANNELS.forEach((channel) => {
    const bounds = game.boundaries[channel];
    const high = document.querySelector(`[data-final-bound-high="${channel}"]`);
    const low = document.querySelector(`[data-final-bound-low="${channel}"]`);
    if (high) high.textContent = bounds.high;
    if (low) low.textContent = bounds.low;
  });

  updateFinalSubmitButtonState();
}

// 수정 예정
function resultBoxesFor(values, labelPrefix) {
  // Helper used by the result modal to display R/G/B boxes as read-only text inputs.
  return CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const value = values?.[channel] ?? 0;
    return `
      <input
        class="value-box ${meta.css}"
        type="text"
        value="${value}"
        readonly
        aria-label="${labelPrefix} ${meta.label} value"
      />
    `;
  }).join("");
}

function finalGuessText(guess) {
  // Convert a final guess object into compact table text.
  if (!guess) return "-";
  return `R ${guess.r ?? 0} / G ${guess.g ?? 0} / B ${guess.b ?? 0}`;
}

function resultTableRows() {
  /*
    The server already sends results sorted by smallest error.
    Sorting again here keeps the table correct even if that server detail changes.
  */
  return [...(game.results || [])]
    .sort((a, b) => (a.finalError ?? 0) - (b.finalError ?? 0))
    .map((result, index) => `
      <tr class="${result.userId === game.localPlayerId ? "is-me" : ""}">
        <td>${index + 1}</td>
        <td><span class="result-profile" aria-hidden="true"></span></td>
        <td>${escapeHtml(result.nickname || "Player")}</td>
        <td>${escapeHtml(finalGuessText(result.finalGuess))}</td>
        <td>0 RP</td>
      </tr>
    `).join("");
}

// 얘도 수정 예정
function renderResultModal() {
  // Hide the result modal unless the game is finished and score data exists.
  els.resultLayer.hidden = game.phase !== "score";
  if (game.phase !== "score" || !game.score) {
    els.resultText.textContent = "";
    return;
  }

  els.resultText.innerHTML = `
    <div class="result-answer">
      <p class="result-row-title">Answer</p>
      <div class="result-boxes" aria-label="Correct RGB result">
        ${resultBoxesFor(game.targetRgb, "Correct")}
      </div>
    </div>
    <p class="result-total-error">My total error: ${game.score.totalError}</p>
    <div class="result-table-wrap">
      <table class="result-table">
        <thead>
          <tr>
            <th>Index</th>
            <th>Profile</th>
            <th>Name</th>
            <th>Final Guess</th>
            <th>RP</th>
          </tr>
        </thead>
        <tbody>
          ${resultTableRows()}
        </tbody>
      </table>
    </div>
  `;
}

function render() {
  /*
    Central redraw function.
    Whenever state changes, call render() so the visible UI matches game state.
    This project uses manual rendering rather than a framework like React.
  */
  els.screenTitle.textContent = currentTitle();
  renderLobby();

  // If lobby is visible, the game-board elements are hidden, so no need to render them.
  if (isLobbyPhase()) return;

  els.roundLabel.textContent = `Round ${Math.min(game.currentRound, TOTAL_ROUNDS)}`;
  els.timerNumber.textContent = game.phase === "choosing" ? game.choiceSeconds : game.turnSeconds;
  els.timerCaption.textContent = game.phase === "choosing" ? "PICK" : "SECONDS";
  if (els.choicePopupTime) els.choicePopupTime.textContent = game.choiceSeconds;
  if (els.finalPopupTime) els.finalPopupTime.textContent = game.turnSeconds;
  renderTargetImage();
  renderPlayers();
  renderChannels();
  renderChoiceModal();
  renderFinalModal();
  renderResultModal();
}

function readGuessFromInputs() {
  /*
    Read the main turn guess inputs and convert them to numbers.
    If any channel is empty, non-integer, or outside 0..255, return null.
    Returning null is a simple way to say "invalid input."
  */
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

function isValidRgbNumber(rawValue) {
  // Shared validation for both main-turn inputs and final-guess inputs.
  if (rawValue === "") return false;
  const value = Number(rawValue);
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function areTurnInputsValid() {
  /*
    The main Submit button should be enabled only when:
    - it is the guessing phase,
    - it is this player's turn,
    - this player has not already submitted,
    - every R/G/B input is a valid 0..255 integer.
  */
  if (game.phase !== "guessing" || !isLocalTurn() || game.turnSubmitted) return false;
  return CHANNELS.every((channel) => {
    const input = document.getElementById(`guess-${channel}`);
    return input && isValidRgbNumber(input.value.trim());
  });
}

function updateTurnSubmitButtonState() {
  // Enable/disable the dynamically created turn Submit button.
  const submitButton = document.getElementById("submitButton");
  if (!submitButton) return;
  submitButton.disabled = !areTurnInputsValid();
}

function areFinalInputsValid() {
  /*
    Same idea as areTurnInputsValid, but for the final modal.
    The final inputs already exist in the HTML, so we read #final-r/g/b directly.
  */
  if (game.phase !== "final" || game.finalSubmitted) return false;
  return CHANNELS.every((channel) => {
    const input = document.getElementById(`final-${channel}`);
    return input && isValidRgbNumber(input.value.trim());
  });
}

function updateFinalSubmitButtonState() {
  // Enable/disable the final Submit button.
  if (!els.submitFinalButton) return;
  els.submitFinalButton.disabled = !areFinalInputsValid();
}

/*
  Boundary update: intersect current bounds with the interval revealed by feedback color.

  Example:
  - Suppose current R range is 0..255.
  - Player guessed R = 100.
  - Feedback is green, meaning true R is within +/- 10.
  - New possible R range becomes 90..110.

  If the range was already narrower, this keeps only the overlapping part.
*/
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
  /*
    Countdown for a normal guessing turn.
    This only updates the local display. The server still controls the real
    timeout and will send the next event when the phase changes.
  */
  clearInterval(turnTimer);
  game.turnSeconds = seconds;
  els.timerNumber.textContent = seconds;
  // run this function every second
  // turnTimer = timer id
  turnTimer = setInterval(() => {
    game.turnSeconds -= 1;
    els.timerNumber.textContent = game.turnSeconds;
    if (game.turnSeconds <= 0) {
      clearInterval(turnTimer);
      if (areTurnInputsValid()) {
        submitTurn(true);
      }
    }
  }, 1000);
}

function startChoiceCountdown(seconds) {
  // Countdown shown during the peek/choice phase.
  clearInterval(choiceTimer);
  game.choiceSeconds = seconds;
  els.timerNumber.textContent = seconds;
  if (els.choicePopupTime) els.choicePopupTime.textContent = seconds;
  choiceTimer = setInterval(() => {
    game.choiceSeconds -= 1;
    els.timerNumber.textContent = game.choiceSeconds;
    if (els.choicePopupTime) els.choicePopupTime.textContent = game.choiceSeconds;
    if (game.choiceSeconds <= 0) clearInterval(choiceTimer);
  }, 1000);
}

function startFinalCountdown(seconds) {
  /*
    Countdown for final guess.
    If time reaches 0 and all final inputs are valid, submit them automatically.
  */
  clearInterval(turnTimer);
  game.turnSeconds = seconds;
  els.timerNumber.textContent = seconds;
  if (els.finalPopupTime) els.finalPopupTime.textContent = seconds;
  turnTimer = setInterval(() => {
    game.turnSeconds -= 1;
    els.timerNumber.textContent = game.turnSeconds;
    if (els.finalPopupTime) els.finalPopupTime.textContent = game.turnSeconds;
    if (game.turnSeconds <= 0) {
      clearInterval(turnTimer);
      if (areFinalInputsValid()) {
        submitFinalAnswer(true);
      }
    }
  }, 1000);
}

function resetFinalInputs() {
  // Clear final R/G/B input boxes and remove filled-state styling.
  CHANNELS.forEach((channel) => {
    const input = document.getElementById(`final-${channel}`);
    if (!input) return;
    input.value = "";
    input.closest(".value-entry")?.classList.remove("has-value");
  });
}

function currentNickname() {
  return els.nicknameInput.value.trim() || `Player ${localUserId.slice(-4)}`;
}

function openCreateRoomModal() {
  // Show the create-room popup and provide a friendly default room name.
  if (!els.createRoomLayer) return;
  els.createRoomNameInput.value = `${currentNickname()}'s room`;
  els.createRoomCodeInput.value = "";
  els.createRoomLayer.hidden = false;
  els.createRoomNameInput.focus();
}

function closeCreateRoomModal() {
  // Hide the create-room popup without changing the current lobby.
  if (els.createRoomLayer) els.createRoomLayer.hidden = true;
}

function createRoomFromLobby() {
  /*
    Called when the user confirms the create-room popup.
    A blank room code creates a public room. A non-blank room code creates a
    private room that other users must enter before joining.
  */
  if (!socket) {
    setLobbyStatus("Open this page through the Node server to use rooms.");
    return;
  }

  roomClient.nickname = currentNickname();
  socket.emit("create_room", {
    roomName: els.createRoomNameInput.value.trim(),
    roomCode: els.createRoomCodeInput.value.trim(),
    level: Number(els.createLevelSelect.value),
    maxPlayers: Number(els.maxPlayersSelect.value),
    userId: game.localPlayerId,
    nickname: roomClient.nickname
  });
  setLobbyStatus("Creating room...");
}

function joinRoom(roomCode, privateCode = "") {
  /*
    Called when the user clicks a Join button in the room list.
    roomCode identifies the listed room. privateCode is only filled for rooms
    marked (P).
  */
  if (!socket) {
    setLobbyStatus("Open this page through the Node server to use rooms.");
    return;
  }

  roomClient.roomCode = String(roomCode || "").trim().toUpperCase();
  roomClient.nickname = currentNickname();
  socket.emit("join_room", {
    roomCode: roomClient.roomCode,
    privateCode,
    userId: game.localPlayerId,
    nickname: roomClient.nickname
  });
  setLobbyStatus("Joining room...");
}

function resetToMainLobby(message = "Choose or create a room.") {
  roomClient.joined = false;
  roomClient.roomCode = "";
  roomClient.roomName = "";
  roomClient.hostUserId = null;
  roomClient.level = 1;
  roomClient.maxPlayers = 5;
  roomClient.isPrivate = false;
  game.phase = "lobby";
  game.players = [];
  render();
  setLobbyStatus(message);
}

function leaveRoom() {
  // Leave the waiting lobby and return to the main room list.
  if (!socket || !roomClient.joined) {
    resetToMainLobby();
    return;
  }

  socket.emit("leave_room", {
    roomCode: roomClient.roomCode
  });
  resetToMainLobby("Leaving room...");
}

function startGameFromLobby() {
  // Called when the host clicks Start Game in the waiting lobby.
  if (!socket || !roomClient.joined) return;
  socket.emit("start_game", {
    roomCode: roomClient.roomCode
  });
}

function submitTurn(autoSubmit) {
  /*
    Submit this player's normal turn guess to the server.
    autoSubmit is kept for symmetry/future use; currently user clicks call false.
  */
  if (game.phase !== "guessing" || !isLocalTurn()) return;

  const guess = readGuessFromInputs();
  if (!guess) {
    if (!autoSubmit) {
      els.statusLine.textContent = "Enter RGB numbers from 0 to 255.";
    }
    return;
  }

  // Save locally so the UI can keep showing the submitted values.
  game.lastVisibleGuess = { ...guess };
  game.turnSubmitted = true;

  // Send the answer to the backend; the backend calculates feedback.
  socket.emit("submit_guess", {
    roomCode: roomClient.roomCode,
    guessRGB: guess
  });
  els.statusLine.textContent = "Submitted. Waiting for reveal...";
  const submitButton = document.getElementById("submitButton");
  if (submitButton) submitButton.disabled = true;
}

function chooseChannel(channel) {
  // During peek phase, ask the server to reveal one channel from the current guess.
  if (game.phase !== "choosing" || game.selectedChoice) return;
  game.selectedChoice = channel;
  socket.emit("peek_color", {
    roomCode: roomClient.roomCode,
    selectedColor: channel
  });
  renderChoiceModal();
}

function submitFinalAnswer(autoSubmit = false) {
  /*
    Submit final R/G/B answer.
    autoSubmit is true when the timer submits valid existing inputs automatically.
  */
  if (game.phase !== "final") return;

  const answer = {};
  for (const channel of CHANNELS) {
    const input = document.getElementById(`final-${channel}`);
    const rawValue = input ? input.value.trim() : String(game.finalAnswer[channel]).trim();
    const value = Number(rawValue);
    if (rawValue === "" || !Number.isInteger(value) || value < 0 || value > 255) {
      if (!autoSubmit) els.finalStatus.textContent = "Enter final RGB numbers from 0 to 255.";
      return;
    }
    answer[channel] = value;
  }

  clearInterval(turnTimer);
  game.finalAnswer = { ...answer };
  game.finalSubmitted = true;
  socket.emit("submit_final_guess", {
    roomCode: roomClient.roomCode,
    guessRGB: answer
  });
  els.finalStatus.textContent = "다른 플레이어의 입력을 기다리는 중...";
  els.submitFinalButton.disabled = true;
}

function handleRoomList(data) {
  /*
    Server event: room_list.
    This is the main lobby list of rooms that are currently waiting for players.
  */
  roomClient.rooms = data?.rooms || [];
  if (game.phase === "lobby") renderLobby();
}

// 얘도 수정해야 할듯
function handleRoomUpdate(data) {
  /*
    Server event: room_update
    Sent when lobby state changes, such as a player joining or the host changing.
    It keeps the lobby player list and host permissions up to date.
  */
  roomClient.hostUserId = data.hostUserId;
  roomClient.roomCode = data.roomCode;
  roomClient.roomName = data.roomName || "Waiting Room";
  roomClient.level = Number(data.level) || 1;
  roomClient.maxPlayers = Number(data.maxPlayers) || 5;
  roomClient.isPrivate = Boolean(data.isPrivate);
  game.players = playersFromServer(data.players || []);
  if (data.phase === "PEEKING") {
    game.responseMarks = new Set(
      game.players.filter((player) => player.hasPeeked).map((player) => player.id)
    );
  } else if (data.phase !== "PLAYING") {
    game.responseMarks = new Set();
  }

  if (data.phase === "WAITING") {
    game.phase = "waiting";
    roomClient.joined = game.players.some((player) => player.id === game.localPlayerId);
    closeCreateRoomModal();
    setLobbyStatus(roomClient.joined
      ? `Room ${roomClient.roomName} is waiting.`
      : "Join a room to play.");
  }

  render();
}

function handleRoundStart(data) {
  /*
    Server event: round_start
    Sent at the start of each round. The server sends the target colors that
    should be displayed for this round.
  */
  game.currentRound = data.round;
  game.targetColors = data.colors || [];

  // Only reset clue boundaries at the first round of the game.
  if (data.round === 1) resetBoundaries();
  game.score = null;
  game.results = [];
  game.finalAnswer = { r: "", g: "", b: "" };
  game.currentSubmission = null;
  game.turnSubmitted = false;
  game.selectedChoice = null;
  game.responseMarks = new Set();
  render();
}

function handleTurnStart(data) {
  /*
    Server event: turn_start
    Sent when a player gets a normal guessing turn.
    The frontend records whose turn it is and starts the local countdown display.
  */
  clearAllTimers();
  game.phase = "guessing";
  game.currentRound = data.round;
  game.players = playersFromServer(data.players || []);

  // Find which player in the local players array matches the turn user id.
  game.currentPlayerIndex = game.players.findIndex((player) => player.id === data.turnUserId);
  if (game.currentPlayerIndex < 0) game.currentPlayerIndex = 0;

  // New turn means previous submission/choice/input state should be cleared.
  game.currentSubmission = null;
  game.turnSubmitted = false;
  game.selectedChoice = null;
  game.lastVisibleGuess = { r: "", g: "", b: "" };
  game.responseMarks = new Set();
  els.statusLine.textContent = isLocalTurn() ? "" : `${activePlayer().name} is guessing.`;
  render();
  startTurnCountdown(data.timeLimit || 30);
}

function handleMyGuessResult(data) {
  /*
    Server event: my_guess_result
    Sent only to the player who just submitted a guess.
    It contains exact feedback for all three channels.
  */
  clearInterval(turnTimer);
  game.phase = "review";
  game.currentSubmission = {
    guess: data.guessRGB,
    feedback: data.feedback
  };
  game.lastVisibleGuess = { ...data.guessRGB };

  // Use the feedback to narrow possible final-answer ranges.
  tightenBoundsFromFeedback(data.guessRGB, data.feedback, CHANNELS);
  els.statusLine.textContent = "";
  render();
}

function handlePeekingStart(data) {
  /*
    Server event: peeking_start
    Sent after the current player has submitted.
    Other players can choose one channel to peek. The current player does not
    get the choice modal, because they already saw their own feedback.
  */
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
  /*
    Server event: peek_result
    Sent after this player chooses R, G, or B during peeking.
    It reveals only the selected channel's guessed value and feedback color.
  */
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

function handlePlayerPeeked(data) {
  /*
    Server event: player_peeked
    Sent to the whole room when a non-turn player chooses a channel to peek.
    The player list already knows how to show a check for ids in responseMarks.
  */
  console.log("player_peeked received:", data);
  if (!data?.userId) return;
  game.responseMarks.add(data.userId);
  console.log("responseMarks:", [...game.responseMarks]);
  renderPlayers();
}

function handleFinalGuessStart(data) {
  /*
    Server event: final_guess_start
    Sent after all rounds/turns are done. Every player now submits a final RGB guess.
  */
  clearAllTimers();
  game.phase = "final";
  game.turnSeconds = data.timeLimit || 30;
  game.targetColors = data.colors || game.targetColors;
  game.finalAnswer = { r: "", g: "", b: "" };
  game.finalSubmitted = false;
  els.finalStatus.textContent = "";
  els.submitFinalButton.disabled = true;
  resetFinalInputs();
  render();
  startFinalCountdown(game.turnSeconds);
}

// 수정해야 됨 
function handleGameOver(data) {
  /*
    Server event: game_over
    Sent after final guesses are submitted or time runs out.
    The server sends the true target RGB and result list.
  */
  clearAllTimers();
  game.phase = "score";
  game.targetRgb = data.targetRgb;
  game.results = data.results || [];

  // Find this player's result inside the server's full result array.
  const myResult = game.results.find((result) => result.userId === game.localPlayerId);
  game.finalAnswer = myResult?.finalGuess || game.finalAnswer;
  game.score = {
    totalError: myResult?.finalError ?? 0,
    points: myResult?.earnedPoint ?? 0
  };
  render();
}

/*
  UI event wiring.
  These listeners connect user actions in the browser to the functions above.
  addEventListener("click", fn) means "run fn when this element is clicked."
*/
els.nicknameInput.value = `Player ${localUserId.slice(-4)}`;
els.openCreateRoomButton.addEventListener("click", openCreateRoomModal);
els.closeCreateRoomButton.addEventListener("click", closeCreateRoomModal);
els.cancelCreateRoomButton.addEventListener("click", closeCreateRoomModal);
els.createRoomButton.addEventListener("click", createRoomFromLobby);
els.leaveRoomButton.addEventListener("click", leaveRoom);
els.startGameButton.addEventListener("click", startGameFromLobby);

// if (els.guideButton && els.guidePopover) {
//   // Optional guide popup support. The current HTML may not include these elements.
//   els.guideButton.addEventListener("click", () => {
//     els.guidePopover.hidden = false;
//   });
// }

// if (els.closeGuide && els.guidePopover) {
//   els.closeGuide.addEventListener("click", () => {
//     els.guidePopover.hidden = true;
//   });
// }

if (els.volumeButton && els.volumeSliderWrap) {
  // Toggle the volume slider open/closed.
  els.volumeButton.addEventListener("click", () => {
    const nextOpen = els.volumeSliderWrap.hidden;
    els.volumeSliderWrap.hidden = !nextOpen;
    els.volumeButton.setAttribute("aria-expanded", String(nextOpen));
  });
}

els.closeChoice.addEventListener("click", () => {
  // This only hides the modal locally. The server still owns the actual phase timing.
  els.choiceLayer.hidden = true;
});

document.querySelectorAll("[data-final-channel]").forEach((input) => {
  /*
    Final inputs are static HTML, so their listeners are attached once here.
    dataset.finalChannel reads the data-final-channel attribute from HTML.
  */
  input.addEventListener("input", (event) => {
    const value = event.target.value.replace(/\D/g, "").slice(0, 3);
    const channel = event.target.dataset.finalChannel;
    event.target.value = value;
    event.target.closest(".value-entry")?.classList.toggle("has-value", value.length > 0);
    game.finalAnswer[channel] = value;
    els.finalStatus.textContent = "";
    updateFinalSubmitButtonState();
  });
});

els.submitFinalButton.addEventListener("click", () => {
  // User clicked the final submit button.
  submitFinalAnswer();
});

els.closeResult.addEventListener("click", () => {
  // Hide the result popup after the user is done reading it.
  els.resultLayer.hidden = true;
});

els.exitButton.addEventListener("click", () => {
  // Placeholder behavior: the visual button exists, but no navigation/reset is wired yet.
  els.statusLine.textContent = "Exit action can be connected later.";
});


/*
  Server event wiring.
  socket.on(eventName, handler) means:
  "When the server sends eventName to this browser, call handler."
*/
if (PREVIEW_GAME_SCREEN) {
  // In preview mode, skip server events and just render local fake state.
  els.statusLine.textContent = "Preview mode: set PREVIEW_GAME_SCREEN to false to use the lobby/server flow.";
} else if (socket) {
  // Basic connection lifecycle events.
  // 수정 예정
  socket.on("connect", () => {
    setLobbyStatus("Connected. Join or create a room.");
    socket.emit("request_room_list");
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

  // Game-specific events sent by server.js.
  socket.on("room_list", handleRoomList);
  socket.on("left_room", () => resetToMainLobby("Choose or create a room."));
  socket.on("room_update", handleRoomUpdate);
  socket.on("round_start", handleRoundStart);
  socket.on("turn_start", handleTurnStart);
  socket.on("my_guess_result", handleMyGuessResult);
  socket.on("peeking_start", handlePeekingStart);
  socket.on("peek_result", handlePeekResult);
  socket.on("player_peeked", handlePlayerPeeked);
  socket.on("final_guess_start", handleFinalGuessStart);
  socket.on("final_guess_received", () => {
    // Confirmation that the server received this player's final answer.
    els.finalStatus.textContent = "다른 플레이어의 입력을 기다리는 중...";
  });
  socket.on("game_over", handleGameOver);
} else {
  setLobbyStatus("Socket.IO is not loaded. Start the Node server and open http://localhost:3000.");
}

// Initial paint. Without this call, the page would keep only the raw HTML defaults.
render();
