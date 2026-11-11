# Java / PostgreSQL backend

JDK 21標準のHTTPサーバー・PostgreSQL JDBC・Jacksonを使用するローカル業務デモです。Spring Bootは使用していません。Next.jsが署名済みセッションから利用者IDを取得し、ブラウザに公開しないAPIキーとともにJavaに渡します。JavaはDBに登録された区分と担当・対象者の関係を検証します。

## 起動と停止

```powershell
npm run demo
# Javaだけの起動／変更後の再起動
.\scripts\start-backend.ps1
.\scripts\start-backend.ps1 -Restart
# Javaと専用PostgreSQLの停止
.\scripts\stop-backend.ps1
```

JDK 21以上とPostgreSQLのbinをPATHに設定します。必要に応じて `JAVA_HOME`・`DEALHUNTER_POSTGRES_BIN` を指定できます。専用DBは `.local/postgres`・127.0.0.1:55432、Javaは127.0.0.1:8080です。既存のPostgreSQLサービスやデータは変更しません。初回にJDBCとJacksonの固定バージョンを公式Maven Centralから取得しSHA-256を検証します。

DB認証情報とAPIキーは `.local` 内に生成します。APIキーをクライアント側コード・公開環境変数に設定しないでください。ヘルス確認以外の全APIは内部キーと利用者IDの両方が必要です。

## 保存される操作

- 営業: 面談依頼作成、回答された候補から日時・URL確定、合否と初回入場登録。
- 新規依頼はリーダー1名と面談者複数名を選び、1案件に面談者別の依頼・候補枠を同一トランザクションで保存します。回答・確定・所感・入場は各人独立です。
- リーダー: `projects.leader_id` に自分が設定された案件の全履歴を閲覧するだけで、全POSTを403で拒否します。
- 受講者: 自分宛て依頼の複数候補への回答、日時未指定・日付指定の依頼への開始日時の提案、確定前の回答変更、自分の面談所感・質問の提出。
- 所感の質問は1問ずつ面談・案件に紐づいて保存され、件数上限は設定していません。
- Lark通知とカレンダーは内容のプレビュー履歴だけを保存します。外部通信・実送信は行いません。
- 所感は一度提出すると参照のみです。確定済み日時や登録済み入場の重複登録は409で拒否します。
- デモを一度に試せるよう、未来日時の面談にも所感を提出できます。不合格の面談でも所感は記録できます。

起動時に実行するのは `schema.sql` と `seed-users.sql`（既存10名＋リーダー2名）だけです。案件サンプルは自動投入せず、削除後に復活しません。`seed.sql`・`seed-workflow.sql`・`seed-student-entry.sql` は過去のサンプル資料として残していますが、起動処理からは実行しません。対応待ちは保存された依頼・所感・予定から算出します。

## API

`GET /api/health` / `GET /api/dashboard`

`POST /api/requests` / `POST /api/requests/{id}/respond` / `POST /api/requests/{id}/confirm`

新規作成の共通項目は `{project, summary, leaderId, studentIds}` です。`studentIds` は重複のない1名以上、`leaderId` は登録リーダーが必須です。日程の確認方法を次の項目で指定します。

- `scheduleMode:"candidates"`（省略時も同じ）：`candidates:[{start,end?}]` を1件以上指定します。`start` は `2026-11-20T13:00` のような日本時間の開始日時です。`end` は省略・NULLを許し、入力する場合は同日の開始より後にします。回答は `{slotIds:[候補ID,...]}` です。
- `scheduleMode:"availability"`：日時を決めずに参加可能な開始日時を尋ねます。`candidates` は省略または空配列にします。任意の `requestedDates:["2026-11-20",...]` で日付だけを指定でき、省略・空配列なら日付の制限もありません。回答は `{proposals:[{start:"2026-11-20T13:00"},...]}` で、終了日時は指定しません。指定日がある場合はその日付の開始日時だけを受け付けます。

回答はどちらも1件以上必要です。日付・開始日時の重複や、方式に合わない候補・回答の混在を拒否します。日時未指定方式の再回答は本人の提案だけを置き換え、対応待ちの版を更新します。営業は回答済みの候補IDを `{slotId,url}` で指定して確定します。確定後の回答変更は409です。

ダッシュボードの各依頼は `scheduleMode`・`requestedDates` と候補一覧を返します。候補の `end` は日時文字列またはNULLです。終了未指定の候補を確定しても終了時刻は補完せず、DBにNULLを保存します。従来の終了日時付き候補・予定はその値を保持します。

作成時の返却は `projectId`・全員分の `requestIds`・本人へ直接届ける `previews` を含みます。旧デモ検証との互換用に、単独の `studentId` 形式も受理し、この旧形式ではリーダー未設定を許します。従来案件のリーダーはNULLのまま保持します。

任意の `participantName`・`participantNameKana` は面談者IDから独立した案件情報として保存します。各200文字まで、かなはNFC正規化後のひらがな・スペース・長音・踊り字・中点を許します。従来案件は空文字の未登録状態です。

新しいスキルシートは任意の `attachment:{name,contentBase64}` で共通1件だけを受け、`project_attachments` に保存します。旧形式の非空 `attachments` 配列は拒否します。`POST /api/requests/{id}/attachment` は担当営業が案件共通ファイルを追加／差し替え、`GET` は対象依頼の本人または担当営業に配信します。各人の依頼URLから同じ共通ファイルを取得でき、案件外の学生・リーダーは取得できません。

既存の `request_attachments` は自動共有・削除しません。共通が未登録の間だけ旧本人添付を返し、明示的な共通ファイル登録後は共通を優先します。メタデータの `scope` は `project` または `request` で区別します。

`POST /api/events/{id}/feedback` / `POST /api/events/{id}/entry`

`POST /api/events/{id}/acknowledge`（JSON `{}`）はエンジニア本人だけが利用できます。面談は合否確定後の結果確認、初回入場は完了確認として `scheduled_events.engineer_confirmed_at` を保存します。再送しても同じ日時を保持し、営業の予定・所感・通知は変更しません。APIは参照用の親面談を含む全予定を返し、エンジニア画面が未確認の予定と確認済みの「入場中」を分類します。

`POST /api/tasks/{key}/acknowledge` は営業が対応内容を確認したことを保存します。対応の完了とは別の状態で、確認しても対応待ちは残ります。候補回答が再提出されると版が増え、以前の確認済み状態を引き継がず未確認に戻ります。所感提出後は営業向けの合否・初回入場登録タスクに切り替わります。

確認状態は `task_acknowledgements` に利用者ごとに保存します。タスクの有効条件は `active_tasks` ビューを一覧表示と確認APIで共有し、元の依頼・面談をロックして古い版や完了済みタスクの確認を拒否します。確認APIは通知を作成しません。

日時入力は日本時間のISOローカル日時です。保存はPostgreSQLトランザクションで行い、同じ依頼・面談への変更を行ロックし、重複確定を防ぎます。

## 検証

```powershell
.\backend\verify.ps1
# 案件データが空で、アカウントだけ残っている状態の確認
.\backend\verify.ps1 -Empty
node .\backend\verify-lifecycle.mjs
# Java再起動後の保存確認
node .\backend\verify-lifecycle.mjs --persisted
# 統合テスト自身が作った案件だけを削除
node .\backend\verify-lifecycle.mjs --cleanup
# 日時未指定・日付指定・開始時刻だけの確定を確認し、この実行の検証案件を削除
node .\backend\verify-availability.mjs
# 実際のJava再起動を挟んで保存を確認（検証案件を一時保持）
node .\backend\verify-availability.mjs --prepare
.\scripts\start-backend.ps1 -Restart
node .\backend\verify-availability.mjs --persisted
# 保存確認をせず、一時保持した検証案件だけを削除する場合
node .\backend\verify-availability.mjs --cleanup
```

`verify-lifecycle.mjs` は専用の「統合確認」案件を作成し、依頼→回答→確定→所感37問→初回入場、権限・所有者・不正入力・重複操作を確認します。

`verify-availability.mjs` は日時未指定・日付指定、複数人の独立した提案、再回答と古い候補の拒否、終了未指定の確定、従来形式との互換性・権限・入力検証を確認します。通常実行は成功・失敗時とも自身が作成した検証案件だけを削除し、既存行が変わっていないことも照合します。`--prepare` は再起動確認用の案件と状態を `.local/availability-test-state.json` に保持します。Java再起動後の `--persisted` は保存内容を照合して検証案件を削除し、`--cleanup` は照合を省いて削除します。

ログは `.local/api.log`・`.local/api-error.log`・`.local/postgres.log` に出力します。
