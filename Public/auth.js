import { 
    signUpWithEmail, 
    login, 
    loginWithGoogle, 
    completeGoogleSignUp, 
    checkIdDuplicate, 
    checkNicknameDuplicate,
    loginAsGuest
  } from './login.js';

  // 상태 관리 변수 (중복 확인 통과 여부)
  let isIdValid = false;
  let isNicknameValid = false;
  let tempGoogleData = null;

  const GAME_PAGE_URL = window.location.protocol === "file:"
    ? "lobby.html"
    : "/lobby.html";

  // ---------------------------------------------------
  // 화면 내부 전환 (SPA 방식)
  // ---------------------------------------------------
  const showSection = (sectionId) => {
    document.querySelectorAll('.container > div').forEach(div => div.classList.add('hidden'));
    document.getElementById(sectionId).classList.remove('hidden');
  };

  document.getElementById('nav-to-login').addEventListener('click', () => showSection('login-section'));
  document.getElementById('nav-to-guest').addEventListener('click', () => showSection('guest-login-section'));
  document.getElementById('nav-to-signup').addEventListener('click', () => showSection('signup-section'));

  document.querySelectorAll('.nav-to-main').forEach(btn => {
    btn.addEventListener('click', () => showSection('main-section'));
  });

  // ---------------------------------------------------
  // 로그인/회원가입 기능 실행 및 화면 이동 (lobby.html 연결)
  // ---------------------------------------------------
  
  // 1. 게스트 로그인
  document.getElementById('btn-guest-login-submit').addEventListener('click', async () => {
    const guestNick = document.getElementById('guest-nickname').value;
    if (!guestNick) return alert("게스트 닉네임을 입력하세요.");
    
    const isSuccess = await loginAsGuest(guestNick);
    if (isSuccess) {
      alert(`${guestNick}님 환영합니다!`);
      window.location.href = GAME_PAGE_URL; // 로그인 성공 시 게임 로비로 이동
    }
  });

  // 2. 일반 로그인
  document.getElementById('btn-login').addEventListener('click', async () => {
    const user_id = document.getElementById('login-id').value;
    const pw = document.getElementById('login-password').value;
    
    try {
      const isSuccess = await login(user_id, pw);
      if (isSuccess) window.location.href = GAME_PAGE_URL; // 로그인 성공 시 게임 로비로 이동
    } catch (error) {
      // login 함수 내부에서 이미 alert를 띄우므로 여기선 생략해도 무방합니다.
    }
  });

  // 3. 구글 로그인 및 추가 정보 기입
  document.getElementById('btn-google-login').addEventListener('click', async () => {
    const result = await loginWithGoogle();
    
    if (result && result.isNewUser) {
      tempGoogleData = result;
      document.getElementById('g-signup-email').value = result.email;
      document.getElementById('g-signup-id').value = result.email.split('@')[0];
      document.getElementById('g-signup-nickname').value = result.nickname;
      showSection('google-signup-section'); // 신규 유저는 추가 정보 창으로
    } else if (result && !result.isNewUser) {
      alert("구글 로그인 성공!");
      window.location.href = GAME_PAGE_URL; // 기존 유저는 바로 게임 로비로 이동
    }
  });

  // 4. 일반 회원가입
  document.getElementById('btn-signup').addEventListener('click', async () => {
    const email = document.getElementById('signup-email').value;
    const pw = document.getElementById('signup-password').value;
    const id = document.getElementById('signup-id').value;
    const nick = document.getElementById('signup-nickname').value;
    const file = document.getElementById('signup-profile-file').files[0];
    
    // 결과값을 isSuccess 변수로 받아옵니다.
    const isSuccess = await signUpWithEmail(email, pw, id, nick, file);
    
    // isSuccess가 true(성공)일 때만 아래 코드를 실행합니다.
    if (isSuccess) {
      alert("회원가입이 완료되었습니다. 로그인해주세요!");
      showSection('login-section'); 
    }
  });

  // 5. 구글 회원가입 완료
  document.getElementById('btn-g-signup-complete').addEventListener('click', async () => {
    const id = document.getElementById('g-signup-id').value;
    const nick = document.getElementById('g-signup-nickname').value;
    const file = document.getElementById('g-signup-profile-file').files[0];

    await completeGoogleSignUp(tempGoogleData.uid, tempGoogleData.email, id, nick, tempGoogleData.photoURL, file);
    alert("구글 연동 가입이 완료되었습니다. 로그인해주세요!");
    showSection('login-section'); // 가입 완료 후 로그인 화면으로 전환
  });

  // 아이디/닉네임 중복 확인 (일반 가입)
  document.getElementById('btn-check-id').addEventListener('click', async () => {
    const idVal = document.getElementById('signup-id').value;
    if(!idVal) return alert("아이디를 입력하세요.");
    const isDup = await checkIdDuplicate(idVal);
    if(isDup) {
      document.getElementById('id-status').innerText = "❌ 이미 사용 중인 아이디입니다.";
      document.getElementById('id-status').style.color = "red";
      isIdValid = false;
    } else {
      document.getElementById('id-status').innerText = "✅ 사용 가능한 아이디입니다.";
      document.getElementById('id-status').style.color = "green";
      isIdValid = true;
    }
  });

  document.getElementById('btn-check-nickname').addEventListener('click', async () => {
    const nickVal = document.getElementById('signup-nickname').value;
    if(!nickVal) return alert("닉네임을 입력하세요.");
    const isDup = await checkNicknameDuplicate(nickVal);
    if(isDup) {
      document.getElementById('nickname-status').innerText = "❌ 이미 사용 중인 닉네임입니다.";
      document.getElementById('nickname-status').style.color = "red";
      isNicknameValid = false;
    } else {
      document.getElementById('nickname-status').innerText = "✅ 사용 가능한 닉네임입니다.";
      document.getElementById('nickname-status').style.color = "green";
      isNicknameValid = true;
    }
  });

  // 유저가 값을 다시 수정하면 통과 상태 초기화
  document.getElementById('signup-id').addEventListener('input', () => { isIdValid = false; document.getElementById('id-status').innerText = ""; });
  document.getElementById('signup-nickname').addEventListener('input', () => { isNicknameValid = false; document.getElementById('nickname-status').innerText = ""; });

  document.getElementById('btn-g-check-id').addEventListener('click', async () => {
    const idVal = document.getElementById('g-signup-id').value;
    if (!idVal) return alert("아이디를 입력하세요.");
    const isDup = await checkIdDuplicate(idVal);
    const status = document.getElementById('g-id-status');
    status.innerText = isDup ? "이미 사용 중인 아이디입니다." : "사용 가능한 아이디입니다.";
    status.style.color = isDup ? "red" : "green";
  });

  document.getElementById('btn-g-check-nickname').addEventListener('click', async () => {
    const nickVal = document.getElementById('g-signup-nickname').value;
    if (!nickVal) return alert("닉네임을 입력하세요.");
    const isDup = await checkNicknameDuplicate(nickVal);
    const status = document.getElementById('g-nickname-status');
    status.innerText = isDup ? "이미 사용 중인 닉네임입니다." : "사용 가능한 닉네임입니다.";
    status.style.color = isDup ? "red" : "green";
  });

  document.getElementById('g-signup-id').addEventListener('input', () => {
    document.getElementById('g-id-status').innerText = "";
  });

  document.getElementById('g-signup-nickname').addEventListener('input', () => {
    document.getElementById('g-nickname-status').innerText = "";
  });
