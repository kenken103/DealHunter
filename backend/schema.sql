CREATE TABLE IF NOT EXISTS app_users (
    id text PRIMARY KEY,
    display_name text NOT NULL,
    role text NOT NULL CHECK (role IN ('sales', 'student', 'leader', 'admin'))
);

CREATE TABLE IF NOT EXISTS interviewer_availability_slots (
    id text PRIMARY KEY,
    student_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    start_at timestamp NOT NULL,
    end_at timestamp NOT NULL,
    CHECK (start_at < end_at AND start_at::date = end_at::date)
);
CREATE INDEX IF NOT EXISTS interviewer_availability_by_student
    ON interviewer_availability_slots(student_id, start_at);

-- Upgrade only the known application-role check, preserving every existing user.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_users'::regclass AND conname='app_users_role_check'
   AND position('admin' IN pg_get_constraintdef(oid))=0) THEN
  ALTER TABLE app_users DROP CONSTRAINT app_users_role_check;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_users'::regclass AND conname='app_users_role_check') THEN
  ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK(role IN('sales','student','leader','admin'));
 END IF;
END $$;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS account_access_codes (
    email text NOT NULL,
    purpose text NOT NULL CHECK(purpose IN ('invite','reset')),
    approved_role text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    issued_by text REFERENCES app_users(id) ON DELETE SET NULL,
    PRIMARY KEY (email,purpose)
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS demo_login_profile text
    CHECK (demo_login_profile IN ('legacy-sales','legacy-student','legacy-leader','workbook'));
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique_idx ON app_users(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS interview_request_drafts (
    id text PRIMARY KEY,
    sales_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    filename text,
    attachment bytea,
    CHECK ((filename IS NULL) = (attachment IS NULL)),
    CHECK (octet_length(attachment) BETWEEN 1 AND 5242880)
);
CREATE INDEX IF NOT EXISTS request_drafts_by_sales ON interview_request_drafts(sales_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY,
    name text NOT NULL,
    sales_id text NOT NULL REFERENCES app_users(id),
    notes text NOT NULL DEFAULT ''
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS leader_id text REFERENCES app_users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS participant_name text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS participant_name_kana text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS upper_company text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_company text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prime_company text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS remarks text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS executor_name text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS follower_names text[] NOT NULL DEFAULT '{}' CHECK(array_position(follower_names,NULL) IS NULL AND cardinality(follower_names)<=30);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS total_rounds integer NOT NULL DEFAULT 1 CHECK(total_rounds BETWEEN 1 AND 5);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS edit_revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS project_handoffs (
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    changed_by text NOT NULL REFERENCES app_users(id),
    old_sales_id text NOT NULL, new_sales_id text NOT NULL,
    old_leader_id text, new_leader_id text
);
CREATE INDEX IF NOT EXISTS projects_leader_idx ON projects(leader_id) WHERE leader_id IS NOT NULL;

-- Workbook history may contain only a date, or no date at all. It is not a scheduled event.
CREATE TABLE IF NOT EXISTS project_import_history (
    project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    student_id text REFERENCES app_users(id),
    source_row integer NOT NULL UNIQUE CHECK (source_row > 0),
    source_number text NOT NULL DEFAULT '',
    interview_date date,
    entry_date date,
    entry_date_text text NOT NULL DEFAULT '',
    outcome text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('joined', 'rejected', 'declined', 'unknown')),
    prime_contractor text NOT NULL DEFAULT '',
    source_data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS project_import_history_student_idx ON project_import_history(student_id);

-- Keep each previously saved end company within the visibility of its project.
-- Names are trimmed at the API boundary; project display values stay unchanged.
CREATE TABLE IF NOT EXISTS project_end_companies (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(name<>''),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_end_companies_project_idx ON project_end_companies(project_id);
-- Legacy names can exceed the B-tree key size. Writers lock the student's row;
-- sales_id identifies the salesperson who can remove each shared NG registration.
CREATE TABLE IF NOT EXISTS interviewer_company_restrictions (
 sales_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 student_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 company_role text NOT NULL CHECK(company_role IN ('end','upper','all')),
 company_name text NOT NULL CHECK(company_name<>'')
);
CREATE INDEX IF NOT EXISTS interviewer_company_restrictions_owner_idx ON interviewer_company_restrictions(sales_id,student_id,company_role);
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid='interviewer_company_restrictions'::regclass
   AND conname='interviewer_company_restrictions_company_role_check'
   AND position('''all''' IN pg_get_constraintdef(oid))=0
 ) THEN
  ALTER TABLE interviewer_company_restrictions DROP CONSTRAINT interviewer_company_restrictions_company_role_check;
  ALTER TABLE interviewer_company_restrictions ADD CONSTRAINT interviewer_company_restrictions_company_role_check
   CHECK(company_role IN ('end','upper','all'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS project_attachments (
 project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 filename text NOT NULL,
 content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_events (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    student_id text NOT NULL REFERENCES app_users(id),
    event_date date NOT NULL,
    start_time time NOT NULL,
    end_time time,
    kind text NOT NULL CHECK (kind IN ('meet', 'entry')),
    route text NOT NULL,
    format text NOT NULL,
    CHECK (end_time IS NULL OR end_time > start_time)
);

CREATE TABLE IF NOT EXISTS interview_questions (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    title text NOT NULL,
    tag text NOT NULL,
    context text NOT NULL,
    display_order integer NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_tasks (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    student_id text NOT NULL REFERENCES app_users(id),
    owner_role text NOT NULL CHECK (owner_role IN ('sales', 'student')),
    title text NOT NULL,
    body text NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduled_events_date_idx ON scheduled_events(event_date, start_time);
CREATE INDEX IF NOT EXISTS scheduled_events_project_idx ON scheduled_events(project_id);
CREATE INDEX IF NOT EXISTS interview_questions_project_idx ON interview_questions(project_id);

CREATE TABLE IF NOT EXISTS app_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- Replace the legacy fallback titles generated for unnamed imported projects.
DO $$ BEGIN
 INSERT INTO app_migrations(version) VALUES('workbook-project-unnamed-title-v1') ON CONFLICT DO NOTHING;
 IF FOUND THEN
  UPDATE projects p
  SET name = '案件名未登録'
  FROM project_import_history h
  WHERE p.id = h.project_id
    AND h.source_data ? '案件名'
    AND coalesce(h.source_data->>'案件名', '') ~ '^[[:space:]　]*$'
    AND p.name = format('案件名未記入（Excel %s行目）', h.source_row);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS leader_members (
 leader_id text NOT NULL REFERENCES app_users(id), student_id text NOT NULL UNIQUE REFERENCES app_users(id),
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(leader_id,student_id), CHECK(leader_id<>student_id)
);
CREATE TABLE IF NOT EXISTS recruitments (
 id text PRIMARY KEY, project_id text NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','assigned')),
 schedule_mode text NOT NULL CHECK(schedule_mode IN('candidates','availability')),
 requested_dates date[] NOT NULL DEFAULT '{}' CHECK(array_position(requested_dates,NULL) IS NULL AND (schedule_mode='availability' OR cardinality(requested_dates)=0)),
 created_at timestamptz NOT NULL DEFAULT now(), assigned_at timestamptz
);
ALTER TABLE recruitments ADD COLUMN IF NOT EXISTS ng_review jsonb;
CREATE TABLE IF NOT EXISTS recruitment_candidate_slots (
 id text PRIMARY KEY, recruitment_id text NOT NULL REFERENCES recruitments(id) ON DELETE CASCADE,
 start_at timestamp NOT NULL, end_at timestamp,
 CHECK(end_at IS NULL OR (end_at>start_at AND end_at::date=start_at::date)), UNIQUE(recruitment_id,start_at)
);
ALTER TABLE recruitments ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
CREATE TABLE IF NOT EXISTS interview_requests (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), student_id text NOT NULL REFERENCES app_users(id),
 status text NOT NULL CHECK (status IN ('requested','responded','confirmed')), confirmed_slot_id text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS schedule_mode text NOT NULL DEFAULT 'candidates' CHECK (schedule_mode IN ('candidates','availability'));
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS requested_dates date[] NOT NULL DEFAULT '{}' CHECK (array_position(requested_dates,NULL) IS NULL AND (schedule_mode='availability' OR cardinality(requested_dates)=0));
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS recruitment_id text REFERENCES recruitments(id);
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS interview_round integer NOT NULL DEFAULT 1 CHECK(interview_round BETWEEN 1 AND 5);
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS total_rounds integer NOT NULL DEFAULT 1 CHECK(total_rounds BETWEEN interview_round AND 5);
CREATE INDEX IF NOT EXISTS interview_requests_project_idx ON interview_requests(project_id);
CREATE INDEX IF NOT EXISTS interview_requests_recruitment_idx ON interview_requests(recruitment_id) WHERE recruitment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS request_attachments (
 request_id text PRIMARY KEY REFERENCES interview_requests(id) ON DELETE CASCADE,
 filename text NOT NULL,
 content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidate_slots (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES interview_requests(id), start_at timestamp NOT NULL, end_at timestamp,
 available boolean NOT NULL DEFAULT false, CHECK (end_at > start_at AND end_at::date = start_at::date)
);
-- Keep existing durations; newly supplied start-only candidates have no assumed end.
ALTER TABLE candidate_slots ALTER COLUMN end_at DROP NOT NULL;
CREATE INDEX IF NOT EXISTS candidate_slots_request_idx ON candidate_slots(request_id,start_at);
ALTER TABLE candidate_slots ADD COLUMN IF NOT EXISTS interview_round integer NOT NULL DEFAULT 1 CHECK(interview_round BETWEEN 1 AND 5);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS request_id text REFERENCES interview_requests(id);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS meeting_url text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS meeting_place text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS guidance text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','feedback-submitted','entry-registered'));
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','passed','rejected'));
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS parent_event_id text REFERENCES scheduled_events(id);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS engineer_confirmed_at timestamptz;
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS interview_round integer NOT NULL DEFAULT 1 CHECK(interview_round BETWEEN 1 AND 5);
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='scheduled_events'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%result%' AND pg_get_constraintdef(oid) NOT LIKE '%offered%' LOOP
  EXECUTE format('ALTER TABLE scheduled_events DROP CONSTRAINT %I',item.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='scheduled_events'::regclass AND conname='scheduled_events_result_workflow_check') THEN
  ALTER TABLE scheduled_events ADD CONSTRAINT scheduled_events_result_workflow_check CHECK(result IN('pending','passed','rejected','advanced','offered','declined'));
 END IF;
END $$;
DROP INDEX IF EXISTS event_request_meet_idx;
CREATE UNIQUE INDEX IF NOT EXISTS event_request_round_meet_idx ON scheduled_events(request_id,interview_round) WHERE kind='meet';
CREATE UNIQUE INDEX IF NOT EXISTS event_parent_entry_idx ON scheduled_events(parent_event_id) WHERE kind = 'entry';
CREATE TABLE IF NOT EXISTS interview_feedback (
 id text PRIMARY KEY, event_id text NOT NULL UNIQUE REFERENCES scheduled_events(id), student_id text NOT NULL REFERENCES app_users(id),
 duties text NOT NULL, process text NOT NULL, remote text NOT NULL, impression text NOT NULL, submitted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview_questions ADD COLUMN IF NOT EXISTS event_id text REFERENCES scheduled_events(id);
ALTER TABLE interview_questions ADD COLUMN IF NOT EXISTS feedback_id text REFERENCES interview_feedback(id);
ALTER TABLE interview_feedback ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS interview_feedback_drafts (
 event_id text PRIMARY KEY REFERENCES scheduled_events(id) ON DELETE CASCADE,
 base_revision integer NOT NULL, version integer NOT NULL, content jsonb NOT NULL,
 saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interview_feedback_edits (
 feedback_id text NOT NULL REFERENCES interview_feedback(id) ON DELETE CASCADE,
 revision integer NOT NULL, edited_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL, previous jsonb NOT NULL, PRIMARY KEY(feedback_id,revision)
);
CREATE TABLE IF NOT EXISTS lark_cancellation_notifications (
 id uuid PRIMARY KEY, recipient_id text NOT NULL REFERENCES app_users(id), message text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
ALTER TABLE lark_cancellation_notifications ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS lark_cancellation_project_idx ON lark_cancellation_notifications(project_id);
CREATE INDEX IF NOT EXISTS lark_cancellation_pending_idx ON lark_cancellation_notifications(next_attempt_at,id) WHERE sent_at IS NULL;
-- Before its first send attempt the queue timestamp is the same as the source cancellation.
WITH cancellations AS (
 SELECT project_id,student_id AS recipient_id,cancelled_at FROM interview_requests WHERE cancelled_at IS NOT NULL
 UNION ALL
 SELECT a.project_id,p.leader_id,a.cancelled_at FROM recruitments a JOIN projects p ON p.id=a.project_id WHERE a.cancelled_at IS NOT NULL
), resolved AS (
 SELECT n.id,min(s.project_id) AS project_id
 FROM lark_cancellation_notifications n JOIN cancellations s
 ON s.recipient_id=n.recipient_id AND s.cancelled_at=n.next_attempt_at
 WHERE n.project_id IS NULL AND n.attempts=0 AND n.sent_at IS NULL
 GROUP BY n.id HAVING count(DISTINCT s.project_id)=1
)
UPDATE lark_cancellation_notifications n SET project_id=r.project_id FROM resolved r WHERE r.id=n.id;
CREATE TABLE IF NOT EXISTS notification_previews (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), recipient_id text NOT NULL REFERENCES app_users(id),
 kind text NOT NULL CHECK (kind IN ('lark','calendar')), title text NOT NULL, lines jsonb NOT NULL, body text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_previews_project_idx ON notification_previews(project_id);

ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS task_revision bigint NOT NULL DEFAULT 1 CHECK (task_revision > 0);
CREATE TABLE IF NOT EXISTS task_acknowledgements (
 user_id text NOT NULL REFERENCES app_users(id),
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_key text NOT NULL,
 revision bigint NOT NULL CHECK (revision > 0),
 acknowledged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id,task_key)
);
CREATE INDEX IF NOT EXISTS task_acknowledgements_project_idx ON task_acknowledgements(project_id);

ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS response_kind text NOT NULL DEFAULT 'none'
 CHECK(response_kind IN ('none','available','alternative','unavailable'));
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS response_note text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS response_deadline timestamp;
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS response_deadline timestamp;
ALTER TABLE interview_requests ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
CREATE TABLE IF NOT EXISTS placement_exits (
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 student_id text NOT NULL REFERENCES app_users(id), ended_on date NOT NULL,
 reason text NOT NULL DEFAULT '', updated_by text NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,student_id)
);
ALTER TABLE candidate_slots ADD COLUMN IF NOT EXISTS proposed boolean NOT NULL DEFAULT false;
ALTER TABLE candidate_slots ADD COLUMN IF NOT EXISTS open_ended boolean NOT NULL DEFAULT false CHECK(NOT open_ended OR end_at IS NULL);
DO $$ BEGIN
 INSERT INTO app_migrations(version) VALUES('v13-legacy-interview-responses') ON CONFLICT DO NOTHING;
 IF FOUND THEN
  UPDATE interview_requests SET response_kind='available' WHERE status IN ('responded','confirmed') AND response_kind='none';
  UPDATE candidate_slots s SET proposed=true FROM interview_requests r WHERE r.id=s.request_id AND
   r.interview_round=s.interview_round AND r.schedule_mode='availability' AND s.available AND NOT s.proposed;
 END IF;
END $$;

ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS schedule_state text NOT NULL DEFAULT 'scheduled'
 CHECK(schedule_state IN ('scheduled','postponed','cancelled'));
CREATE INDEX IF NOT EXISTS entry_student_day_idx ON scheduled_events(student_id,event_date)
 WHERE kind='entry' AND schedule_state='scheduled';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS notice_revision bigint NOT NULL DEFAULT 1 CHECK(notice_revision>0);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS notice_read_at timestamptz;
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS prep_start timestamp;
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS prep_url text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS emergency_contact text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS meeting_id text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS passcode text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS client_feedback text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS share_feedback boolean NOT NULL DEFAULT false;
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS change_reason text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS event_notice_history (
 event_id text NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
 revision bigint NOT NULL, state text NOT NULL, start_at timestamp NOT NULL,
 reason text NOT NULL DEFAULT '', changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,revision)
);
ALTER TABLE event_notice_history ADD COLUMN IF NOT EXISTS end_at timestamp;
ALTER TABLE event_notice_history ADD COLUMN IF NOT EXISTS prep_start timestamp;
ALTER TABLE event_notice_history ADD COLUMN IF NOT EXISTS meeting_place text;
ALTER TABLE event_notice_history ADD COLUMN IF NOT EXISTS guidance text;

-- One authoritative task definition shared by dashboard reads and acknowledgements.
CREATE OR REPLACE VIEW active_tasks AS
 SELECT 'request-'||r.id AS key,p.id AS project_id,p.sales_id,r.student_id,p.name AS project,u.display_name AS person,'営業' AS owner,
 CASE WHEN r.response_kind='unavailable' THEN '候補日時を再調整' ELSE '面談日時を確定' END AS title,
 CASE WHEN r.response_kind='unavailable' THEN '全候補不可の回答です。新しい日程を依頼してください。' ELSE '面談者の回答から日程を選択してください。URLは後から登録できます。' END AS body,
 'schedule' AS action,r.id AS request_id,NULL::text AS event_id,r.task_revision AS revision,NULL::text AS recruitment_id
 FROM interview_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id WHERE r.status='responded' AND r.cancelled_at IS NULL
 UNION ALL
 SELECT 'overdue-'||r.id,p.id,p.sales_id,r.student_id,p.name,u.display_name,'営業','日程回答の期限超過',
 '本人の回答状況を確認し、必要に応じてリマインドしてください。','schedule',r.id,NULL::text,r.task_revision,NULL::text
 FROM interview_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id
 WHERE r.status='requested' AND r.cancelled_at IS NULL AND r.response_deadline <= (now() AT TIME ZONE 'Asia/Tokyo')
 UNION ALL
 SELECT 'entry-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'営業','初回入場を登録','合格した案件の集合日時・場所・当日の案内を登録してください。',
 'entry',e.request_id,e.id,1::bigint,NULL::text FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id
 WHERE e.kind='meet' AND e.result IN('passed','offered') AND NOT EXISTS(SELECT 1 FROM scheduled_events en WHERE en.parent_event_id=e.id)
 UNION ALL
 SELECT 'feedback-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'受講者','面談所感の提出待ち','業務内容・工程・リモート頻度・感想・質問の記録を待っています。',
 'feedback',e.request_id,e.id,1::bigint,NULL::text FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id
 WHERE e.kind='meet' AND e.schedule_state='scheduled' AND e.result='pending' AND NOT EXISTS(SELECT 1 FROM interview_feedback f WHERE f.event_id=e.id)
 AND e.event_date + COALESCE(e.end_time,e.start_time) <= CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo'
 UNION ALL
 SELECT 'result-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'営業','面談結果・初回入場を登録','受講者から面談所感が届きました。内容を確認し、合否と初回入場の案内を登録してください。',
 'entry',e.request_id,e.id,f.revision::bigint,NULL::text FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id JOIN interview_feedback f ON f.event_id=e.id
 WHERE e.kind='meet' AND e.schedule_state='scheduled' AND e.result='pending'
 UNION ALL
 SELECT 'notice-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'営業',
 CASE WHEN e.schedule_state='postponed' THEN '延期した面談の日程を再調整'
      WHEN e.meeting_url='' AND e.prep_start IS NOT NULL AND e.prep_url='' THEN '事前打合せ・本面談のURLを登録'
      WHEN e.meeting_url='' THEN '本面談URLを登録'
      ELSE '事前打合せURLを登録' END,
 CASE WHEN e.schedule_state='postponed' THEN '新しい日程が決まったら面談者へ案内してください。' ELSE '日時は確定済みです。URLが届いたら同じ予定に追記してください。' END,
 'notice',e.request_id,e.id,e.notice_revision,NULL::text
 FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id
 WHERE e.kind='meet' AND e.result='pending' AND e.status='scheduled' AND
 (e.schedule_state='postponed' OR (e.schedule_state='scheduled' AND (e.meeting_url='' OR (e.prep_start IS NOT NULL AND e.prep_url=''))))
 UNION ALL
 SELECT 'assignment-'||a.id,p.id,p.sales_id,NULL::text,p.name,'面談者未定','リーダー','面談者を選定','担当リーダーが自分の部下から面談者を1名以上選択してください。',
 'assign',NULL::text,NULL::text,1::bigint,a.id FROM recruitments a JOIN projects p ON p.id=a.project_id WHERE a.status='pending' AND a.cancelled_at IS NULL;
