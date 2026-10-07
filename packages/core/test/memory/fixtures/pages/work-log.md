---
id: 01HZZZZZZZZZZZZZZZZZZZZZZW
type: work-log
work_id: 01HZZZZZZZZZZZZZZZZZZZZZZK
work_number: 815
project_id: 01HZZZZZZZZZZZZZZZZZZZZZZP
title: W815 月末だけ落ちるテストを直す
outcome: completed
completed_at: 2026-10-02T23:40:00Z
created: 2026-10-02
---
# W815 月末だけ落ちるテストを直す

## 何をしたか
- 月次集計のテストが月末だけ落ちる原因を調べ、固定日時を渡す形に直した
- テスト 3 本を書き換え、日付をずらした実行で通ることを確かめた

## 学んだこと
- [落とし穴] 月末だけ落ちるテストは、テストの中で当月を new Date() で作っていた
- [手順] 落ちたテストは、日付をずらして（TZ と固定日時）もう一度実行して確かめる

## 反映先
- [[テストの落とし穴]] の 落とし穴 に 1 件
- [[テストの落とし穴]] の 手順 に 1 件
