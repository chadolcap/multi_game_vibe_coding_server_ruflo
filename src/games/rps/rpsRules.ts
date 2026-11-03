// 가위바위보(RPS) 의 순수 규칙 — 승패 판정과 승률 계산.
// RpsGameRoom 에서 분리해 둔 이유: RpsGameRoom 은 db/rpsGameResultRepository, db/userCache 등을 값으로
// import 해서, 이 두 함수만 쓰려 해도 DB 연결 모듈까지 전부 끌고 온다. 외부 의존이 없는 규칙만 여기 모아
// 두면 단위 테스트(rpsRules.test.ts)에서 Redis/MySQL 없이 바로 검증할 수 있다.

import type { RpsChoice } from "./rpsTypes.js";

// total_win_count / total_game_count 기준 승률 (0~100 정수). 한 판도 안 한 유저는 0.
// 숫자 두 개를 직접 받는 형태라, FinishGame 에서 "이번 판 결과를 더한 예상값"도 그대로 계산할 수 있다.
export function ComputeWinPer(total_win_count: number, total_game_count: number): number {
    if (total_game_count === 0) return 0;
    return Math.round((total_win_count / total_game_count) * 100);
}

// a 가 b 를 이기면 true (가위>보, 바위>가위, 보>바위)
export const BEATS: Record<RpsChoice, RpsChoice> = { 가위: "보", 바위: "가위", 보: "바위" };

// a 가 이기면 1, b 가 이기면 -1, 무승부면 0
export function JudgeChoice(a: RpsChoice, b: RpsChoice): number {
    if (a === b) return 0;
    return BEATS[a] === b ? 1 : -1;
}
