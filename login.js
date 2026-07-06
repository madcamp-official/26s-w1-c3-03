import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import { 
  getAuth, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  GoogleAuthProvider, 
  signInWithPopup,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { 
  getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, getDocs 
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

// ---------------------------------------------------
// 1. 일반 이메일 회원가입 (비밀번호 조건 추가)
// ---------------------------------------------------
export async function signUpWithEmail(email, password, user_id, nickname, profileFile = null) {
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
      // 🚨 신규 유저: DB를 생성하지 않고, 프론트엔드 폼에 채워넣을 정보만 반환!
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
      return {
        isNewUser: false,
        uid: user.uid,
        userData: userDocSnap.data()
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
      return;
    }

    // 2. 찾은 유저 문서에서 이메일(email) 추출하기
    let userEmail = "";
    querySnapshot.forEach((doc) => {
      userEmail = doc.data().email;
    });

    // 3. 추출한 이메일과 입력받은 비밀번호로 Firebase Auth 로그인 시도
    const userCredential = await signInWithEmailAndPassword(auth, userEmail, password);
    
    // (참고: userCredential.user 안에는 user_id가 없습니다. uid나 email을 출력해야 합니다)
    console.log("로그인 성공! 로그인된 이메일:", userCredential.user.email);
    alert("로그인에 성공했습니다!");

  } catch (error) {
    console.error("로그인 에러 (정보 불일치 등):", error.message);
    alert("로그인에 실패했습니다. 아이디나 비밀번호를 확인해주세요.");
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
export async function loginAsGuest(nickname) {
  try {
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
    sessionStorage.setItem("loggedInNickname", nickname);
    sessionStorage.setItem("loggedInUid", user.uid);
    sessionStorage.setItem("loginType", "guest");

    console.log("게스트 로그인 성공!");
    return true; // 로그인 성공

  } catch (error) {
    console.error("게스트 로그인 에러:", error);
    alert("게스트 로그인 처리 중 문제가 발생했습니다.");
    return false;
  }
}