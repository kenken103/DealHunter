INSERT INTO app_users(id, display_name, role) VALUES
('sales-aoki', '青木 美咲', 'sales'),
('student-takahashi', '高橋 蓮', 'student'),
('student-yamamoto', '山本 葵', 'student'),
('student-mori', '森 彩乃', 'student'),
('student-ito', '伊藤 航', 'student'),
('student-kobayashi', '小林 悠', 'student'),
('student-sasaki', '佐々木 凛', 'student'),
('student-tanaka', '田中 陸', 'student'),
('student-kimura', '木村 楓', 'student'),
('student-inoue', '井上 葵', 'student')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects(id, name, sales_id, notes) VALUES
('DH-1027', '法人向け請求管理システム開発', 'sales-aoki', '請求書の発行・入金消込を支える業務システムの開発。Javaを使ったAPI設計と、トランザクション管理の経験を確認します。'),
('DH-1031', '会員アプリのAPI基盤開発', 'sales-aoki', '会員向けアプリの認証とAPI開発を担当。サーバーサイドの設計・実装経験を確認します。'),
('DH-1018', '物流会社向け在庫管理システム刷新', 'sales-aoki', '品川オフィス1階の総合受付に集合。担当者が入館手続きと開発チームへの合流を案内します。'),
('DH-1034', '販売管理システムの機能追加', 'sales-aoki', '受発注機能の拡張と帳票出力の改修を担当。要件の整理から結合テストまでの経験を確認します。'),
('DH-1023', '製造業向け生産管理システム改修', 'sales-aoki', '生産実績の収集と集計画面の改修を担当。既存システムの調査方法やテスト経験を確認します。'),
('DH-1032', '顧客ポータルの機能追加', 'sales-aoki', '顧客向けポータルの画面とAPIの機能追加を担当。フロントエンドとバックエンドの連携経験を確認します。'),
('DH-1040', 'ECサイトの決済基盤改修', 'sales-aoki', ''),
('DH-1041', '基幹システムのクラウド移行', 'sales-aoki', ''),
('DH-1042', '会員ポータル開発', 'sales-aoki', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO scheduled_events(id, project_id, student_id, event_date, start_time, end_time, kind, route, format) VALUES
('DH-1027', 'DH-1027', 'student-takahashi', '2026-11-06', '14:00', '14:45', 'meet', '一次面談', 'オンライン'),
('DH-1031', 'DH-1031', 'student-yamamoto', '2026-11-06', '16:30', '17:00', 'meet', '一次面談', 'オンライン'),
('DH-1018', 'DH-1018', 'student-mori', '2026-11-09', '09:30', NULL, 'entry', '初回入場', '品川オフィス'),
('DH-1034', 'DH-1034', 'student-ito', '2026-11-09', '13:00', '13:45', 'meet', '一次面談', 'オンライン'),
('DH-1023', 'DH-1023', 'student-kobayashi', '2026-11-10', '11:00', '11:45', 'meet', '二次面談', 'オンライン'),
('DH-1032', 'DH-1032', 'student-sasaki', '2026-11-11', '16:00', '16:45', 'meet', '一次面談', 'オンライン')
ON CONFLICT (id) DO NOTHING;

INSERT INTO interview_questions(id, project_id, title, tag, context, display_order) VALUES
('Q-018', 'DH-1027', '請求確定後の二重更新をどう防ぎましたか？', 'Java', '請求確定処理の実装経験について、同じ請求に対する更新が同時に実行された場合の挙動を聞かれました。', 1),
('Q-019', 'DH-1027', '障害時、どのログから原因を切り分けますか？', '障害対応', '月末の請求バッチが途中で止まった状況を想定し、最初に確認するログと調査の順番を聞かれました。', 2),
('Q-014', 'DH-1018', '既存SQLの実行計画はどこから確認しますか？', 'SQL', '在庫検索が遅くなったときの調査順序と、実行計画で注目する箇所を聞かれました。', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pending_tasks(id, project_id, student_id, owner_role, title, body) VALUES
('task-1', 'DH-1040', 'student-tanaka', 'sales', '面談日時を確定', '受講者から参加可能な候補が2件届いています。先方と調整して日時と面談URLを登録してください。'),
('task-2', 'DH-1041', 'student-kimura', 'sales', '初回入場を登録', '合格連絡を受領しました。確定した初回入場の日時・集合場所を登録してください。'),
('task-3', 'DH-1042', 'student-inoue', 'student', '面談所感の提出待ち', '受講者が業務内容・作業工程・リモート頻度・感想・聞かれた質問を記入する段階です。')
ON CONFLICT (id) DO NOTHING;
