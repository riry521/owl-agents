-- Decisions follow one template (packages/core/src/decision-brief.ts):
-- reason (why it stopped), question (what the Owner decides), and options
-- whose description says what choosing them does. Add the question and
-- rewrite Decisions opened before the template into it.
ALTER TABLE decisions ADD COLUMN question TEXT NOT NULL DEFAULT '';

-- Final Manager judged the Work incomplete: the missing points were only in
-- the system.alert event.
UPDATE decisions
   SET reason = '最終チェックで「まだ完了していない」と判定され、Workが止まりました。' || char(10) || '判定の内容: '
                || trim(substr(reason, length('Final Managerがincompleteと判定しました:') + 1)),
       question = '足りない部分を追加のタスクで直しますか？ それともこのWorkを中止しますか？',
       current_state = 'タスクはすべて終わっていますが、Workは完了になっていません。ここまでの変更はWorkブランチに残っています。',
       tried = COALESCE(
         '足りないと判定された点:' || char(10) || (
           SELECT group_concat('- ' || missing.value, char(10))
             FROM json_each((
               SELECT json_extract(events.payload_json, '$.missing')
                 FROM events
                WHERE events.work_id = decisions.work_id
                  AND events.type = 'system.alert'
                  AND json_extract(events.payload_json, '$.kind') = 'final_manager_incomplete'
                ORDER BY events.sequence DESC LIMIT 1
             )) AS missing
         ),
         '足りない点の一覧は報告されていません。'
       ),
       options_json = json_array(
         json_object('key', 'retry', 'label', '追加タスクで直す',
           'description', 'Managerが足りない点を直すタスクを追加し、Workを再開します。下の欄に直し方を書くと、その指示もManagerに渡ります。'),
         json_object('key', 'cancel', 'label', 'Workを中止する',
           'description', 'Workをキャンセルします。ここまでの変更はWorkブランチに残りますが、完了にはなりません。')
       ),
       recommended = 'retry'
 WHERE question = ''
   AND issuer_role = 'core'
   AND reason LIKE 'Final Managerがincompleteと判定しました:%';

-- Other Core Decisions: a Task that must not be retried automatically, or a
-- halted Work.
UPDATE decisions
   SET question = CASE scope WHEN 'task' THEN 'このタスクをもう一度実行しますか？' ELSE 'Workの自動実行を再開しますか？' END,
       current_state = CASE scope
         WHEN 'task' THEN 'このタスクと、その結果を待つタスクは止まっています。'
         ELSE 'Workは判断待ちで止まっています。タスクの作業内容はそのまま残っています。'
       END,
       tried = CASE tried WHEN 'Core reconciliation/failure handling' THEN '自動での復旧はできませんでした。' ELSE tried END,
       options_json = json_array(
         CASE scope
           WHEN 'task' THEN json_object('key', 'retry', 'label', 'もう一度実行する',
             'description', '同じタスクを最初から実行し直します。認証切れなどの原因があれば、先に直してから選んでください。')
           ELSE json_object('key', 'retry', 'label', '再開する',
             'description', 'Workの自動実行を再開します。原因が残っていると、また止まります。タスクがすべて終わっている場合は、Managerが下の欄の指示も踏まえて計画を立て直します。')
         END,
         json_object('key', 'cancel', 'label', 'Workを中止する',
           'description', 'Workをキャンセルします。ここまでの変更はWorkブランチに残りますが、完了にはなりません。')
       )
 WHERE question = ''
   AND issuer_role = 'core'
   AND options_json IN ('[]', '[{"key":"retry","label":"再試行"},{"key":"cancel","label":"キャンセル"}]');

-- Manager could not resolve a failure.
UPDATE decisions
   SET question = CASE scope WHEN 'task' THEN '失敗したタスクをもう一度実行しますか？' ELSE 'Managerにもう一度計画を立て直させますか？' END,
       options_json = json_array(
         CASE scope
           WHEN 'task' THEN json_object('key', 'retry', 'label', 'もう一度実行する',
             'description', '失敗したタスクを同じ内容でもう一度実行します。')
           ELSE json_object('key', 'retry', 'label', '計画を立て直す',
             'description', 'Workを再開し、Managerがもう一度計画を立て直します。下の欄に指示を書くと、それもManagerに渡ります。')
         END,
         json_object('key', 'cancel', 'label', 'Workを中止する',
           'description', 'Workをキャンセルします。ここまでの変更はWorkブランチに残りますが、完了にはなりません。')
       )
 WHERE question = ''
   AND issuer_role = 'manager'
   AND options_json IN ('[]', '[{"key":"retry","label":"再試行"},{"key":"cancel","label":"キャンセル"}]');

-- Policy lessons of a completed Work (tried keeps the lessons).
UPDATE decisions
   SET question = 'この知見を、今後のWorkでも使うルールとして保存しますか？',
       options_json = json_array(
         json_object('key', 'approve', 'label', 'ルールとして保存する',
           'description', 'knowledge/policies/ に保存し、今後のWorkでも参照されます。'),
         json_object('key', 'skip', 'label', '保存しない',
           'description', 'ルールには加えません。知見はこのWorkの記録（knowledge/works/）には残ります。')
       )
 WHERE question = ''
   AND issuer_role = 'core'
   AND options_json = '[{"key":"approve","label":"policies/へ保存する"},{"key":"skip","label":"保存しない"}]';

-- Anything else still states what is asked.
UPDATE decisions
   SET question = '下の選択肢から、どう進めるかを選んでください。'
 WHERE question = '';
