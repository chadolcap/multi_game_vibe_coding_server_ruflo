// 점핑 한 게임이 끝났을 때 결과를 반영하는 쿼리 모음 (2026-10-14 추가).
// stepping_user_play_info 갱신, stepping_rank_daily/stepping_rank_weekly 점수 누적, stepping_game_log
// 저장을 담당한다. queries/othelloGameLog.ts 를 그대로 복제했고, 다른 점은 로그의 map 컬럼뿐이다:
//   1) 점수 규칙 — 랭킹 점수는 승리 시 고정 20점(STEPPING_SCORE_WIN), 패자·무승부 0점 (오델로 관례)
//   2) 무승부 — 게임 점수와 도착 시각까지 같으면 무승부로 끝난다(steppingRules.DecideWinner).
//      그래서 승수를 안 늘리는 갱신 경로가 따로 필요하다.

import type { Pool } from "mysql2/promise";
import * as steppingGameLogSchema from "../steppingGameLogSchema.js";
import type { SteppingPlayRecord } from "../../game/stepping/steppingTypes.js";

// 승자용 갱신 — 게임 수와 승수를 모두 +1 한다.
// today_date 가 오늘과 다르면(자정이 지난 뒤 첫 게임) today_* 를 1 로 리셋하고 today_date 를 오늘로
// 갱신한다 — 실제 롤오버가 일어나는 지점이다. 조회 시점(queries/userPlayInfo.ts)에서도 보정하므로
// 게임을 안 하는 유저의 today_date 가 영영 안 바뀌어도 문제없다 ("지연 초기화", Phase 8 과 같은 규칙).
const UPDATE_WINNER_SQL = `
    UPDATE stepping_user_play_info SET
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
    UPDATE stepping_user_play_info SET
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
export async function UpdateSteppingPlayInfoAfterGame(
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

// stepping_rank_daily(오늘, KST 기준 CURDATE())/stepping_rank_weekly(이번 주 월요일) 에 점수를 누적한다.
// score:0 이어도(패자·무승부) 행을 만들어 둔다 — 본인 순위 조회 시 항상 행이 있도록.
export async function AddSteppingRankScore(pool: Pool, userid: string, score: number): Promise<void> {
    await pool.query(
        `INSERT INTO stepping_rank_daily (date_game, userid, score) VALUES (CURDATE(), ?, ?)
         ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
        [userid, score]
    );
    await pool.query(
        `INSERT INTO stepping_rank_weekly (date_start, userid, score)
         VALUES (DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), ?, ?)
         ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
        [userid, score]
    );
}

export interface SteppingGameLogEntry {
    start_time: Date;
    end_time: Date;
    map: number; // 맵 번호 (1~3)
    win: string; // 승자 userid (is_draw 면 player1 — steppingGameLogSchema.ts 주석 참고)
    lose: string; // 패자 userid (is_draw 면 player2)
    vs: string; // 승자 기준 게임 점수 "45:30" (is_draw 면 "40:40")
    score: number; // 승자가 획득한 랭킹 점수 (STEPPING_SCORE_WIN, 무승부면 0)
    plays: SteppingPlayRecord[]; // 점프 기록 [{ userid, count, x, y, save }, ...]
    is_draw: boolean;
    win_is_bot: boolean;
    lose_is_bot: boolean;
}

// stepping_game_log_YYYY_MM (end_time 이 속한 달 기준) 에 한 게임 로그를 남긴다.
export async function InsertSteppingGameLog(pool: Pool, entry: SteppingGameLogEntry): Promise<void> {
    const table_name = await steppingGameLogSchema.EnsureSteppingGameLogTable(pool, entry.end_time);
    await pool.query(
        `INSERT INTO \`${table_name}\`
            (start_time, end_time, map, win, lose, vs, score, plays, is_draw, win_is_bot, lose_is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entry.start_time,
            entry.end_time,
            entry.map,
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
