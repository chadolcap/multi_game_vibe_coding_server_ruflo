// PM2 로 6개 채널(Watcher 1 + 로비 2 + RPS 3)을 한 번에 켜고 끄기 위한 설정 (TASKS.md Phase 9).
// package.json 이 "type": "module" 이라, PM2 설정 파일은 Node 가 ESM 으로 해석하지 않도록 .cjs
// 확장자(CommonJS)로 둔다 — PM2 자체도 설정 파일을 require() 로 읽는다.
// 2026-10-02 "게임별 분리 구조" — 채널 타입이 "game" 이 아니라 구체적인 게임 종류(rps 등)다.
// 오델로를 추가하면 Channel("othello_1", "othello", 1) 같은 줄을 더한다(기존 줄은 안 건드림).
//
// 사용법 (이 디렉터리 — server/ — 에서 실행):
//   npm run build                                          코드가 바뀔 때마다 먼저 한 번
//   npx pm2 start ecosystem.config.cjs                      전체 6개 채널 시작 (운영 규모)
//   npx pm2 start ecosystem.config.cjs --only watcher,lobby_1,rps_1   지금처럼 1채널씩만 켜고 싶을 때
//     (CLAUDE.md "로컬 실행 방법" 참고 — 지금은 개발 단계라 로비/RPS 1채널씩만 운영)
//   npx pm2 stop ecosystem.config.cjs                        전체 정지 (SIGINT 전송 → graceful shutdown)
//   npx pm2 restart ecosystem.config.cjs                     전체 재시작
//   npx pm2 delete ecosystem.config.cjs                      PM2 관리 목록에서 제거
//   npx pm2 logs                                             전체 로그 스트리밍
//   npx pm2 status                                           채널별 상태(켜짐/재시작 횟수 등) 확인
// 채널 하나만 다루고 싶으면 이름을 지정한다: npx pm2 restart rps_1 / npx pm2 logs lobby_2
//
// ⚠️ rps_2/rps_3 / othello_2/othello_3 를 실제로 쓰려면 src/common/constants.ts 의
// RPS_CHANNEL_COUNT / OTHELLO_CHANNEL_COUNT 를 먼저 3 으로 올리고 재빌드해야 한다(지금은 개발 단계라
// 둘 다 1 로 막아 둠). lobby_2 는 코드 제한이 없어 지금도 바로 켤 수 있다.
// (CLAUDE.md "로컬 실행 방법" / "규모 스펙" 참고)
//
// kill_timeout: 게임 채널은 SIGINT/SIGTERM 을 받으면 index.ts 의 server.onBeforeShutdown 이
// "채널을 닫는 중"으로 표시하고 진행 중인 게임이 모두 끝나길 최대 CHANNEL_DRAIN_MAX_WAIT_SEC(10분,
// src/common/constants.ts)만큼 기다린다(무중단 재시작 드레인, TASKS.md Phase 9) — PM2 의
// kill_timeout 이 그보다 짧으면 드레인이 끝나기 전에 PM2 가 먼저 SIGKILL 을 보내 버려 드레인이
// 무의미해진다. 반드시 CHANNEL_DRAIN_MAX_WAIT_SEC 보다 길게 잡을 것(여기선 여유 있게 +2분).
// 로비/Watcher 는 드레인 로직이 없어 사실상 금방 끝나지만, 설정을 단순하게 유지하려고 모든 채널에
// 같은 값을 쓴다.
const KILL_TIMEOUT_MS = 12 * 60 * 1000; // 12분 (CHANNEL_DRAIN_MAX_WAIT_SEC=10분 + 여유 2분)

function Channel(name, channel_type, channel_no) {
    return {
        name,
        script: "dist/index.js",
        args: [channel_type, String(channel_no)],
        cwd: __dirname,
        autorestart: true,
        kill_timeout: KILL_TIMEOUT_MS,
    };
}

module.exports = {
    apps: [
        Channel("watcher", "watcher", 1),
        Channel("lobby_1", "lobby", 1),
        Channel("lobby_2", "lobby", 2),
        Channel("rps_1", "rps", 1),
        Channel("rps_2", "rps", 2),
        Channel("rps_3", "rps", 3),
        // 오델로 (2026-10-07 추가, 포트 6031~6033)
        Channel("othello_1", "othello", 1),
        Channel("othello_2", "othello", 2),
        Channel("othello_3", "othello", 3),
        // 점핑 (2026-10-14 추가, 포트 6041~6043)
        Channel("stepping_1", "stepping", 1),
        Channel("stepping_2", "stepping", 2),
        Channel("stepping_3", "stepping", 3),
    ],
};
