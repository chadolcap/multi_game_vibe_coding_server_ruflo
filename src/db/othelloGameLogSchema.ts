// othello_game_log_YYYY_MM — 오델로 월별 게임 로그 테이블. 이름이 매달 바뀌므로 schema.sql 이 아니라
// 여기서 동적으로 만든다 (rpsGameLogSchema.ts 와 같은 패턴, 2026-10-07 추가).
// - vs: 승자 기준 돌 개수 "38:26" 형태. ⚠️ RPS 는 "2:0" 이라 VARCHAR(3) 이었지만 오델로는 두 자리수가
//   양쪽에 올 수 있어(최대 "64:0" / "33:31") VARCHAR(5) 로 둔다.
// - score: 이번 게임에서 승자가 획득한 점수(승리 20점 고정 = OTHELLO_SCORE_WIN, 무승부면 0)
// - plays: 수순을 순서대로 담은 JSON 배열, `[{ userid, x, y }, ...]` 형태. 좌표는 0~7.
//   뒤집힌 돌 목록은 저장하지 않는다 — 수순과 규칙만 있으면 전부 재현할 수 있어 중복이다.
//   패스는 수가 아니므로 기록하지 않는다(수순을 재생하면 패스 시점도 규칙으로 계산된다).
// - is_draw: 무승부 여부. ⚠️ 무승부는 승자가 없는데 win/lose 컬럼이 NOT NULL 이라, player1/player2 를
//   **입장 순서대로** win/lose 자리에 넣고 이 플래그로 구분한다. 즉 is_draw=1 인 행의 win/lose 는
//   "승자/패자"가 아니라 그냥 두 참가자다 — 집계 쿼리를 쓸 때 반드시 이 플래그를 함께 봐야 한다.
// - win_is_bot / lose_is_bot: 승자/패자가 봇이 대신 플레이했는지

import type { Pool } from "mysql2/promise";

// date 가 속한 달의 테이블 이름 (예: 2026-10-07 → othello_game_log_2026_10)
export function GetOthelloGameLogTableName(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `othello_game_log_${year}_${month}`;
}

function GetCreateTableSql(table_name: string): string {
    // 테이블 이름은 GetOthelloGameLogTableName() 이 만든 값만 들어오므로 SQL Injection 위험이 없다 (외부 입력을 직접 꽂지 않음)
    return `
        CREATE TABLE IF NOT EXISTS \`${table_name}\` (
            id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            start_time    DATETIME        NOT NULL,
            end_time      DATETIME        NOT NULL,
            win           VARCHAR(255)    NOT NULL,
            lose          VARCHAR(255)    NOT NULL,
            vs            VARCHAR(5)      NOT NULL,
            score         INT UNSIGNED    NOT NULL DEFAULT 0,
            plays         JSON            NOT NULL,
            is_draw       TINYINT(1)      NOT NULL DEFAULT 0,
            win_is_bot    TINYINT(1)      NOT NULL DEFAULT 0,
            lose_is_bot   TINYINT(1)      NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            KEY idx_win (win),
            KEY idx_lose (lose)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;
}

// date 가 속한 달의 othello_game_log 테이블이 없으면 만든다. 로그를 쓰기 직전에 호출한다.
export async function EnsureOthelloGameLogTable(pool: Pool, date: Date): Promise<string> {
    const table_name = GetOthelloGameLogTableName(date);
    await pool.query(GetCreateTableSql(table_name));
    return table_name;
}
