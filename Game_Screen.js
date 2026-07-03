/*
  All game behavior in this demo lives in this script:
  - mock player/game state
  - rendering the current screen
  - validating RGB guesses
  - updating boundaries
  - running turn and reveal timers
  - handling guide/reveal/final-score interactions
*/

/*
  Later backend shape:
  {
    localPlayerId,
    players,
    round,
    turnPlayerId,
    phase,
    targetRgb,
    boundaries,
    submissions
  }
  The UI below uses that shape with local mock data so the HTML works alone.
*/

/* RGB channel labels and CSS class names used by both the input boxes and reveal modal. */
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

/* Temporary single-color target. Later this can become a 1-5 color generator. */
function randomRgbValue() {
  return Math.floor(Math.random() * 256);
}

function createSingleColorTarget() {
  return {
    r: randomRgbValue(),
    g: randomRgbValue(),
    b: randomRgbValue()
  };
}

/*
  Temporary in-browser game state.
  Later this object can be replaced with data from the server or a multiplayer store.
*/
const game = {
  localPlayerId: 1,
  players: [
    { id: 1, name: "Player 1(Me)" },
    { id: 2, name: "Player 2" },
    { id: 3, name: "Player 3" },
    { id: 4, name: "Player 4" },
    { id: 5, name: "Player 5" }
  ],
  targetRgb: createSingleColorTarget(),
  boundaries: {
    r: { low: 0, high: 255 },
    g: { low: 0, high: 255 },
    b: { low: 0, high: 255 }
  },
  currentRound: 1,
  currentPlayerIndex: 0,
  phase: "guessing",
  turnSeconds: 30,
  choiceSeconds: 10,
  currentSubmission: null,
  lastVisibleGuess: { r: "", g: "", b: "" },
  responseMarks: new Set(),
  selectedChoice: null,
  finalAnswer: { r: "", g: "", b: "" },
  score: null
};

/* Timer handles so countdowns and delayed transitions can be cancelled cleanly. */
let turnTimer = null;
let choiceTimer = null;
let pendingAdvance = null;
let autoSubmitTimer = null;
let responseTimers = [];

/* Frequently used DOM nodes. Keeping them here avoids repeated document lookups. */
const els = {
  screenTitle: document.getElementById("screenTitle"),
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

/* General helpers for numeric bounds, active player lookup, and scoring tiers. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function activePlayer() {
  return game.players[game.currentPlayerIndex];
}

function isLocalTurn() {
  return activePlayer().id === game.localPlayerId;
}

function possessive(name) {
  return name.endsWith("s") ? name + "'" : name + "'s";
}

function errorTier(error) {
  if (error === 0) return "blue";
  if (error <= 10) return "green";
  if (error <= 50) return "yellow";
  if (error <= 150) return "orange";
  return "red";
}

function errorLimitFor(error) {
  return ERROR_LIMIT_BY_TIER[errorTier(error)];
}

function errorsFor(guess) {
  return CHANNELS.reduce((errors, channel) => {
    errors[channel] = Math.abs(Number(guess[channel]) - game.targetRgb[channel]);
    return errors;
  }, {});
}

function clearAllTimers() {
  clearInterval(turnTimer);
  clearInterval(choiceTimer);
  clearTimeout(pendingAdvance);
  clearTimeout(autoSubmitTimer);
  responseTimers.forEach(clearTimeout);
  responseTimers = [];
}

/* Builds the large title at the top from the current turn owner and game phase. */
function currentTitle() {
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

/* Re-renders the player list and check marks for players who have responded. */
function renderPlayers() {
  els.playersList.innerHTML = game.players.map((player, index) => {
    const active = index === game.currentPlayerIndex && game.phase !== "final" && game.phase !== "score";
    const me = player.id === game.localPlayerId;
    const checked = game.responseMarks.has(player.id);
    return `
      <div class="player-row ${active ? "is-active" : ""} ${me ? "is-me" : ""}">
        <div class="player-name">${player.name}</div>
        <div class="player-check" aria-hidden="true">${checked ? "&#10003;" : ""}</div>
      </div>
    `;
  }).join("");
}

/* Decides what should appear inside each RGB box for guessing and review modes. */
function channelValue(channel) {
  if (game.currentSubmission && isLocalTurn() && game.phase === "review") {
    return game.currentSubmission.guess[channel];
  }
  return game.lastVisibleGuess[channel] || "";
}

/* Paints the center image block with the generated target color. */
function renderTargetImage() {
  const { r, g, b } = game.targetRgb;
  const targetColor = `rgb(${r}, ${g}, ${b})`;
  els.targetImage.style.backgroundColor = targetColor;
  els.finalTargetImage.style.backgroundColor = targetColor;
}

/* Returns the result color class for a channel after the local player's submission. */
function channelTier(channel) {
  if (!game.currentSubmission) return "";
  if (!(isLocalTurn() && game.phase === "review")) return "";
  const tier = errorTier(game.currentSubmission.errors[channel]);
  return `tier-${tier}`;
}

/* Renders the RGB boxes, boundaries, and submit button for the current phase. */
function renderChannels() {
  const editable = game.phase === "guessing" && isLocalTurn();
  const canSubmit = editable;

  const channelsHtml = CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const bounds = game.boundaries[channel];
    const value = channelValue(channel);
    const tier = channelTier(channel);
    const inputName = `guess-${channel}`;
    const box = editable
      ? `
        <div class="value-entry ${value ? "has-value" : ""}">
          <input class="value-box ${meta.css}" id="${inputName}" data-channel="${channel}" type="number" inputmode="numeric" min="0" max="255" value="${value}" aria-label="${meta.label} value" />
          <span class="value-label" aria-hidden="true">${meta.label}</span>
        </div>
      `
      : `<div class="value-box ${meta.css}" aria-label="${meta.label} value">${value || meta.label}</div>`;

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
    <button class="submit-button" id="submitButton" type="button" ${canSubmit ? "" : "disabled"}>Submit</button>
  `;

  const submitButton = document.getElementById("submitButton");
  submitButton.addEventListener("click", () => {
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
    });
  });
}

/* Renders the choose-one modal shown to the local player during another player's result reveal. */
function renderChoiceModal() {
  const showChoice = game.phase === "choosing";
  els.choiceLayer.hidden = !showChoice;
  if (!showChoice || !game.currentSubmission) return;

  els.choiceButtons.innerHTML = CHANNELS.map((channel) => {
    const meta = CHANNEL_META[channel];
    const selected = game.selectedChoice === channel;
    const tier = selected ? `tier-${errorTier(game.currentSubmission.errors[channel])}` : "";
    const label = selected ? game.currentSubmission.guess[channel] : meta.label;
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

/* Shows or hides the final answer popup. */
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

/* Builds one read-only RGB row for the result popup. */
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

/* Shows the final score popup after the player submits their final RGB answer. */
function renderResultModal() {
  els.resultLayer.hidden = game.phase !== "score";
  if (game.phase !== "score" || !game.score) {
    els.resultText.textContent = "";
    return;
  }

  const finalAnswer = game.finalAnswer;
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
        ${resultBoxesFor(finalAnswer, "Final guess")}
      </div>
    </div>
    <p class="result-total-error">Total error: ${game.score.totalError}</p>
  `;
}

/* Central render function: updates every visible part of the UI from the game state. */
function render() {
  els.screenTitle.textContent = currentTitle();
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

/* Reads and validates the local player's three RGB inputs for a normal turn. */
function readGuessFromInputs() {
  const guess = {};
  for (const channel of CHANNELS) {
    const input = document.getElementById(`guess-${channel}`);
    const rawValue = input ? input.value.trim() : String(game.lastVisibleGuess[channel]).trim();
    if (rawValue === "") {
      return null;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    guess[channel] = value;
  }
  return guess;
}

/* Mock guess generator for other players until real multiplayer data exists. */
function mockGuessForCurrentPlayer() {
  const roundOffset = game.currentRound * 13;
  const playerOffset = activePlayer().id * 19;
  return {
    r: clamp(92 + playerOffset + roundOffset, 0, 255),
    g: clamp(205 - playerOffset + Math.round(roundOffset / 2), 0, 255),
    b: clamp(71 + playerOffset - Math.round(roundOffset / 3), 0, 255)
  };
}

/* Tightens each revealed channel by intersecting the current boundary with the result-color interval. */
function tightenBounds(guess, channels) {
  channels.forEach((channel) => {
    const value = Number(guess[channel]);
    const error = Math.abs(value - game.targetRgb[channel]);
    const errorLimit = errorLimitFor(error);
    const bounds = game.boundaries[channel];
    const revealedLow = clamp(value - errorLimit, 0, 255);
    const revealedHigh = clamp(value + errorLimit, 0, 255);

    bounds.low = Math.max(bounds.low, revealedLow);
    bounds.high = Math.min(bounds.high, revealedHigh);
  });
}

/* Handles a turn submission, either from the submit button or from the timeout fallback. */
function submitTurn(autoSubmit) {
  if (game.phase !== "guessing") return;

  let guess;
  if (isLocalTurn()) {
    guess = readGuessFromInputs();
    if (!guess) {
      if (!autoSubmit) {
        els.statusLine.textContent = "Enter numbers from 0 to 255.";
        return;
      }

      advanceTurn();
      return;
    }
    game.lastVisibleGuess = { ...guess };
  } else {
    guess = mockGuessForCurrentPlayer();
  }

  clearAllTimers();
  els.statusLine.textContent = "";
  game.currentSubmission = {
    playerId: activePlayer().id,
    round: game.currentRound,
    guess,
    errors: errorsFor(guess)
  };

  if (isLocalTurn()) {
    game.phase = "review";
    tightenBounds(guess, CHANNELS);
    simulateOtherPlayerResponses();
  } else {
    game.phase = "choosing";
    game.choiceSeconds = 10;
    game.selectedChoice = null;
    startChoiceTimer();
  }

  render();
}

/* Demo-only response markers after my submission, simulating other players choosing a channel. */
function simulateOtherPlayerResponses() {
  game.responseMarks = new Set();
  game.players
    .filter((player) => player.id !== game.localPlayerId)
    .forEach((player, index) => {
      responseTimers.push(setTimeout(() => {
        game.responseMarks.add(player.id);
        renderPlayers();
      }, 900 + index * 900));
    });

  pendingAdvance = setTimeout(() => {
    advanceTurn();
  }, 5600);
}

/* Handles the local player's R/G/B choice when watching another player's submission. */
function chooseChannel(channel) {
  if (game.phase !== "choosing" || game.selectedChoice) return;
  game.selectedChoice = channel;
  renderChoiceModal();
  clearInterval(choiceTimer);
  pendingAdvance = setTimeout(() => closeChoiceAndAdvance(), 2000);
}

/* Closes the reveal modal, applies any selected boundary update, and moves to the next turn. */
function closeChoiceAndAdvance() {
  if (game.phase !== "choosing") return;
  if (game.selectedChoice) {
    tightenBounds(game.currentSubmission.guess, [game.selectedChoice]);
  }
  advanceTurn();
}

/* Moves from one player to the next, then from one round to the next, then into the final answer phase. */
function advanceTurn() {
  clearAllTimers();
  game.responseMarks = new Set();
  game.currentSubmission = null;
  game.selectedChoice = null;
  game.choiceSeconds = 10;

  if (game.currentPlayerIndex < game.players.length - 1) {
    game.currentPlayerIndex += 1;
  } else {
    game.currentPlayerIndex = 0;
    game.currentRound += 1;
  }

  if (game.currentRound > TOTAL_ROUNDS) {
    startFinalAnswer();
  } else {
    startTurn();
  }
}

/* Starts a 30-second guessing turn. */
function startTurn() {
  clearAllTimers();
  game.phase = "guessing";
  game.turnSeconds = 30;
  els.statusLine.textContent = "";
  render();

  if (!isLocalTurn()) {
    autoSubmitTimer = setTimeout(() => submitTurn(true), 0);
    return;
  }

  turnTimer = setInterval(() => {
    game.turnSeconds -= 1;
    els.timerNumber.textContent = game.turnSeconds;
    if (game.turnSeconds <= 0) {
      submitTurn(true);
    }
  }, 1000);
}

/* Starts the 10-second window for choosing which channel to reveal. */
function startChoiceTimer() {
  choiceTimer = setInterval(() => {
    game.choiceSeconds -= 1;
    els.timerNumber.textContent = game.choiceSeconds;
    if (game.choiceSeconds <= 0) {
      closeChoiceAndAdvance();
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

/* Shows the final RGB answer form after five full rounds. */
function startFinalAnswer() {
  clearAllTimers();
  game.phase = "final";
  game.turnSeconds = 0;
  game.finalAnswer = { r: "", g: "", b: "" };
  els.statusLine.textContent = "";
  els.finalStatus.textContent = "";
  resetFinalInputs();
  render();
}

/* Scores the final answer by subtracting total RGB error from the maximum possible score. */
function submitFinalAnswer() {
  const answer = {};
  for (const channel of CHANNELS) {
    const input = document.getElementById(`final-${channel}`);
    const rawValue = input ? input.value.trim() : String(game.finalAnswer[channel]).trim();
    const value = Number(rawValue);
    if (rawValue === "" || !Number.isInteger(value) || value < 0 || value > 255) {
      els.finalStatus.textContent = "Enter final numbers from 0 to 255.";
      return;
    }
    answer[channel] = value;
  }

  const errors = errorsFor(answer);
  const totalError = CHANNELS.reduce((sum, channel) => sum + errors[channel], 0);
  game.finalAnswer = { ...answer };
  game.score = {
    totalError,
    points: Math.max(0, 765 - totalError)
  };
  game.lastVisibleGuess = answer;
  game.phase = "score";
  els.statusLine.textContent = "";
  els.finalStatus.textContent = "";
  render();
}

/* UI event wiring for guide, modal close, and placeholder exit actions. */
els.guideButton.addEventListener("click", () => {
  els.guidePopover.hidden = false;
});

els.closeGuide.addEventListener("click", () => {
  els.guidePopover.hidden = true;
});

els.closeChoice.addEventListener("click", () => {
  closeChoiceAndAdvance();
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

/* Initial screen load starts at round 1, player 1, guessing phase. */
startTurn();
// startFinalAnswer();
