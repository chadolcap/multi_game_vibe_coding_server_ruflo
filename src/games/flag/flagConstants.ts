// 청기백기(flag, 1인) 전용 규칙 상수 (2026-10-22 추가). 플랫폼 공용 상수는 common/constants.ts 에 있다.
// 출처 표기: "시트" = 멀티게임_바이브.xlsx 의 flag 시트에 명시된 값,
//           "사용자 결정" = 2026-10-22 대화에서 정한 규칙,
//           "임시" = 시트/규칙에 값이 없어 서버가 정한 연출 시간 — 클라이언트와 맞춰 바꿀 수 있다.

// 깃발 상태 값 (시트: "깃발 상태 값 -1:내려, 0: 고정, 1: 올려"). b = 청기(오리 오른손), w = 백기(오리 왼손) — 2026-10-22 사용자 변경, 오리 기준.
export const FLAG_DOWN = -1;
export const FLAG_KEEP = 0;
export const FLAG_UP = 1;

// 한 게임의 문제 수 (시트: "게임 종료 조건 : 5문제 제시")
export const FLAG_QUEST_COUNT = 5;
// 정답 하나당 점수 (시트: "1판에 5점"). 게임 점수 = 맞춘 개수 × 5 = 랭킹 점수.
export const FLAG_SCORE_PER_CORRECT = 5;

// 문제가 나온 뒤 답할 수 있는 시간 (사용자: "문제가 제시되면 2초 안에")
// 2026-10-23 사용자 변경: 2초 → 5초. QUEST_SHOW.time 으로 클라이언트에도 그대로 간다.
export const FLAG_ANSWER_TIME_SEC = 5;
// 한 문제에 깃발 명령이 두 개(청기·백기 모두) 나올 확률. 나머지는 한쪽만 (사용자 결정: "한쪽 또는 양쪽").
// ⚠️ 임시 값 — 난이도에 맞춰 바꿔도 된다.
// ⚠️ 2026-10-23 사용자 변경(동작 이미지 9장)으로 이 확률은 안 쓴다 — 정답 포즈 9개(양손 × 올림/내림/정지)를
//    균등하게 고르고, 정지인 손의 문구만 FLAG_KEEP_SAY_CODES 에서 고른다(flagRules.CreateQuest / CreateSay).
//    양손 정지 함정 문제도 1/9 확률로 나온다.
// 정지(0)인 손을 말하는 방법 — "올리지마" / "내리지마" / 말하지 않음 (사용자: "3종류의 문제 유형에서 표현이 가능").
// 양손 모두 "말하지 않음"이면 문제가 비므로 CreateSay 가 다시 고른다.
export const FLAG_KEEP_SAY_CODES = ["no_up", "no_down", ""] as const;

// GAME_START 뒤 첫 ONE_START 까지 (임시 — 시작 연출)
export const FLAG_GAME_START_DELAY_SEC = 2;
// ONE_START 뒤 QUEST_SHOW 까지 (임시 — "문제!" 준비 연출)
export const FLAG_QUEST_SHOW_DELAY_SEC = 1;
// ONE_RESULT 뒤 다음 ONE_START 까지 (임시 — 정답/오답 연출)
export const FLAG_ONE_RESULT_DELAY_SEC = 2;
// 마지막 문제의 ONE_RESULT 뒤 GAME_RESULT 까지 (시트: "마지막 문제 출제 후 3초 경과하고 전달")
export const FLAG_RESULT_DELAY_SEC = 3;
// GAME_RESULT 후 재게임/나가기 선택 제한 시간. 시트("10초 내에 재시작,/로비나가기 선택").
export const FLAG_REMATCH_CHOICE_TIMEOUT_SEC = 10;
