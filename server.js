// 웹 서버 구축을 위한 라이브러리 로드
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 게임 규칙에 필요한 상수 정의
const CONFIG = {
  ROUNDS: 5,            // 라운드 수
  GUESS_TIME: 30000,    // 입력 제한 시간: 30초
  PEEK_TIME: 10000,     // 선택 제한 시간: 10초
  POINTS: { 2: [5, 3],  // 유저 수에 따른 지급 포인트
            3: [5, 3, 1],
            4: [5, 4, 2, 1], 
            5: [5, 4, 3, 2, 1] 
        }
};

// 게임이 진행되는 동안 Map 객체에 정보를 저장, 게임이 끝나면 저장된 정보가 삭제
// 저장 정보: 참가자 목록, 진행 라운드, 진행 상황(추측, 선택 등)
const activeRooms = new Map();

// 추측값 결과 리턴 함수
// target: 정답, guess: 추측값
function getFeedbackColor(target, guess) {
  // 오차 절댓값 error 계산
  const error = Math.abs(target - guess);

  if (error === 0) return '파란색';     // 정답이면 파란색
  if (error <= 10) return '초록색';     // error가 10 이하면 초록색
  if (error <= 50) return '노란색';     // error가 50 이하면 노란색
  if (error <= 150) return '주황색';    // error가 150 이하면 주황색
  return '빨간색';                      // error가 255 이하면 빨간색
}

// 정답 RGB 생성 함수
// level: 난이도(색상 개수)
function generateTargetRGB(level) {
  // 평균 계산을 위한 RGB 값의 합을 0으로 초기화
  let totalR = 0, totalG = 0, totalB = 0;

  // 이미지 생성을 위한 RGB 배열 colors 선언
  const colors = [];

  // level에 따라 생성할 색상의 개수만큼 반복
  for (let i = 0; i < level; i++) {
    // RGB 값을 랜덤으로 생성 (0~255)
    const r = Math.floor(Math.random() * 256);
    const g = Math.floor(Math.random() * 256);
    const b = Math.floor(Math.random() * 256);

    // 생성된 RGB를 colors에 저장
    colors.push({ r, g, b });

    // RGB 값의 합을 각각 계산
    totalR += r; totalG += g; totalB += b;
  }
  return {
    colors,
    // RGB 값 각각의 평균
    average: { 
      r: Math.round(totalR / level), 
      g: Math.round(totalG / level), 
      b: Math.round(totalB / level) 
    }
  };
}

// 라운드 시작 함수
function startRound(room) {
  // 라운드수 증가
  room.round++;

  // 추측 유저 초기화
  room.turnIndex = 0;

  // 라운드수와 정답 RGB 값 알림
  io.to(room.roomCode).emit('round_start', { 
    round: room.round, 
    colors: room.targetData.colors 
  });

  // 추측 단계로 이동
  startGuessingPhase(room);
}

// 추측 단계 함수
function startGuessingPhase(room) {
  // 현재 상태를 추측으로 변경, 현재 추측 유저를 변수에 저장
  room.phase = 'GUESSING';
  const currentPlayer = room.players[room.turnIndex];
  
  // 
  io.to(room.roomCode).emit('turn_start', { turnUserId: currentPlayer.userId, timeLimit: 30 });

  // 입력 제한 시간 내에 입력하지 않으면 다음 단계로 이동
  room.timerRef = setTimeout(() => {
    endPeekingPhase(room);
  }, CONFIG.GUESS_TIME);
}

// 결과 확인 단계 함수
function startPeekingPhase(room) {
  // 현재 상태를 확인으로 변경, 결과 확인 유저 set 초기화
  room.phase = 'PEEKING';
  room.peekedUsers = new Set();
  
  // 
  io.to(room.roomCode).emit('peeking_start', { timeLimit: 10 });

  // 선택 제한 시간 내에 선택하지 않으면 다음 단계로 이동
  room.timerRef = setTimeout(() => {
    endPeekingPhase(room);
  }, CONFIG.PEEK_TIME);
}

// 분기점 함수
function endPeekingPhase(room) {
  // 선택 제한 시간이 남은 상태에서 호출 -> 타이머 해제
  clearTimeout(room.timerRef);

  // 추측 순서 변경
  room.turnIndex++;
  
  // 모든 유저가 추측을 했을 때 
  if (room.turnIndex >= room.players.length) {
    // 5 라운드까지 끝난 경우 게임 종료 함수 호출
    if (room.round >= CONFIG.ROUNDS) {
      endGame(room);
    } else { // 라운드가 남은 경우 라운드 시작 함수 호출
      startRound(room);
    }
  } else { // 추측할 유저가 남은 경우 추측 단계 함수 호출
    startGuessingPhase(room);
  }
}

// 게임 종료 함수
function endGame(room) {
  // 현재 상태를 게임 종료로 변경, 최종 오차 절댓값 합이 가장 작은 사람부터 정렬
  room.phase = 'GAME_OVER';
  room.players.sort((a, b) => a.lastRoundErrorSum - b.lastRoundErrorSum);

  const pointArray = CONFIG.POINTS[room.players.length];
  const finalResults = room.players.map((player, index) => ({
    userId: player.userId,
    nickname: player.nickname,
    rank: index + 1,
    earnedPoint: pointArray[index],
    finalError: player.lastRoundErrorSum
  }));

  io.to(room.roomCode).emit('game_over', { results: finalResults });
  activeRooms.delete(room.roomCode);
}

// 콜백 함수
// 새로운 유저가 접속할 때마다 유저 전용 소켓을 배정
io.on('connection', (socket) => {
  // 방 입장
  socket.on('join_room', ({ roomCode, userId, nickname }) => {
    socket.join(roomCode);
    if (!activeRooms.has(roomCode)) {
      activeRooms.set(roomCode, {
        roomCode,           // 방 코드
        level: 1,           // 기본 난이도: 1
        phase: 'WAITING',   // 초기 상태: 대기
        round: 0,           // 라운드 0으로 초기화
        turnIndex: 0,       // 현재 추측 순서
        players: [],        // 참여 유저 배열
        targetData: null,   // 정답 RGB값 초기화
        timerRef: null      // 
      });
    }

    // 해당 방의 정보를 변수에 저장
    const room = activeRooms.get(roomCode);

    // 유저 정보를 players에 저장
    room.players.push({ 
        socketId: socket.id,    // 유저 전용 소켓 아이디
        userId,                 // 유저 아이디
        nickname,               // 유저 닉네임
        lastRoundErrorSum: 0    // 최종 오차 절댓값의 합 0으로 초기화
    });

    // 참여 유저 목록 업데이트
    io.to(roomCode).emit('room_update', { players: room.players });
  });

  // 게임 시작
  socket.on('start_game', ({ roomCode, level }) => {
    // 해당 방의 정보를 변수에 저장
    const room = activeRooms.get(roomCode);

    // 게임 시작 조건: 방이 존재하고, 참가 유저 수가 2 이상이고, 현재 상태가 대기일 때
    if (room && room.players.length >= 2 && room.phase === 'WAITING') {
      room.level = level; // 난이도 업데이트
      room.targetData = generateTargetRGB(room.level); // 정답 RGB 생성
      startRound(room); // 라운드 시작 단계로 이동
    }
  });

  // 추측
  socket.on('submit_guess', ({ roomCode, guessRGB }) => {
    // 해당 방의 정보, 추측 순서 유저를 변수에 저장
    const room = activeRooms.get(roomCode);
    const currentPlayer = room.players[room.turnIndex];

    // 현재 상태가 추측이 아니거나, 추측을 시도한 유저가 추측 순서가 아닐 때 리턴
    if (room.phase !== 'GUESSING' || socket.id !== currentPlayer.socketId) return;

    // 입력 제한 시간 안에 추측을 했으므로 30초 타이머 해제
    clearTimeout(room.timerRef);

    // 추측값의 결과 계산
    const target = room.targetData.average;
    const feedback = {
      R: getFeedbackColor(target.r, guessRGB.r),
      G: getFeedbackColor(target.g, guessRGB.g),
      B: getFeedbackColor(target.b, guessRGB.b)
    };

    // 추측값 및 결과 저장
    room.currentTurnData = { guessRGB, feedback };

    // 유저에게 추측 결과 알림
    socket.emit('my_guess_result', { guessRGB, feedback });
    
    // 다른 유저들이 확인할 결과를 선택하는 단계로 이동
    startPeekingPhase(room);
  });

  // 결과 확인
  socket.on('peek_color', ({ roomCode, selectedColor }) => {
    // 해당 방의 정보를 변수에 저장
    const room = activeRooms.get(roomCode);

    // 현재 상태가 확인이 아니고, 해당 유저가 추측한 유저일 때 리턴
    if (room.phase !== 'PEEKING' || socket.id === room.players[room.turnIndex].socketId) return;

    // 이미 결과 확인을 했다면 리턴
    if (room.peekedUsers.has(socket.id)) return;

    // 결과 확인 유저 set의 유저 소켓 아이디 add
    room.peekedUsers.add(socket.id);

    // 유저가 선택한 색의 추측값과 결과를 변수에 저장
    const guessValue = room.currentTurnData.guessRGB[selectedColor.toLowerCase()];
    const resultColor = room.currentTurnData.feedback[selectedColor]; 

    // 유저에게 선택한 색의 결과 알림
    socket.emit('peek_result', { selectedColor, resultColor, guessValue });

    // 추측 유저를 제외한 모든 유저가 결과를 확인했다면 다음 단계로 이동
    if (room.peekedUsers.size >= room.players.length - 1) {
      endPeekingPhase(room);
    }
  });

  // 최종 RGB값 추측
  socket.on('submit_final_guess', ({ roomCode, guessRGB }) => {
    // 해당 방의 정보를 변수에 저장
    const room = activeRooms.get(roomCode);

    // 현재 상태가 최종 추측이 아니라면 리턴
    if (room.phase !== 'FINAL_GUESS') return;


    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || room.finalSubmissions.has(socket.id)) return;

    // 최종 오차 계산 및 저장
    const target = room.targetData.average;
    player.finalErrorSum = Math.abs(target.r - guessRGB.r) + Math.abs(target.g - guessRGB.g) + Math.abs(target.b - guessRGB.b);
    
    room.finalSubmissions.add(socket.id);

    // 전원 제출 완료 시 즉시 게임 종료
    if (room.finalSubmissions.size === room.players.length) {
      clearTimeout(room.timerRef);
      endGame(room);
    }
  });

  // 연결 끊김
  socket.on('disconnect', () => {
    activeRooms.forEach((room, roomCode) => {
      const index = room.players.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        io.to(roomCode).emit('room_update', { players: room.players });
      }
    });
  });
});


// 서버 가동 명령어 -> 3000번 포트에 연결
server.listen(3000, () => console.log('Color Master Server running on port 3000'));