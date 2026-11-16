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

DB認証情報とAPIキーは `.local` 内に生成します。APIキーをクライアント側コード・公開環境変数に設定しないでください。ヘルス確認以外の全APIに内部キーが必要です。登録・ログイン・セッション用利用者照会は内部キーで呼び出し、業務API・管理APIは利用者IDも検証します。ブラウザはNext.jsの認証付き経路を利用します。

## 保存される操作

- 営業: 面談依頼作成、回答された候補から日時・URL確定、合否と初回入場登録。
- アカウント: `legarea.jp` のメールアドレス・氏名・パスワード・役割による新規登録、パスワードログイン。登録時の役割は営業・エンジニア・リーダーだけです。
- 管理者: 登録済み利用者の役割とエンジニアの所属リーダーを編集できます。既存の業務記録は削除せず、変更後のDB上の役割を次のリクエストから適用します。
- 新規依頼はリーダー1名を選び、営業が面談者を直接指定する `direct` と、面談者未定でリーダーへ選定を依頼する `leader` を選べます。後者は案件と選定依頼を先に保存し、面談者別の依頼は選定後に作成します。回答・確定・所感・入場は各人独立です。
- リーダー: `projects.leader_id` に自分が設定された案件の全履歴を閲覧できます。担当の未選定依頼について、自チームの部下を1名以上選ぶ操作だけを許可し、その他のPOSTは403で拒否します。
- 受講者: 自分宛て依頼の複数候補への回答、日時未指定・日付指定の依頼への開始日時の提案、確定前の回答変更、自分の面談所感・質問の提出。
- 所感の質問は1問ずつ面談・案件に紐づいて保存され、件数上限は設定していません。
- Lark通知とカレンダーは内容のプレビュー履歴だけを保存します。外部通信・実送信は行いません。
- 所感は一度提出すると参照のみです。確定済み日時や登録済み入場の重複登録は409で拒否します。
- デモを一度に試せるよう、未来日時の面談にも所感を提出できます。不合格の面談でも所感は記録できます。

起動時は `schema.sql` と `seed-users.sql`（既存デモ12名）を実行し、未設定のデモ認証情報と初期管理者を補います。既存の認証情報・役割・業務データは上書きしません。案件サンプルは自動投入せず、削除後に復活しません。`seed.sql`・`seed-workflow.sql`・`seed-student-entry.sql` は過去のサンプル資料として残していますが、起動処理からは実行しません。対応待ちは保存された依頼・所感・予定から算出します。

チーム所属は `leader_members` で管理します。承認済みデモ所属は、佐藤 健一の部下が高橋 蓮・山本 葵・森 彩乃・伊藤 航・小林 悠の5名、鈴木 遥の部下が佐々木 凛・田中 陸・木村 楓・井上 葵の4名です。`seed-users.sql` はこの所属を初回の移行で登録し、以降の再起動では変更済みの所属を上書きしません。

## API

### アカウント登録・認証・管理

- `POST /api/auth/register`：`{name,email,password,role}`。氏名は1〜100文字、パスワードは10〜128文字、役割は `student`／`leader`／`sales` です。メールは前後空白を除去して小文字化し、`legarea.jp` の完全一致ドメインだけを受理します。サブドメイン・類似ドメイン・末尾への文字列追加・制御文字は拒否します。不正入力は400、重複メールは409です。成功時に `{message,user:{id,name,role}}` を返します。
- `POST /api/auth/login`：`{email,password}`。DBの認証情報を検証し、`{user:{id,name,role}}` を返します。未登録・パスワード不一致は同じ401応答です。
- `GET /api/auth/users/{id}`：Next.jsが署名済みセッションの利用者IDから現在の役割・氏名を照会する内部APIです。役割をCookieやフォームの値から採用しません。
- `GET /api/admin/users`：管理者だけに `{users,leaders}` を返します。利用者の `id`・`name`・`email`・`role`・`leaderId`・`leaderName`・`isDemo` と、所属先候補のリーダー一覧を含みます。パスワードハッシュは返しません。
- `POST /api/admin/users/{id}`：管理者が `{role,leaderId?}` で役割と所属を編集します。役割は `student`／`leader`／`sales`／`admin`、所属先はエンジニアにだけ指定でき、`null` は所属なしです。エンジニア以外に変更すると、その人の部下としての所属は無効になります。

一般の登録APIは `admin` を拒否します。部下が所属中、または選定待ち案件を持つリーダーの降格は409です。先に部下の所属変更と面談者の選定を完了してください。最後の管理者の降格も409で拒否します。管理者の編集をトランザクションの排他ロック、通常操作を対応する共有ロックで保護し、役割の変更と古い権限での更新が競合しないようにしています。管理者はアカウント管理を利用し、営業・エンジニア・リーダーの業務更新を代行できません。

`app_users.email` と `password_hash` を追加し、メールの小文字表現に一意制約を設けています。パスワードは16バイトのランダムソルト付きPBKDF2-HMAC-SHA256（600,000回、256bit）でハッシュ化し、DBにはハッシュ方式・反復数・ソルト・ハッシュ値を保存します。公開デモ用のメール・パスワードは、未設定時だけ移行します。

管理者がまだいない初回起動時には、`admin@legarea.jp` の管理者を作成します。生成した初期パスワードは、その環境の `.local/initial-admin-password.txt` で確認してください。起動ログやAPI応答には出力せず、再起動で既存の認証情報をリセットしません。新規登録とパスワードログインは実装済みですが、メールの所有確認・パスワード再発行・HTTPSでの外部公開は未対応です。

ブラウザ側の登録は `/api/auth/register`、管理は `/api/admin/users`・`/api/admin/users/{id}` をNext.js経由で呼び出します。Next.jsはOrigin・JSON・セッションを検証し、登録成功時は署名付きセッションを作成して役割のホームへ進めます。

### 面談依頼・日程回答

`GET /api/health` / `GET /api/dashboard`

`POST /api/requests` / `POST /api/requests/{id}/respond` / `POST /api/requests/{id}/confirm`

新規作成の共通項目は `{project, summary, upperCompany, leaderId}` です。`upperCompany` は上位会社、任意の `endCompany` はエンド企業です。両端のUnicode空白を除去した後、上位会社は1〜200文字、エンド企業は200文字以内で受け付けます。`endCompany` の省略・空白のみは `""` で保存します。上位会社の省略・空白のみ、いずれかに `null` や非文字列を指定した場合は400で拒否し、部分保存しません。会社項目は `direct` の複数面談者・`leader`・旧 `studentId` 形式のすべての新規作成に適用します。`leaderId` は登録リーダーが必須です。面談者の決め方を `assignmentMode` で指定します。

- `assignmentMode:"direct"`（省略時も同じ）：`studentIds` に重複のない1名以上を指定します。案件と面談者別の依頼・候補枠を同一トランザクションで作成します。
- `assignmentMode:"leader"`：面談者未定の選定依頼を作成します。`studentIds` は省略または空配列、`studentId` は指定しません。案件・選定依頼・日程条件・任意の共通添付を保存し、この時点では面談者別の依頼を作成しません。

どちらの選定方法でも、日程の確認方法は次の項目で指定します。

- `scheduleMode:"candidates"`（省略時も同じ）：`candidates:[{start,end?}]` を1件以上指定します。`start` は `2026-11-20T13:00` のような日本時間の開始日時です。`end` は省略・NULLを許し、入力する場合は同日の開始より後にします。回答は `{slotIds:[候補ID,...]}` です。
- `scheduleMode:"availability"`：日時を決めずに参加可能な開始日時を尋ねます。`candidates` は省略または空配列にします。任意の `requestedDates:["2026-11-20",...]` で日付だけを指定でき、省略・空配列なら日付の制限もありません。回答は `{proposals:[{start:"2026-11-20T13:00"},...]}` で、終了日時は指定しません。指定日がある場合はその日付の開始日時だけを受け付けます。

回答はどちらも1件以上必要です。日付・開始日時の重複や、方式に合わない候補・回答の混在を拒否します。日時未指定方式の再回答は本人の提案だけを置き換え、対応待ちの版を更新します。営業は回答済みの候補IDを `{slotId,url}` で指定して確定します。確定後の回答変更は409です。

ダッシュボードの各依頼は `scheduleMode`・`requestedDates` と候補一覧を返します。候補の `end` は日時文字列またはNULLです。終了未指定の候補を確定しても終了時刻は補完せず、DBにNULLを保存します。従来の終了日時付き候補・予定はその値を保持します。

直接指定の返却は `projectId`・全員分の `requestIds`・本人へ直接届ける `previews` を含みます。リーダーへの選定依頼は `projectId`・`recruitmentId`・空の `requestIds` と、リーダー向け選定依頼のプレビューを返します。旧デモ検証との互換用に、`direct` では単独の `studentId` 形式も受理し、この旧形式ではリーダー未設定を許します。従来案件のリーダーはNULLのまま保持します。

### リーダーによる面談者の選定

`POST /api/recruitments/{id}/assign` は、担当リーダーが `{studentIds:["student-takahashi",...]}` だけを送信して利用します。自チームの有効な部下を、重複なしで1名以上指定してください。他のリーダーの案件は403、自チーム外の面談者や不正な入力は400、選定済みの依頼への再選定は409です。営業・エンジニアは選定を実行できません。

選定を確定すると、保存済みの日程条件を引き継いだ面談者別の依頼・候補枠を同一トランザクションで作成し、選定依頼を `pending` から `assigned` に更新します。以降は面談者本人の `/respond` と営業の `/confirm` を使用します。選定APIは日程回答・面談日時確定を代行しません。返却には作成した `requestIds`、各本人向けの `previews`、営業向けの選定完了 `salesPreview` を含みます。

`GET /api/dashboard` には次の配列を追加しています。

- `recruitments`：担当営業・担当リーダーに見える選定依頼。`id`、`projectId`、`project`、`summary`、`leaderId`、`leaderName`、`status`（`pending`／`assigned`）、`scheduleMode`、`requestedDates`、`candidates`、選定済みの `studentIds`、`attachment` を返します。エンジニアには空配列です。
- `teamMembers`：ログイン中のリーダーが選定できる、自チームの有効な部下一覧（`id`・`name`）。営業・エンジニアには空配列です。既存の `students` 配列とは用途を分けています。

選定前の担当営業画面には共通添付のファイル名を表示します。リーダーには添付のメタデータ・ダウンロード権限を与えず、選定後の本人と担当営業は既存の依頼添付APIを使用します。

### 案件情報・添付とその他のAPI

会社情報は `projects.upper_company`・`projects.end_company` に保存し、ダッシュボードの `projects`・`requests`・`recruitments`・`events` へ `upperCompany`・`endCompany` として返します。取得範囲は既存の担当・本人の権限に従います。既存案件には両列の既定値 `""` を追加し、会社名を推測したり上書きしたりしません。必須検証は新規作成時だけで、選定・日程回答・日時確定・初回入場は同じ案件の値を引き継ぎ、既存の未登録案件でも継続できます。

任意の `participantName`・`participantNameKana` は面談者IDから独立した案件情報として保存します。各200文字まで、かなはNFC正規化後のひらがな・スペース・長音・踊り字・中点を許します。従来案件は空文字の未登録状態です。

新しいスキルシートは任意の `attachment:{name,contentBase64}` で共通1件だけを受け、`project_attachments` に保存します。旧形式の非空 `attachments` 配列は拒否します。`POST /api/requests/{id}/attachment` は担当営業が案件共通ファイルを追加／差し替え、`GET` は対象依頼の本人または担当営業に配信します。各人の依頼URLから同じ共通ファイルを取得でき、案件外の学生・リーダーは取得できません。

既存の `request_attachments` は自動共有・削除しません。共通が未登録の間だけ旧本人添付を返し、明示的な共通ファイル登録後は共通を優先します。メタデータの `scope` は `project` または `request` で区別します。

`POST /api/events/{id}/feedback` / `POST /api/events/{id}/entry`

`POST /api/events/{id}/acknowledge`（JSON `{}`）はエンジニア本人だけが利用できます。面談は合否確定後の結果確認、初回入場は完了確認として `scheduled_events.engineer_confirmed_at` を保存します。再送しても同じ日時を保持し、営業の予定・所感・通知は変更しません。APIは参照用の親面談を含む全予定を返し、エンジニア画面が未確認の予定と確認済みの「入場中」を分類します。

`POST /api/tasks/{key}/acknowledge` は営業が対応内容を確認したことを保存します。対応の完了とは別の状態で、確認しても対応待ちは残ります。候補回答が再提出されると版が増え、以前の確認済み状態を引き継がず未確認に戻ります。所感提出後は営業向けの合否・初回入場登録タスクに切り替わります。

確認状態は `task_acknowledgements` に利用者ごとに保存します。タスクの有効条件は `active_tasks` ビューを一覧表示と確認APIで共有し、元の依頼・面談・選定依頼をロックして古い版や完了済みタスクの確認を拒否します。未選定の依頼は `action:"assign"`・`recruitmentId` を持つリーダー対応のタスクになり、営業からは選定状況を閲覧できます。確認APIは通知を作成しません。

日時入力は日本時間のISOローカル日時です。保存はPostgreSQLトランザクションで行い、同じ依頼・面談への変更を行ロックし、重複確定を防ぎます。

## 検証

会社項目を対象とする `node backend/verify-companies.mjs` の通し検証結果は確定前です。以下には過去の確認コマンドも含みます。

```powershell
.\backend\verify.ps1
# 案件データが空で、アカウント・チーム所属だけ残っている状態の確認
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
# リーダーへの面談者選定依頼・権限・同時選定・本人別日程の統合確認
node .\backend\verify-recruitment.mjs
# 所属・選定待ち／選定済み依頼・通知プレビューを実再起動後に照合
node .\backend\verify-recruitment.mjs --prepare
.\scripts\start-backend.ps1 -Restart
node .\backend\verify-recruitment.mjs --persisted
# 登録・ログイン・管理権限・役割変更とNext.js経由の確認
node .\backend\verify-accounts.mjs --with-frontend
# アカウント情報の実再起動後の保存確認
node .\backend\verify-accounts.mjs --with-frontend --prepare
.\scripts\start-backend.ps1 -Restart
node .\backend\verify-accounts.mjs --with-frontend --persisted
```

`verify-lifecycle.mjs` は専用の「統合確認」案件を作成し、依頼→回答→確定→所感37問→初回入場、権限・所有者・不正入力・重複操作を確認します。

`verify-availability.mjs` は日時未指定・日付指定、複数人の独立した提案、再回答と古い候補の拒否、終了未指定の確定、従来形式との互換性・権限・入力検証を確認します。通常実行は成功・失敗時とも自身が作成した検証案件だけを削除し、既存行が変わっていないことも照合します。`--prepare` は再起動確認用の案件と状態を `.local/availability-test-state.json` に保持します。Java再起動後の `--persisted` は保存内容を照合して検証案件を削除し、`--cleanup` は照合を省いて削除します。

`verify-recruitment.mjs` は面談者未定の依頼、担当リーダーと自チームに限定した選定、不正入力の原子的拒否、同時選定の重複防止、日程条件の引き継ぎ、本人別回答・日時確定と直接指定の互換性を確認します。所属変更が初期登録で戻されないこともロールバック付きで検証します。通常実行では自身の検証案件だけを削除して既存行の一致を照合します。`--prepare`／`--persisted`／`--cleanup` は同じ方式で `.local/recruitment-test-state.json` を使います。テスト中に他の操作で業務データを更新しないでください。

ログは `.local/api.log`・`.local/api-error.log`・`.local/postgres.log` に出力します。
