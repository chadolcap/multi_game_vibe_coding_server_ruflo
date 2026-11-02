# 클라이언트 반영 요청

서버는 개발 서버(전 채널)에 반영돼 있습니다. 아래 체크리스트대로 클라이언트를 고쳐 주세요.
메시지 형식은 맨 아래 **참고: 프로토콜** 에 있습니다.

---

## 0. 게임 시작 star 차감 (2026-11-02)

게임이 실제로 시작될 때(`GAME_START`, 재게임 포함) star 가 1 줄어듭니다. 방에 들어왔다 READY 전에 나가면 줄지 않습니다.

- [ ] 로비의 star 표시는 지금처럼 `ENTER_LOBBY` 응답의 `star` 로 초기화 (게임에서 돌아오면 차감된 값이 옴)
- [ ] `JOIN_MATCH` 뒤 `ERROR{code:"NOT_ENOUGH_STAR"}` 처리 — 매칭 대기 화면을 닫고, star 부족 안내와 '광고 보기'로 유도 (로비 연결은 유지됨)
- [ ] (선택) 보유 star 가 0 이면 게임 참여 버튼 누를 때 서버 응답 전에 같은 안내 표시
- [ ] **모든 게임 결과 화면의 재시작 버튼** — `GAME_RESULT` 에서 내 `star` 를 저장해 두고(2인 게임은 `winner`/`loser` 중 `userid` 가 나인 쪽, 청기백기는 최상위 `star`), 버튼을 누를 때 0 이면:
  1. `GAME_RESULT{replay:"Y"}` 를 **보내지 않고** star 부족 알림 팝업 표시
  2. 팝업의 창닫기를 누르면 평소 게임 종료처럼 로비로 이동 (1-3 경로)
- ⚠️ 서버의 재게임 대기는 10초라 팝업이 떠 있는 동안 `RETURN_TO_LOBBY` 가 올 수 있습니다. 팝업이 열려 있으면 바로 이동하지 말고 **창닫기를 누른 뒤** 로비로 이동해 주세요.
- 재시작 버튼을 안 누르고 나가는 경우는 팝업 없이 기존 흐름 그대로입니다.
- ⚠️ 2인 게임에서 상대의 star 가 없으면 내가 재게임을 골라도 상대가 나간 것과 같습니다 — 기존 "새 상대 기다리기" 그대로이고, 내 star 는 새 게임이 시작될 때 줄어듭니다.

---

## 1. star · 광고 보기 (2026-10-30)

### 1-1. 공통 타입 (`src/common/types.ts`)

- [ ] `MessageType.AD_VIEW_COMPLETE`, `MessageType.ADMIN_AD_LOG` 추가
- [ ] `EnterLobbyResultPayload` 에 `star?: number` 추가
- [ ] `AdViewCompleteResultPayload`, `AdminAdLogQuery`, `AdminAdLogResultPayload` 추가 (참고 A-2, A-3)

### 1-2. 로비 (`LobbyScene` / `LobbyConnection`)

- [ ] 상단에 **보유 star 수** 표시 — `ENTER_LOBBY` 응답의 `star` 로 초기화
- [ ] star 옆에 **'광고 보기' 버튼**
  1. 누르면 버튼을 잠그고 광고 재생
  2. 광고를 **끝까지 봤을 때만** `AD_VIEW_COMPLETE` 전송 (중간에 닫으면 안 보냄)
  3. 응답의 `star` 로 표시를 **덮어씀** (클라이언트에서 +1 계산하지 않기). `result:"Y"` 면 `+star_add` 연출
  4. `result:"N"` 이면 "잠시 후 다시 시도해 주세요" 안내 (error 1 = 10초 안에 다시 보냄, 2 = 서버 오류)
  5. 응답을 받으면 버튼 잠금 해제
- [ ] 광고 SDK 가 아직 없으면 개발용 "N초 대기 후 완료" 가짜 광고로 대체

### 1-3. 게임 종료 → 광고 → 로비 (각 게임 Scene 의 `GoToLobbyOnce()` 경로)

`RETURN_TO_LOBBY`, '로비로' 버튼, 재게임 `N` 등 게임이 끝나 로비로 돌아갈 때:

- [ ] ① 게임방 소켓을 **정상 나가기**로 먼저 끊기 — `room.leave(true)`
- [ ] ② 광고 표시
- [ ] ③ 광고가 끝나면(또는 닫으면) 로비로 이동해 평소처럼 `ENTER_LOBBY`

- ⚠️ 게임 **도중**에는 광고를 띄우지 마세요. 소켓이 끊기면 서버는 "나감"으로 보고 봇이 대신 둡니다.
- ⚠️ `room.leave(false)`·탭 이동처럼 비정상으로 끊기면 서버가 재접속을 기다려, 로비 입장 때 `REJOIN_GAME` 이 올 수 있습니다.
- 이 광고는 **star 를 주지 않습니다**(star 보상은 로비 '광고 보기' 버튼만). 보상을 주기로 바뀌면 서버에 알려 주세요.

### 1-4. 관리자 페이지 (`admin.html` / `src/admin.ts` / `WatcherConnection`)

- [ ] `ADMIN_AD_LOG` 송수신 추가 (`ADMIN_LOGIN` 성공 뒤에만 동작)
- [ ] **"광고 로그"** 섹션: 날짜 선택(기본 오늘) + 조회 버튼
  - 날짜는 보내기 전에 `YYYY-MM-DD` 실제 날짜인지 검사 — 틀리면 서버가 **응답하지 않음**
- [ ] 요약 4칸: 시청 수(`view_count`) · 유저 수(`user_count`) · 지급 star(`star_total`) · 거부 수(`reject_count`)
- [ ] 목록 표: 시각 · userid · 결과(Y 지급 / N 거부) · 지급 star · 보유 star · 채널
- [ ] `total > list.length` 면 "최근 500건만 표시" 안내
- [ ] 로그가 없는 날은 0 과 빈 목록이 옴 → "기록 없음" 표시

---

## 참고: 프로토콜

### A-1. `ENTER_LOBBY` 응답 (S→C) — `star` 추가

```json
{ "result": "Y", "userid": "…", "new": "N", "name": "오리", "avatar": "a_f_0", "star": 6 }
```

`star` = 보유 star. 신규 유저는 5, 기존 유저도 처음엔 5.

### A-1-1. `ERROR` — star 부족 (로비)

```json
{ "code": "NOT_ENOUGH_STAR", "message": "star 가 부족합니다. 광고를 보고 star 를 받아 주세요." }
```

### A-1-2. `GAME_RESULT` (S→C) — `star` 추가

`star` = 이번 게임 시작 비용까지 뺀 남은 star. 기존 필드는 그대로입니다.

```json
// 가위바위보·오델로·점핑·에어하키 — winner/loser 각각 (draw 라도 같은 모양)
{ "winner": { "userid": "…", "win_count": 2, "win_per": 60, "star": 3 },
  "loser":  { "userid": "…", "win_count": 1, "win_per": 40, "star": 0 } }

// 청기백기
{ "score": 15, "correct_count": 3, "win_per": 60, "star": 3 }
```

### A-2. `AD_VIEW_COMPLETE` (로비)

| 방향 | payload |
|---|---|
| C→S | `{}` |
| S→C 성공 | `{ "result": "Y", "star_add": 1, "star": 7 }` |
| S→C 실패 | `{ "result": "N", "error": 1, "star": 6 }` |

- 광고 1회 = star +1, 하루 횟수 제한 없음, **같은 유저 10초 간격**(error 1)
- `star` 는 성공·실패 모두 현재 보유량
- `ENTER_LOBBY` 성공 전에 보내면 응답 없음

### A-3. `ADMIN_AD_LOG` (관리자)

| 방향 | payload |
|---|---|
| C→S | `{ "date": "2026-10-30" }` (서버 기준 날짜, KST) |
| S→C | 아래 |

```json
{
  "date": "2026-10-30",
  "summary": { "view_count": 120, "user_count": 45, "star_total": 120, "reject_count": 3 },
  "list": [
    { "time": "15:03:05", "userid": "ocb_…", "result": "Y", "star_add": 1, "star": 7, "channel": "lobby_1" }
  ],
  "total": 123
}
```

- `list` 최신순 최대 500건, `summary`·`total` 은 그날 전체 기준
