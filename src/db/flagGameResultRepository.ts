// 청기백기(1인) 한 게임이 끝났을 때 결과를 DB/Redis 에 반영하는 진입점 (2026-10-22 추가).
// FlagGameRoom 은 db/queries 를 직접 부르지 않고 이 모듈만 호출한다 (CLAUDE.md 코딩 컨벤션).
// steppingGameResultRepository.ts 를 바탕으로 했다 — 유저가 한 명뿐이고, 랭킹 점수 = 게임 점수(맞춘 수 × 5)다.

import type { Pool } from "mysql2/promise";
import type { FlagPlayRecord } from "../game/flag/flagTypes.js";
import type { UserInfo } from "../common/types.js";
import * as connection from "./connection.js";
import * as flagGameLog from "./queries/flagGameLog.js";
import * as userInfo from "./queries/userInfo.js";
import * as playInfoRepository from "./playInfoRepository.js";
import * as rankingZSet from "./rankingZSet.js";
import * as userCache from "./userCache.js";
import * as types from "./types.js";

export interface SaveFlagGameResultInput {
    userid: string;
    score: number; // 맞춘 수 × 5
    correct_count: number;
    quest_count: number; // 판정까지 간 문제 수
    start_time: Date;
    end_time: Date;
    plays: FlagPlayRecord[];
    is_quit: boolean; // 게임 중 나가서 그 시점 점수로 끝났는지
}

// flag_user_play_info 갱신 + flag_rank_daily/weekly 점수 누적 + flag_game_log 저장 + Redis 캐시 write-through 를
// 한 번에 처리하고, 갱신된 유저의 최신 정보를 돌려준다 (FlagGameRoom 메모리 갱신용 — 재게임 때 정답률 표시).
export async function SaveFlagGameResult(input: SaveFlagGameResultInput): Promise<UserInfo> {
    const pool = connection.GetDbPool();

    await flagGameLog.UpdateFlagPlayInfoAfterGame(pool, input.userid, input.correct_count, input.score);

    // MySQL(원본)과 랭킹 Sorted Set(Redis, 조회용 인덱스) 이중 쓰기 — 다른 게임과 같은 지점.
    // 0점이어도 ZINCRBY 해서 "오늘(이번 주) 참여했다"는 멤버 자체는 남겨 둔다.
    await Promise.all([
        flagGameLog.AddFlagRankScore(pool, input.userid, input.score),
        rankingZSet.IncrementRankScore("flag", "daily", input.userid, input.score),
        rankingZSet.IncrementRankScore("flag", "weekly", input.userid, input.score),
    ]);

    await flagGameLog.InsertFlagGameLog(pool, {
        start_time: input.start_time,
        end_time: input.end_time,
        userid: input.userid,
        score: input.score,
        correct_count: input.correct_count,
        quest_count: input.quest_count,
        plays: input.plays,
        is_quit: input.is_quit,
    });

    // 청기백기 통계 캐시는 방금 값이 바뀌었으니 버린다 (다음 조회가 DB 를 읽어 보정까지 다시 타게)
    await playInfoRepository.InvalidatePlayInfoCache(input.userid, "flag");

    return await RefreshUserCache(pool, input.userid);
}

// DB 에서 최신 값을 읽어 Redis 캐시에 다시 쓴다 (write-through).
// ⚠️ FetchUserInfo 는 **RPS 통계**를 담아 오므로(queries/userInfo.ts 의 JOIN), 신원 캐시에는 그대로 저장하고
//    돌려주는 값의 통계만 청기백기 것으로 교체한다 (steppingGameResultRepository.ts 와 같은 이유).
async function RefreshUserCache(pool: Pool, userid: string): Promise<UserInfo> {
    const fresh = await userInfo.FetchUserInfo(pool, userid);
    if (!fresh) {
        const cached = await userCache.GetUserCache(userid);
        if (cached) return await playInfoRepository.WithGamePlayInfo(cached, "flag");
        throw new Error(`게임 결과 반영 중 유저 정보를 찾지 못했습니다: userid=${userid}`);
    }
    const public_info = types.ToPublicUserInfo(fresh);
    await userCache.SaveUserCache(public_info);
    return await playInfoRepository.WithGamePlayInfo(public_info, "flag");
}
