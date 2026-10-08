// 가위바위보(RPS) 한 판(2선승제)이 끝났을 때 결과를 DB/Redis 에 반영하는 진입점.
// `gameResultRepository.ts` 에서 이름을 바꿨다(2026-10-02, "게임별 분리 구조" — CLAUDE.md 참고).
// RpsGameRoom 은 db/queries 를 직접 부르지 않고 이 모듈만 호출한다 (CLAUDE.md 코딩 컨벤션).
// 다른 게임(예: 오델로)을 추가하면 이 파일과 같은 패턴으로 othelloGameResultRepository.ts 를
// 따로 둔다(통계 테이블도 게임별로 나뉘어 있어 재사용할 "범용" 함수는 이제 없다 —
// queries/rpsGameLog.ts 참고).

import type { Pool } from "mysql2/promise";
import * as rpsConstants from "../game/rps/rpsConstants.js";
import type { UserInfo } from "../common/types.js";
import * as connection from "./connection.js";
import * as rpsGameLog from "./queries/rpsGameLog.js";
import type { RpsGameLogEntry, RpsPlayRecord } from "./queries/rpsGameLog.js";
import * as userInfo from "./queries/userInfo.js";
import * as rankingZSet from "./rankingZSet.js";
import * as userCache from "./userCache.js";
import * as types from "./types.js";

export type { RpsPlayRecord };

export interface SaveRpsGameResultInput {
    winner_userid: string;
    loser_userid: string;
    loser_win_count: number; // 0 이면 2:0 승리, 1 이면 2:1 승리
    start_time: Date;
    end_time: Date;
    plays: RpsPlayRecord[];
    win_is_bot: boolean;
    lose_is_bot: boolean;
}

export interface SaveRpsGameResultResult {
    winner: UserInfo;
    loser: UserInfo;
}

// rps_user_play_info 갱신 + rps_rank_daily/rps_rank_weekly 점수 누적 + rps_game_log 저장 + Redis 캐시 write-through 를
// 한 번에 처리하고, 갱신된 두 유저의 최신 정보를 돌려준다 (RpsGameRoom 메모리 갱신용).
export async function SaveRpsGameResult(input: SaveRpsGameResultInput): Promise<SaveRpsGameResultResult> {
    const pool = connection.GetDbPool();
    const score = input.loser_win_count === 0 ? rpsConstants.RPS_SCORE_WIN_STRAIGHT : rpsConstants.RPS_SCORE_WIN_NORMAL;

    await rpsGameLog.UpdateRpsPlayInfoAfterGame(pool, input.winner_userid, input.loser_userid, score, rpsConstants.RPS_SCORE_LOSE);
    // rps_rank_daily/rps_rank_weekly(MySQL, 원본)와 랭킹 Sorted Set(Redis, 조회용 인덱스)을 함께 갱신한다 —
    // 2026-10-01 Redis Sorted Set 전환(사용자 요청) 이후의 "이중 쓰기" 지점. 패자도 0점으로 ZINCRBY 해서
    // "오늘(이번 주) 참여했다"는 멤버 자체는 남겨 둔다(AddRpsRankScore 가 MySQL 에 0점 행을 만들어 두는 것과 동일한 이유).
    await Promise.all([
        rpsGameLog.AddRpsRankScore(pool, input.winner_userid, score),
        rpsGameLog.AddRpsRankScore(pool, input.loser_userid, rpsConstants.RPS_SCORE_LOSE),
        rankingZSet.IncrementRankScore("rps", "daily", input.winner_userid, score),
        rankingZSet.IncrementRankScore("rps", "daily", input.loser_userid, rpsConstants.RPS_SCORE_LOSE),
        rankingZSet.IncrementRankScore("rps", "weekly", input.winner_userid, score),
        rankingZSet.IncrementRankScore("rps", "weekly", input.loser_userid, rpsConstants.RPS_SCORE_LOSE),
    ]);

    const game_log: RpsGameLogEntry = {
        start_time: input.start_time,
        end_time: input.end_time,
        win: input.winner_userid,
        lose: input.loser_userid,
        vs: input.loser_win_count === 0 ? "2:0" : "2:1",
        score,
        plays: input.plays,
        win_is_bot: input.win_is_bot,
        lose_is_bot: input.lose_is_bot,
    };
    await rpsGameLog.InsertRpsGameLog(pool, game_log);

    const [winner, loser] = await Promise.all([
        RefreshUserCache(pool, input.winner_userid),
        RefreshUserCache(pool, input.loser_userid),
    ]);
    return { winner, loser };
}

// DB 에서 최신 값을 읽어 Redis 캐시에 다시 쓴다 (write-through) — 로비 복귀/재접속 시 DB 재조회 부하를 줄인다
async function RefreshUserCache(pool: Pool, userid: string): Promise<UserInfo> {
    const fresh = await userInfo.FetchUserInfo(pool, userid);
    if (!fresh) {
        // 정상 흐름이면 없을 수 없다 (게임 중이던 유저는 이미 DB 에 등록돼 있음) — 방어적으로 캐시 값이라도 반환
        const cached = await userCache.GetUserCache(userid);
        if (cached) return cached;
        throw new Error(`게임 결과 반영 중 유저 정보를 찾지 못했습니다: userid=${userid}`);
    }
    const public_info = types.ToPublicUserInfo(fresh);
    await userCache.SaveUserCache(public_info);
    return public_info;
}
