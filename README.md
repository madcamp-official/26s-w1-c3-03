# 26s-w1-c3-03

## 공통과제 I : 웹 기반 프로젝트 (2인 1팀)

**목적:** 공통 과제를 함께 수행하며 웹 개발의 전체 흐름을 빠르게 익히고 협업에 적응하기

**결과물:** 기획부터 배포까지 완료된 웹 서비스와 관련 문서 일체

---

## 팀원

| 이름 | GitHub | 역할 |
|---|---|---|
| 조예준 | https://github.com/jossi-jossi | 프론트 |
| 김민 | https://github.com/7immin | 백 |

---

## 기획안

> 프로젝트 주제, 목적, 핵심 기능, 예상 사용자, 팀원별 역할 등 정리

- **주제: 웹 기반 실시간 멀티플레이 게임 「컬러마스터(Color Master)」**
- **목적: 이미지의 평균 RGB 값을 가장 정확하게 예측하는 경쟁형 웹 게임 개발**
- **핵심 기능: (1) 이미지를 보고 평균 RGB 값을 입력하여 정확도를 겨루는 라운드 기반 실시간 멀티플레이 (2) 친구 추가, 친구 목록 및 초대 기능 (3) 실시간 게임 룸 생성, 참여 및 관리 기능 (4) 난이도 설정 기능**
- **예상 사용자: 캐주얼 게임을 즐기는 모든 인터넷 사용자**

---

## 기능 명세서

> 구현할 기능을 사용자 관점에서 정리하고, 필수 기능과 선택 기능을 구분

### 필수 기능

- 이미지를 보고 평균 RGB 값을 입력하여 정확도를 겨루는 라운드 기반 실시간 멀티플레이
- 실시간 게임 룸 생성, 참여 및 관리 기능

### 선택 기능

- 회원가입 및 로그인 기능, 친구 추가, 친구 목록 및 초대 기능
- 난이도 설정 기능
- 랭킹 시스템 및 유저별 기록 관리

---

## IA 및 화면 설계서

> 서비스의 전체 페이지 구조와 페이지 간 이동 흐름; 각 페이지의 주요 UI 구성, 입력 요소, 버튼, 사용자 행동 흐름 등을 간단한 와이어프레임 형태로 정리

### IA
<img width="2228" height="1392" alt="Image" src="https://github.com/user-attachments/assets/200bdbc3-d67e-43ad-a013-aa5762587a5f" />

### 화면 설계서
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/deb5d6e7-d90a-46b3-8e7a-96c261b5b9d6" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/563d753b-8a0a-4076-9a50-f9daa192c0ce" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/cda0bc97-11d4-474c-a66c-651358dc3183" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/63d65647-8801-4ffc-99c6-46eb146f0252" />
<img width="3505" height="2480" alt="Image" src="https://github.com/user-attachments/assets/f03231dc-fca4-4bb6-9abb-937356782790" />

---

## DB 스키마

> 필요한 테이블, 주요 필드, 데이터 타입, 테이블 간 관계를 정리

<img width="1488" height="647" alt="Image" src="https://github.com/user-attachments/assets/b98d2cbe-be16-4966-a4d7-d5a2ec408f48" />

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
- **실행 방법:**

```bash
# 실행 방법 작성
```

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
