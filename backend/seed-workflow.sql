-- Applied once via app_migrations. Never overwrite saved user changes on restart.
UPDATE scheduled_events SET meeting_url='https://meet.example/' || lower(id) WHERE kind='meet' AND meeting_url='';
UPDATE scheduled_events SET meeting_place=format,guidance=p.notes FROM projects p WHERE kind='entry' AND p.id=scheduled_events.project_id;
INSERT INTO projects(id,name,sales_id,notes) VALUES
('DH-1050','金融機関向け顧客管理API開発','sales-aoki','Java APIの開発案件です。候補日時から参加可能な枠を回答してください。'),
('DH-1051','社内ワークフローシステム改修','sales-aoki','面談後の所感と聞かれた質問を記録するためのデモ案件です。') ON CONFLICT DO NOTHING;
INSERT INTO interview_requests(id,project_id,student_id,status) VALUES
('R-DEMO-TAKAHASHI','DH-1050','student-takahashi','requested'),
('R-DEMO-TANAKA','DH-1040','student-tanaka','responded') ON CONFLICT DO NOTHING;
INSERT INTO candidate_slots(id,request_id,start_at,end_at,available) VALUES
('S-TAKAHASHI-1','R-DEMO-TAKAHASHI','2026-11-12 14:00','2026-11-12 14:45',false),
('S-TAKAHASHI-2','R-DEMO-TAKAHASHI','2026-11-13 15:00','2026-11-13 15:45',false),
('S-TANAKA-1','R-DEMO-TANAKA','2026-11-09 13:00','2026-11-09 14:00',true),
('S-TANAKA-2','R-DEMO-TANAKA','2026-11-10 15:00','2026-11-10 16:00',true) ON CONFLICT DO NOTHING;
INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,end_time,kind,route,format,meeting_url,status,result) VALUES
('DH-DEMO-FEEDBACK','DH-1051','student-takahashi','2026-11-04','14:00','14:45','meet','一次面談','オンライン','https://meet.example/workflow','scheduled','pending'),
('DH-1041-MEET','DH-1041','student-kimura','2026-11-04','10:00','10:45','meet','一次面談','オンライン','https://meet.example/cloud','feedback-submitted','passed'),
('DH-1042-MEET','DH-1042','student-inoue','2026-11-04','16:00','16:45','meet','一次面談','オンライン','https://meet.example/portal','scheduled','pending') ON CONFLICT DO NOTHING;
INSERT INTO interview_feedback(id,event_id,student_id,duties,process,remote,impression) VALUES
('F-DEMO-KIMURA','DH-1041-MEET','student-kimura','クラウド移行作業','設計・実装・テスト','週3日リモート','業務内容と担当範囲を確認しました。') ON CONFLICT DO NOTHING;
