// 오델로 한 게임이 끝났을 때 결과를 DB/Redis 에 반영하는 진입점 (2026-10-07 추가).
// OthelloGameRoom 은 db/queries 를 직접 부르지 않고 이 모듈만 호출한다 (CLAUDE.md 코딩 컨벤션).
// rpsGameResultRepository.ts 와 같은 패턴이고, 다른 점은 두 가지다:
//   1) 점수 — 승리 20점 고정(OTHELLO_SCORE_WIN), 패자·무승부 0점
//   2) 무승부 — is_draw 면 승수를 아무도 못 받고 점수도 0점이다

import type { Pool } from "mysql2/promise";
import * as othelloConstants from "../game/othello/othelloConstants.js";
import type { OthelloPlayRecord } from "../game/othello/othelloTypes.js";
import type { UserInfo } from "../common/types.js";
import * as connection from "./connection.js";
import * as othelloGameLog from "./queries/othelloGameLog.js";
import type { OthelloGameLogEntry } from "./queries/othelloGameLog.js";
import * as userInfo from "./queries/userInfo.js";
import * as playInfoRepository from "./playInfoRepository.js";
import * as rankingZSet from "./rankingZSet.js";
import * as userCache from "./userCache.js";
import * as types from "./types.js";

export interface SaveOthelloGameResultInput {
    winner_userid: string; // is_draw 면 player1 (othelloGameLogSchema.ts 주석 참고)
    loser_userid: string; // is_draw 면 player2
    winner_stones: number; // 승자(또는 player1)의 최종 돌 개수
    loser_stones: number; // 패자(또는 player2)의 최종 돌 개수
    is_draw: boolean;
    start_time: Date;
    end_time: Date;
    plays: OthelloPlayRecord[];
    win_is_bot: boolean;
    lose_is_bot: boolean;
}

export interface SaveOthelloGameResultResult {
    winner: UserInfo;
    loser: UserInfo;
}

// othello_user_play_info 갱신 + othello_rank_daily/weekly 점수 누적 + othello_game_log 저장 +
// Redis 캐시 write-through 를 한 번에 처리하고, 갱신된 두 유저의 최신 정보를 돌려준다
// (OthelloGameRoom 메모리 갱신용).
export async function SaveOthelloGameResult(input: SaveOthelloGameResultInput): Promise<SaveOthelloGameResultResult> {
    const pool = connection.GetDbPool();
    const winner_score = input.is_draw ? othelloConstants.OTHELLO_SCORE_DRAW : othelloConstants.OTHELLO_SCORE_WIN;
    const loser_score = input.is_draw ? othelloConstants.OTHELLO_SCORE_DRAW : othelloConstants.OTHELLO_SCORE_LOSE;

    await othelloGameLog.UpdateOthelloPlayInfoAfterGame(
        pool,
        input.winner_userid,
        input.loser_userid,
        winner_score,
        loser_score,
        input.is_draw
    );

    // othello_rank_daily/weekly(MySQL, 원본)와 랭킹 Sorted Set(Redis, 조회용 인덱스)을 함께 갱신한다 —
    // RPS 와 같은 "이중 쓰기" 지점. 점수가 0 이어도 ZINCRBY 해서 "오늘(이번 주) 참여했다"는 멤버 자체는
    // 남겨 둔다(AddOthelloRankScore 가 MySQL 에 0점 행을 만들어 두는 것과 같은 이유).
    await Promise.all([
        othelloGameLog.AddOthelloRankScore(pool, input.winner_userid, winner_score),
        othelloGameLog.AddOthelloRankScore(pool, input.loser_userid, loser_score),
        rankingZSet.IncrementRankScore("othello", "daily", input.winner_userid, winner_score),
        rankingZSet.IncrementRankScore("othello", "daily", input.loser_userid, loser_score),
        rankingZSet.IncrementRankScore("othello", "weekly", input.winner_userid, winner_score),
        rankingZSet.IncrementRankScore("othello", "weekly", input.loser_userid, loser_score),
    ]);

    const game_log: OthelloGameLogEntry = {
        start_time: input.start_time,
        end_time: input.end_time,
        win: input.winner_userid,
        lose: input.loser_userid,
        vs: `${input.winner_stones}:${input.loser_stones}`,
        score: winner_score,
        plays: input.plays,
        is_draw: input.is_draw,
        win_is_bot: input.win_is_bot,
        lose_is_bot: input.lose_is_bot,
    };
    await othelloGameLog.InsertOthelloGameLog(pool, game_log);

    // 오델로 통계 캐시는 방금 값이 바뀌었으니 버린다 (다음 조회가 DB 를 읽어 보정까지 다시 타게)
    await Promise.all([
        playInfoRepository.InvalidatePlayInfoCache(input.winner_userid, "othello"),
        playInfoRepository.InvalidatePlayInfoCache(input.loser_userid, "othello"),
    ]);

    const [winner, loser] = await Promise.all([
        RefreshUserCache(pool, input.winner_userid, "othello"),
        RefreshUserCache(pool, input.loser_userid, "othello"),
    ]);
    return { winner, loser };
}

// DB 에서 최신 값을 읽어 Redis 캐시에 다시 쓴다 (write-through).
// ⚠️ FetchUserInfo 는 **RPS 통계**를 담아 오므로(queries/userInfo.ts 의 JOIN), 신원 캐시
//    (user:info:{userid})에는 그대로 저장하고, 돌려주는 값의 통계만 이 게임 것으로 교체한다 —
//    게임방 메모리(this.players)가 오델로 승률을 보여줘야 하기 때문이다.
async function RefreshUserCache(pool: Pool, userid: string, game: "othello"): Promise<UserInfo> {
    const fresh = await userInfo.FetchUserInfo(pool, userid);
    if (!fresh) {
        // 정상 흐름이면 없을 수 없다 (게임 중이던 유저는 이미 DB 에 등록돼 있음) — 방어적으로 캐시 값이라도 반환
        const cached = await userCache.GetUserCache(userid);
        if (cached) return await playInfoRepository.WithGamePlayInfo(cached, game);
        throw new Error(`게임 결과 반영 중 유저 정보를 찾지 못했습니다: userid=${userid}`);
    }
    const public_info = types.ToPublicUserInfo(fresh);
    await userCache.SaveUserCache(public_info);
    return await playInfoRepository.WithGamePlayInfo(public_info, game);
}
