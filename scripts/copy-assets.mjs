// tsc 는 .ts 파일만 dist 로 컴파일하므로, .sql 같은 정적 파일은 빌드 후 직접 복사한다.
// 사용법: node scripts/copy-assets.mjs (build 스크립트에서 tsc 뒤에 실행)

import fs from "node:fs";
import path from "node:path";

const ASSETS = [{ from: "src/db/schema.sql", to: "dist/db/schema.sql" }];

for (const { from, to } of ASSETS) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`[copy-assets] ${from} → ${to}`);
}
