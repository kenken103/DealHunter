-- Login accounts only. Case data is registered through the application.
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
('student-inoue', '井上 葵', 'student'),
('leader-sato', '佐藤 健一', 'leader'),
('leader-suzuki', '鈴木 遥', 'leader')
ON CONFLICT (id) DO NOTHING;
