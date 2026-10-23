// .env 로딩 및 설정 값
// - 접속 정보/계정/인증서 경로는 반드시 .env 로만 관리한다. (코드에 하드코딩 금지)
// - .env 가 없으면 기본값으로 동작한다. (개발용 기본값만 둔다. 비밀번호 기본값은 두지 않는다)

// Node 22+ 내장 기능으로 .env 를 읽는다 (dotenv 패키지 불필요)
try {
    process.loadEnvFile();
} catch {
    // .env 파일이 없으면 환경 변수만 사용한다
}

function ReadString(key: string, default_value: string): string {
    const value = process.env[key];
    return value === undefined || value === "" ? default_value : value;
}

function ReadNumber(key: string, default_value: number): number {
    const value = process.env[key];
    if (value === undefined || value === "") return default_value;

    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`[config] ${key} 는 정수여야 합니다: ${value}`);
    }
    return parsed;
}

function ReadNumberList(key: string, default_value: number[]): number[] {
    const value = process.env[key];
    if (value === undefined || value === "") return default_value;

    return value.split(",").map((item) => {
        const parsed = Number(item.trim());
        if (!Number.isInteger(parsed)) {
            throw new Error(`[config] ${key} 는 쉼표로 구분한 정수 목록이어야 합니다: ${value}`);
        }
        return parsed;
    });
}

function ReadBoolean(key: string, default_value: boolean): boolean {
    const value = process.env[key];
    if (value === undefined || value === "") return default_value;
    return value.toLowerCase() === "true";
}

export const config = {
    // 채널별 포트 (CLAUDE.md 규모 스펙)
    watcher_port: ReadNumber("WATCHER_PORT", 6000),
    lobby_ports: ReadNumberList("LOBBY_PORTS", [6011, 6012]),
    // 게임 채널 포트 — 게임마다 `{게임이름 대문자}_PORTS` 를 읽는 줄을 하나씩 둔다
    // (2026-10-02 "게임별 분리 구조" — 기존 GAME_PORTS 에서 RPS_PORTS 로 이름을 바꿨다).
    rps_ports: ReadNumberList("RPS_PORTS", [6021, 6022, 6023]),
    othello_ports: ReadNumberList("OTHELLO_PORTS", [6031, 6032, 6033]), // 2026-10-07 오델로 추가
    stepping_ports: ReadNumberList("STEPPING_PORTS", [6041, 6042, 6043]), // 2026-10-14 점핑 추가
    airhockey_ports: ReadNumberList("AIRHOCKEY_PORTS", [6051, 6052, 6053]), // 2026-10-15 에어하키 추가
    flag_ports: ReadNumberList("FLAG_PORTS", [6061, 6062, 6063]), // 2026-10-22 청기백기 추가

    // 좌석 예약(seat_reservation)의 publicAddress 에 쓰는 이 서버의 공개 주소.
    // 개발 환경 기본값은 localhost. 운영 환경은 실제 도메인/IP 로 .env 에 설정해야 한다.
    // (CLAUDE.md "게임 채널 접속 방식" 참고 — 나중에 ip/port 명시 방식으로 바뀌면 이 값의 용도도 바뀐다)
    public_host: ReadString("PUBLIC_HOST", "localhost"),

    // wss(TLS) — 운영 환경은 반드시 true. 개발 환경에서만 false(ws) 로 켠다
    use_tls: ReadBoolean("USE_TLS", false),
    tls_cert_path: ReadString("TLS_CERT_PATH", ""),
    tls_key_path: ReadString("TLS_KEY_PATH", ""),

    // Redis
    redis_host: ReadString("REDIS_HOST", "127.0.0.1"),
    redis_port: ReadNumber("REDIS_PORT", 6780),

    // MySQL — 계정/비밀번호는 기본값을 두지 않는다 (.env 필수)
    db_host: ReadString("DB_HOST", "127.0.0.1"),
    db_port: ReadNumber("DB_PORT", 3306),
    db_user: ReadString("DB_USER", ""),
    db_password: ReadString("DB_PASSWORD", ""),
    db_name: ReadString("DB_NAME", ""),

    // 관리자(Watcher) 로그인 계정 — 코드/문서에 적지 않고 .env 로만 관리한다. 기본값을 두지 않는다
    // (비어 있으면 어떤 비밀번호로도 로그인이 되는 사고를 막기 위해 두 군데서 막는다:
    //  index.ts 가 Watcher 채널 자체를 기동하지 않고, WatcherManager.HandleAdminLogin 도 빈 값이면
    //  어떤 값으로도 로그인시키지 않는다 — 상수 시간 비교 SafeEqual("","") 이 true 라서 이 검사가 필요하다).
    admin_id: ReadString("ADMIN_ID", ""),
    admin_password: ReadString("ADMIN_PASSWORD", ""),
} as const;
