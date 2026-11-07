-- Stable learner entry fixture independent of disposable integration-test data.
INSERT INTO projects(id,name,sales_id,notes) VALUES
('DH-1052','情報共有ポータル開発','sales-aoki','入場初日は開発環境の準備とチームへのご挨拶を行います。') ON CONFLICT DO NOTHING;
INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,meeting_place,guidance,result) VALUES
('DH-DEMO-ENTRY','DH-1052','student-takahashi','2026-11-09','09:00','entry','初回入場','大崎オフィス','大崎オフィス1階 総合受付','8:55までに総合受付へお越しください。本人確認書類と筆記用具をご持参ください。受付後、担当営業にご連絡ください。','passed') ON CONFLICT DO NOTHING;
