// (partner, mid) → userid 변환 (CLAUDE.md 흐름 3번)
// - userid = partner + "_" + XOR(mid)
// - XOR: mid 의 글자 하나하나의 문자 코드에 key(5) 를 적용하고, 결과 숫자를 10진수 문자열로 이어 붙인다
//   (예: 'u'(117) ^ 5 = 112 → "112")
// - ⚠️ **암호화가 아니라 형식 변환이다. 단방향이 아니고, userid 에서 mid 를 되돌릴 수 있다.**
//   mid 를 영문/숫자로 제한해서 XOR 결과가 48~127 범위에 들어가는데, 앞자리를 보면 2자리인지 3자리인지
//   정해지기 때문(앞자리가 1 이면 100~127 로 3자리, 4~9 면 2자리)에 구분자 없이도 유일하게 쪼갤 수 있다.
//   무작위 mid 2만 건으로 왕복 복원을 확인했다(2026-10-06). 그러니 **userid 를 비밀로 취급하면 안 된다** —
//   외부에 노출되면 파트너사의 mid 가 그대로 드러난다. (예전 주석은 "단방향이라 복원할 수 없다"고
//   적혀 있었는데 사실이 아니었다)
// - 실무에서 mid 가 필요하면 되돌리지 말고 user_partner_info 에서 조회한다.

import * as constants from "./constants.js";

// partner: 영문/숫자 1~11자, '_' 포함 금지
const PARTNER_PATTERN = /^[A-Za-z0-9]{1,11}$/;
// mid: 영문/숫자 1~63자 (XOR 숫자열끼리 충돌하지 않도록 영문/숫자로 제한)
const MID_PATTERN = /^[A-Za-z0-9]{1,63}$/;

export function IsValidPartner(partner: unknown): partner is string {
    return typeof partner === "string" && partner.length <= constants.PARTNER_MAX_LENGTH && PARTNER_PATTERN.test(partner);
}

export function IsValidMid(mid: unknown): mid is string {
    return typeof mid === "string" && mid.length <= constants.MID_MAX_LENGTH && MID_PATTERN.test(mid);
}

// gender: F 또는 M 만 허용
export function IsValidGender(gender: unknown): gender is (typeof constants.ALLOWED_GENDERS)[number] {
    return typeof gender === "string" && (constants.ALLOWED_GENDERS as readonly string[]).includes(gender);
}

// phone: 빈 값 불가, 텍스트 최대 100자 (형식은 자유 — 파트너사마다 다를 수 있어 숫자만으로 제한하지 않는다)
export function IsValidPhone(phone: unknown): phone is string {
    return typeof phone === "string" && phone.length > 0 && phone.length <= constants.PHONE_MAX_LENGTH;
}

// 첫 접속 유저의 기본 아바타 (M → a_m_0, F → a_f_0).
// 호출 전에 IsValidGender 로 형식을 검사해야 한다. 검사되지 않은 값이 들어오면 빈 문자열을 돌려준다.
export function GetDefaultAvatar(gender: string): string {
    return constants.DEFAULT_AVATAR_BY_GENDER[gender as (typeof constants.ALLOWED_GENDERS)[number]] ?? "";
}

// mid 의 각 글자를 XOR 후 10진수 문자열로 이어 붙인다
function XorMid(mid: string): string {
    let result = "";
    for (let i = 0; i < mid.length; i++) {
        const code = mid.charCodeAt(i) ^ constants.USERID_XOR_KEY;
        result += code.toString(10);
    }
    return result;
}

// (partner, mid) → userid. 호출 전에 IsValidPartner / IsValidMid 로 형식을 검사해야 한다
export function ConvertMidToUserid(partner: string, mid: string): string {
    return `${partner}_${XorMid(mid)}`;
}
