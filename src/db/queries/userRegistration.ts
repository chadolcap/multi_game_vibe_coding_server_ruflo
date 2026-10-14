// 첫 접속 유저 등록 (한 트랜잭션, 중복 호출에 안전)
// 기존 유저의 phone 갱신 쿼리도 여기서 함께 다룬다.
// ⚠️ **모든 게임의 통계 행을 가입 시점에 함께 만든다**(2026-10-07 사용자 결정). 오델로를 추가할 때
// "가입 시 즉시 생성 vs 그 게임을 처음 할 때 지연 생성"을 정해야 했고, 즉시 생성을 택했다 —
// queries/userInfo.ts 가 통계 테이블을 INNER JOIN 하는 구조라, 행이 없으면 유저 조회 자체가 null 이
// 되어 로그인이 깨진다. 게임을 추가하면 아래 GAME_PLAY_INFO_TABLES 에 테이블 이름을 한 줄 더한다.

import type { Pool } from "mysql2/promise";
import * as userid from "../../common/userid.js";
import type { NewUserInput } from "../types.js";

// 가입 시 통계 행을 만들 테이블 목록. 이름 규칙은 `{게임}_user_play_info` 다
// (common/channelNames.ts 의 ALL_GAME_TYPES 와 1:1 로 맞춰야 한다).
const GAME_PLAY_INFO_TABLES = ["rps_user_play_info", "othello_user_play_info", "stepping_user_play_info"] as const;

// user_partner_info / user_member_info / 각 게임의 *_user_play_info 에 기본 정보를 넣는다.
// INSERT IGNORE 를 쓰므로 (partner, mid) 가 이미 있으면(동시 호출 등) 조용히 넘어간다 — 에러 아님.
export async function RegisterNewUser(pool: Pool, input: NewUserInput): Promise<void> {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // user_member_info / *_user_play_info 가 userid 를 FK 로 참조하므로 partner_info 를 먼저 넣는다
        await connection.query(
            "INSERT IGNORE INTO user_partner_info (userid, partner, mid, gender) VALUES (?, ?, ?, ?)",
            [input.userid, input.partner, input.mid, input.gender]
        );
        // 아바타는 성별 기본값으로 정한다 (M → a_m_0, F → a_f_0). 나중에 유저가 직접 바꿀 수 있다.
        await connection.query(
            "INSERT IGNORE INTO user_member_info (userid, avatar, phone) VALUES (?, ?, ?)",
            [input.userid, userid.GetDefaultAvatar(input.gender), input.phone]
        );
        for (const table of GAME_PLAY_INFO_TABLES) {
            // 테이블 이름은 위 상수 배열의 값만 들어오므로 SQL Injection 위험이 없다 (외부 입력 아님)
            await connection.query(`INSERT IGNORE INTO ${table} (userid, today_date) VALUES (?, CURDATE())`, [
                input.userid,
            ]);
        }

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// 게임이 추가되기 전에 가입한 유저에게 그 게임의 통계 행을 채워 넣는다 (백필).
// db:init 에서 한 번 돌린다 — INSERT IGNORE 라 여러 번 실행해도 안전하다.
export async function BackfillMissingPlayInfo(pool: Pool): Promise<Record<string, number>> {
    const inserted: Record<string, number> = {};
    for (const table of GAME_PLAY_INFO_TABLES) {
        const [result] = await pool.query(
            `INSERT IGNORE INTO ${table} (userid, today_date)
             SELECT p.userid, CURDATE() FROM user_partner_info p
             LEFT JOIN ${table} g ON g.userid = p.userid
             WHERE g.userid IS NULL`
        );
        inserted[table] = (result as { affectedRows?: number }).affectedRows ?? 0;
    }
    return inserted;
}

// 저장된 값과 다를 때만 UPDATE 한다. 반환값은 실제로 바뀌었는지 여부.
export async function UpdatePhoneIfChanged(pool: Pool, userid: string, new_phone: string): Promise<boolean> {
    const [result] = await pool.query(
        "UPDATE user_member_info SET phone = ? WHERE userid = ? AND phone <> ?",
        [new_phone, userid, new_phone]
    );
    return (result as { affectedRows: number }).affectedRows > 0;
}

export type SetNameDbResult = "ok" | "duplicate";

// 별명 등록/변경 — 이미 별명이 있어도 다시 보내면 그 값으로 갱신한다 (문서에는 없는 확장 — CLAUDE.md 참고).
// name 에는 UNIQUE 제약이 걸려 있어(schema.sql 참고) 동시에 같은 별명을 등록/변경해도 한쪽만 성공한다
// — 실패한 쪽은 ER_DUP_ENTRY 로 잡는다. 같은 값으로 다시 저장해도(무변경) 제약에 걸리지 않는다.
export async function TrySetUserName(pool: Pool, userid: string, name: string): Promise<SetNameDbResult> {
    try {
        await pool.query("UPDATE user_member_info SET name = ? WHERE userid = ?", [name, userid]);
        return "ok";
    } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") return "duplicate";
        throw error;
    }
}
