# DealHunter

SESの面談依頼から日程回答・所感・合否・初回入場までを確認できるローカルデモです。ログイン後、営業／エンジニア（受講者）／リーダーそれぞれのホームへ進みます。Next.js＋TypeScript、Java、PostgreSQLで構成しています。

## 起動

必要環境：Git、Node.js 20.9以降（npmを含む）、JDK 21以降、PostgreSQL 17。付属の起動スクリプトはWindows PowerShell用です。初回は依存ライブラリを取得するため、インターネット接続が必要です。

初めて取得する場合は、PowerShellで次を実行します。取得済みならプロジェクトのフォルダで `npm.cmd run demo` だけを実行してください。

```powershell
git clone https://github.com/kenken103/DealHunter.git
cd DealHunter
npm.cmd run demo
```

初回は `npm ci`、Java依存ライブラリ（PostgreSQL JDBC・Jackson）の取得、専用DBの初期化を自動実行します。その後、Java API・PostgreSQL・Next.jsが起動します。ターミナルを開いたまま、次へアクセスしてください。

[ログイン画面を開く](http://127.0.0.1:3100/login)

未ログインの場合はログイン画面へ進みます。画面のデモアカウントボタンで入力し、「ログイン」を押してください。

| 区分 | メールアドレス | デモパスワード | 遷移先 |
| --- | --- | --- | --- |
| 営業（青木 美咲） | sales.aoki@dealhunter.example | demo-sales | `/sales` 営業ホーム |
| エンジニア（高橋 蓮） | engineer.takahashi@dealhunter.example | demo-engineer | `/engineer` 自分の予定・依頼・所感 |
| リーダー（佐藤 健一） | leader.sato@dealhunter.example | demo-leader | `/leader` 担当案件の継続閲覧 |
| リーダー（鈴木 遥） | leader.suzuki@dealhunter.example | demo-leader | `/leader` 担当案件の継続閲覧 |

区分はサーバーに登録したアカウントで判定します。各画面の「ログアウト」でログイン画面へ戻れます。

エンジニアはログイン画面の選択欄で9名、リーダーは2名を切り替えられます。エンジニアのデモパスワードは共通で `demo-engineer`、リーダーは `demo-leader` です。リーダーは受講者側の閲覧用区分で、営業の操作や面談者本人の回答を代行できません。

`JAVA_HOME` が設定されていなければPATH上のJavaを、`DEALHUNTER_POSTGRES_BIN` が未設定ならPATH上の `psql.exe` のフォルダを使います。自動検出できない場合は、インストール先に合わせて設定してから起動します。

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
$env:DEALHUNTER_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\17\bin'
npm.cmd run demo
```

フロントエンドはCtrl+Cで終了します。Java APIと専用PostgreSQLも停止する場合：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-backend.ps1
```

停止しても登録データは残ります。別のPowerShellで停止する場合は、起動時と同じ `DEALHUNTER_POSTGRES_BIN` の設定を使ってください。

## 個別起動・再起動

依存関係を `npm.cmd ci` で取得後、次の順で実行できます。Javaソースはバックエンド起動時にコンパイルされるため、MavenやGradleの実行は不要です。

```powershell
# Java APIと専用PostgreSQLをバックグラウンド起動
npm.cmd run backend
# フロントエンドを起動（Ctrl+Cで終了）
npm.cmd run dev
```

Javaの変更を反映するときは、次を実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-backend.ps1 -Restart
```

本番ビルドをローカル確認する場合は `npm.cmd run backend`、`npm.cmd run build`、`npm.cmd start` の順に実行します。URLは開発時と同じです。

## 構成

- Next.js App Router / TypeScript / React：ログイン、営業ホーム、エンジニアホーム、リーダーホーム（`127.0.0.1:3100`）
- Java 21：JDK標準HTTPサーバーとJDBCによる業務API（`127.0.0.1:8080`）。Spring Bootは使用していません。
- PostgreSQL：案件・利用者・面談依頼・候補日時・回答・予定・所感・質問・通知プレビュー（`127.0.0.1:55432`）
- データ経路：ブラウザ → Next.jsの認証付きAPI → Java API → PostgreSQL

専用データベースは `.local/postgres` に作成します。既存PostgreSQLのデータや設定を変更しません。生成パスワードは `.local/database.password` に保存し、Git管理対象から除外しています。3つのサーバーはループバックでのみ待ち受けます。

## 今回の範囲

予定表の初期基準日は2026年11月5日、日本時間です。営業「青木 美咲」の担当案件と、その案件に紐づく各エンジニアのデータを共有します。新しいDBには利用者だけが登録され、案件関連データは空の状態から開始します。営業の「面談依頼を作成」から登録して試せます。

- 「すべて／面談／初回入場」、日付・週・月移動、今日へ、直近予定への移動
- 選択した面談の日時・受講者・デモURL・案件別の過去質問
- 初回入場の集合時刻・集合場所・当日の案内
- 対応待ち総数／未確認数の表示、閲覧による確認済みの保存、再回答時の再未確認、質問集から該当案件への移動
- 営業による面談依頼の作成とDB保存、リーダー1名・面談者複数名・複数候補日時の選択
- 営業は面談の開始日時だけを入力。日時未指定、または日付だけを指定してエンジニアに空き日時を確認する依頼にも対応
- 空き日時の確認依頼には、エンジニアが参加できる日付・開始時刻を複数提案し、営業が回答から日時を確定
- 営業と各面談者が直接回答・日時確定を進め、リーダーは担当案件の全員の状態・概要・所感・結果・入場記録を継続閲覧
- エンジニアによる参加可能な候補日時の複数回答、営業による回答済み枠からの日時確定・URL登録
- エンジニアによる業務内容・作業工程・リモート頻度・感想・質問の登録
- 所感提出後の営業向け対応待ち、面談結果・初回入場案内の登録
- エンジニアによる面談結果の確認と予定一覧からの非表示、初回入場の完了確認、複数の「入場中」案件と概要の参照
- 面談者と別に参画者・参画者のひらがなを保存・表示
- 案件共通のスキルシート1件の添付、作成済み依頼への追加・差し替え、対象面談者と担当営業によるダウンロード（PDF／Excel／Word、5MB以下）
- 通知・カレンダー送信内容のローカルプレビュー
- スマートフォンでの詳細への移動と、選択した一覧行への復帰

ログイン済みアカウントに応じてホームと取得データが切り替わります。営業は担当案件、エンジニアは自分宛ての依頼と自分の予定・所感だけを取得・更新できます。リーダーは自分が設定された案件の全面談者を閲覧でき、すべての業務更新APIは拒否されます。同じ案件の過去質問は共有しますが、別面談者の所感本文はエンジニアへ返しません。Next.jsのセッションは署名・期限付きのHttpOnly Cookieで保持し、署名鍵は `.local/demo-auth.key` に保存します。

認証は公開された架空アカウントを使うローカルデモです。実アカウント管理・パスワード再設定・本番認証は未実装です。Java APIはNext.jsとの内部キー（`.local/api-key`）と利用者IDを検証し、DB上の区分と案件との関係を判定します。

業務入力はPostgreSQLに保存され、再読み込み・アカウント切り替え・再起動後も残ります。Lark通知の実送信と外部カレンダー登録は行わず、送信内容をローカル履歴として保存・表示します。初期面談URLは架空のデモ用URLです。

通し操作は [デモ操作ガイド](docs/demo-guide.md) を参照してください。
主要機能の実装状況と最新の検証結果は [機能確認表](docs/feature-status.md) にまとめています。

案件サンプルは起動時に自動投入しません。利用者は営業1名・エンジニア9名・リーダー2名です。既存DBがある場合は登録済みの業務データを引き継ぎ、再起動しても削除済みのサンプルは復活しません。従来案件のリーダーは自動では設定しません。

## 確認コマンド

アプリを起動した状態で、プロジェクトのフォルダから実行します。

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run verify:auth
powershell -NoProfile -ExecutionPolicy Bypass -File backend/verify.ps1
```

バックエンドの構成とAPIは [backend/README.md](backend/README.md)、通し操作の確認記録は [検証記録](docs/verification.md) を参照してください。

## 起動できない場合

- JDK／PostgreSQLが見つからない：上記の `JAVA_HOME`／`DEALHUNTER_POSTGRES_BIN` を、実際のインストール先に設定します。
- 依存関係の取得に失敗する：npmレジストリとMaven Centralへ接続できることを確認して、再実行します。
- ポートが使用中：`3100`（Next.js）・`8080`（Java）・`55432`（専用PostgreSQL）の使用状況を確認します。
- API／DBの起動に失敗する：`.local/api-error.log` と `.local/postgres.log` を確認します。Javaだけ再起動する場合は上記の `-Restart` を使います。

`.local` 内のDB・認証情報・ログと、生成された依存ライブラリはGit管理対象から除外しています。共有するのはソースコードで、各環境の保存済み案件や添付ファイルはリポジトリに含まれません。
