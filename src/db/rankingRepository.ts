// 랭킹 조회 진입점. LobbyManager 는 이 모듈만 호출한다 (db/ 밖에서 db/queries 를 직접 부르지 않는다 —
// CLAUDE.md 코딩 컨벤션). 순위/점수 계산 자체는 db/rankingZSet.ts 의 Redis Sorted Set 이 O(log N)으로
// 처리한다(2026-10-01, 사용자 요청으로 MySQL RANK() 윈도우 함수 방식에서 전환). 여기서는 그 결과(top
// 100의 userid+score)에 이름을 붙이고, 이름 조인(MySQL 쿼리) 비용만 짧게 캐시한다.
//
// RANK_DAILY/RANK_WEEKLY 의 날짜 표시(date/term)는 여기서 "YYYY.MM.DD" 로 포맷해서 돌려준다 — 통신규약
// 시트의 payload 예시(`date:2026.10.01`, `term:{start:2026.09.28, end:2026.10.04}`)가 이 형식이다.

import type { GameType } from "../common/channelNames.js";
import * as constants from "../common/constants.js";
import * as connection from "./connection.js";
import * as ranking from "./queries/ranking.js";
import * as rankingZSet from "./rankingZSet.js";
import * as redis from "./redis.js";
import type { RankEntry, RankPeriod } from "./types.js";

// 게임별로 캐시를 나눈다 — 안 그러면 다른 게임의 랭킹 목록이 섞여 나간다.
function RankListCacheKey(game: GameType, period: RankPeriod): string {
    return `rank_list:${game}:${period}`;
}

// top 100 (userid, score) 에 이름을 붙인 최종 목록 — 이름 조인(MySQL IN 쿼리)만 짧게 캐시한다.
// 순위 번호는 배열 순서(점수 내림차순) 그대로 매긴다 — 이 번호 자체는 클라이언트에 안 나간다
// (LobbyManager 가 [name, score] 튜플로만 변환해서 보낸다, common/types.ts RankListEntry 참고).
async function GetCachedRankList(game: GameType, period: RankPeriod): Promise<RankEntry[]> {
    const cached = await redis.GetJson<RankEntry[]>(RankListCacheKey(game, period));
    if (cached) return cached;

    const pool = connection.GetDbPool();
    const top = await rankingZSet.GetTopRankEntries(pool, game, period);
    const names = await ranking.GetNamesByUserids(pool, top.map((entry) => entry.userid));
    const list: RankEntry[] = top.map((entry, index) => ({
        rank: index + 1,
        userid: entry.userid,
        name: names.get(entry.userid) ?? "",
        score: entry.score,
    }));

    await redis.SetJson(RankListCacheKey(game, period), list,constants.RANK_LIST_CACHE_TTL_SEC);
    return list;
}

function FormatDateDot(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}.${month}.${day}`;
}

// 이번 주 월요일 Date 객체 (DB 의 rps_rank_weekly.date_start 계산 — DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) — 과 같은 기준)
function GetThisWeekMonday(): Date {
    const now = new Date();
    const day = now.getDay(); // 0=일, 1=월, ..., 6=토
    const diff_from_monday = day === 0 ? 6 : day - 1;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff_from_monday);
    return monday;
}

export interface RankDailyInfo {
    date: string;
    rank_list: RankEntry[];
    my_rank: number;
    my_score: number;
}

export interface RankWeeklyInfo {
    term: { start: string; end: string };
    rank_list: RankEntry[];
    my_rank: number;
    my_score: number;
}

export async function FetchRankDaily(game: GameType, userid: string): Promise<RankDailyInfo> {
    const [rank_list, my] = await Promise.all([
        GetCachedRankList(game, "daily"),
        rankingZSet.GetMyRankFromZSet(connection.GetDbPool(), game, "daily", userid),
    ]);
    return { date: FormatDateDot(new Date()), rank_list, my_rank: my.rank, my_score: my.score };
}

export async function FetchRankWeekly(game: GameType, userid: string): Promise<RankWeeklyInfo> {
    const [rank_list, my] = await Promise.all([
        GetCachedRankList(game, "weekly"),
        rankingZSet.GetMyRankFromZSet(connection.GetDbPool(), game, "weekly", userid),
    ]);
    const monday = GetThisWeekMonday();
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return {
        term: { start: FormatDateDot(monday), end: FormatDateDot(sunday) },
        rank_list,
        my_rank: my.rank,
        my_score: my.score,
    };
}
