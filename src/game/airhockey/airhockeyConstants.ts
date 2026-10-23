// 에어하키(airhockey) 전용 규칙 상수 (2026-10-15 추가). 플랫폼 공용 상수는 common/constants.ts 에 있다.
// 출처 표기: "시트" = 멀티게임_바이브.xlsx 의 airhockey 시트에 명시된 값,
//           "사용자 결정" = 2026-10-15 대화에서 정한 규칙,
//           "임시" = 시트/규칙에 값이 없어 서버가 정한 값 — 클라이언트와 맞춰야 한다.

// ── 테이블 좌표계 ──
// 원점(0,0)이 테이블 **정중앙**(퍽 시작 위치)이고, x 는 오른쪽, y 는 위쪽이 + 다.
// 좌표는 항상 **받는/보내는 유저 기준**이다 — 내 골대가 아래(y < 0), 상대 골대가 위(y > 0).
// 서버 내부에서는 player1 이 아래, player2 가 위인 절대 좌표를 쓰고, player2 와 주고받을 때만 (x,y) → (-x,-y)
// 로 뒤집는다(시트: "상대방의 좌표는 내 좌표를 기준으로 반대 방향", "나의 위치를 하단에 배치").
//
// ⚠️ 아래 크기 값은 **임시**다. 영상(세로 화면, 비율 약 9:16)에 맞춰 잡았고, 클라이언트의 테이블/퍽/레버
//    크기와 반드시 같아야 한다 — 다르면 화면에서는 안 닿았는데 튕기거나, 닿았는데 통과한다.
//    영상의 꺾인 옆벽은 연출로만 두고 충돌은 직사각형으로 판정한다(사용자 결정).
export const AIRHOCKEY_TABLE_WIDTH = 720;
export const AIRHOCKEY_TABLE_HEIGHT = 1280;
export const AIRHOCKEY_GOAL_WIDTH = 260; // 위아래 벽 가운데의 골대 입구 폭 (영상 기준 테이블 폭의 약 36%)
export const AIRHOCKEY_PUCK_RADIUS = 30;
export const AIRHOCKEY_LEVER_RADIUS = 60;

// ── 물리 ──
// 서버가 퍽을 직접 계산한다(시트: PUCK_MOVE = "퍽의 현재 위치 알림"). 클라이언트는 레버 좌표만 보낸다.
export const AIRHOCKEY_TICK_MS = 1000 / 60; // 물리 계산 주기 (60Hz)
export const AIRHOCKEY_SUBSTEPS = 4; // 한 틱을 이만큼 나눠 계산한다 — 빠른 퍽이 레버를 뚫고 지나가지 않게
// 루프가 늦게 불렸을 때 한 번에 따라잡는 최대 틱 수. 이보다 밀리면(서버 멈춤 등) 밀린 시간은 버린다 — 퍽이 순간이동하지 않게.
export const AIRHOCKEY_MAX_CATCHUP_TICKS = 5;
export const AIRHOCKEY_SEND_EVERY_TICKS = 2; // PUCK_MOVE / LEVER_MOVE 중계 주기 = 2틱마다(30Hz)
// 퍽 최대 속도 (단위/초). 2026-10-15 2000 → 2800: 예전엔 손을 600/초만 움직여도 상한에 걸려 세기 차이가 없었다.
// 서브스텝당 이동 거리(2800/240 ≈ 12) 가 퍽+레버 반지름 합(90)보다 훨씬 작아 뚫고 지나가지 않는다.
export const AIRHOCKEY_PUCK_MAX_SPEED = 2800;
export const AIRHOCKEY_PUCK_FRICTION_PER_SEC = 0.35; // 1초에 잃는 속도 비율 (에어하키라 마찰이 작다)
export const AIRHOCKEY_PUCK_MIN_SPEED = 5; // 이보다 느려지면 멈춘 것으로 본다(PUCK_MOVE 를 그만 보낸다)
export const AIRHOCKEY_WALL_RESTITUTION = 0.9; // 벽에 튕길 때 남는 속도 비율
// 레버-퍽 충돌 (2026-10-15 손맛 수정). 레버는 손이 움직이므로 충돌로 느려지지 않지만, 퍽이 받는 힘은
// 유한 질량 충돌식으로 계산한다: 멈춘 퍽을 속도 V 로 치면 퍽 속도 = (1 + e) × M/(M+1) × V ≈ 1.3V.
// (예전엔 레버를 질량 무한대로 보고 e=0.9 라 1.9V 였다 — 실제 에어하키 말렛은 퍽보다 3~4배 무겁다)
export const AIRHOCKEY_LEVER_RESTITUTION = 0.65; // 레버에 맞을 때 반발계수
export const AIRHOCKEY_LEVER_MASS_RATIO = 4; // 레버(말렛) 질량 ÷ 퍽 질량
// 레버가 따라갈 수 있는 최대 속도(단위/초). 클라이언트 좌표로 순간이동해도 서버의 레버는 이 속도로만
// 따라간다 — 순간이동한 레버가 퍽에 무한대 속도를 주는 것(조작)을 막는다.
export const AIRHOCKEY_LEVER_MAX_SPEED = 3000;
// LEVER_MOVE 도착 간격 추정 (2026-10-15 손맛 수정). 서버 레버는 새 목표까지 "다음 LEVER_MOVE 가 올 때쯤"
// 도착하도록 일정한 속도로 움직인다 — 그래야 서버 레버 속도가 실제 손 속도와 같아진다.
// ⚠️ 예전처럼 최대 속도로 몰아서 가면, 30Hz 입력(2틱에 한 번)에서 레버 속도가 [0, 2V, 0, 2V …] 로
//    튀어서 같은 손놀림에도 퍽이 달라붙었다가(0) 튕겨 나갔다(2V).
export const AIRHOCKEY_LEVER_INPUT_INTERVAL_SEC = 1 / 30; // 첫 입력 전 기본값 (클라이언트 30Hz 가정)
export const AIRHOCKEY_LEVER_INPUT_INTERVAL_MIN_SEC = 1 / 120; // 패킷이 몰려 와도 이보다 짧게 보지 않는다
export const AIRHOCKEY_LEVER_INPUT_INTERVAL_MAX_SEC = 0.1; // 손을 멈췄다 다시 움직일 때 너무 느려지지 않게
export const AIRHOCKEY_LEVER_INPUT_INTERVAL_SMOOTHING = 0.3; // 간격 이동평균(EMA)에서 새 값의 비중
// 레버 무게 (2026-10-22 사용자 요청 "레버가 너무 가벼워 퍽이 쉽게 튄다"). 위 규칙으로 입력을 따라가는 점은 "손"이고,
// 레버는 그 손을 1차 지연으로 늦게 따라간다: 매 틱 레버 += (손 - 레버) × (1 - e^(-dt/τ)).
// 짧게 툭 친 손은 레버가 다 가속하기 전에 끝나서 약하게 맞고, 길게 휘두르면 손 속도까지 올라가 세게 맞는다.
// 손을 멈추면 레버가 스르륵 멈춘다(지나쳤다 돌아오지 않는다). 값이 클수록 무겁고, 0 이면 예전처럼 손에 바로 붙는다.
// ⚠️ 클라이언트가 자기 레버를 그릴 때도 같은 τ·공식을 써야 화면 레버와 판정 레버가 맞는다(손 = 손가락 위치).
//    상대 레버(LEVER_MOVE 중계)는 이미 무게가 적용된 서버 좌표라 클라이언트가 다시 늦추면 안 된다.
export const AIRHOCKEY_LEVER_WEIGHT_SEC = 0.05;
export const AIRHOCKEY_LEVER_SETTLE_DISTANCE = 0.5; // 손과 이보다 가까우면 손 자리에 딱 맞춰 멈춘다 (무한히 다가가며 떨지 않게)

// ── 봇(자동 조종) ──
// 게임 중 끊기거나 나간 유저의 레버는 서버의 간단한 봇이 대신 움직인다(사용자 결정).
export const AIRHOCKEY_BOT_SPEED = 900; // 봇 레버 이동 속도 (단위/초). 사람보다 느리게 — 이길 수 있게
export const AIRHOCKEY_BOT_HOME_OFFSET = 180; // 수비 위치 = 자기 골 라인에서 이만큼 앞
// 공격할 때 겨누는 x 를 매 틱 ±이만큼 흔든다. ⚠️ 빼면 안 된다 — 봇끼리(둘 다 끊긴 경우) 중앙의 퍽에 정확히
// 대칭으로 달려들어 퍽을 사이에 끼운 채 영원히 골이 안 난다(오프라인 시뮬레이션 20/20 교착). ±20 이면 0/20.
export const AIRHOCKEY_BOT_AIM_JITTER = 20;
// 봇이 느린 퍽에 붙어 있으면 이만큼 물러났다가 다시 친다(2026-10-15). ⚠️ 빼면 안 된다 — 퍽이 구석(벽 두 개가
// 만나는 곳)에 들어가면 레버가 닿을 수 있는 모든 자리에서 미는 방향이 구석 쪽이라, 계속 누르고 있으면 영원히
// 못 빼낸다(봇끼리 30판 중 5판 교착). 치고 물러나야 벽에 튕긴 퍽이 구석을 빠져나온다.
export const AIRHOCKEY_BOT_RETREAT_DISTANCE = 100;
export const AIRHOCKEY_BOT_RETREAT_PUCK_SPEED = 250; // 퍽이 이보다 느릴 때만 물러난다 (빠른 퍽은 그냥 친다)

// ── 진행 ──
export const AIRHOCKEY_WIN_GOALS = 3; // 3골 먼저 넣으면 승리 (시트/사용자: "총 3점을 먼저 획득한 유저가 승자")
export const AIRHOCKEY_GAME_START_DELAY_SEC = 3; // GAME_START 뒤 첫 ONE_START 까지 (임시 — 시작 연출 시간)
export const AIRHOCKEY_ONE_RESULT_DELAY_SEC = 3; // 골(ONE_RESULT) 뒤 다음 ONE_START 까지 (임시 — 영상의 "GOAL!" 연출 시간)
export const AIRHOCKEY_RESULT_DELAY_SEC = 3; // 마지막 골 뒤 GAME_RESULT 까지 (RPS/점핑과 같은 마지막 연출 대기)
export const AIRHOCKEY_REMATCH_CHOICE_TIMEOUT_SEC = 10; // 시트("10초 내에 재시작,/로비나가기 선택")
// 퍽이 AIRHOCKEY_STUCK_RESET_SEC 동안 처음 자리에서 AIRHOCKEY_STUCK_RADIUS 밖으로 못 나가면 "움직일 수 없는 상황"으로
// 보고 이번 판만 다시 시작한다(점수 유지, ONE_START 부터) — 사용자 결정(2026-10-15).
// 레버 두 개가 중앙선에서 퍽을 벽에 끼운 경우, 구석에 갇힌 경우, 한쪽이 퍽을 잡고 안 치는 경우(퍽 독점)를 함께 막는다.
// 반경은 퍽 반지름 정도 — 끼인 퍽은 제자리에서 몇 단위씩 떨리므로 "속도 0" 이 아니라 "이동 범위"로 판정한다.
export const AIRHOCKEY_STUCK_RADIUS = 30;
export const AIRHOCKEY_STUCK_RESET_SEC = 10;
// 골 없이 정체 재시작을 이만큼 연달아 했는데 또 정체되면(= 4번째) 게임을 무효로 한다 — 즉시 GAME_RESULT{draw:"Y"}
// 를 보내고 일반 결과와 같은 재게임 선택을 받는다(기록 없음). 판이 시작됐는데 양쪽 다 가만히 있는 경우(방치) —
// 사용자 결정(2026-10-15). 골이 나면 횟수는 0 으로 돌아간다. 양쪽이 가만히 있으면 첫 ONE_START 부터 약 40초(10초 × 4).
export const AIRHOCKEY_STUCK_MAX_RESTARTS = 3;
// ── 랭킹 점수 ──
// 넣은 골 수 × 5점. 승패와 상관없이 양쪽 모두 받는다(사용자 결정: 시트 "승리 점수 : 1판에 5점").
export const AIRHOCKEY_SCORE_PER_GOAL = 5;
