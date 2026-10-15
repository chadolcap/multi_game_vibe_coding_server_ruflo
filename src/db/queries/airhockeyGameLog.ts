// 에어하키 한 게임이 끝났을 때 결과를 반영하는 쿼리 모음 (2026-10-15 추가).
// airhockey_user_play_info 갱신, airhockey_rank_daily/airhockey_rank_weekly 점수 누적, airhockey_game_log
// 저장을 담당한다. queries/steppingGameLog.ts 를 그대로 복제했고, 다른 점은 로그에 map 컬럼이 없는 것뿐이다:
//   1) 점수 규칙 — 랭킹 점수는 넣은 골 수 × 5점(AIRHOCKEY_SCORE_PER_GOAL). **패자도** 자기 골만큼 받는다.
//   2) 무승부 — 둘 다 나갔는데 골 수가 같을 때만 생긴다(airhockeyRules.DecideWinner).
//      그래서 승수를 안 늘리는 갱신 경로가 따로 필요하다.

import type { Pool } from "mysql2/promise";
import * as airhockeyGameLogSchema from "../airhockeyGameLogSchema.js";
import type { AirhockeyPlayRecord } from "../../game/airhockey/airhockeyTypes.js";

// 승자용 갱신 — 게임 수와 승수를 모두 +1 한다.
// today_date 가 오늘과 다르면(자정이 지난 뒤 첫 게임) today_* 를 1 로 리셋하고 today_date 를 오늘로
// 갱신한다 — 실제 롤오버가 일어나는 지점이다 ("지연 초기화", steppingGameLog.ts 와 같은 규칙).
const UPDATE_WINNER_SQL = `
    UPDATE airhockey_user_play_info SET
        total_game_count = total_game_count + 1,
        total_win_count  = total_win_count + 1,
        total_score      = total_score + ?,
        today_game_count = IF(today_date = CURDATE(), today_game_count + 1, 1),
        today_win_count  = IF(today_date = CURDATE(), today_win_count + 1, 1),
        today_score      = IF(today_date = CURDATE(), today_score + ?, ?),
        today_date = CURDATE()
     WHERE userid = ?
`;

// 패자/무승부용 갱신 — 게임 수만 +1 하고 승수는 그대로 둔다.
// ⚠️ today_win_count 줄을 지우면 안 된다. 값을 더하지는 않지만 "자정이 지났으면 0 으로 리셋"하는
//    역할을 이 IF 가 하고 있다 (today_date 가 아래에서 오늘로 갱신되기 때문).
const UPDATE_NON_WINNER_SQL = `
    UPDATE airhockey_user_play_info SET
        total_game_count = total_game_count + 1,
        total_score      = total_score + ?,
        today_game_count = IF(today_date = CURDATE(), today_game_count + 1, 1),
        today_win_count  = IF(today_date = CURDATE(), today_win_count, 0),
        today_score      = IF(today_date = CURDATE(), today_score + ?, ?),
        today_date = CURDATE()
     WHERE userid = ?
`;

// 두 유저의 통계를 한 트랜잭션으로 갱신한다.
// is_draw 면 양쪽 모두 "승수 없는" 갱신을 받는다(둘 다 패자 경로).
export async function UpdateAirhockeyPlayInfoAfterGame(
    pool: Pool,
    winner_userid: string,
    loser_userid: string,
    winner_score: number,
    loser_score: number,
    is_draw: boolean
): Promise<void> {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(is_draw ? UPDATE_NON_WINNER_SQL : UPDATE_WINNER_SQL, [
            winner_score,
            winner_score,
            winner_score,
            winner_userid,
        ]);
        await connection.query(UPDATE_NON_WINNER_SQL, [loser_score, loser_score, loser_score, loser_userid]);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// airhockey_rank_daily(오늘, KST 기준 CURDATE())/airhockey_rank_weekly(이번 주 월요일) 에 점수를 누적한다.
// score:0 이어도(골을 못 넣은 패자) 행을 만들어 둔다 — 본인 순위 조회 시 항상 행이 있도록.
export async function AddAirhockeyRankScore(pool: Pool, userid: string, score: number): Promise<void> {
    await pool.query(
        `INSERT INTO airhockey_rank_daily (date_game, userid, score) VALUES (CURDATE(), ?, ?)
         ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
        [userid, score]
    );
    await pool.query(
        `INSERT INTO airhockey_rank_weekly (date_start, userid, score)
         VALUES (DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), ?, ?)
         ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
        [userid, score]
    );
}

export interface AirhockeyGameLogEntry {
    start_time: Date;
    end_time: Date;
    win: string; // 승자 userid (is_draw 면 player1 — airhockeyGameLogSchema.ts 주석 참고)
    lose: string; // 패자 userid (is_draw 면 player2)
    vs: string; // 승자 기준 골 수 "3:1" (is_draw 면 "1:1")
    score: number; // 승자가 획득한 랭킹 점수 (골 수 × 5)
    plays: AirhockeyPlayRecord[]; // 골 기록 [{ userid, sec }, ...]
    is_draw: boolean;
    win_is_bot: boolean;
    lose_is_bot: boolean;
}

// airhockey_game_log_YYYY_MM (end_time 이 속한 달 기준) 에 한 게임 로그를 남긴다.
export async function InsertAirhockeyGameLog(pool: Pool, entry: AirhockeyGameLogEntry): Promise<void> {
    const table_name = await airhockeyGameLogSchema.EnsureAirhockeyGameLogTable(pool, entry.end_time);
    await pool.query(
        `INSERT INTO \`${table_name}\`
            (start_time, end_time, win, lose, vs, score, plays, is_draw, win_is_bot, lose_is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entry.start_time,
            entry.end_time,
            entry.win,
            entry.lose,
            entry.vs,
            entry.score,
            JSON.stringify(entry.plays),
            entry.is_draw ? 1 : 0,
            entry.win_is_bot ? 1 : 0,
            entry.lose_is_bot ? 1 : 0,
        ]
    );
}
