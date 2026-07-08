import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  deleteUser,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDWZ4qh55v0fHXIEzaA9MkeVM-mAJEGCMw",
  authDomain: "colormaster-madcamp.firebaseapp.com",
  projectId: "colormaster-madcamp",
  storageBucket: "colormaster-madcamp.firebasestorage.app",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

function normalizeProfileImage(profileImage) {
  const image = String(profileImage || "").trim();
  if (!image || image === "profile.png") return "/Images/profile.png";
  if (image.startsWith("https://firebasestorage.googleapis.com/")) {
    const match = image.match(/\/o\/([^?]+)/);
    if (match) return `/api/profile-image-file?path=${match[1]}`;
  }
  return image;
}

function saveCurrentUserSession(uid, userData, loginType) {
  const currentUser = {
    uid,
    id: uid,
    loginId: userData?.user_id || "",
    nickname: userData?.nickname || "Player",
    email: userData?.email || "",
    rankingPoint: Number(userData?.point) || 0,
    profileImage: normalizeProfileImage(userData?.profile_image),
    loginType,
    isGuest: Boolean(userData?.isGuest)
  };

  sessionStorage.setItem("colorMasterCurrentUser", JSON.stringify(currentUser));
  sessionStorage.setItem("colorMasterUserId", uid);

  // Keep older keys too, so pages that already read them still work.
  sessionStorage.setItem("loggedInNickname", currentUser.nickname);
  sessionStorage.setItem("loggedInUid", uid);
  sessionStorage.setItem("loginType", loginType);

  return currentUser;
}

// ---------------------------------------------------
// 1. 일반 이메일 회원가입
// ---------------------------------------------------
export async function signUpWithEmail(email, password, user_id, nickname, profileFile = null) {
  // 1. 아이디 유효성 검사 (영문, 숫자만 1자 이상)
  const idRegex = /^[a-zA-Z0-9]+$/;
  if (!idRegex.test(user_id)) {
    alert("아이디는 영문과 숫자만 사용할 수 있습니다.");
    return false; // 실패했음을 알림
  }

  // 2. 닉네임 유효성 검사 (2~12자, 한글, 영문, 숫자만)
  // '가-힣'은 완성형 한글을 의미하며, 자음/모음 단독(ㄱ, ㅏ 등)은 제외됩니다.
  const nicknameRegex = /^[a-zA-Z0-9가-힣]{2,12}$/;
  if (!nicknameRegex.test(nickname)) {
    alert("닉네임은 2~12자이며, 한글, 영문, 숫자만 사용할 수 있습니다.");
    return false; // 실패했음을 알림
  }

  // 3. 비밀번호 유효성 검사 (기존 코드)
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*()_+~\-={}\[\]:;"'<>,.?/|\\]/.test(password);
  
  if (password.length < 8 || password.length > 12 || !hasLetter || !hasNumber || !hasSpecial) {
    alert("비밀번호는 8~12자리이며, 영문, 숫자, 특수문자를 모두 포함해야 합니다.");
    return false; // 실패했음을 알림
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    let profileImageUrl = "profile.png";
    if (profileFile) {
      const storageRef = ref(storage, `profile_images/${user.uid}_${profileFile.name}`);
      const snapshot = await uploadBytes(storageRef, profileFile);
      profileImageUrl = await getDownloadURL(snapshot.ref); 
    }

    await setDoc(doc(db, "User", user.uid), {
      user_id: user_id,
      nickname: nickname,
      email: user.email,
      point: 0,
      profile_image: profileImageUrl
    });

    console.log("이메일 회원가입 완료!");
    return true; // 완벽하게 성공했음을 알림
  } catch (error) {
    if (error.code === 'auth/email-already-in-use') {
      alert("이미 가입된 이메일입니다. 다른 이메일을 사용해 주세요.");
    } else {
      console.error("회원가입 에러:", error.message);
    }
    return false; // 에러가 나서 실패했음을 알림
  }
}

// ---------------------------------------------------
// 2. 구글 로그인 로직 변경 (신규 유저 감지 시 정보만 반환)
// ---------------------------------------------------
export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();

  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;

    const userDocRef = doc(db, "User", user.uid);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      // 신규 유저: DB를 생성하지 않고, 프론트엔드 폼에 채워넣을 정보만 반환!
      console.log("신규 구글 유저입니다. 추가 정보 입력이 필요합니다.");
      return {
        isNewUser: true,
        uid: user.uid,
        email: user.email,
        nickname: user.displayName || "", // 구글 이름 반환
        photoURL: user.photoURL || "profile.png"
      };
    } else {
      // 기존 유저: 로그인 성공 처리
      console.log("기존 구글 계정 로그인 성공!");
      const currentUser = saveCurrentUserSession(user.uid, userDocSnap.data(), "google");
      return {
        isNewUser: false,
        uid: user.uid,
        userData: userDocSnap.data(),
        currentUser
      };
    }

  } catch (error) {
    console.error("구글 로그인 에러:", error.message);
  }
}

// ---------------------------------------------------
// 3. 구글 신규 유저 최종 DB 생성 함수 (새로 추가됨)
// ---------------------------------------------------
// 프론트엔드에서 구글 유저가 폼(아이디, 닉네임) 작성을 마치고 최종 가입 버튼을 눌렀을 때 실행됩니다.
export async function completeGoogleSignUp(uid, email, user_id, nickname, googlePhotoURL, profileFile = null) {
  try {
    let profileImageUrl = "profile.png";

    // 유저가 구글 사진 대신 직접 새 사진을 올렸다면 Storage에 업로드
    if (profileFile) {
      console.log("새로운 프로필 사진 업로드 중...");
      const storageRef = ref(storage, `profile_images/${uid}_${profileFile.name}`);
      const snapshot = await uploadBytes(storageRef, profileFile);
      profileImageUrl = await getDownloadURL(snapshot.ref); 
    }

    // 최종적으로 Firestore에 저장
    await setDoc(doc(db, "User", uid), {
      user_id: user_id,
      nickname: nickname,
      email: email,
      point: 0,
      profile_image: profileImageUrl
    });

    console.log("구글 계정 최종 회원가입(DB 생성) 완료!");
  } catch (error) {
    console.error("구글 계정 DB 생성 에러:", error.message);
  }
}

// ---------------------------------------------------
// 4. 로그인 함수
// ---------------------------------------------------
export async function login(user_id, password) {
  try {
    // 1. 입력받은 user_id로 Firestore에서 유저 찾기
    const q = query(collection(db, "User"), where("user_id", "==", user_id));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      console.error("로그인 에러: 존재하지 않는 아이디입니다.");
      alert("존재하지 않는 아이디입니다.");
      return false;
    }

    // 2. 찾은 유저 문서에서 이메일(email) 추출하기
    let userEmail = "";
    let userData = null;
    querySnapshot.forEach((doc) => {
      userData = doc.data();
      userEmail = userData.email;
    });

    // 3. 추출한 이메일과 입력받은 비밀번호로 Firebase Auth 로그인 시도
    const userCredential = await signInWithEmailAndPassword(auth, userEmail, password);
    saveCurrentUserSession(userCredential.user.uid, {
      ...userData,
      email: userCredential.user.email
    }, "email");

    return true;

  } catch (error) {
    console.error("로그인 에러 (정보 불일치 등):", error.message);
    alert("로그인에 실패했습니다. 아이디나 비밀번호를 확인해주세요.");
    return false;
  }
}

// ---------------------------------------------------
// 5. 프로필 사진 업데이트 함수
// ---------------------------------------------------
export async function updateProfileImage(file, userId) {
  try {
    const storageRef = ref(storage, `profile_images/${userId}_${file.name}`);
    const snapshot = await uploadBytes(storageRef, file);
    const downloadURL = await getDownloadURL(snapshot.ref);
    const userDocRef = doc(db, "User", userId);
    await updateDoc(userDocRef, { profile_image: downloadURL });
    return downloadURL;
  } catch (error) {
    console.error("프로필 사진 업데이트 에러:", error.message);
  }
}

// ---------------------------------------------------
// 6. 아이디 중복 확인 함수
// ---------------------------------------------------
function friendFromUserDoc(userId, userData = {}, fallbackData = {}) {
  const lastActiveAt = Number(userData.lastActiveAt ?? fallbackData.lastActiveAt) || 0;
  const recentlyActive = lastActiveAt > 0 && Date.now() - lastActiveAt < 90000;
  return {
    id: userId,
    nickname: userData.nickname || fallbackData.nickname || "Player",
    rankingPoint: Number(userData.point ?? userData.rankingPoint ?? fallbackData.rankingPoint) || 0,
    profileImage: normalizeProfileImage(userData.profile_image || userData.profileImage || fallbackData.profileImage),
    online: Boolean(userData.online) && recentlyActive
  };
}

function leaderboardUserFromDoc(userDoc) {
  const data = userDoc.data();
  if (data.isGuest) return null;
  return {
    id: userDoc.id,
    nickname: data.nickname || data.user_id || "Player",
    rankingPoint: Number(data.point ?? data.rankingPoint) || 0,
    profileImage: normalizeProfileImage(data.profile_image || data.profileImage)
  };
}

export async function getLeaderboardUsers(maxUsers = 50) {
  const safeLimit = Math.max(1, Math.min(Number(maxUsers) || 50, 100));
  const leaderboardQuery = query(
    collection(db, "User"),
    orderBy("point", "desc"),
    limit(safeLimit)
  );
  const leaderboardSnapshot = await getDocs(leaderboardQuery);
  return leaderboardSnapshot.docs
    .map(leaderboardUserFromDoc)
    .filter(Boolean);
}

export async function setUserPresence(userId, online) {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) return;

  await setDoc(doc(db, "User", cleanUserId), {
    online: Boolean(online),
    lastActiveAt: Date.now()
  }, { merge: true });
}

export async function getFriends(userId) {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) return [];

  const friendsSnapshot = await getDocs(collection(db, "User", cleanUserId, "Friends"));
  const friends = await Promise.all(friendsSnapshot.docs.map(async (friendDoc) => {
    const fallbackData = friendDoc.data();
    const friendUserId = fallbackData.fd_id || fallbackData.userId || friendDoc.id;
    const friendUserDoc = await getDoc(doc(db, "User", friendUserId));
    return friendFromUserDoc(
      friendUserId,
      friendUserDoc.exists() ? friendUserDoc.data() : {},
      fallbackData
    );
  }));

  return friends;
}

function mailboxNoticeFromDoc(noticeDoc) {
  const data = noticeDoc.data();
  const sender = data.sender || data.nickname || "Player";
  const createdAt = data.createdAt?.toMillis?.() || Number(data.createdAt) || Date.now();
  const type = data.type === "invite" ? "invite" : "friend";

  return {
    id: noticeDoc.id,
    type,
    source: "db",
    senderId: data.senderId || "",
    sender,
    createdAt,
    profileImage: normalizeProfileImage(data.profileImage || data.profile_image),
    rankingPoint: Number(data.rankingPoint ?? data.point) || 0,
    message: data.message || (type === "friend"
      ? `"${sender}" has sent you a friend request.`
      : `"${sender}" has invited you to a game.`),
    fullMessage: data.fullMessage || (type === "friend"
      ? `"${sender}" has sent you a friend request.`
      : `"${sender}" has invited you to a game.`),
    room: data.room || null
  };
}

export async function getMailboxNotices(userId) {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) return [];

  const noticesSnapshot = await getDocs(collection(db, "User", cleanUserId, "Mailbox"));
  return noticesSnapshot.docs
    .map(mailboxNoticeFromDoc)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function sendFriendRequestByNickname(userId, friendNickname) {
  const cleanUserId = String(userId || "").trim();
  const cleanNickname = String(friendNickname || "").trim();
  if (!cleanUserId) throw new Error("Missing current user id.");
  if (!cleanNickname) throw new Error("Enter a user nickname first.");

  const usersQuery = query(collection(db, "User"), where("nickname", "==", cleanNickname));
  const usersSnapshot = await getDocs(usersQuery);
  if (usersSnapshot.empty) throw new Error("No user found with that nickname.");

  const friendUserDoc = usersSnapshot.docs[0];
  const friendUserId = friendUserDoc.id;
  if (friendUserId === cleanUserId) throw new Error("You cannot add yourself as a friend.");

  const existingFriendDoc = await getDoc(doc(db, "User", cleanUserId, "Friends", friendUserId));
  if (existingFriendDoc.exists()) throw new Error("This user is already your friend.");

  const currentUserDoc = await getDoc(doc(db, "User", cleanUserId));
  if (!currentUserDoc.exists()) throw new Error("Current user data was not found.");

  const currentUser = friendFromUserDoc(cleanUserId, currentUserDoc.data());
  const friend = friendFromUserDoc(friendUserId, friendUserDoc.data());
  const requestId = `friend_request_${cleanUserId}`;
  const requestDocRef = doc(db, "User", friendUserId, "Mailbox", requestId);
  const existingRequestDoc = await getDoc(requestDocRef);
  if (existingRequestDoc.exists()) throw new Error("Friend request is already pending.");

  await setDoc(requestDocRef, {
    type: "friend",
    status: "pending",
    senderId: cleanUserId,
    sender: currentUser.nickname,
    profileImage: currentUser.profileImage,
    rankingPoint: currentUser.rankingPoint,
    message: `"${currentUser.nickname}" has sent you a friend request.`,
    fullMessage: `"${currentUser.nickname}" has sent you a friend request.`,
    createdAt: serverTimestamp()
  });

  return friend;
}

export async function addFriendByNickname(userId, friendNickname) {
  return sendFriendRequestByNickname(userId, friendNickname);
}

export async function acceptFriendRequest(userId, requestId) {
  const cleanUserId = String(userId || "").trim();
  const cleanRequestId = String(requestId || "").trim();
  if (!cleanUserId || !cleanRequestId) throw new Error("Missing friend request data.");

  const requestDocRef = doc(db, "User", cleanUserId, "Mailbox", cleanRequestId);
  const requestDoc = await getDoc(requestDocRef);
  if (!requestDoc.exists()) throw new Error("Friend request was not found.");

  const request = requestDoc.data();
  if (request.type !== "friend" || !request.senderId) throw new Error("This notice is not a friend request.");

  const senderId = request.senderId;
  const [currentUserDoc, senderUserDoc] = await Promise.all([
    getDoc(doc(db, "User", cleanUserId)),
    getDoc(doc(db, "User", senderId))
  ]);
  if (!currentUserDoc.exists() || !senderUserDoc.exists()) throw new Error("User data was not found.");

  const currentUser = friendFromUserDoc(cleanUserId, currentUserDoc.data());
  const senderUser = friendFromUserDoc(senderId, senderUserDoc.data());

  await Promise.all([
    setDoc(doc(db, "User", cleanUserId, "Friends", senderId), {
      user_id: cleanUserId,
      fd_id: senderId,
      nickname: senderUser.nickname,
      rankingPoint: senderUser.rankingPoint,
      profileImage: senderUser.profileImage,
      online: senderUser.online,
      createdAt: serverTimestamp()
    }, { merge: true }),
    setDoc(doc(db, "User", senderId, "Friends", cleanUserId), {
      user_id: senderId,
      fd_id: cleanUserId,
      nickname: currentUser.nickname,
      rankingPoint: currentUser.rankingPoint,
      profileImage: currentUser.profileImage,
      online: currentUser.online,
      createdAt: serverTimestamp()
    }, { merge: true }),
    deleteDoc(requestDocRef)
  ]);

  return senderUser;
}

export async function rejectFriendRequest(userId, requestId) {
  const cleanUserId = String(userId || "").trim();
  const cleanRequestId = String(requestId || "").trim();
  if (!cleanUserId || !cleanRequestId) throw new Error("Missing friend request data.");
  await deleteDoc(doc(db, "User", cleanUserId, "Mailbox", cleanRequestId));
}

export async function sendGameInvite(userId, friendUserId, roomInfo = {}) {
  const cleanUserId = String(userId || "").trim();
  const cleanFriendUserId = String(friendUserId || "").trim();
  const cleanRoomCode = String(roomInfo.roomCode || "").trim().toUpperCase();
  if (!cleanUserId) throw new Error("Missing current user id.");
  if (!cleanFriendUserId) throw new Error("Missing friend user id.");
  if (!cleanRoomCode) throw new Error("Join or create a room before inviting friends.");
  if (cleanUserId === cleanFriendUserId) throw new Error("You cannot invite yourself.");

  const [currentUserDoc, friendUserDoc] = await Promise.all([
    getDoc(doc(db, "User", cleanUserId)),
    getDoc(doc(db, "User", cleanFriendUserId))
  ]);
  if (!currentUserDoc.exists()) throw new Error("Current user data was not found.");
  if (!friendUserDoc.exists()) throw new Error("Friend user data was not found.");

  const friendDoc = await getDoc(doc(db, "User", cleanUserId, "Friends", cleanFriendUserId));
  if (!friendDoc.exists()) throw new Error("You can only invite users on your friends list.");

  const currentUser = friendFromUserDoc(cleanUserId, currentUserDoc.data());
  const inviteId = `game_invite_${cleanRoomCode}_${cleanUserId}`;
  const inviteDocRef = doc(db, "User", cleanFriendUserId, "Mailbox", inviteId);
  const existingInviteDoc = await getDoc(inviteDocRef);
  if (existingInviteDoc.exists()) throw new Error("Game invite is already pending.");

  const room = {
    roomCode: cleanRoomCode,
    privateCode: String(roomInfo.privateCode || "").trim(),
    isPrivate: Boolean(roomInfo.isPrivate),
    name: String(roomInfo.name || "Waiting Room").trim(),
    level: Number(roomInfo.level) || 1,
    currentPlayers: Number(roomInfo.currentPlayers) || 1,
    maxPlayers: Number(roomInfo.maxPlayers) || 5
  };

  await setDoc(inviteDocRef, {
    type: "invite",
    status: "pending",
    senderId: cleanUserId,
    sender: currentUser.nickname,
    profileImage: currentUser.profileImage,
    rankingPoint: currentUser.rankingPoint,
    message: `"${currentUser.nickname}" has invited you to a game.`,
    fullMessage: `"${currentUser.nickname}" has invited you to a game.`,
    room,
    createdAt: serverTimestamp()
  });

  return { id: inviteId, room };
}

export async function acceptGameInvite(userId, noticeId) {
  const cleanUserId = String(userId || "").trim();
  const cleanNoticeId = String(noticeId || "").trim();
  if (!cleanUserId || !cleanNoticeId) throw new Error("Missing game invite data.");

  const inviteDocRef = doc(db, "User", cleanUserId, "Mailbox", cleanNoticeId);
  const inviteDoc = await getDoc(inviteDocRef);
  if (!inviteDoc.exists()) throw new Error("Game invite was not found.");

  const invite = inviteDoc.data();
  if (invite.type !== "invite" || !invite.room?.roomCode) throw new Error("This notice is not a game invite.");

  await deleteDoc(inviteDocRef);
  return invite.room;
}

export async function rejectGameInvite(userId, noticeId) {
  const cleanUserId = String(userId || "").trim();
  const cleanNoticeId = String(noticeId || "").trim();
  if (!cleanUserId || !cleanNoticeId) throw new Error("Missing game invite data.");
  await deleteDoc(doc(db, "User", cleanUserId, "Mailbox", cleanNoticeId));
}

export async function deleteFriend(userId, friendUserId) {
  const cleanUserId = String(userId || "").trim();
  const cleanFriendUserId = String(friendUserId || "").trim();
  if (!cleanUserId || !cleanFriendUserId) throw new Error("Missing friend data.");

  await Promise.all([
    deleteDoc(doc(db, "User", cleanUserId, "Friends", cleanFriendUserId)),
    deleteDoc(doc(db, "User", cleanFriendUserId, "Friends", cleanUserId))
  ]);
}

export async function deleteMailboxNotice(userId, noticeId) {
  const cleanUserId = String(userId || "").trim();
  const cleanNoticeId = String(noticeId || "").trim();
  if (!cleanUserId || !cleanNoticeId) throw new Error("Missing notice data.");
  await deleteDoc(doc(db, "User", cleanUserId, "Mailbox", cleanNoticeId));
}

async function deleteUserSubcollection(userId, subcollectionName) {
  const snapshot = await getDocs(collection(db, "User", userId, subcollectionName));
  await Promise.all(snapshot.docs.map((itemDoc) => deleteDoc(itemDoc.ref)));
}

export async function deleteGuestAccount(userId) {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) throw new Error("Missing guest user id.");

  const userDocRef = doc(db, "User", cleanUserId);
  const userDoc = await getDoc(userDocRef);
  if (!userDoc.exists()) return;

  const userData = userDoc.data();
  if (!userData.isGuest) {
    throw new Error("Only guest accounts can be deleted from logout.");
  }

  const friendsSnapshot = await getDocs(collection(db, "User", cleanUserId, "Friends"));
  await Promise.all(friendsSnapshot.docs.map((friendDoc) => {
    const friendData = friendDoc.data();
    const friendUserId = friendData.fd_id || friendData.userId || friendDoc.id;
    return deleteDoc(doc(db, "User", friendUserId, "Friends", cleanUserId));
  }));

  await Promise.all([
    deleteUserSubcollection(cleanUserId, "Friends"),
    deleteUserSubcollection(cleanUserId, "Mailbox")
  ]);

  await deleteDoc(userDocRef);

  if (auth.currentUser?.uid === cleanUserId) {
    try {
      await deleteUser(auth.currentUser);
    } catch (error) {
      console.warn("Could not delete anonymous auth user:", error);
      await signOut(auth);
    }
  }
}

export async function checkIdDuplicate(user_id) {
  try {
    const q = query(collection(db, "User"), where("user_id", "==", user_id));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty; // 중복이면 true 반환
  } catch (error) {
    console.error("아이디 중복 확인 에러:", error);
    alert("서버 연결에 실패했습니다. (보안 규칙 등을 확인해주세요)");
    return true; // 에러가 발생하면 일단 가입을 막기 위해 true(중복/불가)로 처리
  }
}

// ---------------------------------------------------
// 7. 닉네임 중복 확인 함수
// ---------------------------------------------------
export async function checkNicknameDuplicate(nickname) {
  try {
    const q = query(collection(db, "User"), where("nickname", "==", nickname));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty; 
  } catch (error) {
    console.error("닉네임 중복 확인 에러:", error);
    alert("서버 연결에 실패했습니다.");
    return true; // 에러 발생 시 true 반환
  }
}

// ---------------------------------------------------
// 8. 게스트 로그인 함수
// ---------------------------------------------------
async function cleanupCurrentAnonymousGuest() {
  const currentUser = auth.currentUser;
  if (!currentUser?.isAnonymous) return;

  try {
    await deleteGuestAccount(currentUser.uid);
  } catch (error) {
    console.warn("Could not clean previous anonymous guest locally:", error);
    await fetch(`/api/guest-logout?userId=${encodeURIComponent(currentUser.uid)}`, {
      method: "POST",
      keepalive: true
    }).catch(() => {});
  }

  if (auth.currentUser?.uid === currentUser.uid) {
    try {
      await deleteUser(auth.currentUser);
    } catch (_error) {
      await signOut(auth).catch(() => {});
    }
  }
}

export async function loginAsGuest(nickname) {
  try {
    await cleanupCurrentAnonymousGuest();

    // 1. 닉네임 중복 확인 (기존에 만든 함수 재사용)
    const q = query(collection(db, "User"), where("nickname", "==", nickname));
    const querySnapshot = await getDocs(q);
    
    if (!querySnapshot.empty) {
      alert("이미 존재하는 닉네임입니다. 다른 닉네임을 입력해주세요.");
      return false; // 로그인 실패
    }

    // 2. 중복이 아니면 Firebase 익명 로그인 실행
    const userCredential = await signInAnonymously(auth);
    const user = userCredential.user;

    // 3. Firestore DB에 게스트 유저 정보 생성
    // (일반 유저와 섞이지 않도록 isGuest 플래그를 추가하거나 user_id를 특수하게 부여)
    await setDoc(doc(db, "User", user.uid), {
      user_id: "guest_" + user.uid.substring(0, 6),
      nickname: nickname,
      point: 0,
      profile_image: "profile.png",
      isGuest: true // 게스트 여부 표시
    });

    // 4. 브라우저 세션 스토리지에 닉네임 저장 (게임 중 유지할 정보)
    saveCurrentUserSession(user.uid, {
      user_id: "guest_" + user.uid.substring(0, 6),
      nickname,
      point: 0,
      profile_image: "profile.png",
      isGuest: true
    }, "guest");

    console.log("게스트 로그인 성공!");
    return true; // 로그인 성공

  } catch (error) {
    console.error("게스트 로그인 에러:", error);
    alert("게스트 로그인 처리 중 문제가 발생했습니다.");
    return false;
  }
}

// ---------------------------------------------------
// 9. 랭킹 포인트(RP) 업데이트 함수
// ---------------------------------------------------
export async function updateRankingPoint(userId, newPoint) {
  try {
    const userRef = doc(db, "User", userId);
    
    // 회원가입 시 'point' 필드로 초기화했으므로 동일한 필드명인 'point'를 업데이트합니다.
    await updateDoc(userRef, {
      point: newPoint 
    });
    
    console.log(`DB 포인트 업데이트 완료: ${newPoint} RP`);
  } catch (error) {
    console.error("DB 포인트 업데이트 에러:", error);
  }
}