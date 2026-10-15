// DB 생성 + 스키마 적용 (npm run db:init)
// - .env 의 DB_NAME 으로 데이터베이스가 없으면 만든다.
// - schema.sql 의 테이블들을 CREATE TABLE IF NOT EXISTS 로 적용한다 (여러 번 실행해도 안전).
// - 이번 달 RPS 게임 로그 테이블도 미리 만들어 둔다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { config } from "../common/config.js";
import * as airhockeyGameLogSchema from "./airhockeyGameLogSchema.js";
import * as othelloGameLogSchema from "./othelloGameLogSchema.js";
import * as steppingGameLogSchema from "./steppingGameLogSchema.js";
import * as userRegistration from "./queries/userRegistration.js";
import * as rpsGameLogSchema from "./rpsGameLogSchema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function EnsureDatabaseExists(): Promise<void> {
    // database 지정 없이 접속해서 CREATE DATABASE 부터 실행한다
    const connection = await mysql.createConnection({
        host: config.db_host,
        port: config.db_port,
        user: config.db_user,
        password: config.db_password,
    });
    try {
        await connection.query(
            `CREATE DATABASE IF NOT EXISTS \`${config.db_name}\` DEFAULT CHARACTER SET utf8mb4`
        );
        console.log(`[db:init] 데이터베이스 확인/생성 완료: ${config.db_name}`);
    } finally {
        await connection.end();
    }
}

// schema.sql 을 세미콜론 기준으로 나눠서 하나씩 실행한다 (mysql2 기본 연결은 여러 statement 를 한 번에 못 보냄)
async function ApplySchema(): Promise<void> {
    const schema_path = path.join(__dirname, "schema.sql");
    const schema_sql = fs.readFileSync(schema_path, "utf-8");

    // "-- 설명" 처럼 줄 단위 주석을 먼저 제거한 뒤 세미콜론으로 나눈다.
    // (주석 줄이 CREATE TABLE 문 바로 위에 붙어 있어서, 주석을 먼저 지우지 않으면
    //  "-- 설명\nCREATE TABLE ..." 덩어리 전체가 "주석으로 시작한다"고 걸러져 버린다)
    const sql_without_comments = schema_sql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

    const statements = sql_without_comments
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

    const connection = await mysql.createConnection({
        host: config.db_host,
        port: config.db_port,
        user: config.db_user,
        password: config.db_password,
        database: config.db_name,
    });
    try {
        for (const statement of statements) {
            await connection.query(statement);
        }
        console.log(`[db:init] 테이블 ${statements.length}개 확인/생성 완료`);
    } finally {
        await connection.end();
    }
}

// 월별 게임 로그 테이블은 이름이 매달 바뀌어 schema.sql 에 없다 — 게임마다 이번 달 것을 미리 만들어 둔다.
// 게임을 추가하면 여기에 한 줄 더한다.
async function EnsureCurrentMonthGameLogs(): Promise<void> {
    const { GetDbPool } = await import("./connection.js");
    const pool = GetDbPool();
    const now = new Date();

    const rps_table = await rpsGameLogSchema.EnsureRpsGameLogTable(pool, now);
    console.log(`[db:init] 이번 달 RPS 게임 로그 테이블 확인/생성 완료: ${rps_table}`);

    const othello_table = await othelloGameLogSchema.EnsureOthelloGameLogTable(pool, now);
    console.log(`[db:init] 이번 달 오델로 게임 로그 테이블 확인/생성 완료: ${othello_table}`);

    const stepping_table = await steppingGameLogSchema.EnsureSteppingGameLogTable(pool, now);
    console.log(`[db:init] 이번 달 점핑 게임 로그 테이블 확인/생성 완료: ${stepping_table}`);

    const airhockey_table = await airhockeyGameLogSchema.EnsureAirhockeyGameLogTable(pool, now);
    console.log(`[db:init] 이번 달 에어하키 게임 로그 테이블 확인/생성 완료: ${airhockey_table}`);
}

// 게임이 추가되기 전에 가입한 유저에게 그 게임의 통계 행을 채워 넣는다.
// (가입 시 모든 게임 행을 만들기로 했으므로, 과거 유저만 이 백필이 필요하다)
async function BackfillPlayInfo(): Promise<void> {
    const { GetDbPool } = await import("./connection.js");
    const inserted = await userRegistration.BackfillMissingPlayInfo(GetDbPool());
    for (const [table, count] of Object.entries(inserted)) {
        if (count > 0) console.log(`[db:init] ${table} 누락 행 ${count}개 생성`);
    }
}

async function Main(): Promise<void> {
    await EnsureDatabaseExists();
    await ApplySchema();
    await EnsureCurrentMonthGameLogs();
    await BackfillPlayInfo();
    console.log("[db:init] 완료");
    process.exit(0);
}

Main().catch((error) => {
    console.error("[db:init] 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
});
