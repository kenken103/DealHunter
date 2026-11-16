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

-- Apply the approved demo teams once; later membership changes remain intact.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_migrations WHERE version='demo-leader-teams-v1') THEN
  INSERT INTO leader_members(leader_id,student_id) VALUES
  ('leader-sato','student-takahashi'),('leader-sato','student-yamamoto'),
  ('leader-sato','student-mori'),('leader-sato','student-ito'),('leader-sato','student-kobayashi'),
  ('leader-suzuki','student-sasaki'),('leader-suzuki','student-tanaka'),
  ('leader-suzuki','student-kimura'),('leader-suzuki','student-inoue')
  ON CONFLICT(student_id) DO NOTHING;
  INSERT INTO app_migrations(version) VALUES('demo-leader-teams-v1');
 END IF;
END $$;
