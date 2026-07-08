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
  let isGuestNicknameValid = false;

  const GAME_PAGE_URL = window.location.protocol === "file:"
    ? "lobby.html"
    : "/lobby.html";
  const AUTO_UNLOCK_BGM_KEY = "colorMasterAutoplayBgm";

  function goToLobbyAfterLogin() {
    sessionStorage.setItem(AUTO_UNLOCK_BGM_KEY, "true");
    window.location.href = GAME_PAGE_URL;
  }

  const nativeAlert = window.alert.bind(window);
  const authModalLayer = document.getElementById('authModalLayer');
  const authModalMessage = document.getElementById('authModalMessage');
  const authModalConfirm = document.getElementById('authModalConfirm');

  function closeAuthModal() {
    if (!authModalLayer) return;
    authModalLayer.classList.add('hidden');
    authModalLayer.setAttribute('aria-hidden', 'true');
  }

  function showAuthModal(message) {
    if (!authModalLayer || !authModalMessage) {
      nativeAlert(message);
      return;
    }
    authModalMessage.textContent = String(message ?? "");
    authModalLayer.classList.remove('hidden');
    authModalLayer.setAttribute('aria-hidden', 'false');
    authModalConfirm?.focus();
  }

  window.alert = showAuthModal;

  [authModalConfirm].forEach((button) => {
    if (!button) return;
    button.addEventListener('click', closeAuthModal);
  });

  document.querySelectorAll('[data-auth-modal-close]').forEach((element) => {
    element.addEventListener('click', closeAuthModal);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (authModalLayer?.classList.contains('hidden')) return;
    closeAuthModal();
  });

  // ---------------------------------------------------
  // 화면 내부 전환 (SPA 방식)
  // ---------------------------------------------------
  const showSection = (sectionId) => {
    document.querySelectorAll('.container > div').forEach(div => div.classList.add('hidden'));
    document.getElementById(sectionId).classList.remove('hidden');
  };

  function resetTextInput(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = "";
    setBorderColor(input, "var(--line)");
  }

  function clearStatus(statusId) {
    const status = document.getElementById(statusId);
    if (!status) return;
    status.innerText = "";
    status.style.color = "";
  }

  function resetProfilePreview(imageId, fileInputId) {
    const image = document.getElementById(imageId);
    const fileInput = document.getElementById(fileInputId);
    if (fileInput) fileInput.value = "";
    if (!image) return;
    image.src = "/Images/profile.png";
    image.classList.add('default-img');
  }

  function resetLoginSection() {
    resetTextInput('login-id');
    resetTextInput('login-password');
  }

  function resetGuestLoginSection() {
    resetTextInput('guest-nickname');
    clearStatus('guest-nickname-status');
    isGuestNicknameValid = false;
    guestBtnCheckNickname.disabled = true;
    guestLoginBtn.disabled = true;
  }

  function resetSignupSection() {
    resetTextInput('signup-email');
    resetTextInput('signup-nickname');
    resetTextInput('signup-id');
    resetTextInput('signup-password');
    clearStatus('nickname-status');
    clearStatus('id-status');
    resetProfilePreview('defaultProfileImage', 'signup-profile-file');
    isIdValid = false;
    isNicknameValid = false;
    isEmailValid = false;
    isPasswordValid = false;
    btnCheckId.disabled = true;
    btnCheckNickname.disabled = true;
    btnSignup.disabled = true;
  }

  function resetGoogleSignupSection() {
    resetTextInput('g-signup-email');
    resetTextInput('g-signup-nickname');
    resetTextInput('g-signup-id');
    clearStatus('g-nickname-status');
    clearStatus('g-id-status');
    resetProfilePreview('g-defaultProfileImage', 'g-signup-profile-file');
    isGoogleIdValid = false;
    isGoogleNicknameValid = false;
    googleBtnCheckId.disabled = true;
    googleBtnCheckNickname.disabled = true;
    googleBtnSignup.disabled = true;
    tempGoogleData = null;
  }

  function resetAuthFlowForms() {
    resetLoginSection();
    resetGuestLoginSection();
    resetSignupSection();
    resetGoogleSignupSection();
  }

  document.getElementById('nav-to-login').addEventListener('click', () => {
    resetLoginSection();
    showSection('login-section');
  });
  document.getElementById('nav-to-guest').addEventListener('click', () => {
    resetGuestLoginSection();
    showSection('guest-login-section');
  });
  document.getElementById('nav-to-signup').addEventListener('click', () => {
    resetSignupSection();
    resetGoogleSignupSection();
    showSection('before-signup-section');
  });
  document.getElementById('nav-to-email-signup').addEventListener('click', () => {
    resetSignupSection();
    showSection('signup-section');
  });

  document.querySelectorAll('.nav-to-main').forEach(btn => {
    btn.addEventListener('click', () => {
      resetAuthFlowForms();
      showSection('main-section');
    });
  });

  // ---------------------------------------------------
  // [게스트 로그인]
  // --------------------------------------------------- 
  // 요소 가져오기
  const guestBtnCheckNickname = document.getElementById('btn-guest-check-nickname');
  const guestLoginNicknameInput = document.getElementById('guest-nickname')
  const guestLoginBtn = document.getElementById('btn-guest-login-submit')

  // 초기 버튼 상태 (모두 잠금)
  guestBtnCheckNickname.disabled = true;
  guestLoginBtn.disabled = true;

  // 모든 조건이 통과했을 때만 가입 버튼 활성화하는 함수
  function updateGuestSignupButtonState() {
    if (isGuestNicknameValid) {
      guestLoginBtn.disabled = false;
    } else {
      guestLoginBtn.disabled = true;
    }
  }

  // 실시간 테두리 강제 적용 
  function setBorderColor(inputElement, color) {
    // !important를 추가해서 CSS의 :focus 스타일을 이겨냅니다.
    inputElement.style.setProperty('border-color', color, 'important');
    // 브라우저 기본 외곽선(outline)을 없애서 테두리 색이 실시간으로 보이게 합니다.
    inputElement.style.setProperty('outline', 'none', 'important');
  }

  // 닉네임 입력 (형식 검사 -> 중복확인 버튼 활성화)
  guestLoginNicknameInput.addEventListener('input', (event) => {
    let val = event.target.value.normalize('NFC');
    
    // 한글 조합이 깨지지 않도록 자음(ㄱ-ㅎ), 모음(ㅏ-ㅣ)을 허용 목록에 추가
    val = val.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
    event.target.value = val;

    isGuestNicknameValid = false;
    document.getElementById('guest-nickname-status').innerText = "";

    // 버튼 활성화를 위해 '완성형 한글, 영문, 숫자'만 허용하는 최종 확인용 정규식
    const nicknameRegex = /^[a-zA-Z0-9가-힣]{2,12}$/;

    if (val === "") {
      setBorderColor(event.target, "var(--line)");
      guestBtnCheckNickname.disabled = true;
    } else if (nicknameRegex.test(val)) {
      // 입력값이 완성형 한글이면서 2~12자 조건을 만족할 때만 버튼 활성화
      setBorderColor(event.target, "var(--line)");
      guestBtnCheckNickname.disabled = false; 
    } else {
      setBorderColor(event.target, "rgba(255, 90, 90, 0.5)");
      guestBtnCheckNickname.disabled = true;
    }
    updateGuestSignupButtonState();
  });

  // 닉네임 중복 확인 버튼
  guestBtnCheckNickname.addEventListener('click', async () => {
    const nickVal = guestLoginNicknameInput.value;
    const isDup = await checkNicknameDuplicate(nickVal);
    const statusEl = document.getElementById('guest-nickname-status');

    if(isDup) {
      statusEl.innerText = "이미 사용 중인 닉네임입니다.";
      statusEl.style.color = "rgba(255, 90, 90, 0.5)";
      setBorderColor(guestLoginNicknameInput, "rgba(255, 90, 90, 0.5)");
      isGuestNicknameValid = false;
    } else {
      statusEl.innerText = "사용 가능한 닉네임입니다.";
      statusEl.style.color = "rgba(90, 255, 90, 0.5)";
      setBorderColor(guestLoginNicknameInput, "var(--line)");
      isGuestNicknameValid = true; // 완벽히 통과!
    }
    updateGuestSignupButtonState();
  });

  document.getElementById('btn-guest-login-submit').addEventListener('click', async () => {
    if(guestLoginBtn.disabled) return;

    const guestNick = document.getElementById('guest-nickname').value.trim().normalize('NFC');

    const isSuccess = await loginAsGuest(guestNick);
    if (isSuccess) goToLobbyAfterLogin();
  });

  // ---------------------------------------------------
  // 로그인/회원가입 기능 실행 및 화면 이동 (lobby.html 연결)
  // ---------------------------------------------------

  // 1. 일반 로그인
  document.getElementById('btn-login').addEventListener('click', async () => {
    const user_id = document.getElementById('login-id').value;
    const pw = document.getElementById('login-password').value;
    if (!user_id && !pw){return alert("아이디와 비밀번호를 입력하세요.");}
    else if (!user_id){return alert("아이디를 입력하세요.");}
    else if (!pw){return alert("비밀번호를 입력하세요.");}
    
    const isSuccess = await login(user_id, pw);
    if (isSuccess) goToLobbyAfterLogin(); // 로그인 성공 시 게임 로비로 이동
  });

  // 2. 구글 로그인 및 추가 정보 기입
  document.getElementById('btn-google-login').addEventListener('click', async () => {
    const result = await loginWithGoogle();
    
    if (result && result.isNewUser) {
      tempGoogleData = result;
      document.getElementById('g-signup-email').value = result.email;
      document.getElementById('g-signup-id').value = result.email.split('@')[0];
      document.getElementById('g-signup-nickname').value = result.nickname ? result.nickname.normalize('NFC') : "";

      document.getElementById('g-signup-id').dispatchEvent(new Event('input'));
      document.getElementById('g-signup-nickname').dispatchEvent(new Event('input'));

      showSection('google-signup-section'); // 신규 유저는 추가 정보 창으로
    } else if (result && !result.isNewUser) {
      goToLobbyAfterLogin(); // 기존 유저는 바로 게임 로비로 이동
    }
  });

  document.getElementById('btn-google-signup').addEventListener('click', async () => {
    const result = await loginWithGoogle();
    
    if (result && result.isNewUser) {
      tempGoogleData = result;
      document.getElementById('g-signup-email').value = result.email;
      document.getElementById('g-signup-id').value = result.email.split('@')[0];
      document.getElementById('g-signup-nickname').value = result.nickname ? result.nickname.normalize('NFC') : "";

      document.getElementById('g-signup-id').dispatchEvent(new Event('input'));
      document.getElementById('g-signup-nickname').dispatchEvent(new Event('input'));

      showSection('google-signup-section'); // 신규 유저는 추가 정보 창으로
    } else if (result && !result.isNewUser) {
      goToLobbyAfterLogin(); // 기존 유저는 바로 게임 로비로 이동
    }
  });

  // ---------------------------------------------------
  // [일반 회원가입 실시간 검증 및 버튼 제어 로직]
  // ---------------------------------------------------

  const signupProfileFile = document.getElementById('signup-profile-file');
  const choiceProfileImageButton = document.getElementById('choiceProfileImageButton');
  const defaultProfileImage = document.getElementById('defaultProfileImage');

  // 1. "프로필 사진 선택" 버튼 클릭 시 숨겨진 파일 선택 창 열기
  choiceProfileImageButton.addEventListener('click', () => {
    signupProfileFile.click();
  });

  // 2. 파일이 선택(변경)되었을 때 이미지 미리보기 적용
  signupProfileFile.addEventListener('change', (event) => {
    const file = event.target.files[0]; // 유저가 선택한 파일 가져오기
    
    if (file) {
      // 선택한 파일의 임시 브라우저 URL을 생성하여 img 태그에 덮어씌움
      const imageUrl = URL.createObjectURL(file);
      defaultProfileImage.src = imageUrl;
      defaultProfileImage.classList.remove('default-img'); 
    } else {
      // 파일 선택 창을 열었다가 '취소'를 누른 경우 다시 기본 이미지로 복구
      defaultProfileImage.src = "Images/profile.png";
      defaultProfileImage.classList.add('default-img');
    }
  });
  
  // 요소 가져오기
  const signupIdInput = document.getElementById('signup-id');
  const signupNicknameInput = document.getElementById('signup-nickname');
  const signupEmailInput = document.getElementById('signup-email');
  const signupPasswordInput = document.getElementById('signup-password');

  const btnCheckId = document.getElementById('btn-check-id');
  const btnCheckNickname = document.getElementById('btn-check-nickname');
  const btnSignup = document.getElementById('btn-signup');

  // 유효성 상태 (이메일/비밀번호는 초기값 false로 추가)
  let isEmailValid = false;
  let isPasswordValid = false;

  // 초기 버튼 상태 (모두 잠금)
  btnCheckId.disabled = true;
  btnCheckNickname.disabled = true;
  btnSignup.disabled = true;

  // 모든 조건이 통과했을 때만 가입 버튼 활성화하는 함수
  function updateSignupButtonState() {
    if (isIdValid && isNicknameValid && isEmailValid && isPasswordValid) {
      btnSignup.disabled = false;
    } else {
      btnSignup.disabled = true;
    }
  }

  // 1. 아이디 입력 (형식 검사 -> 중복확인 버튼 활성화)
  signupIdInput.addEventListener('input', (event) => {
    // 영문, 숫자만 남기고 삭제
    event.target.value = event.target.value.replace(/[^a-zA-Z0-9]/g, '');
    const val = event.target.value;

    // 값이 바뀌었으므로 기존 중복확인 통과 기록 초기화
    isIdValid = false; 
    document.getElementById('id-status').innerText = "";

    if (val === "") {
      setBorderColor(event.target, "var(--line)"); // 빈 값이면 테두리 원상복구
      btnCheckId.disabled = true;
    } else {
      setBorderColor(event.target, "var(--line)");
      btnCheckId.disabled = false; // 중복확인 버튼 열림
    }
    updateSignupButtonState();
  });

  // 1-2. 아이디 중복 확인 버튼
  btnCheckId.addEventListener('click', async () => {
    const idVal = signupIdInput.value;
    const isDup = await checkIdDuplicate(idVal);
    const statusEl = document.getElementById('id-status');

    if(isDup) {
      statusEl.innerText = "이미 사용 중인 아이디입니다.";
      statusEl.style.color = "rgba(255, 90, 90, 0.5)";
      setBorderColor(signupIdInput, "rgba(255, 90, 90, 0.5)");
      isIdValid = false;
    } else {
      statusEl.innerText = "사용 가능한 아이디입니다.";
      statusEl.style.color = "rgba(90, 255, 90, 0.5)";
      setBorderColor(signupIdInput, "var(--line)");
      isIdValid = true; // 완벽히 통과!
    }
    updateSignupButtonState();
  });

  // 2. 닉네임 입력 (형식 검사 -> 중복확인 버튼 활성화)
  signupNicknameInput.addEventListener('input', (event) => {
    let val = event.target.value.normalize('NFC');
    
    // 한글 조합이 깨지지 않도록 자음(ㄱ-ㅎ), 모음(ㅏ-ㅣ)을 허용 목록에 추가
    val = val.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
    event.target.value = val;

    isNicknameValid = false;
    document.getElementById('nickname-status').innerText = "";

    // 버튼 활성화를 위해 '완성형 한글, 영문, 숫자'만 허용하는 최종 확인용 정규식
    const nicknameRegex = /^[a-zA-Z0-9가-힣]{2,12}$/;

    if (val === "") {
      setBorderColor(event.target, "var(--line)");
      btnCheckNickname.disabled = true;
    } else if (nicknameRegex.test(val)) {
      // 입력값이 완성형 한글이면서 2~12자 조건을 만족할 때만 버튼 활성화
      setBorderColor(event.target, "var(--line)");
      btnCheckNickname.disabled = false; 
    } else {
      setBorderColor(event.target, "rgba(255, 90, 90, 0.5)");
      btnCheckNickname.disabled = true;
    }
    updateSignupButtonState();
  });

  // 2-2. 닉네임 중복 확인 버튼
  btnCheckNickname.addEventListener('click', async () => {
    const nickVal = signupNicknameInput.value;
    const isDup = await checkNicknameDuplicate(nickVal);
    const statusEl = document.getElementById('nickname-status');

    if(isDup) {
      statusEl.innerText = "이미 사용 중인 닉네임입니다.";
      statusEl.style.color = "rgba(255, 90, 90, 0.5)";
      setBorderColor(signupNicknameInput, "rgba(255, 90, 90, 0.5)");
      isNicknameValid = false;
    } else {
      statusEl.innerText = "사용 가능한 닉네임입니다.";
      statusEl.style.color = "rgba(90, 255, 90, 0.5)";
      setBorderColor(signupNicknameInput, "var(--line)");
      isNicknameValid = true; // 완벽히 통과!
    }
    updateSignupButtonState();
  });

  // 3. 이메일 입력 (형식 검사)
  signupEmailInput.addEventListener('input', (event) => {
    const val = event.target.value;
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

    if (val === "") {
      setBorderColor(event.target, "var(--line)");; // 지웠을 때 원래 색으로
      isEmailValid = false;
    } else if (emailRegex.test(val)) {
      setBorderColor(event.target, "var(--line)");
      isEmailValid = true;
    } else {
      setBorderColor(event.target, "rgba(255, 90, 90, 0.5)");
      isEmailValid = false;
    }
    updateSignupButtonState();
  });

  // 4. 비밀번호 입력 (형식 검사)
  signupPasswordInput.addEventListener('input', (event) => {
    const val = event.target.value;

    if (val === "") {
      setBorderColor(event.target, "var(--line)");; // 지웠을 때 원래 색으로
      isPasswordValid = false;
    } else {
      const hasLetter = /[a-zA-Z]/.test(val);
      const hasNumber = /\d/.test(val);
      const hasSpecial = /[!@#$%^&*()_+~\-={}\[\]:;"'<>,.?/|\\]/.test(val);
      const isValidLength = val.length >= 8 && val.length <= 12;

      if (isValidLength && hasLetter && hasNumber && hasSpecial) {
        setBorderColor(event.target, "var(--line)");
        isPasswordValid = true;
      } else {
        setBorderColor(event.target, "rgba(255, 90, 90, 0.5)");
        isPasswordValid = false;
      }
    }
    updateSignupButtonState();
  });

  // 5. 최종 가입 버튼 클릭 이벤트
  document.getElementById('btn-signup').addEventListener('click', async () => {
    const email = signupEmailInput.value;
    const pw = signupPasswordInput.value;
    const id = signupIdInput.value;
    const nick = signupNicknameInput.value;
    const file = document.getElementById('signup-profile-file').files[0];
    
    const isSuccess = await signUpWithEmail(email, pw, id, nick, file);
    
    if (isSuccess) {
      showSection('login-section'); 
    }
  });

  // ---------------------------------------------------
  // [구글 회원가입 실시간 검증 및 버튼 제어 로직]
  // ---------------------------------------------------

  // 구글 전용 상태 변수 선언
  let isGoogleIdValid = false;
  let isGoogleNicknameValid = false;

  const googleSignupProfileFile = document.getElementById('g-signup-profile-file');
  const googleChoiceProfileImageButton = document.getElementById('googleChoiceProfileImageButton');
  const gDefaultProfileImage = document.getElementById('g-defaultProfileImage'); // ✨ HTML 수정 반영

  // 1. "프로필 사진 선택" 버튼 클릭 시 숨겨진 파일 선택 창 열기
  googleChoiceProfileImageButton.addEventListener('click', () => {
    googleSignupProfileFile.click();
  });

  // 2. 파일이 선택(변경)되었을 때 이미지 미리보기 적용
  googleSignupProfileFile.addEventListener('change', (event) => {
    const file = event.target.files[0]; 
    if (file) {
      const imageUrl = URL.createObjectURL(file);
      gDefaultProfileImage.src = imageUrl;
      gDefaultProfileImage.classList.remove('default-img'); 
    } else {
      gDefaultProfileImage.src = "Images/profile.png";
      gDefaultProfileImage.classList.add('default-img');
    }
  });
  
  const googleSignupIdInput = document.getElementById('g-signup-id');
  const googleSignupNicknameInput = document.getElementById('g-signup-nickname');

  const googleBtnCheckId = document.getElementById('btn-g-check-id');
  const googleBtnCheckNickname = document.getElementById('btn-g-check-nickname');
  const googleBtnSignup = document.getElementById('btn-g-signup-complete'); 

  // 초기 버튼 상태 (모두 잠금)
  googleBtnCheckId.disabled = true;
  googleBtnCheckNickname.disabled = true;
  googleBtnSignup.disabled = true;

  function updateGoogleSignupButtonState() {
    if (isGoogleIdValid && isGoogleNicknameValid) {
      googleBtnSignup.disabled = false;
    } else {
      googleBtnSignup.disabled = true;
    }
  }

  // 1. 아이디 입력 
  googleSignupIdInput.addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/[^a-zA-Z0-9]/g, '');
    const val = event.target.value;

    isGoogleIdValid = false; 
    document.getElementById('g-id-status').innerText = "";

    if (val === "") {
      setBorderColor(event.target, "var(--line)"); 
      googleBtnCheckId.disabled = true;
    } else {
      setBorderColor(event.target, "var(--line)");
      googleBtnCheckId.disabled = false; 
    }
    updateGoogleSignupButtonState();
  });

  // 1-2. 아이디 중복 확인 버튼
  googleBtnCheckId.addEventListener('click', async () => {
    const idVal = googleSignupIdInput.value;
    const isDup = await checkIdDuplicate(idVal);
    const statusEl = document.getElementById('g-id-status');

    if(isDup) {
      statusEl.innerText = "이미 사용 중인 아이디입니다.";
      statusEl.style.color = "rgba(255, 90, 90, 0.5)";
      setBorderColor(googleSignupIdInput, "rgba(255, 90, 90, 0.5)");
      isGoogleIdValid = false;
    } else {
      statusEl.innerText = "사용 가능한 아이디입니다.";
      statusEl.style.color = "rgba(90, 255, 90, 0.5)";
      setBorderColor(googleSignupIdInput, "var(--line)");
      isGoogleIdValid = true; 
    }
    updateGoogleSignupButtonState();
  });

  // 2. 닉네임 입력
  googleSignupNicknameInput.addEventListener('input', (event) => {
    let val = event.target.value.normalize('NFC');
    
    // 한글 조합이 깨지지 않도록 자음(ㄱ-ㅎ), 모음(ㅏ-ㅣ)을 허용 목록에 추가!
    val = val.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
    event.target.value = val;

    isGoogleNicknameValid = false;
    document.getElementById('g-nickname-status').innerText = ""; 

    // 완성형 한글/영/숫자 확인
    const nicknameRegex = /^[a-zA-Z0-9가-힣]{2,12}$/;

    if (val === "") {
      setBorderColor(event.target, "var(--line)");
      googleBtnCheckNickname.disabled = true;
    } else if (nicknameRegex.test(val)) {
      // 조건 만족 시에만 중복 확인 버튼 활성화
      setBorderColor(event.target, "var(--line)");
      googleBtnCheckNickname.disabled = false; 
    } else {
      setBorderColor(event.target, "rgba(255, 90, 90, 0.5)");
      googleBtnCheckNickname.disabled = true;
    }
    updateGoogleSignupButtonState();
  });

  // 2-2. 닉네임 중복 확인 버튼
  googleBtnCheckNickname.addEventListener('click', async () => {
    const nickVal = googleSignupNicknameInput.value.trim().normalize('NFC');

    if (!nickVal) return;

    const isDup = await checkNicknameDuplicate(nickVal);
    const statusEl = document.getElementById('g-nickname-status');

    if(isDup) {
      statusEl.innerText = "이미 사용 중인 닉네임입니다.";
      statusEl.style.color = "rgba(255, 90, 90, 0.5)";
      setBorderColor(googleSignupNicknameInput, "rgba(255, 90, 90, 0.5)");
      isGoogleNicknameValid = false;
    } else {
      statusEl.innerText = "사용 가능한 닉네임입니다.";
      statusEl.style.color = "rgba(90, 255, 90, 0.5)";
      setBorderColor(googleSignupNicknameInput, "var(--line)");
      isGoogleNicknameValid = true; 
    }
    updateGoogleSignupButtonState();
  });

  // 3. 구글 회원가입 완료
  googleBtnSignup.addEventListener('click', async () => {
    if(googleBtnSignup.disabled) return;

    const id = document.getElementById('g-signup-id').value;
    const nick = document.getElementById('g-signup-nickname').value.trim().normalize('NFC');
    const file = document.getElementById('g-signup-profile-file').files[0];

    await completeGoogleSignUp(tempGoogleData.uid, tempGoogleData.email, id, nick, tempGoogleData.photoURL, file);
    showSection('login-section'); 
  });

  // 요소 가져오기
  const loginIdInput = document.getElementById('login-id');
  const loginPasswordInput = document.getElementById('login-password');
  const loginBtn = document.getElementById('btn-login');

  // 1. 비밀번호 입력란에서 엔터 키를 누르면 로그인 실행
  loginPasswordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // 기본 엔터 동작 방지 (선택 사항)
      event.preventDefault(); 
      // 로그인 버튼을 클릭한 것과 같은 효과를 줍니다.
      loginBtn.click(); 
    }
  });

  // 2. (선택 사항) 아이디 입력란에서 엔터 키를 누르면 비밀번호 입력란으로 포커스 이동
  loginIdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginPasswordInput.focus();
    }
  });

  // 게스트 로그인에서 닉네임에 엔터 키를 누르면 로그인
  guestLoginNicknameInput.addEventListener('keydown', (event) => {
    if (event.key == 'Enter') {
      event.preventDefault();
      guestLoginBtn.click();
    }
  });
