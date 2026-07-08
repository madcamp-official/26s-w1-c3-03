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

const PAGE_KIND = document.body?.dataset.page || "combined";
const IS_LOBBY_PAGE = PAGE_KIND === "lobby";
const IS_GAME_PAGE = PAGE_KIND === "game" || PAGE_KIND === "combined";
const LOGIN_PAGE_URL = window.location.protocol === "file:" ? "auth.html" : "/auth.html";
const LOBBY_PAGE_URL = window.location.protocol === "file:" ? "lobby.html" : "/lobby.html";
const GAME_PAGE_URL = window.location.protocol === "file:" ? "game.html" : "/game.html";
const LOGIN_MODULE_URL = window.location.protocol === "file:" ? "login.js" : "/login.js";
const DEFAULT_PROFILE_IMAGE = "/Images/profile.png";
const PENDING_ROOM_ACTION_KEY = "colorMasterPendingRoomAction";
const INTERNAL_NAVIGATION_KEY = "colorMasterInternalNavigation";

function normalizeProfileImage(profileImage) {
  /*
    Login data stores the default profile image as "profile.png".
    The game page is inside Public, while the real image file is served from
    /Images/profile.png, so this function converts the default value into a
    browser-loadable URL.
  */
  const image = String(profileImage || "").trim();
  if (!image || image === "profile.png") return DEFAULT_PROFILE_IMAGE;
  if (image.startsWith("https://firebasestorage.googleapis.com/")) {
    const match = image.match(/\/o\/([^?]+)/);
    if (match) return `/api/profile-image-file?path=${match[1]}`;
  }
  return image;
}

function isDefaultProfileImage(profileImage) {
  const image = String(profileImage || "").trim();
  return !image || image === "profile.png" || image === DEFAULT_PROFILE_IMAGE;
}

function setProfileImage(element, profileImage) {
  if (!element) return;
  element.src = normalizeProfileImage(profileImage);
  element.classList.toggle("is-default-profile", isDefaultProfileImage(profileImage));
}

function profileImageHtml(className, profileImage, alt = "", extraAttributes = "") {
  const defaultClass = isDefaultProfileImage(profileImage) ? " is-default-profile" : "";
  const attributes = extraAttributes ? ` ${extraAttributes}` : "";
  return `<img class="${escapeHtml(`${className}${defaultClass}`)}" src="${escapeHtml(normalizeProfileImage(profileImage))}" alt="${escapeHtml(alt)}"${attributes} />`;
}

function normalizeLoggedInUser(user) {
  /*
    login.js saves the real Firebase/Firestore user in sessionStorage.
    This normalizes the shape so the older game UI can keep reading fields like
    mockCurrentUser.nickname and mockCurrentUser.rankingPoint.
  */
  const uid = user?.uid || user?.id || sessionStorage.getItem("colorMasterUserId");
  const nickname = user?.nickname || sessionStorage.getItem("loggedInNickname") || "Player";
  if (!uid) return null;

  return {
    id: uid,
    uid,
    loginId: user?.loginId || user?.user_id || "",
    nickname,
    rankingPoint: Number(user?.rankingPoint ?? user?.point) || 0,
    profileImage: normalizeProfileImage(user?.profileImage || user?.profile_image),
    password: "*******",
    email: user?.email || "",
    loginType: user?.loginType || sessionStorage.getItem("loginType") || "email",
    isGuest: Boolean(user?.isGuest)
  };
}

function loadCurrentUser() {
  try {
    const storedUser = sessionStorage.getItem("colorMasterCurrentUser");
    if (storedUser) return normalizeLoggedInUser(JSON.parse(storedUser));
  } catch (_error) {
    // Fall through and try legacy session keys.
  }

  return normalizeLoggedInUser({
    uid: sessionStorage.getItem("loggedInUid"),
    nickname: sessionStorage.getItem("loggedInNickname"),
    loginType: sessionStorage.getItem("loginType")
  });
}

function clearLoginSession() {
  [
    "colorMasterCurrentUser",
    "colorMasterUserId",
    "colorMasterMockUser",
    "loggedInNickname",
    "loggedInUid",
    "loginType"
  ].forEach((key) => sessionStorage.removeItem(key));
}

function markInternalNavigation() {
  sessionStorage.setItem(INTERNAL_NAVIGATION_KEY, "true");
}

let internalNavigationConsumed = false;
let guestLogoutBeaconSent = false;

function consumeInternalNavigationFlag() {
  if (internalNavigationConsumed) return true;
  const isInternal = sessionStorage.getItem(INTERNAL_NAVIGATION_KEY) === "true";
  sessionStorage.removeItem(INTERNAL_NAVIGATION_KEY);
  if (isInternal) internalNavigationConsumed = true;
  return isInternal;
}

function sendGuestLogoutBeacon() {
  if (!isGuestUser() || !mockCurrentUser.id || guestLogoutBeaconSent) return;
  guestLogoutBeaconSent = true;
  const payload = JSON.stringify({ userId: mockCurrentUser.id });
  const url = `/api/guest-logout?userId=${encodeURIComponent(mockCurrentUser.id)}`;
  if (navigator.sendBeacon) {
    const body = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon(url, body);
    return;
  }
  fetch(url, {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
    keepalive: true
  }).catch(() => {});
}

async function updateCurrentUserPresence(online) {
  if (!currentUserFromSession || !mockCurrentUser?.id) return;
  try {
    const { setUserPresence } = await import(LOGIN_MODULE_URL);
    await setUserPresence(mockCurrentUser.id, online);
  } catch (error) {
    console.warn("Could not update presence:", error);
  }
}

function refreshVisibleFriendPresence() {
  const friendsPageVisible = roomClient.lobbyView === "friends" && isLobbyPhase();
  const invitePopupVisible = els.inviteFriendLayer && !els.inviteFriendLayer.hidden;
  if (!friendsPageVisible && !invitePopupVisible) return;
  loadFriendsFromDb(true);
}

function refreshMailboxNotifications() {
  loadMailboxNoticesFromDb(false);
}

function startPresenceTracking() {
  if (!currentUserFromSession || presenceTimer) return;
  updateCurrentUserPresence(true);
  presenceTimer = setInterval(() => {
    updateCurrentUserPresence(true);
    refreshVisibleFriendPresence();
    refreshMailboxNotifications();
  }, 10000);
}

function stopPresenceTracking() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
  return updateCurrentUserPresence(false);
}

const currentUserFromSession = loadCurrentUser();
if (!currentUserFromSession && !PREVIEW_GAME_SCREEN) {
  window.location.href = LOGIN_PAGE_URL;
}

const mockCurrentUser = currentUserFromSession || {
  id: "preview_user",
  uid: "preview_user",
  loginId: "",
  nickname: "Player",
  rankingPoint: 0,
  profileImage: DEFAULT_PROFILE_IMAGE,
  password: "*******",
  email: "",
  loginType: "preview",
  isGuest: true
};

const localUserId = mockCurrentUser.id;
sessionStorage.setItem("colorMasterUserId", localUserId);

function isGuestUser() {
  return mockCurrentUser.loginType === "guest" || Boolean(mockCurrentUser.isGuest);
}

document.body?.classList.toggle("is-guest-user", isGuestUser());

const bgmTracks = typeof Audio === "function"
  ? {
      lobby: new Audio("/BGM/Platformer.wav"),
      game: new Audio("/BGM/Pipiripi.mp3")
    }
  : {};

function enableSoftLoop(audio, trimSeconds = 0.12) {
  if (!audio) return;
  audio.loop = false;
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration || Number.isNaN(audio.duration)) return;
    if (audio.currentTime < audio.duration - trimSeconds) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
}

Object.values(bgmTracks).forEach((audio) => {
  audio.loop = true;
  audio.preload = "auto";
});
enableSoftLoop(bgmTracks.lobby, 0.12);
let activeBgmName = "";
let bgmUnlocked = false;
let bgmVolume = clamp(Number(localStorage.getItem("colorMasterVolume") ?? 70), 0, 100);

function createMockProfileImage(nickname, hue) {
  /*
    Temporary profile image for screen development.
    Later this can be replaced with a real image URL from the login/DB server.
  */
  const initials = nickname.slice(0, 2).toUpperCase();
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="hsl(${hue}, 88%, 62%)"/>
          <stop offset="100%" stop-color="hsl(${(hue + 72) % 360}, 82%, 44%)"/>
        </linearGradient>
      </defs>
      <rect width="160" height="160" rx="24" fill="url(#g)"/>
      <circle cx="80" cy="62" r="30" fill="rgba(255,255,255,0.82)"/>
      <path d="M34 142c8-32 28-48 46-48s38 16 46 48" fill="rgba(255,255,255,0.82)"/>
      <text x="80" y="88" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="rgba(20,24,50,0.72)">${initials}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function saveMockUser() {
  /*
    The user-info popup currently edits only local UI state. Keep the session
    copy in sync so the lobby keeps showing the latest values in this tab.
    Updating Firestore will be a separate DB-write step later.
  */
  const currentUser = {
    uid: mockCurrentUser.id,
    id: mockCurrentUser.id,
    loginId: mockCurrentUser.loginId,
    nickname: mockCurrentUser.nickname,
    email: mockCurrentUser.email,
    rankingPoint: mockCurrentUser.rankingPoint,
    profileImage: mockCurrentUser.profileImage,
    loginType: mockCurrentUser.loginType,
    isGuest: mockCurrentUser.isGuest
  };

  sessionStorage.setItem("colorMasterCurrentUser", JSON.stringify(currentUser));
  sessionStorage.setItem("colorMasterUserId", mockCurrentUser.id);
  sessionStorage.setItem("loggedInNickname", mockCurrentUser.nickname);
}

function savePendingRoomAction(action) {
  sessionStorage.setItem(PENDING_ROOM_ACTION_KEY, JSON.stringify(action));
}

function takePendingRoomAction() {
  try {
    const storedAction = sessionStorage.getItem(PENDING_ROOM_ACTION_KEY);
    if (!storedAction) return null;
    sessionStorage.removeItem(PENDING_ROOM_ACTION_KEY);
    return JSON.parse(storedAction);
  } catch (_error) {
    sessionStorage.removeItem(PENDING_ROOM_ACTION_KEY);
    return null;
  }
}

function goToGameWithAction(action) {
  savePendingRoomAction(action);
  markInternalNavigation();
  window.location.href = GAME_PAGE_URL;
}

function goToLobby(message = "") {
  if (message) sessionStorage.setItem("colorMasterLobbyStatus", message);
  markInternalNavigation();
  window.location.href = LOBBY_PAGE_URL;
}

function restoreLobbyStatus() {
  if (PAGE_KIND !== "lobby") return;
  const message = sessionStorage.getItem("colorMasterLobbyStatus");
  if (!message) return;
  sessionStorage.removeItem("colorMasterLobbyStatus");
  setLobbyStatus(message);
}

let leaderboardUsers = [];
let leaderboardLoaded = false;
let leaderboardLoading = false;
let leaderboardLoadPromise = null;
let rankingMode = "all";

let friends = [];
let friendsLoaded = false;
let friendsLoading = false;
let friendsLoadPromise = null;
let friendDeleteMode = false;

function loadMockMailboxNotices() {
  sessionStorage.removeItem("colorMasterMockMailbox");
  return [];
}

function saveMockMailboxNotices() {
  sessionStorage.removeItem("colorMasterMockMailbox");
}

let mockMailboxNotices = loadMockMailboxNotices();
let mailboxLoading = false;
let mailboxLoadPromise = null;

const MAILBOX_READ_IDS_KEY = "colorMasterMailboxReadNoticeIds";

function mailboxReadIds() {
  try {
    const storedIds = JSON.parse(sessionStorage.getItem(MAILBOX_READ_IDS_KEY) || "[]");
    return new Set(Array.isArray(storedIds) ? storedIds : []);
  } catch (_error) {
    return new Set();
  }
}

function hasUnreadMailboxNotices() {
  const readIds = mailboxReadIds();
  return mockMailboxNotices.some((notice) => !readIds.has(String(notice.id)));
}

function updateMailboxUnreadDots() {
  // The same Mailbox button appears on several lobby-style screens.
  const hasUnread = hasUnreadMailboxNotices();
  [
    els.mailboxButton,
    els.rankingMailboxButton,
    els.friendsMailboxButton
  ].forEach((button) => {
    if (!button) return;
    button.classList.toggle("has-unread-mail", hasUnread);
    button.setAttribute("aria-label", hasUnread ? "Mailbox, new mail" : "Mailbox");
  });
}

function markMailboxNoticeAsRead(noticeId) {
  const cleanNoticeId = String(noticeId || "").trim();
  if (!cleanNoticeId) return;
  const readIds = mailboxReadIds();
  readIds.add(cleanNoticeId);
  sessionStorage.setItem(MAILBOX_READ_IDS_KEY, JSON.stringify([...readIds]));
  updateMailboxUnreadDots();
}

async function loadMailboxNoticesFromDb(force = false) {
  if (!mockCurrentUser.id) return mockMailboxNotices;
  if (mailboxLoadPromise) return mailboxLoadPromise;

  mailboxLoading = true;
  const showLoadingState = force || (els.mailboxLayer && !els.mailboxLayer.hidden && !mockMailboxNotices.length);
  if (showLoadingState) renderMailboxNotices();
  if (els.mailboxStatus) els.mailboxStatus.textContent = "";

  mailboxLoadPromise = import(LOGIN_MODULE_URL)
    .then(({ getMailboxNotices }) => getMailboxNotices(mockCurrentUser.id))
    .then((dbNotices) => {
      mockMailboxNotices = dbNotices
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      renderMailboxNotices();
      updateMailboxUnreadDots();
      if (els.mailboxStatus) els.mailboxStatus.textContent = "";
      return mockMailboxNotices;
    })
    .catch((error) => {
      console.error("Failed to load mailbox notices:", error);
      if (els.mailboxStatus) els.mailboxStatus.textContent = "Could not load notices from DB.";
      return mockMailboxNotices;
    })
    .finally(() => {
      mailboxLoading = false;
      mailboxLoadPromise = null;
      renderMailboxNotices();
    });

  return mailboxLoadPromise;
}

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
  lobbyView: "rooms",
  nickname: "",
  hostUserId: null,
  pendingPrivateRoomCode: "",
  privateCode: ""
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
let presenceTimer = null;

function createHiddenStubElement(id) {
  /*
    lobby.html and game.html now contain different parts of the old combined DOM.
    The shared controller still references all ids, so missing page-specific
    elements get inert hidden stubs instead of causing null errors.
  */
  const element = document.createElement("div");
  element.id = id;
  element.hidden = true;
  element.style.display = "none";
  element.setAttribute("data-stub-element", "true");
  document.body.appendChild(element);
  return element;
}

function byId(id) {
  return document.getElementById(id) || createHiddenStubElement(id);
}

/*
  Frequently used DOM nodes.
  byId("...") finds an element from the HTML by id.
  Storing them in els avoids repeating long DOM lookup code everywhere.
  If an id changes in the HTML, the matching name here must be updated too.
*/
const els = {
  screenTitle: byId("screenTitle"),
  lobbyScreen: byId("lobbyScreen"),
  gameBoard: byId("gameBoard"),
  lobbyStatus: byId("lobbyStatus"),
  mainLobbyPanel: byId("mainLobbyPanel"),
  rankingPagePanel: byId("rankingPagePanel"),
  waitingLobbyPanel: byId("waitingLobbyPanel"),
  lobbyProfileImage: byId("lobbyProfileImage"),
  lobbyNickname: byId("lobbyNickname"),
  lobbyRankingPoint: byId("lobbyRankingPoint"),
  rankingProfileImage: byId("rankingProfileImage"),
  rankingNickname: byId("rankingNickname"),
  rankingRankingPoint: byId("rankingRankingPoint"),
  rankingStatus: byId("rankingStatus"),
  rankingTableBody: byId("rankingTableBody"),
  friendsPagePanel: byId("friendsPagePanel"),
  friendsProfileImage: byId("friendsProfileImage"),
  friendsNickname: byId("friendsNickname"),
  friendsRankingPoint: byId("friendsRankingPoint"),
  friendsStatus: byId("friendsStatus"),
  friendsTableBody: byId("friendsTableBody"),
  mailboxLayer: byId("mailboxLayer"),
  mailboxStatus: byId("mailboxStatus"),
  mailboxNoticeList: byId("mailboxNoticeList"),
  leaderBoardsButton: byId("leaderBoardsButton"),
  friendsButton: byId("friendsButton"),
  mailboxButton: byId("mailboxButton"),
  homeButton: byId("homeButton"),
  lobbyProfileBox: byId("lobbyProfileBox"),
  lobbyProfileMenu: byId("lobbyProfileMenu"),
  lobbyUserInfoButton: byId("lobbyUserInfoButton"),
  lobbyProfileLogOutButton: byId("lobbyProfileLogOutButton"),
  rankingLeaderBoardsButton: byId("rankingLeaderBoardsButton"),
  rankingFriendsButton: byId("rankingFriendsButton"),
  rankingMailboxButton: byId("rankingMailboxButton"),
  rankingHomeButton: byId("rankingHomeButton"),
  allRankingTabButton: byId("allRankingTabButton"),
  friendRankingTabButton: byId("friendRankingTabButton"),
  rankingProfileBox: byId("rankingProfileBox"),
  rankingProfileMenu: byId("rankingProfileMenu"),
  rankingUserInfoButton: byId("rankingUserInfoButton"),
  rankingProfileLogOutButton: byId("rankingProfileLogOutButton"),
  friendsLeaderBoardsButton: byId("friendsLeaderBoardsButton"),
  friendsFriendsButton: byId("friendsFriendsButton"),
  friendsMailboxButton: byId("friendsMailboxButton"),
  friendsHomeButton: byId("friendsHomeButton"),
  friendsProfileBox: byId("friendsProfileBox"),
  friendsProfileMenu: byId("friendsProfileMenu"),
  friendsUserInfoButton: byId("friendsUserInfoButton"),
  friendsProfileLogOutButton: byId("friendsProfileLogOutButton"),
  mailboxCloseButton: byId("mailboxCloseButton"),
  addFriendButton: byId("addFriendButton"),
  deleteFriendModeButton: byId("deleteFriendModeButton"),
  addFriendLayer: byId("addFriendLayer"),
  closeAddFriendButton: byId("closeAddFriendButton"),
  addFriendNicknameInput: byId("addFriendNicknameInput"),
  sendFriendRequestButton: byId("sendFriendRequestButton"),
  mailboxDetailLayer: byId("mailboxDetailLayer"),
  closeMailboxDetailButton: byId("closeMailboxDetailButton"),
  mailboxDetailTitle: byId("mailboxDetailTitle"),
  mailboxDetailContent: byId("mailboxDetailContent"),
  userInfoLayer: byId("userInfoLayer"),
  closeUserInfoButton: byId("closeUserInfoButton"),
  userInfoMainImage: byId("userInfoMainImage"),
  editProfileImageButton: byId("editProfileImageButton"),
  profileImageFileInput: byId("profileImageFileInput"),
  userInfoIdInput: byId("userInfoIdInput"),
  userInfoNicknameInput: byId("userInfoNicknameInput"),
  userInfoPasswordInput: byId("userInfoPasswordInput"),
  userInfoEmailInput: byId("userInfoEmailInput"),
  saveUserInfoButton: byId("saveUserInfoButton"),
  inviteFriendLayer: byId("inviteFriendLayer"),
  closeInviteFriendButton: byId("closeInviteFriendButton"),
  inviteFriendStatus: byId("inviteFriendStatus"),
  inviteFriendTableBody: byId("inviteFriendTableBody"),
  lobbyVolumeButton: byId("lobbyVolumeButton"),
  lobbyVolumeSliderWrap: byId("lobbyVolumeSliderWrap"),
  lobbyVolumeSlider: byId("lobbyVolumeSlider"),
  rankingVolumeButton: byId("rankingVolumeButton"),
  rankingVolumeSliderWrap: byId("rankingVolumeSliderWrap"),
  rankingVolumeSlider: byId("rankingVolumeSlider"),
  friendsVolumeButton: byId("friendsVolumeButton"),
  friendsVolumeSliderWrap: byId("friendsVolumeSliderWrap"),
  friendsVolumeSlider: byId("friendsVolumeSlider"),
  roomList: byId("roomList"),
  openCreateRoomButton: byId("openCreateRoomButton"),
  createRoomLayer: byId("createRoomLayer"),
  closeCreateRoomButton: byId("closeCreateRoomButton"),
  cancelCreateRoomButton: byId("cancelCreateRoomButton"),
  createRoomButton: byId("createRoomButton"),
  createRoomNameInput: byId("createRoomNameInput"),
  createRoomCodeInput: byId("createRoomCodeInput"),
  createLevelSelect: byId("createLevelSelect"),
  maxPlayersSelect: byId("maxPlayersSelect"),
  privateRoomCodeLayer: byId("privateRoomCodeLayer"),
  closePrivateRoomCodeButton: byId("closePrivateRoomCodeButton"),
  privateRoomCodeInput: byId("privateRoomCodeInput"),
  submitPrivateRoomCodeButton: byId("submitPrivateRoomCodeButton"),
  nicknameInput: byId("nicknameInput"),
  waitingRoomTitle: byId("waitingRoomTitle"),
  waitingRoomMeta: byId("waitingRoomMeta"),
  leaveRoomButton: byId("leaveRoomButton"),
  startGameButton: byId("startGameButton"),
  lobbyPlayersList: byId("lobbyPlayersList"),
  roundLabel: byId("roundLabel"),
  timerNumber: byId("timerNumber"),
  timerCaption: byId("timerCaption"),
  playersList: byId("playersList"),
  targetImage: byId("targetImage"),
  finalTargetImage: byId("finalTargetImage"),
  rgbControls: byId("rgbControls"),
  statusLine: byId("statusLine"),
  guideButton: byId("guideButton"),
  guidePopover: byId("guidePopover"),
  closeGuide: byId("closeGuide"),
  choiceLayer: byId("choiceLayer"),
  choiceButtons: byId("choiceButtons"),
  choicePopupTime: byId("choicePopupTime"),
  closeChoice: byId("closeChoice"),
  finalLayer: byId("finalLayer"),
  finalPopupTime: byId("finalPopupTime"),
  finalStatus: byId("finalStatus"),
  submitFinalButton: byId("submitFinalButton"),
  resultLayer: byId("resultLayer"),
  resultText: byId("resultText"),
  closeResult: byId("closeResult"),
  exitButton: byId("exitButton"),
  volumeButton: byId("volumeButton"),
  volumeSliderWrap: byId("volumeSliderWrap"),
  volumeSlider: byId("volumeSlider")
};

function allVolumeSliders() {
  return [...document.querySelectorAll(".lobby-volume-slider, .waiting-volume-slider, .volume-slider")];
}

function allVolumeButtons() {
  return [...document.querySelectorAll(".lobby-volume-button, .waiting-volume-button, .volume-button")];
}

function setBgmVolume(value) {
  bgmVolume = clamp(Math.round(Number(value) || 0), 0, 100);
  localStorage.setItem("colorMasterVolume", String(bgmVolume));
  Object.values(bgmTracks).forEach((audio) => {
    audio.volume = bgmVolume / 100;
    audio.muted = bgmVolume === 0;
  });
  allVolumeSliders().forEach((slider) => {
    slider.value = String(bgmVolume);
  });
  allVolumeButtons().forEach((button) => {
    button.classList.toggle("is-muted", bgmVolume === 0);
  });
}

function audioModeForCurrentScreen() {
  return isLobbyPhase() ? "lobby" : "game";
}

function syncBgmWithScreen() {
  if (!bgmTracks.lobby || !bgmTracks.game) return;
  const nextBgmName = audioModeForCurrentScreen();
  if (nextBgmName === activeBgmName) {
    if (bgmUnlocked && bgmTracks[nextBgmName].paused) {
      bgmTracks[nextBgmName].play().catch(() => {
        bgmUnlocked = false;
      });
    }
    return;
  }

  Object.entries(bgmTracks).forEach(([name, audio]) => {
    if (name !== nextBgmName) audio.pause();
  });
  activeBgmName = nextBgmName;
  if (!bgmUnlocked) return;

  bgmTracks[nextBgmName].play().catch(() => {
    bgmUnlocked = false;
  });
}

function unlockBgmPlayback() {
  if (bgmUnlocked) return;
  bgmUnlocked = true;
  syncBgmWithScreen();
}

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

function applyGuestUiState() {
  const guest = isGuestUser();
  document.body?.classList.toggle("is-guest-user", guest);

  [
    els.leaderBoardsButton,
    els.friendsButton,
    els.mailboxButton,
    els.openCreateRoomButton
  ].forEach((button) => {
    if (!button) return;
    button.disabled = guest;
    button.setAttribute("aria-disabled", String(guest));
  });

  [
    els.lobbyUserInfoButton,
    els.rankingUserInfoButton,
    els.friendsUserInfoButton
  ].forEach((button) => {
    if (!button) return;
    button.disabled = guest;
    button.setAttribute("aria-disabled", String(guest));
  });
}

function renderLobbyUser() {
  // Paint the temporary logged-in user box from mock data.
  setProfileImage(els.lobbyProfileImage, mockCurrentUser.profileImage);
  if (els.lobbyNickname) els.lobbyNickname.textContent = mockCurrentUser.nickname;
  if (els.lobbyRankingPoint) els.lobbyRankingPoint.textContent = `${mockCurrentUser.rankingPoint} RP`;
  setProfileImage(els.rankingProfileImage, mockCurrentUser.profileImage);
  if (els.rankingNickname) els.rankingNickname.textContent = mockCurrentUser.nickname;
  if (els.rankingRankingPoint) els.rankingRankingPoint.textContent = `${mockCurrentUser.rankingPoint} RP`;
  setProfileImage(els.friendsProfileImage, mockCurrentUser.profileImage);
  if (els.friendsNickname) els.friendsNickname.textContent = mockCurrentUser.nickname;
  if (els.friendsRankingPoint) els.friendsRankingPoint.textContent = `${mockCurrentUser.rankingPoint} RP`;
  if (els.nicknameInput) els.nicknameInput.value = mockCurrentUser.nickname;
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
    hasPeeked: Boolean(player.hasPeeked),
    rankingPoint: Number(player.rankingPoint || player.point || 0), // RP 추가
    isReady: Boolean(player.isReady) // 준비 상태 추가
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
  
  // 숫자에 맞는 난이도 텍스트를 매핑합니다.
  const labels = {
    1: "Easy",
    2: "Normal",
    3: "Hard",
    4: "Extreme"
  };
  
  // 1~4 범위를 벗어나는 값이 오면 기본값으로 "Easy"를 반환합니다.
  return labels[count] || "Easy";
}

function renderRoomList() {
  /*
    Main lobby room list.
    The server sends only rooms that are still waiting. Each row gets a Join
    button; private rooms ask for their room code before emitting join_room.
  */
  const rooms = roomClient.rooms || [];
  els.roomList.classList.toggle("is-empty", !rooms.length);
  els.roomList.innerHTML = `
    <div class="room-list-header" aria-hidden="true">
      <span>No.</span>
      <span>Name</span>
      <span>Level</span>
      <span>Players</span>
      <span></span>
    </div>
    ${!rooms.length ? `<div class="room-empty">대기 중인 방이 없습니다.</div>` : rooms.map((room, index) => {
      const isFull = room.playerCount >= room.maxPlayers;
      return `
        <div class="room-row">
          <span>${index + 1}</span>
          <span class="room-name">${escapeHtml(room.roomName)}${room.isPrivate ? `<img class="room-private-icon" src="/Images/lock_icon.png" alt="비공개" />` : ""}</span>
          <span>${roomLevelLabel(room.level)}</span>
          <span>${room.playerCount}/${room.maxPlayers}</span>
          <button class="room-join-button" type="button" data-join-room="${escapeHtml(room.roomCode)}" data-private="${room.isPrivate ? "true" : "false"}" ${isFull ? "disabled" : ""}>참여</button>
        </div>
      `;
    }).join("")}
  `;

  document.querySelectorAll("[data-join-room]").forEach((button) => {
    button.addEventListener("click", () => {
      const privateRoom = button.dataset.private === "true";
      if (privateRoom) {
        openPrivateRoomCodeModal(button.dataset.joinRoom);
        return;
      }
      joinRoom(button.dataset.joinRoom, "");
    });
  });
}

function updateRankingTabs() {
  if (!els.allRankingTabButton || !els.friendRankingTabButton) return;
  els.allRankingTabButton.classList.toggle("is-active", rankingMode === "all");
  els.friendRankingTabButton.classList.toggle("is-active", rankingMode === "friends");
  els.allRankingTabButton.setAttribute("aria-pressed", String(rankingMode === "all"));
  els.friendRankingTabButton.setAttribute("aria-pressed", String(rankingMode === "friends"));
}

function renderRankingTable() {
  // Paint the ranking table in highest-ranking-point order.
  if (!els.rankingTableBody) return;
  updateRankingTabs();

  const friendRankingLoading = rankingMode === "friends" && friendsLoading;
  if (leaderboardLoading || friendRankingLoading) {
    els.rankingTableBody.innerHTML = `
      <tr>
        <td colspan="4">Loading rankings...</td>
      </tr>
    `;
    return;
  }

  const currentUserRankingEntry = {
    id: mockCurrentUser.id,
    nickname: mockCurrentUser.nickname,
    profileImage: mockCurrentUser.profileImage,
    rankingPoint: Number(mockCurrentUser.rankingPoint) || 0
  };
  const rankingUsers = rankingMode === "friends"
    ? [
      currentUserRankingEntry,
      ...friends.map((friend) => ({
        id: friend.id,
        nickname: friend.nickname,
        profileImage: friend.profileImage,
        rankingPoint: Number(friend.rankingPoint) || 0
      }))
    ]
    : leaderboardUsers;

  if (!rankingUsers.length) {
    els.rankingTableBody.innerHTML = `
      <tr>
        <td colspan="4">No ranking data yet.</td>
      </tr>
    `;
    return;
  }

  els.rankingTableBody.innerHTML = rankingUsers
    .slice()
    .sort((a, b) => b.rankingPoint - a.rankingPoint)
    .map((user, index) => `
      <tr class="${user.id === mockCurrentUser.id ? "is-me" : ""}">
        <td>${index + 1}</td>
        <td>${profileImageHtml("ranking-profile-image", user.profileImage)}</td>
        <td>${escapeHtml(user.nickname)}</td>
        <td>${Number(user.rankingPoint) || 0} RP</td>
      </tr>
    `).join("");
}

async function setRankingMode(mode) {
  rankingMode = mode === "friends" ? "friends" : "all";
  updateRankingTabs();

  if (rankingMode === "friends") {
    await loadFriendsFromDb();
  } else {
    await loadLeaderboardFromDb();
  }

  renderRankingTable();
}

async function loadLeaderboardFromDb(force = false) {
  if (leaderboardLoadPromise) return leaderboardLoadPromise;
  if (leaderboardLoaded && !force) return leaderboardUsers;

  leaderboardLoading = true;
  renderRankingTable();
  if (els.rankingStatus) els.rankingStatus.textContent = "Loading rankings...";

  leaderboardLoadPromise = import(LOGIN_MODULE_URL)
    .then(({ getLeaderboardUsers }) => getLeaderboardUsers(50))
    .then((dbUsers) => {
      leaderboardUsers = dbUsers;
      leaderboardLoaded = true;
      renderRankingTable();
      if (els.rankingStatus) els.rankingStatus.textContent = leaderboardUsers.length
        ? "Highest ranking points first."
        : "No ranking data yet.";
      return leaderboardUsers;
    })
    .catch((error) => {
      console.error("Failed to load leaderboard:", error);
      if (els.rankingStatus) els.rankingStatus.textContent = "Could not load rankings from DB.";
      return leaderboardUsers;
    })
    .finally(() => {
      leaderboardLoading = false;
      leaderboardLoadPromise = null;
      renderRankingTable();
    });

  return leaderboardLoadPromise;
}

async function loadFriendsFromDb(force = false) {
  if (!mockCurrentUser.id) return [];
  if (friendsLoadPromise) return friendsLoadPromise;
  if (friendsLoaded && !force) return friends;

  const showLoadingRow = !friendsLoaded && !friends.length;
  friendsLoading = true;
  if (showLoadingRow) renderFriendsTable();
  if (els.friendsStatus) els.friendsStatus.textContent = "Loading friends...";

  friendsLoadPromise = import(LOGIN_MODULE_URL)
    .then(({ getFriends }) => getFriends(mockCurrentUser.id))
    .then((dbFriends) => {
      friends = dbFriends;
      friendsLoaded = true;
      renderFriendsTable();
      if (els.inviteFriendLayer && !els.inviteFriendLayer.hidden) renderInviteFriendList();
      if (els.friendsStatus) {
        els.friendsStatus.textContent = friends.length
          ? "Recently added friends appear lower."
          : "No friends yet.";
      }
      return friends;
    })
    .catch((error) => {
      console.error("Failed to load friends:", error);
      if (els.friendsStatus) els.friendsStatus.textContent = "Could not load friends from DB.";
      return friends;
    })
    .finally(() => {
      friendsLoading = false;
      friendsLoadPromise = null;
      renderFriendsTable();
      if (els.inviteFriendLayer && !els.inviteFriendLayer.hidden) renderInviteFriendList();
    });

  return friendsLoadPromise;
}

function renderFriendsTable() {
  /*
    Paint the friends table from Firestore-backed data.
    The array order is kept as loaded; later DB work can add explicit ordering.
  */
  if (!els.friendsTableBody) return;
  if (friendsLoading && !friendsLoaded && !friends.length) {
    els.friendsTableBody.innerHTML = `
      <tr>
        <td class="friends-empty" colspan="5">Loading friends...</td>
      </tr>
    `;
    return;
  }

  if (!friends.length) {
    els.friendsTableBody.innerHTML = `
      <tr>
        <td class="friends-empty" colspan="5">친구가 없습니다.</td>
      </tr>
    `;
    return;
  }

  els.friendsTableBody.innerHTML = friends.map((friend, index) => {
    const statusClass = friend.online ? "is-online" : "is-offline";
    const statusText = friend.online ? "온라인" : "오프라인";
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${profileImageHtml("friends-profile-image", friend.profileImage)}</td>
        <td>${escapeHtml(friend.nickname)}</td>
        <td>${friend.rankingPoint} RP</td>
        <td>
          <div class="friend-status-cell">
            <span class="friend-status">
              <span class="friend-status-dot ${statusClass}" aria-hidden="true"></span>
              ${statusText}
            </span>
            <button class="friend-delete-button" type="button" data-delete-friend="${escapeHtml(friend.id)}" aria-label="Delete ${escapeHtml(friend.nickname)}" ${friendDeleteMode ? "" : "hidden disabled"}>삭제</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  document.querySelectorAll("[data-delete-friend]").forEach((button) => {
    button.addEventListener("click", () => deleteFriend(button.dataset.deleteFriend));
  });
}

function renderMailboxNotices() {
  // Paint the temporary mailbox notice list.
  if (!els.mailboxNoticeList) return;
  if (mailboxLoading) {
    els.mailboxNoticeList.innerHTML = `<div class="mailbox-notice-empty">알림을 불러오는 중...</div>`;
    return;
  }

  if (!mockMailboxNotices.length) {
    els.mailboxNoticeList.innerHTML = `<div class="mailbox-notice-empty">알림이 없습니다.</div>`;
    return;
  }

  els.mailboxNoticeList.innerHTML = mockMailboxNotices.map((notice) => {
    const message = notice.type === "invite"
      ? `"${notice.sender}"님이 게임으로 초대했습니다.`
      : `"${notice.sender}"님이 친구 신청을 보냈습니다.`;
    return `
      <div class="mailbox-notice-row">
        <button class="mailbox-message-button" type="button" data-mailbox-open="${escapeHtml(notice.id)}">
          ${escapeHtml(message)}
        </button>
        <button class="mailbox-delete-button" type="button" data-mailbox-delete="${escapeHtml(notice.id)}">삭제</button>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-mailbox-open]").forEach((button) => {
    button.addEventListener("click", () => openMailboxDetail(button.dataset.mailboxOpen));
  });

  document.querySelectorAll("[data-mailbox-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteMailboxNotice(button.dataset.mailboxDelete));
  });
}

function renderInviteFriendList() {
  // Paint online friends inside the waiting-lobby invite popup.
  if (!els.inviteFriendTableBody) return;
  const onlineFriends = friends.filter((friend) => friend.online);

  if (!onlineFriends.length) {
    els.inviteFriendTableBody.innerHTML = `
      <tr>
        <td class="invite-friend-empty" colspan="4">접속 중인 친구가 없습니다.</td>
      </tr>
    `;
    return;
  }

  els.inviteFriendTableBody.innerHTML = onlineFriends.map((friend, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${profileImageHtml("invite-friend-profile-image", friend.profileImage)}</td>
      <td>${escapeHtml(friend.nickname)}</td>
      <td><button class="invite-friend-button" type="button" data-send-game-invite="${escapeHtml(friend.id)}">초대</button></td>
    </tr>
  `).join("");

  document.querySelectorAll("[data-send-game-invite]").forEach((button) => {
    button.addEventListener("click", () => sendGameInvite(button.dataset.sendGameInvite));
  });
}

function openInviteFriendModal() {
  // Show online friends after the user clicks an empty waiting-room slot.
  if (!els.inviteFriendLayer) return;
  loadFriendsFromDb(true);
  renderInviteFriendList();
  els.inviteFriendLayer.hidden = false;
  if (els.inviteFriendStatus) els.inviteFriendStatus.textContent = "";
}

function closeInviteFriendModal() {
  // Hide the invite-friend popup.
  if (els.inviteFriendLayer) els.inviteFriendLayer.hidden = true;
}

async function sendGameInvite(friendId) {
  const friend = friends.find((item) => item.id === friendId);
  if (!friend) return;

  if (!roomClient.joined || !roomClient.roomCode) {
    if (els.inviteFriendStatus) els.inviteFriendStatus.textContent = "Join or create a room before inviting friends.";
    return;
  }

  const button = [...document.querySelectorAll("[data-send-game-invite]")]
    .find((candidate) => candidate.dataset.sendGameInvite === friendId);
  if (button?.disabled) return;

  const previousButtonText = button?.textContent || "초대";
  if (button) {
    button.disabled = true;
    button.textContent = "보냄";
  }
  if (els.inviteFriendStatus) els.inviteFriendStatus.textContent = "";

  try {
    const { sendGameInvite: sendGameInviteToDb } = await import(LOGIN_MODULE_URL);
    await sendGameInviteToDb(mockCurrentUser.id, friend.id, {
      roomCode: roomClient.roomCode,
      privateCode: roomClient.privateCode,
      isPrivate: roomClient.isPrivate,
      name: roomClient.roomName,
      level: roomClient.level,
      currentPlayers: game.players.length,
      maxPlayers: roomClient.maxPlayers
    });
    if (els.inviteFriendStatus) els.inviteFriendStatus.textContent = "";
    if (button) button.textContent = "보냄";
  } catch (error) {
    console.error("Failed to send game invite:", error);
    if (els.inviteFriendStatus) els.inviteFriendStatus.textContent = error.message || "Could not send game invite.";
    if (button) button.textContent = previousButtonText;
  } finally {
    if (button) button.disabled = button.textContent === "보냄";
  }
}

function updateFriendDeleteModeButton() {
  if (!els.deleteFriendModeButton) return;
  els.deleteFriendModeButton.classList.toggle("is-active", friendDeleteMode);
  els.deleteFriendModeButton.setAttribute("aria-pressed", String(friendDeleteMode));
  els.deleteFriendModeButton.textContent = friendDeleteMode ? "삭제 취소" : "친구 삭제";
}

function toggleFriendDeleteMode() {
  friendDeleteMode = !friendDeleteMode;
  updateFriendDeleteModeButton();
  renderFriendsTable();
  if (els.friendsStatus) {
    els.friendsStatus.textContent = friendDeleteMode
      ? "Choose a friend to delete."
      : "Recently added friends appear lower.";
  }
}

async function deleteFriend(friendId) {
  const friend = friends.find((item) => item.id === friendId);
  if (!friend) return;

  const button = document.querySelector(`[data-delete-friend="${CSS.escape(friendId)}"]`);
  const previousButtonText = button?.textContent || "Delete";
  if (button) {
    button.disabled = true;
    button.textContent = "Deleting...";
  }
  if (els.friendsStatus) els.friendsStatus.textContent = `Deleting ${friend.nickname}...`;

  try {
    const { deleteFriend: deleteFriendFromDb } = await import(LOGIN_MODULE_URL);
    await deleteFriendFromDb(mockCurrentUser.id, friendId);
    friends = friends.filter((item) => item.id !== friendId);
    renderFriendsTable();
    if (els.inviteFriendLayer && !els.inviteFriendLayer.hidden) renderInviteFriendList();
    if (els.friendsStatus) els.friendsStatus.textContent = `${friend.nickname} removed from friends.`;
  } catch (error) {
    console.error("Failed to delete friend:", error);
    if (els.friendsStatus) els.friendsStatus.textContent = error.message || "Could not delete friend.";
    if (button) {
      button.disabled = false;
      button.textContent = previousButtonText;
    }
  }
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
  if (els.leaveRoomButton) {
    els.leaveRoomButton.hidden = !showLobby || game.phase !== "waiting" || !roomClient.joined;
  }
  if (!showLobby) return;

  const showWaitingLobby = game.phase === "waiting" && roomClient.joined;
  const showRankingPage = !showWaitingLobby && roomClient.lobbyView === "ranking";
  const showFriendsPage = !showWaitingLobby && roomClient.lobbyView === "friends";
  els.mainLobbyPanel.hidden = showWaitingLobby || showRankingPage || showFriendsPage;
  els.rankingPagePanel.hidden = !showRankingPage;
  els.friendsPagePanel.hidden = !showFriendsPage;
  els.waitingLobbyPanel.hidden = !showWaitingLobby;

  if (showRankingPage) {
    renderRankingTable();
    return;
  }

  if (showFriendsPage) {
    renderFriendsTable();
    return;
  }

  if (!showWaitingLobby) {
    renderRoomList();
    return;
  }

  const isHost = roomClient.hostUserId === game.localPlayerId;
  // const privateMark = roomClient.isPrivate ? " (P)" : "";
  // els.waitingRoomTitle.textContent = `${roomClient.roomName || "Waiting Room"}${privateMark}`;
  // els.waitingRoomMeta.textContent = `${roomLevelLabel(roomClient.level)} | ${game.players.length}/${roomClient.maxPlayers} players`;
  // els.startGameButton.hidden = !isHost;
  // els.startGameButton.disabled = !roomClient.joined || !isHost || game.players.length < 2;
  // const privateMark = roomClient.isPrivate ? " (P)" : "";
  // els.waitingRoomTitle.textContent = `${roomClient.roomName || "Waiting Room"}${privateMark}`;
  const privateMark = roomClient.isPrivate ? `<img class="room-private-icon" src="/Images/lock_icon.png" alt="비공개" />` : "";
  const levelLabel = roomLevelLabel(roomClient.level);
  els.waitingRoomTitle.innerHTML = `
    <span class="waiting-room-name">${escapeHtml(roomClient.roomName || "Waiting Room")}${privateMark}</span>
    <span class="waiting-room-divider" aria-hidden="true"></span>
    <span class="waiting-room-level">${escapeHtml(levelLabel)}</span>
  `;
  els.waitingRoomMeta.textContent = "";
  els.waitingRoomMeta.hidden = true;

  const allPlayersReady = game.players.length >= 2 && game.players.every((player) => player.isReady);
  els.startGameButton.hidden = !isHost;
  els.startGameButton.disabled = !roomClient.joined || !isHost || !allPlayersReady;

  /*
    innerHTML replaces the whole player-list container with newly generated HTML.
    map(...) creates one HTML string per player; join("") combines them into one string.
  */
  const playerSlots = game.players.map((player, index) => {
    const isMe = player.id === game.localPlayerId;
    const isReady = player.isReady;
    const statusText = isReady ? "준비 완료" : "준비 중";
    // const hostLabel = player.isHost ? `<img class="room-crown-icon" src="/Images/crown_icon.png" alt="방장" />` : "";
    const hostLabel = player.isHost ? `<span class="waiting-player-badge">방장</span>` : "";

    let statusHtml;
    if (isMe) {
      const btnClass = isReady ? "is-ready" : "is-not-ready";
      statusHtml = `<button class="waiting-ready-button ${btnClass}" type="button" data-toggle-ready="true">준비 완료</button>`;
    } else {
      const dotClass = isReady ? "is-online" : "is-offline"; 
      statusHtml = `
        <span class="friend-status">
          <span class="friend-status-dot ${dotClass}" aria-hidden="true"></span>
          ${statusText}
        </span>
      `;
    }

    return `
      <tr class="${isMe ? "is-me" : ""}">
        <td>${index + 1}</td>
        <td>${profileImageHtml("players-profile-image", player.profileImage)}</td>
        <td>${escapeHtml(player.name)}${hostLabel}</td>
        <td>${player.rankingPoint} RP</td>
        <td>
          <div class="friend-status-cell">
            ${statusHtml}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  const emptySlotCount = Math.max(0, roomClient.maxPlayers - game.players.length);
  const emptySlots = Array.from({ length: emptySlotCount }, (_, index) => `
    <tr>
      <td>${game.players.length + index + 1}</td>
      <td colspan="4" style="text-align: center; padding: 16px 0;">
        <button class="waiting-invite-slot-button" type="button" data-open-invite-friends="${index + 1}">+ 친구 초대</button>
      </td>
    </tr>
  `).join("");

  // 확실하게 tbody 태그를 찾아서 넣도록 안전장치 추가
  const targetTbody = document.querySelector("tbody#lobbyPlayersList");
  if (targetTbody) {
    targetTbody.innerHTML = playerSlots + emptySlots;
  } else if (els.lobbyPlayersList) {
    els.lobbyPlayersList.innerHTML = playerSlots + emptySlots;
  }

  // 친구 초대 버튼 클릭 이벤트 다시 연결
  document.querySelectorAll("[data-open-invite-friends]").forEach((button) => {
    button.addEventListener("click", openInviteFriendModal);
  });

  // 본인 준비 상태 토글 버튼 이벤트 다시 연결
  document.querySelectorAll("[data-toggle-ready]").forEach((button) => {
    button.addEventListener("click", () => {
      console.log("준비 상태 토글 클릭됨!"); // 디버깅용 로그
      if (socket) {
        socket.emit("toggle_ready", { roomCode: roomClient.roomCode });
      }
    });
  });

  // const playerSlots = game.players.map((player) => `
  //     <div class="waiting-player-item">
  //       <span>${escapeHtml(player.name)}</span>
  //       <span class="waiting-player-badge">${player.isHost ? "Host" : "Player"}</span>
  //     </div>
  //   `).join("");
  // const emptySlotCount = Math.max(0, roomClient.maxPlayers - game.players.length);
  // const emptySlots = Array.from({ length: emptySlotCount }, (_, index) => `
  //     <div class="waiting-player-item is-empty-slot">
  //       <button class="waiting-invite-slot-button" type="button" data-open-invite-friends="${index + 1}">Invite Friend</button>
  //     </div>
  //   `).join("");

  // els.lobbyPlayersList.innerHTML = playerSlots + emptySlots;

  // document.querySelectorAll("[data-open-invite-friends]").forEach((button) => {
  //   button.addEventListener("click", openInviteFriendModal);
  // });
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
  byId("submitButton").addEventListener("click", () => {
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
  // return [...(game.results || [])]
  //   .sort((a, b) => (a.finalError ?? 0) - (b.finalError ?? 0))
  //   .map((result, index) => `
  //     <tr class="${result.userId === game.localPlayerId ? "is-me" : ""}">
  //       <td>${index + 1}</td>
  //       <td><span class="result-profile" aria-hidden="true"></span></td>
  //       <td>${escapeHtml(result.nickname || "Player")}</td>
  //       <td>${escapeHtml(finalGuessText(result.finalGuess))}</td>
  //       <td>0 RP</td>
  //     </tr>
  //   `).join("");
  return [...(game.results || [])]
    .sort((a, b) => (a.finalError ?? 0) - (b.finalError ?? 0))
    .map((result, index) => {
      // 대기실에서 받아두었던 game.players 배열에서 해당 유저의 프로필 사진을 찾습니다.
      const playerInfo = game.players.find(p => p.id === result.userId) || {};
      const profileImg = playerInfo.profileImage ? normalizeProfileImage(playerInfo.profileImage) : "/Images/profile.png";
      
      // 서버에서 계산해서 보내준 '이번 게임 획득 포인트(earnedPoint)'를 사용합니다.
      const earned = result.earnedPoint || 0;
      
      // 양수일 경우 가독성을 위해 앞에 '+' 기호를 붙여줍니다. (예: +10 RP, 0 RP, -5 RP)
      const displayRp = earned > 0 ? `+${earned}` : earned;

      return `
      <tr class="${result.userId === game.localPlayerId ? "is-me" : ""}">
        <td>${index + 1}</td>
        <td>${profileImageHtml("result-profile-image", profileImg)}</td>
        <td>${escapeHtml(result.nickname || "Player")}</td>
        <td>${escapeHtml(finalGuessText(result.finalGuess))}</td>
        <td style="color: ${earned > 0 ? '#31e981' : (earned < 0 ? '#ff4c64' : '#e9edff')}; font-weight: 950;">${displayRp} RP</td>
      </tr>
    `}).join("");
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
  syncBgmWithScreen();
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
  const submitButton = byId("submitButton");
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
    game.turnSeconds = Math.max(0, game.turnSeconds - 1);
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
  clearInterval(turnTimer);
  clearInterval(choiceTimer);
  game.choiceSeconds = seconds;
  els.timerNumber.textContent = seconds;
  if (els.choicePopupTime) els.choicePopupTime.textContent = seconds;
  choiceTimer = setInterval(() => {
    game.choiceSeconds = Math.max(0, game.choiceSeconds - 1);
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
    game.turnSeconds = Math.max(0, game.turnSeconds - 1);
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
  return mockCurrentUser.nickname || els.nicknameInput.value.trim() || `Player ${localUserId.slice(-4)}`;
}

function openCreateRoomModal() {
  // Show the create-room popup and provide a friendly default room name.
  if (isGuestUser()) {
    setLobbyStatus("Guest users cannot create rooms.");
    return;
  }
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

function openPrivateRoomCodeModal(roomCode) {
  // Show a small code-entry popup before joining a private room.
  if (!els.privateRoomCodeLayer) return;
  roomClient.pendingPrivateRoomCode = String(roomCode || "").trim().toUpperCase();
  els.privateRoomCodeInput.value = "";
  els.privateRoomCodeLayer.hidden = false;
  els.privateRoomCodeInput.focus();
}

function closePrivateRoomCodeModal() {
  // Hide the private-room code popup and clear the pending room target.
  if (els.privateRoomCodeLayer) els.privateRoomCodeLayer.hidden = true;
  roomClient.pendingPrivateRoomCode = "";
}

function submitPrivateRoomCode() {
  // Join the selected private room using the code typed into the popup.
  const privateCode = els.privateRoomCodeInput.value.trim();
  if (!privateCode) {
    els.privateRoomCodeInput.focus();
    setLobbyStatus("Enter the private room code.");
    return;
  }

  const roomCode = roomClient.pendingPrivateRoomCode;
  closePrivateRoomCodeModal();
  joinRoom(roomCode, privateCode);
}

function openAddFriendModal() {
  // Show the small friend-request popup from the Friends page.
  if (!els.addFriendLayer) return;
  closeProfileMenus();
  els.addFriendNicknameInput.value = "";
  els.addFriendLayer.hidden = false;
  els.addFriendNicknameInput.focus();
}

function closeAddFriendModal() {
  // Hide the add-friend popup without changing the current friends list.
  if (els.addFriendLayer) els.addFriendLayer.hidden = true;
}

async function sendFriendRequest() {
  const nickname = els.addFriendNicknameInput.value.trim();
  if (!nickname) {
    els.addFriendNicknameInput.focus();
    if (els.friendsStatus) els.friendsStatus.textContent = "유저 닉네임을 먼저 입력해 주세요.";
    return;
  }

  const previousButtonText = els.sendFriendRequestButton?.textContent || "요청 보내기";
  if (els.sendFriendRequestButton) {
    els.sendFriendRequestButton.disabled = true;
    els.sendFriendRequestButton.textContent = "요청 중...";
  }
  if (els.friendsStatus) els.friendsStatus.textContent = `${nickname}님에게 친구 요청을 보내는 중...`;

  try {
    const { sendFriendRequestByNickname } = await import(LOGIN_MODULE_URL);
    const friend = await sendFriendRequestByNickname(mockCurrentUser.id, nickname);
    closeAddFriendModal();
    if (els.friendsStatus) els.friendsStatus.textContent = `${friend.nickname}님에게 친구 요청을 보냈습니다.`;
  } catch (error) {
    console.error("Failed to add friend:", error);
    if (els.friendsStatus) els.friendsStatus.textContent = error.message || "친구 요청을 보내지 못했습니다.";
  } finally {
    if (els.sendFriendRequestButton) {
      els.sendFriendRequestButton.disabled = false;
      els.sendFriendRequestButton.textContent = previousButtonText;
    }
  }
}

function createRoomFromLobby() {
  /*
    Called when the user confirms the create-room popup.
    A blank room code creates a public room. A non-blank room code creates a
    private room that other users must enter before joining.
  */
  if (isGuestUser()) {
    closeCreateRoomModal();
    setLobbyStatus("Guest users cannot create rooms.");
    return;
  }

  if (!socket) {
    setLobbyStatus("Open this page through the Node server to use rooms.");
    return;
  }

  roomClient.nickname = currentNickname();
  roomClient.privateCode = els.createRoomCodeInput.value.trim();
  const action = {
    type: "create",
    roomName: els.createRoomNameInput.value.trim(),
    roomCode: roomClient.privateCode,
    level: Number(els.createLevelSelect.value),
    maxPlayers: Number(els.maxPlayersSelect.value),
    userId: game.localPlayerId,
    nickname: roomClient.nickname
  };

  if (!IS_GAME_PAGE || IS_LOBBY_PAGE) {
    setLobbyStatus("Opening room...");
    goToGameWithAction(action);
    return;
  }

  socket.emit("create_room", action);
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
  roomClient.privateCode = String(privateCode || "").trim();
  roomClient.nickname = currentNickname();
  const action = {
    type: "join",
    roomCode: roomClient.roomCode,
    privateCode,
    userId: game.localPlayerId,
    nickname: roomClient.nickname
  };

  if (!IS_GAME_PAGE || IS_LOBBY_PAGE) {
    setLobbyStatus("Opening room...");
    goToGameWithAction(action);
    return;
  }

  socket.emit("join_room", action);
  setLobbyStatus("Joining room...");
}

function runPendingRoomAction() {
  if (!IS_GAME_PAGE || !socket) return false;

  const action = takePendingRoomAction();
  if (!action) return false;

  roomClient.nickname = action.nickname || currentNickname();

  if (action.type === "create") {
    roomClient.privateCode = String(action.roomCode || "").trim();
    socket.emit("create_room", {
      roomName: action.roomName,
      roomCode: roomClient.privateCode,
      level: Number(action.level) || 1,
      maxPlayers: Number(action.maxPlayers) || 5,
      userId: game.localPlayerId,
      nickname: roomClient.nickname
    });
    setLobbyStatus("Creating room...");
    return true;
  }

  if (action.type === "join") {
    roomClient.roomCode = String(action.roomCode || "").trim().toUpperCase();
    roomClient.privateCode = String(action.privateCode || "").trim();
    socket.emit("join_room", {
      roomCode: roomClient.roomCode,
      privateCode: roomClient.privateCode,
      userId: game.localPlayerId,
      nickname: roomClient.nickname
    });
    setLobbyStatus("Joining room...");
    return true;
  }

  return false;
}

function resetToMainLobby(message = "") {
  clearAllTimers();
  if (PAGE_KIND === "game") {
    goToLobby(message);
    return;
  }

  roomClient.joined = false;
  roomClient.roomCode = "";
  roomClient.roomName = "";
  roomClient.hostUserId = null;
  roomClient.level = 1;
  roomClient.maxPlayers = 5;
  roomClient.isPrivate = false;
  roomClient.lobbyView = "rooms";
  roomClient.pendingPrivateRoomCode = "";
  roomClient.privateCode = "";
  game.phase = "lobby";
  game.players = [];
  game.targetColors = [];
  game.currentSubmission = null;
  game.turnSubmitted = false;
  game.selectedChoice = null;
  game.finalSubmitted = false;
  game.score = null;
  game.results = [];
  els.choiceLayer.hidden = true;
  els.finalLayer.hidden = true;
  els.resultLayer.hidden = true;
  if (els.privateRoomCodeLayer) els.privateRoomCodeLayer.hidden = true;
  if (els.mailboxLayer) els.mailboxLayer.hidden = true;
  if (els.mailboxDetailLayer) els.mailboxDetailLayer.hidden = true;
  if (els.userInfoLayer) els.userInfoLayer.hidden = true;
  if (els.inviteFriendLayer) els.inviteFriendLayer.hidden = true;
  render();
  setLobbyStatus(message);
}

function showRankingPage() {
  // Navigate from the room lobby to the ranking page.
  if (isGuestUser()) return;
  roomClient.lobbyView = "ranking";
  rankingMode = "all";
  game.phase = "lobby";
  render();
  loadLeaderboardFromDb(true);
}

function showFriendsPage() {
  // Navigate from the room lobby or ranking page to the friends page.
  if (isGuestUser()) return;
  roomClient.lobbyView = "friends";
  game.phase = "lobby";
  render();
  updateFriendDeleteModeButton();
  loadFriendsFromDb(true);
}

function openMailboxModal() {
  // Show the mailbox as a popup on top of the current lobby-style page.
  if (isGuestUser()) return;
  if (!els.mailboxLayer) return;
  closeProfileMenus();
  renderMailboxNotices();
  els.mailboxLayer.hidden = false;
  if (els.mailboxStatus) els.mailboxStatus.textContent = "";
  loadMailboxNoticesFromDb(true);
}

function closeMailboxModal() {
  // Hide the mailbox popup and any full-message popup opened from it.
  if (els.mailboxLayer) els.mailboxLayer.hidden = true;
  closeMailboxDetail();
}

const USER_INFO_INVALID_BORDER = "rgba(255, 90, 90, 0.5)";
const USER_INFO_VALID_BORDER = "var(--line)";
const USER_INFO_FIELDS = {
  userInfoEmailInput: {
    key: "email",
    success: "사용 가능한 이메일입니다.",
    invalid: "올바른 이메일 형식으로 입력해 주세요."
  },
  userInfoNicknameInput: {
    key: "nickname",
    success: "사용 가능한 닉네임입니다.",
    invalid: "닉네임은 2~12자의 한글, 영어, 숫자만 사용할 수 있습니다."
  },
  userInfoIdInput: {
    key: "loginId",
    success: "사용 가능한 아이디입니다.",
    invalid: "아이디는 영어와 숫자만 사용할 수 있습니다."
  },
  userInfoPasswordInput: {
    key: "password",
    success: "사용 가능한 비밀번호입니다.",
    invalid: "비밀번호는 8~12자이며 영어, 숫자, 특수문자를 모두 포함해야 합니다."
  }
};

function userInfoEditButtons() {
  return Array.from(document.querySelectorAll("[data-user-info-edit]"));
}

function userInfoStatusElement(inputId) {
  return document.querySelector(`[data-user-info-status="${inputId}"]`);
}

function setUserInfoInputBorder(input, color) {
  if (!input) return;
  input.style.setProperty("border-color", color, "important");
  input.style.setProperty("outline", "none", "important");
}

function setUserInfoStatus(inputId, message = "", type = "") {
  const status = userInfoStatusElement(inputId);
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", type === "error");
  status.classList.toggle("is-success", type === "success");
}

function currentUserInfoValue(inputId) {
  const meta = USER_INFO_FIELDS[inputId];
  if (!meta) return "";
  return String(mockCurrentUser[meta.key] || "");
}

function isUserInfoRowEditing() {
  return userInfoEditButtons().some((button) => button.classList.contains("is-confirming"));
}

function updateUserInfoSaveButtonState() {
  if (!els.saveUserInfoButton) return;
  els.saveUserInfoButton.disabled = isUserInfoRowEditing();
}

function resetUserInfoEditButtons() {
  userInfoEditButtons().forEach((button) => {
    button.textContent = "수정";
    button.classList.remove("is-confirming");
  });
}

function setUserInfoInputsDisabled(disabled) {
  // Toggle the editable state for every user-info table input.
  [
    els.userInfoIdInput,
    els.userInfoNicknameInput,
    els.userInfoPasswordInput,
    els.userInfoEmailInput
  ].forEach((input) => {
    if (input) input.disabled = disabled;
  });
}

function resetUserInfoValidation() {
  Object.keys(USER_INFO_FIELDS).forEach((inputId) => {
    const input = document.getElementById(inputId);
    if (input) {
      setUserInfoInputBorder(input, USER_INFO_VALID_BORDER);
      delete input.dataset.userInfoConfirmed;
    }
    setUserInfoStatus(inputId);
  });
}

function renderUserInfoPopup() {
  // Fill the user-info popup from the current mock user.
  if (!els.userInfoLayer) return;
  setProfileImage(els.userInfoMainImage, mockCurrentUser.profileImage);
  if (els.userInfoIdInput) els.userInfoIdInput.value = mockCurrentUser.loginId;
  if (els.userInfoNicknameInput) els.userInfoNicknameInput.value = mockCurrentUser.nickname;
  if (els.userInfoPasswordInput) els.userInfoPasswordInput.value = mockCurrentUser.password;
  if (els.userInfoEmailInput) els.userInfoEmailInput.value = mockCurrentUser.email;
  if (els.saveUserInfoButton) {
    els.saveUserInfoButton.textContent = "저장";
    els.saveUserInfoButton.disabled = false;
  }
  setUserInfoInputsDisabled(true);
  resetUserInfoEditButtons();
  resetUserInfoValidation();
}

function openUserInfoModal() {
  // Show the user-info popup from the profile action menu.
  if (isGuestUser()) {
    closeProfileMenus();
    return;
  }
  if (!els.userInfoLayer) return;
  closeProfileMenus();
  renderUserInfoPopup();
  els.userInfoLayer.hidden = false;
}

function closeUserInfoModal() {
  // Hide the user-info popup without saving new edits.
  if (els.userInfoLayer) els.userInfoLayer.hidden = true;
}

function sanitizeUserInfoInput(input) {
  if (!input) return "";
  if (input.id === "userInfoIdInput") {
    input.value = input.value.replace(/[^a-zA-Z0-9]/g, "");
  }
  if (input.id === "userInfoNicknameInput") {
    input.value = input.value.normalize("NFC").replace(/[^a-zA-Z0-9가-힣]/g, "");
  }
  if (input.id === "userInfoEmailInput") {
    input.value = input.value.trim();
  }
  return input.value;
}

function checkUserInfoFormat(input) {
  const value = sanitizeUserInfoInput(input);

  if (input.id === "userInfoEmailInput") {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
  }

  if (input.id === "userInfoNicknameInput") {
    return /^[a-zA-Z0-9가-힣]{2,12}$/.test(value);
  }

  if (input.id === "userInfoIdInput") {
    return /^[a-zA-Z0-9]+$/.test(value);
  }

  if (input.id === "userInfoPasswordInput") {
    const hasLetter = /[a-zA-Z]/.test(value);
    const hasNumber = /\d/.test(value);
    const hasSpecial = /[!@#$%^&*()_+~\-={}\[\]:;"'<>,.?/|\\]/.test(value);
    return value.length >= 8 && value.length <= 12 && hasLetter && hasNumber && hasSpecial;
  }

  return true;
}

async function validateUserInfoInput(input, checkDuplicate = false) {
  const meta = USER_INFO_FIELDS[input.id];
  if (!meta) return { valid: true, message: "" };

  if (!checkUserInfoFormat(input)) {
    return { valid: false, message: meta.invalid };
  }

  const nextValue = input.value.trim();
  const previousValue = currentUserInfoValue(input.id);
  const valueChanged = nextValue !== previousValue;

  if (checkDuplicate && valueChanged && input.id === "userInfoIdInput") {
    const { checkIdDuplicate } = await import(LOGIN_MODULE_URL);
    if (await checkIdDuplicate(nextValue)) {
      return { valid: false, message: "이미 사용 중인 아이디입니다." };
    }
  }

  if (checkDuplicate && valueChanged && input.id === "userInfoNicknameInput") {
    const { checkNicknameDuplicate } = await import(LOGIN_MODULE_URL);
    if (await checkNicknameDuplicate(nextValue)) {
      return { valid: false, message: "이미 사용 중인 닉네임입니다." };
    }
  }

  return { valid: true, message: meta.success };
}

function markUserInfoInputPending(input) {
  if (!input) return;
  delete input.dataset.userInfoConfirmed;
  const validFormat = !input.value || checkUserInfoFormat(input);
  setUserInfoInputBorder(input, validFormat ? USER_INFO_VALID_BORDER : USER_INFO_INVALID_BORDER);
  setUserInfoStatus(input.id);
}

function enableUserInfoInput(inputId, button) {
  // Edit buttons enable one row at a time and focus its input.
  const input = document.getElementById(inputId);
  if (!input) return;
  input.disabled = false;
  delete input.dataset.userInfoConfirmed;
  if (button) {
    button.textContent = "확인";
    button.classList.add("is-confirming");
  }
  setUserInfoStatus(inputId);
  setUserInfoInputBorder(input, USER_INFO_VALID_BORDER);
  updateUserInfoSaveButtonState();
  input.focus();
  input.select();
}

async function confirmUserInfoInput(inputId, button) {
  const input = document.getElementById(inputId);
  if (!input) return;

  button.disabled = true;
  const result = await validateUserInfoInput(input, true).catch((error) => {
    console.error("User info validation failed:", error);
    return { valid: false, message: "확인 중 오류가 발생했습니다." };
  });
  button.disabled = false;

  if (!result.valid) {
    setUserInfoInputBorder(input, USER_INFO_INVALID_BORDER);
    setUserInfoStatus(inputId, result.message, "error");
    input.disabled = false;
    input.focus();
    updateUserInfoSaveButtonState();
    return;
  }

  setUserInfoInputBorder(input, USER_INFO_VALID_BORDER);
  setUserInfoStatus(inputId, result.message, "success");
  input.disabled = true;
  input.dataset.userInfoConfirmed = input.value.trim() !== currentUserInfoValue(inputId) ? "true" : "false";
  button.textContent = "수정";
  button.classList.remove("is-confirming");
  updateUserInfoSaveButtonState();
}

function toggleUserInfoEdit(inputId, button) {
  if (button.classList.contains("is-confirming")) {
    confirmUserInfoInput(inputId, button);
  } else {
    enableUserInfoInput(inputId, button);
  }
}

function editProfileImage() {
  if (!els.profileImageFileInput) return;
  els.profileImageFileInput.value = "";
  els.profileImageFileInput.click();
}

function profileImageDisplayUrl(downloadUrl) {
  const separator = downloadUrl.includes("?") ? "&" : "?";
  return `${downloadUrl}${separator}updated=${Date.now()}`;
}

async function uploadProfileImageViaServer(file) {
  /*
    Send the selected image to our Node/EC2 server first.
    The server then uploads it to Firebase Storage using the Admin SDK.
  */
  const formData = new FormData();
  formData.append("userId", mockCurrentUser.id);
  formData.append("profileImage", file);

  const response = await fetch("/api/profile-image", {
    method: "POST",
    body: formData
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Profile image upload failed.");
  }

  return data.profileImage;
}

async function uploadSelectedProfileImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
    alert("Please choose a JPG, PNG, WEBP, or GIF image.");
    event.target.value = "";
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    alert("Profile image must be 2MB or smaller.");
    event.target.value = "";
    return;
  }

  const previousButtonText = els.editProfileImageButton?.textContent || "프로필 사진 수정";
  if (els.editProfileImageButton) {
    els.editProfileImageButton.disabled = true;
    els.editProfileImageButton.textContent = "업로드 중...";
  }

  try {
    const downloadUrl = await uploadProfileImageViaServer(file);
    if (!downloadUrl) throw new Error("Profile image upload did not return a URL.");

    mockCurrentUser.profileImage = profileImageDisplayUrl(downloadUrl);
    saveMockUser();
    renderLobbyUser();
    renderUserInfoPopup();

    if (els.editProfileImageButton) {
      els.editProfileImageButton.textContent = "업로드 완료";
      setTimeout(() => {
        if (els.editProfileImageButton) els.editProfileImageButton.textContent = previousButtonText;
      }, 1200);
    }
  } catch (error) {
    console.error("Profile image upload failed:", error);
    alert("Profile image upload failed. Please try again.");
    if (els.editProfileImageButton) els.editProfileImageButton.textContent = previousButtonText;
  } finally {
    if (els.editProfileImageButton) els.editProfileImageButton.disabled = false;
    event.target.value = "";
  }
}

async function saveUserInfoChanges() {
  /*
    Save confirmed user-info edits locally and to Firestore.
    The save button is disabled while any row is still waiting for confirmation.
  */
  if (isUserInfoRowEditing()) {
    updateUserInfoSaveButtonState();
    return;
  }

  const pendingUpdates = {};
  const nextValues = {};

  Object.entries(USER_INFO_FIELDS).forEach(([inputId, meta]) => {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.userInfoConfirmed !== "true") return;
    const nextValue = inputId === "userInfoPasswordInput" ? input.value : input.value.trim();
    pendingUpdates[meta.key] = nextValue;
    nextValues[meta.key] = nextValue;
  });

  if (els.saveUserInfoButton) {
    els.saveUserInfoButton.disabled = true;
    els.saveUserInfoButton.textContent = "저장 중...";
  }

  try {
    if (Object.keys(pendingUpdates).length) {
      const { updateUserInfo } = await import(LOGIN_MODULE_URL);
      await updateUserInfo(mockCurrentUser.id, {
        user_id: pendingUpdates.loginId,
        nickname: pendingUpdates.nickname,
        password: pendingUpdates.password,
        email: pendingUpdates.email
      });
    }

    Object.assign(mockCurrentUser, nextValues);

    saveMockUser();
    renderLobbyUser();
    renderUserInfoPopup();
    setUserInfoInputsDisabled(true);
    if (els.saveUserInfoButton) {
      els.saveUserInfoButton.textContent = "저장 완료";
      els.saveUserInfoButton.disabled = false;
    }
  } catch (error) {
    console.error("Failed to save user info:", error);
    if (els.saveUserInfoButton) {
      els.saveUserInfoButton.textContent = "저장";
      els.saveUserInfoButton.disabled = false;
    }
    alert("유저 정보를 저장하지 못했습니다. 다시 시도해 주세요.");
  }
}

function openMailboxDetail(noticeId) {
  // Show the rich detail popup for one mailbox notice.
  const notice = mockMailboxNotices.find((item) => item.id === noticeId);
  if (!notice || !els.mailboxDetailLayer || !els.mailboxDetailContent) return;

  markMailboxNoticeAsRead(notice.id);
  els.mailboxDetailTitle.textContent = notice.type === "friend" ? "친구 신청" : "게임 방 초대";
  const roomHtml = notice.type === "invite" && notice.room
    ? `
      <div class="mailbox-detail-room" aria-label="Room information">
        <div class="mailbox-detail-room-row">
          <span class="mailbox-detail-room-label">Room Name</span>
          <span>${escapeHtml(notice.room.name)}</span>
        </div>
        <div class="mailbox-detail-room-row">
          <span class="mailbox-detail-room-label">Level</span>
          <span>${escapeHtml(roomLevelLabel(notice.room.level))}</span>
        </div>
        <div class="mailbox-detail-room-row">
          <span class="mailbox-detail-room-label">Players</span>
          <span>${notice.room.currentPlayers}/${notice.room.maxPlayers}</span>
        </div>
      </div>
    `
    : "";

  els.mailboxDetailContent.innerHTML = `
    <div class="mailbox-detail-user">
      ${profileImageHtml("mailbox-detail-profile", notice.profileImage)}
      <div class="mailbox-detail-user-text">
        <div class="mailbox-detail-name">${escapeHtml(notice.sender)}</div>
        <div class="mailbox-detail-rp">${notice.rankingPoint} RP</div>
      </div>
    </div>
    ${roomHtml}
    <div class="mailbox-detail-actions">
      <button class="mailbox-detail-action is-accept" type="button" data-mailbox-response="accept" data-mailbox-response-id="${escapeHtml(notice.id)}">수락</button>
      <button class="mailbox-detail-action is-reject" type="button" data-mailbox-response="reject" data-mailbox-response-id="${escapeHtml(notice.id)}">거절</button>
    </div>
  `;

  document.querySelectorAll("[data-mailbox-response]").forEach((button) => {
    button.addEventListener("click", () => {
      handleMailboxResponse(button.dataset.mailboxResponseId, button.dataset.mailboxResponse);
    });
  });

  els.mailboxDetailLayer.hidden = false;
}

function closeMailboxDetail() {
  // Hide the full-message popup.
  if (els.mailboxDetailLayer) els.mailboxDetailLayer.hidden = true;
}

async function handleMailboxResponse(noticeId, response) {
  const notice = mockMailboxNotices.find((item) => item.id === noticeId);
  if (!notice) return;
  const actionText = response === "accept" ? "Accepted" : "Rejected";
  const targetText = notice.type === "friend" ? "friend request" : "game invite";

  try {
    if (notice.source === "db" && notice.type === "friend") {
      const actions = await import(LOGIN_MODULE_URL);
      if (response === "accept") {
        const friend = await actions.acceptFriendRequest(mockCurrentUser.id, notice.id);
        friends = [
          ...friends.filter((item) => item.id !== friend.id),
          friend
        ];
        friendsLoaded = true;
        renderFriendsTable();
        if (els.inviteFriendLayer && !els.inviteFriendLayer.hidden) renderInviteFriendList();
      } else {
        await actions.rejectFriendRequest(mockCurrentUser.id, notice.id);
      }
    } else if (notice.source === "db" && notice.type === "invite") {
      const actions = await import(LOGIN_MODULE_URL);
      if (response === "accept") {
        const room = await actions.acceptGameInvite(mockCurrentUser.id, notice.id);
        mockMailboxNotices = mockMailboxNotices.filter((item) => item.id !== noticeId);
        saveMockMailboxNotices();
        updateMailboxUnreadDots();
        closeMailboxDetail();
        closeMailboxModal();
        renderMailboxNotices();
        joinRoom(room.roomCode, room.privateCode || "");
        return;
      }
      await actions.rejectGameInvite(mockCurrentUser.id, notice.id);
    }

    mockMailboxNotices = mockMailboxNotices.filter((item) => item.id !== noticeId);
    saveMockMailboxNotices();
    updateMailboxUnreadDots();
    closeMailboxDetail();
    renderMailboxNotices();
    if (els.mailboxStatus) els.mailboxStatus.textContent = `${actionText} ${targetText} from ${notice.sender}.`;
  } catch (error) {
    console.error("Failed to respond to mailbox notice:", error);
    if (els.mailboxStatus) els.mailboxStatus.textContent = error.message || "Could not update this notice.";
  }
}

async function deleteMailboxNotice(noticeId) {
  // Remove one temporary notice and persist that deletion for this browser session.
  const notice = mockMailboxNotices.find((item) => item.id === noticeId);
  if (!notice) return;

  try {
    if (notice.source === "db") {
      const { deleteMailboxNotice: deleteMailboxNoticeFromDb } = await import(LOGIN_MODULE_URL);
      await deleteMailboxNoticeFromDb(mockCurrentUser.id, noticeId);
    }
  } catch (error) {
    console.error("Failed to delete mailbox notice:", error);
    if (els.mailboxStatus) els.mailboxStatus.textContent = error.message || "Could not delete notice.";
    return;
  }

  mockMailboxNotices = mockMailboxNotices.filter((notice) => notice.id !== noticeId);
  saveMockMailboxNotices();
  updateMailboxUnreadDots();
  closeMailboxDetail();
  renderMailboxNotices();
  if (els.mailboxStatus) els.mailboxStatus.textContent = "Notice deleted.";
}

function showMainLobbyPage(message = "") {
  // Navigate back to the main room list from a lobby subpage.
  if (PAGE_KIND === "game") {
    goToLobby(message);
    return;
  }

  roomClient.lobbyView = "rooms";
  game.phase = "lobby";
  render();
  setLobbyStatus(message);
}

function closeProfileMenus(exceptMenu = null) {
  /*
    Hide profile action menus.
    exceptMenu is used when opening one menu so the chosen menu stays open while
    the other profile menus close.
  */
  [
    [els.lobbyProfileBox, els.lobbyProfileMenu],
    [els.rankingProfileBox, els.rankingProfileMenu],
    [els.friendsProfileBox, els.friendsProfileMenu]
  ].forEach(([box, menu]) => {
    if (!box || !menu || menu === exceptMenu) return;
    menu.classList.remove("is-open");
    menu.hidden = true;
    box.setAttribute("aria-expanded", "false");
  });
}

function toggleProfileMenu(box, menu) {
  // Open the clicked profile menu, or close it if it is already open.
  if (!box || !menu) return;
  const shouldOpen = menu.hidden || !menu.classList.contains("is-open");
  closeProfileMenus(shouldOpen ? menu : null);
  menu.hidden = false;
  menu.classList.toggle("is-open", shouldOpen);
  if (!shouldOpen) menu.hidden = true;
  box.setAttribute("aria-expanded", String(shouldOpen));
}

function setLobbyPageMessage(message) {
  // Update status text for whichever lobby-style page is visible now.
  setLobbyStatus(message);
  if (els.rankingStatus) els.rankingStatus.textContent = message;
  if (els.friendsStatus) els.friendsStatus.textContent = message;
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
  const submitButton = byId("submitButton");
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
  if (!IS_LOBBY_PAGE && PAGE_KIND !== "combined") return;
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
  clearInterval(turnTimer);
  clearInterval(choiceTimer);

  if (data.turnUserId === game.localPlayerId) {
    game.choiceSeconds = data.timeLimit || 10;
    startChoiceCountdown(game.choiceSeconds);
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

  if (mockCurrentUser && game.score.points) {
    mockCurrentUser.rankingPoint = Number(mockCurrentUser.rankingPoint || 0) + game.score.points;
    saveMockUser();

    // --------------------------------------------------
    // ▼ 추가된 부분: 게임 종료 후 변경된 RP를 Firestore DB에 즉시 반영
    // --------------------------------------------------
    if (!isGuestUser()) { // 게스트가 아닌 로그인 유저만 DB 업데이트
      import(LOGIN_MODULE_URL).then(({ updateRankingPoint }) => {
        if (updateRankingPoint) {
          // 로컬에 계산된 최신 포인트를 DB에 전송
          updateRankingPoint(mockCurrentUser.id, mockCurrentUser.rankingPoint);
        }
      }).catch((error) => {
        console.error("DB 업데이트 모듈을 불러오지 못했습니다:", error);
      });
    }
  }

  render();
}

/*
  UI event wiring.
  These listeners connect user actions in the browser to the functions above.
  addEventListener("click", fn) means "run fn when this element is clicked."
*/
applyGuestUiState();
renderLobbyUser();
updateMailboxUnreadDots();
els.openCreateRoomButton.addEventListener("click", openCreateRoomModal);
els.closeCreateRoomButton.addEventListener("click", closeCreateRoomModal);
if (els.cancelCreateRoomButton) {
  els.cancelCreateRoomButton.addEventListener("click", closeCreateRoomModal);
}
els.createRoomButton.addEventListener("click", createRoomFromLobby);
els.closePrivateRoomCodeButton.addEventListener("click", closePrivateRoomCodeModal);
els.submitPrivateRoomCodeButton.addEventListener("click", submitPrivateRoomCode);
els.leaveRoomButton.addEventListener("click", leaveRoom);
els.startGameButton.addEventListener("click", startGameFromLobby);
els.leaderBoardsButton.addEventListener("click", showRankingPage);
els.friendsButton.addEventListener("click", showFriendsPage);
els.mailboxButton.addEventListener("click", openMailboxModal);
els.rankingFriendsButton.addEventListener("click", showFriendsPage);
els.rankingMailboxButton.addEventListener("click", openMailboxModal);
els.friendsLeaderBoardsButton.addEventListener("click", showRankingPage);
els.friendsMailboxButton.addEventListener("click", openMailboxModal);
els.rankingHomeButton.addEventListener("click", () => showMainLobbyPage());
els.friendsHomeButton.addEventListener("click", () => showMainLobbyPage());
els.mailboxCloseButton.addEventListener("click", closeMailboxModal);

if (els.deleteFriendModeButton) {
  els.deleteFriendModeButton.addEventListener("click", toggleFriendDeleteMode);
}

if (els.allRankingTabButton) {
  els.allRankingTabButton.addEventListener("click", () => setRankingMode("all"));
}

if (els.friendRankingTabButton) {
  els.friendRankingTabButton.addEventListener("click", () => setRankingMode("friends"));
}

[
  [els.lobbyProfileBox, els.lobbyProfileMenu],
  [els.rankingProfileBox, els.rankingProfileMenu],
  [els.friendsProfileBox, els.friendsProfileMenu]
].forEach(([box, menu]) => {
  if (!box || !menu) return;

  box.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleProfileMenu(box, menu);
  });

  box.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleProfileMenu(box, menu);
  });

  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });
});

document.addEventListener("click", () => {
  closeProfileMenus();
});

[
  els.lobbyUserInfoButton,
  els.rankingUserInfoButton,
  els.friendsUserInfoButton
].forEach((button) => {
  if (!button) return;
  button.addEventListener("click", () => {
    openUserInfoModal();
  });
});

[
  els.lobbyProfileLogOutButton,
  els.rankingProfileLogOutButton,
  els.friendsProfileLogOutButton
].forEach((button) => {
  if (!button) return;
  button.addEventListener("click", async () => {
    closeProfileMenus();
    await stopPresenceTracking();
    if (isGuestUser()) {
      try {
        const { deleteGuestAccount } = await import(LOGIN_MODULE_URL);
        await deleteGuestAccount(mockCurrentUser.id);
      } catch (error) {
        console.error("Failed to delete guest account:", error);
        sendGuestLogoutBeacon();
      }
    }
    clearLoginSession();
    markInternalNavigation();
    window.location.href = LOGIN_PAGE_URL;
  });
});

if (els.addFriendButton) {
  els.addFriendButton.addEventListener("click", openAddFriendModal);
}

if (els.privateRoomCodeInput) {
  els.privateRoomCodeInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitPrivateRoomCode();
  });
}

if (els.privateRoomCodeLayer) {
  els.privateRoomCodeLayer.addEventListener("click", (event) => {
    if (event.target === els.privateRoomCodeLayer) closePrivateRoomCodeModal();
  });
}

if (els.closeAddFriendButton) {
  els.closeAddFriendButton.addEventListener("click", closeAddFriendModal);
}

if (els.sendFriendRequestButton) {
  els.sendFriendRequestButton.addEventListener("click", sendFriendRequest);
}

if (els.addFriendNicknameInput) {
  els.addFriendNicknameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    sendFriendRequest();
  });
}

if (els.addFriendLayer) {
  els.addFriendLayer.addEventListener("click", (event) => {
    if (event.target === els.addFriendLayer) closeAddFriendModal();
  });
}

if (els.mailboxLayer) {
  els.mailboxLayer.addEventListener("click", (event) => {
    if (event.target === els.mailboxLayer) closeMailboxModal();
  });
}

if (els.closeMailboxDetailButton) {
  els.closeMailboxDetailButton.addEventListener("click", closeMailboxDetail);
}

if (els.mailboxDetailLayer) {
  els.mailboxDetailLayer.addEventListener("click", (event) => {
    if (event.target === els.mailboxDetailLayer) closeMailboxDetail();
  });
}

if (els.closeUserInfoButton) {
  els.closeUserInfoButton.addEventListener("click", closeUserInfoModal);
}

if (els.userInfoLayer) {
  els.userInfoLayer.addEventListener("click", (event) => {
    if (event.target === els.userInfoLayer) closeUserInfoModal();
  });
}

document.querySelectorAll("[data-user-info-edit]").forEach((button) => {
  button.addEventListener("click", () => toggleUserInfoEdit(button.dataset.userInfoEdit, button));
});

Object.keys(USER_INFO_FIELDS).forEach((inputId) => {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener("input", () => markUserInfoInputPending(input));
});

if (els.editProfileImageButton) {
  els.editProfileImageButton.addEventListener("click", editProfileImage);
}

if (els.profileImageFileInput) {
  els.profileImageFileInput.addEventListener("change", uploadSelectedProfileImage);
}

if (els.saveUserInfoButton) {
  els.saveUserInfoButton.addEventListener("click", saveUserInfoChanges);
}

if (els.closeInviteFriendButton) {
  els.closeInviteFriendButton.addEventListener("click", closeInviteFriendModal);
}

if (els.inviteFriendLayer) {
  els.inviteFriendLayer.addEventListener("click", (event) => {
    if (event.target === els.inviteFriendLayer) closeInviteFriendModal();
  });
}

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

document.querySelectorAll(".lobby-volume-control, .waiting-volume-control, .volume-control").forEach((control) => {
  const button = control.querySelector(".lobby-volume-button, .waiting-volume-button, .volume-button");
  const sliderWrap = control.querySelector(".lobby-volume-slider-wrap, .waiting-volume-slider-wrap, .volume-slider-wrap");
  if (!button || !sliderWrap) return;
  button.addEventListener("click", () => {
    const nextOpen = sliderWrap.hidden;
    sliderWrap.hidden = !nextOpen;
    button.setAttribute("aria-expanded", String(nextOpen));
  });
});

allVolumeSliders().forEach((slider) => {
  slider.addEventListener("input", (event) => {
    unlockBgmPlayback();
    setBgmVolume(event.target.value);
  });
});

allVolumeButtons().forEach((button) => {
  button.addEventListener("click", unlockBgmPlayback);
});

document.addEventListener("pointerdown", unlockBgmPlayback, { once: true });
document.addEventListener("keydown", unlockBgmPlayback, { once: true });
setBgmVolume(bgmVolume);

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
  // After results are read, return this browser to the main lobby.
  resetToMainLobby();
});

els.exitButton.addEventListener("click", () => {
  // Placeholder behavior: the visual button exists, but no navigation/reset is wired yet.
  els.statusLine.textContent = "Exit action can be connected later.";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updateCurrentUserPresence(true);
    refreshVisibleFriendPresence();
  }
});

window.addEventListener("pagehide", () => {
  if (!consumeInternalNavigationFlag()) {
    sendGuestLogoutBeacon();
  }
  stopPresenceTracking();
});

window.addEventListener("beforeunload", () => {
  if (!consumeInternalNavigationFlag()) {
    sendGuestLogoutBeacon();
  }
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
    if (PAGE_KIND === "game") {
      if (!runPendingRoomAction()) {
        goToLobby();
      }
      return;
    }

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
  socket.on("left_room", () => resetToMainLobby());
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
restoreLobbyStatus();
if (currentUserFromSession) {
  startPresenceTracking();
  loadMailboxNoticesFromDb(false);
}
