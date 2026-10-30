---
name: require-build-restart-after-edit
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: (src[\\/].*(?<!\.test)\.ts|src[\\/].*\.sql|\.env)$
---

🔁 **서버 코드 수정 — 빌드·재실행까지 해야 완료 (사용자 요청)**

이 작업이 끝나면 **따로 요청이 없어도** 아래를 직접 실행하고, 결과를 보고에 적으세요.

1. `npm run build`
2. 영향받는 프로세스만 `npx pm2 restart <이름…>` (꺼져 있으면 `npm run pm2:start:dev`)
   - `game/{game}/`·`db/{game}*`·`queries/{game}*` → `{game}_1`
   - `game/lobby/`·`game/room/`·`db/user*`·랭킹 조회 → `lobby_1`
   - `watch/` → `watcher`
   - `common/`·`db/connection.ts`·`redis.ts`·`index.ts`·`.env` → 전부
3. `pm2 jlist` 의 `online`·재시작 횟수 + `netstat -ano` 포트 LISTENING 확인
4. 보고에 **"빌드 후 `<프로세스>` 재실행 완료 (online, 포트 LISTENING)"** 를 꼭 적기

⚠️ 게임 채널은 SIGINT 드레인이라 진행 중인 게임이 있으면 최대 10분 기다립니다. 재시작 전에 `~/.pm2/logs/<채널>-out.log` 로 사용자가 게임 중인지 확인하세요.
여러 파일을 고치는 중이면 마지막 수정이 끝난 뒤 **한 번만** 실행합니다.
