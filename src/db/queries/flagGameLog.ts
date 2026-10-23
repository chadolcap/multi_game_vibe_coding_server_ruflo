// 청기백기(1인) 한 게임이 끝났을 때 결과를 반영하는 쿼리 모음 (2026-10-22 추가).
// flag_user_play_info 갱신, flag_rank_daily/flag_rank_weekly 점수 누적, flag_game_log 저장을 담당한다.
// queries/steppingGameLog.ts 를 바탕으로 했고, 다른 점:
//   1) 유저가 한 명뿐이다 — 승자/패자 경로가 없다
//   2) total_win_count/today_win_count 에 **맞춘 문제 수**를 더한다(정답률 계산용, flagRules.ComputeWinPer)

import type { Pool } from "mysql2/promise";
import * as flagGameLogSchema from "../flagGameLogSchema.js";
import type { FlagPlayRecord } from "../../game/flag/flagTypes.js";

// today_date 가 오늘과 다르면(자정이 지난 뒤 첫 게임) today_* 를 이번 값으로 리셋한다 — 다른 게임과 같은
// "지연 초기화" 규칙(queries/steppingGameLog.ts 주석 참고).
const UPDATE_PLAY_INFO_SQL = `
    UPDATE flag_user_play_info SET
        total_game_count = total_game_count + 1,
        total_win_count  = total_win_count + ?,
        total_score      = total_score + ?,
        today_game_count = IF(today_date = CURDATE(), today_game_count + 1, 1),
        today_win_count  = IF(today_date = CURDATE(), today_win_count + ?, ?),
        today_score      = IF(today_date = CURDATE(), today_score + ?, ?),
        today_date = CURDATE()
     WHERE userid = ?
`;

export async function UpdateFlagPlayInfoAfterGame(pool: Pool, userid: string, correct_count: number, score: number): Promise<void> {
    await pool.query(UPDATE_PLAY_INFO_SQL, [correct_count, score, correct_count, correct_count, score, score, userid]);
}

// flag_rank_daily(오늘)/flag_rank_weekly(이번 주 월요일) 에 점수를 누적한다.
// score:0 이어도 행을 만들어 둔다 — 본인 순위 조회 시 항상 행이 있도록 (다른 게임과 같은 규칙).
export async function AddFlagRankScore(pool: Pool, userid: string, score: number): Promise<void> {
    await pool.query(
        `INSERT INTO flag_rank_daily (date_game, userid, score) VALUES (CURDATE(), ?, ?)
         ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
        [userid, score]
    );
    await pool.query(
        `INSERT INTO flag_rank_weekly (date_start, userid, score)
         VALUES (DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), ?, ?)
         ON DUPLICATE KEY UPDATE score = score + VALUES(score)`,
        [userid, score]
    );
}

export interface FlagGameLogEntry {
    start_time: Date;
    end_time: Date;
    userid: string;
    score: number; // 게임 점수 = 랭킹 점수 (맞춘 수 × 5)
    correct_count: number; // 맞춘 문제 수
    quest_count: number; // 판정까지 간 문제 수 (중도 퇴장이면 5 미만)
    plays: FlagPlayRecord[]; // [{ quest, answer, result }, ...]
    is_quit: boolean;
}

// flag_game_log_YYYY_MM (end_time 이 속한 달 기준) 에 한 게임 로그를 남긴다.
export async function InsertFlagGameLog(pool: Pool, entry: FlagGameLogEntry): Promise<void> {
    const table_name = await flagGameLogSchema.EnsureFlagGameLogTable(pool, entry.end_time);
    await pool.query(
        `INSERT INTO \`${table_name}\`
            (start_time, end_time, userid, score, correct_count, quest_count, plays, is_quit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entry.start_time,
            entry.end_time,
            entry.userid,
            entry.score,
            entry.correct_count,
            entry.quest_count,
            JSON.stringify(entry.plays),
            entry.is_quit ? 1 : 0,
        ]
    );
}
