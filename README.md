# 26s-w1-c3-03

## 공통과제 I : 웹 기반 프로젝트 (2인 1팀)

**목적:** 공통 과제를 함께 수행하며 웹 개발의 전체 흐름을 빠르게 익히고 협업에 적응하기

**결과물:** 기획부터 배포까지 완료된 웹 서비스와 관련 문서 일체

---

## 팀원

| 이름 | GitHub | 역할 |
|---|---|---|
| 조예준 | https://github.com/jossi-jossi | 프론트엔드 중심의 풀스택 개발 |
| 김민 | https://github.com/7immin | 백엔드 중심의 풀스택 개발  |

---

## 기획안

> 프로젝트 주제, 목적, 핵심 기능, 예상 사용자를 정리

- **주제:** 웹 기반 실시간 멀티플레이 게임 「컬러마스터(Color Master)」

- **목적:**  
  제시된 이미지의 평균 RGB 값을 예측하고, 다른 플레이어와 정확도를 겨루는 캐주얼 경쟁형 웹 게임을 개발한다.

- **핵심 기능:**
  1. 평균 RGB 값을 추측하는 라운드 기반 실시간 멀티플레이
  2. 일반 이메일·Google·게스트 로그인
  3. 게임 방 생성, 참여, 초대 및 실시간 관리
  4. 전체 및 친구 랭킹
  5. 친구 추가·삭제, 접속 상태 확인 및 알림함
  6. 접속 종료 시 자동 플레이
  7. 화면별 BGM 및 음량 조절

- **예상 사용자:**  
  짧고 가볍게 즐길 수 있는 캐주얼 멀티플레이 게임을 선호하는 사용자

---

## 기능 명세서

### 핵심 기능

- 여러 사용자가 게임 방에 참여하여 실시간으로 플레이할 수 있다.
- 플레이어는 제시된 이미지의 평균 RGB 값을 추측한다.
- 각 RGB 채널의 오차에 따라 색상 피드백을 제공한다.
- 여러 라운드 종료 후 최종 RGB 값을 제출하고 순위를 결정한다.
- 게임 결과에 따라 랭킹 포인트를 반영한다.
- 로그인 사용자는 방 이름, 방 코드, 플레이어 수, 난이도를 설정해 게임 방을 생성할 수 있다.
- 로그인 및 게스트 사용자는 생성된 방에 참여할 수 있다.
- 접속이 끊기거나 게임을 이탈한 사용자는 자동 플레이로 전환된다.

### 선택 기능

- 일반 이메일과 Google 계정으로 회원가입 및 로그인할 수 있다.
- 회원가입 없이 게스트로 로그인할 수 있다.
- 로그인 사용자는 아이디, 비밀번호, 닉네임, 프로필 사진을 수정할 수 있다.
- 게스트는 로그아웃 전까지 랭킹 포인트가 유지된다.
- 친구 추가, 삭제 및 친구 목록 확인이 가능하다.
- 친구의 접속 상태, 닉네임, 프로필 사진, 랭킹 포인트를 확인할 수 있다.
- 친구 신청과 게임 초대를 알림함에서 수락하거나 거절할 수 있다.
- 방 대기화면에서 접속 중인 친구를 초대할 수 있다.
- 전체 랭킹과 친구 랭킹을 확인할 수 있다.
- 로비와 방 대기화면에서 로비 BGM을 재생한다.
- 게임 화면에서는 별도의 플레이 BGM을 재생한다.
- 슬라이더로 음량을 실시간 조절할 수 있다.

---

## IA 및 화면 설계서

> 서비스의 전체 페이지 구조와 페이지 간 이동 흐름; 각 페이지의 주요 UI 구성, 입력 요소, 버튼, 사용자 행동 흐름 등을 간단한 와이어프레임 형태로 정리

### IA
<img width="1680" height="1184" alt="Image" src="https://github.com/user-attachments/assets/77b8fcc1-981b-4968-bcc9-58cb85bce2f3" />

### 화면 설계서
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/deb5d6e7-d90a-46b3-8e7a-96c261b5b9d6" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/563d753b-8a0a-4076-9a50-f9daa192c0ce" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/cda0bc97-11d4-474c-a66c-651358dc3183" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/63d65647-8801-4ffc-99c6-46eb146f0252" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/f03231dc-fca4-4bb6-9abb-937356782790" />

<img width="2164" height="1415" alt="Image" src="https://github.com/user-attachments/assets/cbfa276f-daec-4a5a-a229-c3728e87b502" />

---

## DB 스키마

> 필요한 테이블, 주요 필드, 데이터 타입, 테이블 간 관계를 정리

<img width="2464" height="1568" alt="Image" src="https://github.com/user-attachments/assets/c3fa37a8-25d1-46a5-9e69-1cba27c806c4" />

---

## API 문서

> API 주소, 요청 방식, 요청값, 응답값, 에러 상황을 정리

| Method | Endpoint | 설명 | 요청 | 응답 |
|---|---|---|---|---|
|  |  |  |  |  |

---

## 배포 결과물

> 접속 가능한 링크, 실행 방법, 주요 구현 내용

- **서비스 URL:**  
  https://color-master.madcamp-kaist.org/

  HTTP로 접속하는 경우 HTTPS로 자동 리다이렉트됩니다.

- **서비스 이용 방법:**
  1. 서비스 URL에 접속합니다.
  2. 일반 이메일, Google 계정 또는 게스트 계정으로 로그인합니다.
  3. 로그인 사용자는 게임 방을 생성하거나 기존 방에 참여할 수 있습니다.
  4. 게스트 사용자는 생성된 게임 방에 참여할 수 있습니다.
  5. 방에 2명 이상의 플레이어가 모이면 방장이 게임을 시작할 수 있습니다.

---

## 회고 문서

> 개발 과정에서의 어려움, 해결 방법, 역할 분담, 다음에 개선할 점 (KPT 방법론 참고)

### Keep

### Problem

### Try

---

## 참고 자료

- [SDD(스펙 주도 개발) 이해하기](https://news.hada.io/topic?id=21338)
- [Software Design Document Best Practices](https://www.atlassian.com/work-management/project-management/design-document)
- [IA 정보구조도 작성 방법](https://brunch.co.kr/@nyonyo/7)
- [기획자 화면설계서 작성법](https://brunch.co.kr/@soup/10)
- [Figma 와이어프레임 가이드](https://www.figma.com/ko-kr/resource-library/what-is-wireframing/)
- [무료 Figma 와이어프레임 키트](https://www.figma.com/ko-kr/templates/wireframe-kits/)
- [ERD/DB 설계 총정리](https://inpa.tistory.com/entry/DB-%F0%9F%93%9A-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EB%AA%A8%EB%8D%B8%EB%A7%81-%EA%B0%9C%EB%85%90-ERD-%EB%8B%A4%EC%9D%B4%EC%96%B4%EA%B7%B8%EB%9E%A8)
- [API 명세서 작성 가이드라인](https://velog.io/@sebinChu/BackEnd-API-%EB%AA%85%EC%84%B8%EC%84%9C-%EC%9E%91%EC%84%B1-%EA%B0%80%EC%9D%B4%EB%93%9C-%EB%9D%BC%EC%9D%B8)
- [좋은 README 작성하는 방법](https://velog.io/@sabo/good-readme)
- [단기 프로젝트 회고 KPT 방법론](https://velog.io/@habwa/%EB%8B%A8%EA%B8%B0-%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8-%ED%9A%8C%EA%B3%A0-KPT-%EB%B0%A9%EB%B2%95%EB%A1%A0)
