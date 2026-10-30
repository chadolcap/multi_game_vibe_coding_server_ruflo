---
name: warn-md-changelog-style
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.md$
  - field: file_path
    operator: not_contains
    pattern: .claude
---

📝 **md 문서 작성 규칙 (사용자 요청)**

변경 내용을 줄줄이 나열하지 말고 **최종 내용만 간결하게** 기록하세요.

- ❌ "A 였는데 B 로 바꿈", "수정 전/후", 날짜별 변경 이력 나열
- ✅ 지금 기준의 최종 동작·값만 한 번 적기 (기존 항목은 덮어쓰기)
- 다시 밟을 수 있는 함정은 ⚠️ 한 줄로만 남기기
- 변경 경위가 꼭 필요하면 `docs/archive/` 로 보내고 본문에는 넣지 않기
