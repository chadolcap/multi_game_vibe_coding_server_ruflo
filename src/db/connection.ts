// MySQL connection pool 관리 — 매니저(Lobby/Room/Watcher)는 이 pool 을 직접 쓰지 않고
// db/queries/ 의 함수를 통해서만 접근한다.

import mysql, { type Pool } from "mysql2/promise";
import { config } from "../common/config.js";

let pool: Pool | undefined;

export function GetDbPool(): Pool {
    if (!pool) {
        pool = mysql.createPool({
            host: config.db_host,
            port: config.db_port,
            user: config.db_user,
            password: config.db_password,
            database: config.db_name,
            waitForConnections: true,
            connectionLimit: 10,
            dateStrings: false,
        });
    }
    return pool;
}
