// DB 에서 막 조회한 유저 정보 전용 타입 — 개인정보(phone)를 포함하므로 클라이언트에는 그대로 보내지
// 않는다(ToPublicUserInfo() 로 phone 을 뺀 UserInfo 로 변환). ⚠️ Redis 캐시(user:info:{userid})에는
// 이 타입이 아니라 phone 없는 UserInfo 그대로 저장한다 — CLAUDE.md "유저 정보 처리 단계" 1번: "phone 은
// 개인정보다. ... 좌석 예약·로그·Redis 공유 정보에 넣지 않는다"를 실제 코드에도 맞췄다(2026-10-01,
// 전엔 이 타입이 Redis 캐시에도 그대로 쓰여서 phone 이 캐시에 남아 있었다 — 사용자 지적으로 분리함).
// phone 은 통계 전용 정보라, 캐시 히트 시에는 phone 변경 여부를 확인하지 않는다(db/userRepository.ts
// GetOrCreateUser 참고) — 캐시가 만료돼 DB 를 다시 조회할 때만 비교/갱신된다.

import type { UserInfo } from "../common/types.js";

export interface DbUserInfo extends UserInfo {
    phone: string;
}

// 첫 접속 유저 등록에 필요한 값
export interface NewUserInput {
    userid: string;
    partner: string;
    mid: string;
    gender: string;
    phone: string;
}

export function ToPublicUserInfo(user: DbUserInfo): UserInfo {
    const { phone: _phone, ...public_info } = user;
    return public_info;
}

// 랭킹 조회(Phase 8) 내부 타입 — 일간/주간 어느 쪽인지는 db/queries/ranking.ts 가 테이블/날짜 조건을
// 고르는 데만 쓰는 내부 구현 디테일이라 common/types.ts(프로토콜 타입)가 아니라 여기 둔다. 클라이언트에
// 보내는 RANK_DAILY/RANK_WEEKLY 의 실제 payload 모양은 common/types.ts 의 RankDailyResultPayload 등 참고.
export type RankPeriod = "daily" | "weekly";

// 랭킹 목록 한 줄(DB 조회 결과). rank 는 동점자가 같은 순위를 받는 표준 방식(RANK() 윈도우 함수 —
// "내 점수보다 높은 사람 수 + 1" 과 같은 결과). LobbyManager 가 이걸 [name, score] 튜플로 변환해서 보낸다.
export interface RankEntry {
    rank: number;
    userid: string;
    name: string;
    score: number;
}
