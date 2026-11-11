WITH viewer AS (SELECT id,role FROM app_users WHERE id = ?),
visible_projects AS (
 SELECT p.* FROM projects p CROSS JOIN viewer v
 WHERE (v.role='sales' AND p.sales_id=v.id) OR (v.role='student' AND (
 EXISTS(SELECT 1 FROM scheduled_events e WHERE e.project_id=p.id AND e.student_id=v.id)
 OR EXISTS(SELECT 1 FROM interview_requests r WHERE r.project_id=p.id AND r.student_id=v.id)))
 OR (v.role='leader' AND p.leader_id=v.id)
),
visible_events AS (
 SELECT e.* FROM scheduled_events e JOIN visible_projects p ON p.id=e.project_id CROSS JOIN viewer v
 WHERE v.role IN('sales','leader') OR e.student_id=v.id
),
visible_requests AS (
 SELECT r.* FROM interview_requests r JOIN visible_projects p ON p.id=r.project_id CROSS JOIN viewer v
 WHERE v.role IN('sales','leader') OR r.student_id=v.id
),
tasks AS (
 SELECT t.*,a.acknowledged_at FROM active_tasks t JOIN visible_projects p ON p.id=t.project_id CROSS JOIN viewer v
 LEFT JOIN task_acknowledgements a ON a.user_id=CASE WHEN v.role='leader' THEN t.sales_id ELSE v.id END AND a.task_key=t.key AND a.revision=t.revision
 WHERE v.role IN('sales','leader') OR t.student_id=v.id
)
SELECT jsonb_build_object(
 'events',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'key',e.id,'projectId',p.id,'date',extract(day FROM e.event_date)::integer,
 'time',to_char(e.start_time,'HH24:MI'),'end',COALESCE(to_char(e.end_time,'HH24:MI'),''),
 'project',p.name,'person',u.display_name,'studentId',u.id,'notes',p.notes,'route',e.route,'format',e.format,
 'entry',e.kind='entry','stamp',(extract(epoch FROM e.event_date::timestamp AT TIME ZONE 'UTC')*1000)::bigint,
 'type',e.kind,'requestId',e.request_id,'parentEventId',e.parent_event_id,'url',e.meeting_url,'meetingPlace',e.meeting_place,
 'guidance',e.guidance,'status',e.status,'result',e.result,'engineerConfirmedAt',e.engineer_confirmed_at,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana
 ) ORDER BY e.event_date,e.start_time,e.id) FROM visible_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id LEFT JOIN app_users lu ON lu.id=p.leader_id AND lu.role='leader'),'[]'::jsonb),
 'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',q.id,'project',q.project_id,'title',q.title,'tag',q.tag,'context',
 CASE WHEN v.role IN('sales','leader') OR q.feedback_id IS NULL OR EXISTS(SELECT 1 FROM interview_feedback f WHERE f.id=q.feedback_id AND f.student_id=v.id) THEN q.context ELSE '' END,'eventId',q.event_id)
 ORDER BY q.display_order,q.id) FROM interview_questions q JOIN visible_projects p ON p.id=q.project_id CROSS JOIN viewer v),'[]'::jsonb),
 'tasks',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',key,'projectId',project_id,'project',project,'person',person,'owner',owner,'title',title,'body',body,'action',action,'requestId',request_id,'eventId',event_id,'revision',revision,'unread',acknowledged_at IS NULL,'acknowledgedAt',acknowledged_at) ORDER BY key) FROM tasks),'[]'::jsonb),
 'students',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) FROM app_users u CROSS JOIN viewer v WHERE u.role='student' AND (v.role='sales' OR u.id=v.id OR (v.role='leader' AND (
 EXISTS(SELECT 1 FROM visible_events e WHERE e.student_id=u.id) OR EXISTS(SELECT 1 FROM visible_requests r WHERE r.student_id=u.id))))),'[]'::jsonb),
 'leaders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) FROM app_users u CROSS JOIN viewer v WHERE u.role='leader' AND v.role='sales'),'[]'::jsonb),
 'projects',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'notes',p.notes,'salesId',p.sales_id,'salesName',su.display_name,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana) ORDER BY p.id)
 FROM visible_projects p JOIN app_users su ON su.id=p.sales_id LEFT JOIN app_users lu ON lu.id=p.leader_id AND lu.role='leader'),'[]'::jsonb),
 'requests',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'projectId',p.id,'project',p.name,'summary',p.notes,'studentId',r.student_id,'person',u.display_name,'status',r.status,'scheduleMode',r.schedule_mode,'requestedDates',to_jsonb(r.requested_dates),'confirmedSlotId',r.confirmed_slot_id,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana,'attachment',CASE WHEN v.role='leader' THEN NULL ELSE COALESCE((SELECT jsonb_build_object('name',a.filename,'size',octet_length(a.content),'scope','project') FROM project_attachments a WHERE a.project_id=p.id),(SELECT jsonb_build_object('name',a.filename,'size',octet_length(a.content),'scope','request') FROM request_attachments a WHERE a.request_id=r.id)) END,
 'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'start',to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI'),'end',to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI')) ORDER BY s.start_at,s.id) FROM candidate_slots s WHERE s.request_id=r.id),'[]'::jsonb),
 'availableSlotIds',COALESCE((SELECT jsonb_agg(s.id ORDER BY s.start_at,s.id) FROM candidate_slots s WHERE s.request_id=r.id AND s.available),'[]'::jsonb)
 ) ORDER BY r.created_at,r.id) FROM visible_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id LEFT JOIN app_users lu ON lu.id=p.leader_id AND lu.role='leader' CROSS JOIN viewer v),'[]'::jsonb),
 'feedbacks',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'eventId',f.event_id,'projectId',e.project_id,'studentId',f.student_id,'person',u.display_name,'duties',f.duties,'process',f.process,'remote',f.remote,'impression',f.impression,'submittedAt',f.submitted_at,
 'questions',COALESCE((SELECT jsonb_agg(q.title ORDER BY q.display_order,q.id) FROM interview_questions q WHERE q.feedback_id=f.id),'[]'::jsonb)) ORDER BY f.submitted_at,f.id)
 FROM interview_feedback f JOIN visible_events e ON e.id=f.event_id JOIN app_users u ON u.id=f.student_id),'[]'::jsonb),
 'notifications',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',n.id,'userId',n.recipient_id,'kind',n.kind,'title',n.title,'lines',n.lines,'body',n.body,'createdAt',n.created_at) ORDER BY n.created_at DESC,n.id)
 FROM notification_previews n JOIN visible_projects p ON p.id=n.project_id CROSS JOIN viewer v WHERE v.role IN('sales','leader') OR n.recipient_id=v.id),'[]'::jsonb)
)::text;
