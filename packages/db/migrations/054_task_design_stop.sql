-- Lead 段階で受けた Reviewer の差し戻し（Task ごとの累計。Manager の再実行でも減らさない）。
-- Owner 起点の組み直しで新しい系統として作られた Task は、置き換え元の未リセット分から始まる
ALTER TABLE tasks ADD COLUMN lead_review_rejections INTEGER NOT NULL DEFAULT 0
  CHECK (lead_review_rejections >= 0);
-- Core が設計の作り直しを止めた／Designer が設計できないと報告したことの記録。
-- NULL 以外のとき: ready/review_fix_waiting/running なら次の Designer 起動は報告専用、
-- judgement_waiting なら開いている Decision が design stop であることを示す。
ALTER TABLE tasks ADD COLUMN design_stop_json TEXT NULL
  CHECK (design_stop_json IS NULL OR json_valid(design_stop_json));
-- 設計停止の Decision が持つ構造化した原因（cause_kind と repeated_findings）。書き手の報告がなければ NULL。
ALTER TABLE decisions ADD COLUMN design_block_json TEXT NULL
  CHECK (design_block_json IS NULL OR json_valid(design_block_json));
