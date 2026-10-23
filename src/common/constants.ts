// 규모 스펙 / 플랫폼 공용 상수 — 어떤 게임이든 똑같이 쓰는 숫자만 이곳에 둔다 (CLAUDE.md 기준).
// 게임 전용 규칙 상수(가위바위보 등)는 game/<게임이름>/<게임이름>Constants.ts 에 따로 둔다
// (2026-10-02 "게임별 분리 구조" — CLAUDE.md 참고).

// ── 규모 ──
// ⚠️ 지금은 개발 단계라 로비/RPS 1채널씩만 운영한다. 실 서비스 목표는 로비 2 / RPS 3 (CLAUDE.md 규모 스펙 참고).
// 로비 채널 수는 .env 의 LOBBY_PORTS 목록 길이로 정해진다(channelNames.ts GetChannelPort 참고) — 여기엔
// 상수가 없다. 게임 채널은 GameRoomMatcher 가 "몇 번까지 켜져 있을 수 있는지" 알아야 해서 상수로 둔다 —
// 게임 종류마다 하나씩 둔다 — 게임을 추가하면 `{게임}_CHANNEL_COUNT` 를 똑같이 더하고
// common/channelNames.ts 의 GetGameChannelCount/GetChannelPort 에 분기를 추가한다.
// 운영 전환/증설 시 여기 값을 되돌리고, .env 의 *_PORTS 도 포트를 추가할 것 (LOBBY_PORTS 는 바로 추가 가능).
export const RPS_CHANNEL_COUNT = 1;
export const OTHELLO_CHANNEL_COUNT = 1; // 실 서비스 목표 3 (.env OTHELLO_PORTS=6031,6032,6033), 로컬 테스트는 6031 만
export const STEPPING_CHANNEL_COUNT = 1; // 2026-10-14 점핑 추가. 실 서비스 목표 3 (.env STEPPING_PORTS=6041,6042,6043), 로컬 테스트는 6041 만
export const AIRHOCKEY_CHANNEL_COUNT = 1; // 2026-10-15 에어하키 추가. 실 서비스 목표 3 (.env AIRHOCKEY_PORTS=6051,6052,6053), 로컬 테스트는 6051 만
export const FLAG_CHANNEL_COUNT = 1; // 2026-10-22 청기백기(1인) 추가. 실 서비스 목표 3 (.env FLAG_PORTS=6061,6062,6063), 로컬 테스트는 6061 만
export const MAX_CLIENTS_PER_CHANNEL = 300;     // 로비/게임 채널별 최대 동시 접속
export const MAX_ROOMS_PER_GAME_CHANNEL = 100;  // 게임 채널별 방 개수
export const MAX_PLAYERS_PER_GAME_CHANNEL = 200; // 게임 채널별 게임 인원
export const PLAYERS_PER_ROOM = 2;              // 게임방 1개당 인원

// ── 시간 제한 (초) ──
export const ENTER_LOBBY_TIMEOUT_SEC = 10;      // 접속 후 ENTER_LOBBY 제한 시간
export const SEAT_RESERVATION_SEC = 10;         // 좌석 예약 유효 시간
export const RECONNECT_WAIT_SEC = 5;            // 끊긴 뒤 봇 투입까지 대기
// 가위바위보 선택 제한/연출 대기/재게임 응답 제한 등 RPS 전용 시간 상수는 game/rps/rpsConstants.ts 로
// 옮겼다(2026-10-02, "게임별 분리 구조" — CLAUDE.md 참고).

// 채널 하트비트: 게임 채널이 "지금 켜져 있는지"를 Redis 에 TTL 로 표시한다 (db/channelHeartbeat.ts).
// INTERVAL 은 TTL 의 절반 이하로 — 한두 번 갱신을 놓쳐도(Redis 지연 등) 바로 죽은 걸로 오판하지 않게 여유를 둔다.
export const CHANNEL_HEARTBEAT_TTL_SEC = 15;
export const CHANNEL_HEARTBEAT_INTERVAL_SEC = 5;

// 무중단 재시작(드레인, Phase 9) — 게임 채널을 "닫는 중"으로 표시해 새 매칭/기다리는 방 입장을 막고
// (db/channelHeartbeat.ts MarkChannelClosing/IsChannelClosing), 그 채널의 진행 중인 게임이 모두
// 끝날 때까지 index.ts 가 polling 으로 기다린다. CLOSING_TTL 은 이 Redis 표시가 혹시 안 지워져도
// 영원히 남지 않게 하는 안전망일 뿐이다(정상적으로는 다음 기동 때 ClearChannelClosing 으로 지운다).
export const CHANNEL_CLOSING_TTL_SEC = 60 * 60;       // 1시간 (안전망)
export const CHANNEL_DRAIN_POLL_INTERVAL_SEC = 5;     // 진행 중인 게임이 다 끝났는지 이 간격으로 확인
export const CHANNEL_DRAIN_MAX_WAIT_SEC = 10 * 60;    // 10분 — 이 시간이 지나도 안 끝나면 포기하고 종료 진행
                                                       // (ecosystem.config.cjs 의 kill_timeout 이 이보다 짧으면
                                                       //  PM2 가 먼저 SIGKILL 을 보내 버리니 반드시 더 길게 맞출 것)

// 게임 규칙(2선승제, 점수표 등) 상수는 게임마다 다르므로 여기 없다 — 가위바위보는
// game/rps/rpsConstants.ts 참고(2026-10-02 분리).

// ── 캐시 / 랭킹 ──
export const USER_CACHE_TTL_SEC = 120;          // Redis 유저 정보 TTL (2분)
export const RANKING_LIST_SIZE = 100;           // 랭킹 노출 1~100위
// 랭킹 순위/점수 자체는 Redis Sorted Set(rank_zset:*, db/rankingZSet.ts)에서 O(log N)으로 조회하므로
// 더 이상 캐시가 필요 없다(2026-10-01, 사용자 요청으로 MySQL RANK() 윈도우 함수 방식에서 전환).
// 이 캐시는 "상위 100명의 userid 목록에 이름을 붙인 최종 리스트"(이름 조인에 MySQL 쿼리가 필요한
// 부분)만 짧게 캐시해 DB 부하를 줄인다 — db/rankingRepository.ts 참고.
export const RANK_LIST_CACHE_TTL_SEC = 10;
// Redis Sorted Set(rank_zset:daily:{date}/rank_zset:weekly:{monday})의 TTL. 그 날/그 주가 끝난 뒤에도
// 한동안은 재구축 없이 바로 조회되게 여유를 둔다 — 진짜 원본은 MySQL(rps_rank_daily/rps_rank_weekly)이므로
// 이 TTL 이 지나 ZSET 이 사라져도 다음 조회 때 자동으로 다시 채워진다(db/rankingZSet.ts 참고).
export const RANK_ZSET_TTL_SEC = 3 * 24 * 60 * 60; // 3일

// 게임 중인 userid → 게임방 정보(방 재접속용) 기록의 Redis TTL. 정상적으로는 onLeave 에서 즉시 지우므로
// 이 TTL 은 프로세스가 죽는 등 onLeave 가 아예 안 불리는 드문 경우를 대비한 안전망일 뿐이다 — 실제 게임
// 한 판(2선승제) 최대 소요 시간보다 넉넉히 길게 잡는다.
export const ACTIVE_GAME_TTL_SEC = 600;

// ── 관리자(Watcher, Phase 7) ──
export const ADMIN_LOGIN_TIMEOUT_SEC = 10;      // 접속 후 ADMIN_LOGIN 제한 시간 (ENTER_LOBBY_TIMEOUT_SEC 와 동일한 값)
// 같은 IP 에서 ADMIN_LOGIN 이 이 횟수만큼 연속 실패하면 그 IP 를 잠그고, 잠금이 풀릴 때까지 Watcher
// 채널 접속 자체를 거부한다(WatcherRoom.onAuth). 로그인 실패 시 연결을 끊기 때문에(WatcherManager
// HandleAdminLogin) 세션 단위로는 셀 수 없어서, 연결보다 오래 사는 IP 를 기준으로 센다.
// 관리자 혼자 쓰는 채널이라 시도 횟수를 넉넉히 줄 이유가 없다.
export const ADMIN_LOGIN_MAX_FAIL_COUNT = 5;
// 잠금 시간. "연속 실패 기록을 잊는 기간"으로도 함께 쓴다 (이 시간 동안 실패가 없으면 기록을 버린다).
export const ADMIN_LOGIN_LOCK_SEC = 10 * 60;
// 각 로비/게임 채널이 자기 채널의 접속자 목록(userid, 게임 채널이면 room 도)을 Redis 에 올리는 주기/TTL.
// ADMIN_CHANNEL_USER 는 이 스냅샷을 읽으므로 최대 이 간격만큼 오래된 값일 수 있다(ADMIN_CHANNEL_COUNT 는
// matchMaker.query() 로 그때그때 집계하므로 여기 해당 없음).
export const CHANNEL_USERS_REPORT_INTERVAL_SEC = 5;
export const CHANNEL_USERS_TTL_SEC = 15;
// SEND_NOTICE 에 time(구간) 이 담겨 오면, 그 구간 동안 이 간격으로 반복 전송한다.
export const NOTICE_REPEAT_INTERVAL_SEC = 60;

// ── 입력 형식 ──
export const PARTNER_MAX_LENGTH = 11;
export const MID_MAX_LENGTH = 63;
export const PHONE_MAX_LENGTH = 100;
export const NAME_MAX_LENGTH = 50;              // user_member_info.name 컬럼 길이와 맞춘다
export const ALLOWED_GENDERS = ["F", "M"] as const;
export const USERID_XOR_KEY = 5;

// ── 기본 아바타 (첫 접속 유저 등록 시 성별로 정함) ──
export const DEFAULT_AVATAR_BY_GENDER: Record<(typeof ALLOWED_GENDERS)[number], string> = {
    M: "a_m_0",
    F: "a_f_0",
};
