// flag_game_log_YYYY_MM — 청기백기(1인) 월별 게임 로그 테이블. 이름이 매달 바뀌므로 schema.sql 이 아니라
// 여기서 동적으로 만든다 (steppingGameLogSchema.ts 와 같은 패턴, 2026-10-22 추가).
// 혼자 하는 게임이라 win/lose/vs/is_draw 대신 한 유저의 기록만 남긴다:
// - userid: 플레이한 유저
// - score: 게임 점수 = 랭킹 점수 (맞춘 수 × 5)
// - correct_count: 맞춘 문제 수 (0~5)
// - quest_count: 실제로 판정까지 간 문제 수. 중도 퇴장하면 5보다 작다
// - plays: 문제별 기록 JSON 배열, `[{ quest:{b,w}, answer:{b,w}, result:"Y"|"N" }, ...]`
// - is_quit: 게임 중 나가서(끊김 포함) 그 시점 점수로 끝났는지

import type { Pool } from "mysql2/promise";

// date 가 속한 달의 테이블 이름 (예: 2026-10-22 → flag_game_log_2026_10)
export function GetFlagGameLogTableName(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `flag_game_log_${year}_${month}`;
}

function GetCreateTableSql(table_name: string): string {
    // 테이블 이름은 GetFlagGameLogTableName() 이 만든 값만 들어오므로 SQL Injection 위험이 없다 (외부 입력을 직접 꽂지 않음)
    return `
        CREATE TABLE IF NOT EXISTS \`${table_name}\` (
            id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
            start_time     DATETIME         NOT NULL,
            end_time       DATETIME         NOT NULL,
            userid         VARCHAR(255)     NOT NULL,
            score          INT UNSIGNED     NOT NULL DEFAULT 0,
            correct_count  TINYINT UNSIGNED NOT NULL DEFAULT 0,
            quest_count    TINYINT UNSIGNED NOT NULL DEFAULT 0,
            plays          JSON             NOT NULL,
            is_quit        TINYINT(1)       NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            KEY idx_userid (userid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;
}

// date 가 속한 달의 flag_game_log 테이블이 없으면 만든다. 로그를 쓰기 직전에 호출한다.
export async function EnsureFlagGameLogTable(pool: Pool, date: Date): Promise<string> {
    const table_name = GetFlagGameLogTableName(date);
    await pool.query(GetCreateTableSql(table_name));
    return table_name;
}
