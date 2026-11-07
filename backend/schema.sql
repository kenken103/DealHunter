CREATE TABLE IF NOT EXISTS app_users (
    id text PRIMARY KEY,
    display_name text NOT NULL,
    role text NOT NULL CHECK (role IN ('sales', 'student', 'leader'))
);

-- Upgrade only the known application-role check, preserving every existing user.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_users'::regclass AND conname='app_users_role_check'
   AND position('leader' IN pg_get_constraintdef(oid))=0) THEN
  ALTER TABLE app_users DROP CONSTRAINT app_users_role_check;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_users'::regclass AND conname='app_users_role_check') THEN
  ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK(role IN('sales','student','leader'));
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY,
    name text NOT NULL,
    sales_id text NOT NULL REFERENCES app_users(id),
    notes text NOT NULL DEFAULT ''
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS leader_id text REFERENCES app_users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS participant_name text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS participant_name_kana text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS projects_leader_idx ON projects(leader_id) WHERE leader_id IS NOT NULL;
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
CREATE INDEX IF NOT EXISTS interview_questions_project_idx ON interview_questions(project_id);

CREATE TABLE IF NOT EXISTS app_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS interview_requests (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), student_id text NOT NULL REFERENCES app_users(id),
 status text NOT NULL CHECK (status IN ('requested','responded','confirmed')), confirmed_slot_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS request_attachments (
 request_id text PRIMARY KEY REFERENCES interview_requests(id) ON DELETE CASCADE,
 filename text NOT NULL,
 content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidate_slots (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES interview_requests(id), start_at timestamp NOT NULL, end_at timestamp NOT NULL,
 available boolean NOT NULL DEFAULT false, CHECK (end_at > start_at AND end_at::date = start_at::date)
);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS request_id text REFERENCES interview_requests(id);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS meeting_url text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS meeting_place text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS guidance text NOT NULL DEFAULT '';
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','feedback-submitted','entry-registered'));
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','passed','rejected'));
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS parent_event_id text REFERENCES scheduled_events(id);
ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS engineer_confirmed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS event_request_meet_idx ON scheduled_events(request_id) WHERE kind = 'meet';
CREATE UNIQUE INDEX IF NOT EXISTS event_parent_entry_idx ON scheduled_events(parent_event_id) WHERE kind = 'entry';
CREATE TABLE IF NOT EXISTS interview_feedback (
 id text PRIMARY KEY, event_id text NOT NULL UNIQUE REFERENCES scheduled_events(id), student_id text NOT NULL REFERENCES app_users(id),
 duties text NOT NULL, process text NOT NULL, remote text NOT NULL, impression text NOT NULL, submitted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE interview_questions ADD COLUMN IF NOT EXISTS event_id text REFERENCES scheduled_events(id);
ALTER TABLE interview_questions ADD COLUMN IF NOT EXISTS feedback_id text REFERENCES interview_feedback(id);
CREATE TABLE IF NOT EXISTS notification_previews (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), recipient_id text NOT NULL REFERENCES app_users(id),
 kind text NOT NULL CHECK (kind IN ('lark','calendar')), title text NOT NULL, lines jsonb NOT NULL, body text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);

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

-- One authoritative task definition shared by dashboard reads and acknowledgements.
CREATE OR REPLACE VIEW active_tasks AS
 SELECT 'request-'||r.id AS key,p.id AS project_id,p.sales_id,r.student_id,p.name AS project,u.display_name AS person,'営業' AS owner,
 '面談日時を確定' AS title,'受講者の回答から候補日時を選び、面談URLを登録してください。' AS body,
 'schedule' AS action,r.id AS request_id,NULL::text AS event_id,r.task_revision AS revision
 FROM interview_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id WHERE r.status='responded'
 UNION ALL
 SELECT 'entry-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'営業','初回入場を登録','合格した案件の集合日時・場所・当日の案内を登録してください。',
 'entry',e.request_id,e.id,1::bigint FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id
 WHERE e.kind='meet' AND e.result='passed' AND NOT EXISTS(SELECT 1 FROM scheduled_events en WHERE en.parent_event_id=e.id)
 UNION ALL
 SELECT 'feedback-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'受講者','面談所感の提出待ち','業務内容・工程・リモート頻度・感想・質問の記録を待っています。',
 'feedback',e.request_id,e.id,1::bigint FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id
 WHERE e.kind='meet' AND NOT EXISTS(SELECT 1 FROM interview_feedback f WHERE f.event_id=e.id)
 AND (e.event_date <= DATE '2026-11-05' OR e.request_id IS NOT NULL)
 UNION ALL
 SELECT 'result-'||e.id,p.id,p.sales_id,e.student_id,p.name,u.display_name,'営業','面談結果・初回入場を登録','受講者から面談所感が届きました。内容を確認し、合否と初回入場の案内を登録してください。',
 'entry',e.request_id,e.id,1::bigint FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id
 WHERE e.kind='meet' AND e.result='pending' AND EXISTS(SELECT 1 FROM interview_feedback f WHERE f.event_id=e.id);
