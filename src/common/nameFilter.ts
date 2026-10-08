// 별명(NAME) 형식 검사 + 금칙어(욕설 등) 필터
// ⚠️ BANNED_WORDS 는 최소한의 예시 목록이다. 실제 서비스에는 운영팀이 관리하는 금칙어 목록으로 교체해야 한다.

import * as constants from "./constants.js";

const BANNED_WORDS = ["시발", "씨발", "개새끼", "병신", "fuck", "shit", "bitch"];

// 별명 형식 검사 (문자열, 공백 제외 1자 이상 NAME_MAX_LENGTH 자 이하). 금칙어는 여기서 다루지 않는다.
export function IsValidNameFormat(name: unknown): name is string {
    if (typeof name !== "string") return false;
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= constants.NAME_MAX_LENGTH;
}

// 금칙어(욕설 등)가 포함되어 있는지 — 대소문자 구분 없이 부분 일치로 검사한다
export function ContainsBannedWord(name: string): boolean {
    const lower = name.toLowerCase();
    return BANNED_WORDS.some((word) => lower.includes(word.toLowerCase()));
}
