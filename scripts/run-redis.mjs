// redis-server.exe 를 직접 spawn 으로 실행한다.
// package.json 의 "redis" 스크립트를 `"C:\Program Files\Redis\redis-server.exe" redis/redis-6780.conf`
// 처럼 문자열로 적으면, npm 이 이 문자열을 cmd.exe 로 넘기는 과정에서 따옴표 처리가 깨져
// "'C:\Program' 은(는) 내부 또는 외부 명령... 이 아닙니다" 오류가 난다.
// (경로에 공백이 있고 뒤에 인자가 더 붙는 조합에서 cmd.exe 가 흔히 겪는 quoting 문제)
// spawn 은 실행 파일 경로와 인자를 배열로 따로 받으므로 이 문제가 생기지 않는다.
// 사용법: node scripts/run-redis.mjs (build 스크립트에서 쓰는 copy-assets.mjs 와 같은 패턴)

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const REDIS_EXE = "C:\\Program Files\\Redis\\redis-server.exe";
const CONFIG_PATH = "redis/redis-6780.conf";

if (!fs.existsSync(REDIS_EXE)) {
    console.error(`[run-redis] Redis 실행 파일을 찾을 수 없습니다: ${REDIS_EXE}`);
    console.error("[run-redis] 설치 경로가 다르면 scripts/run-redis.mjs 의 REDIS_EXE 값을 수정하세요.");
    process.exit(1);
}
if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[run-redis] 설정 파일을 찾을 수 없습니다: ${CONFIG_PATH}`);
    console.error("[run-redis] 프로젝트 루트(server/)에서 실행했는지 확인하세요.");
    process.exit(1);
}

// stdio: "inherit" 로 Redis 로그가 그대로 이 터미널에 출력되고, Ctrl+C 도 그대로 전달된다.
const result = spawnSync(REDIS_EXE, [CONFIG_PATH], { stdio: "inherit" });
process.exit(result.status ?? 1);
