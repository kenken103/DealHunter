WITH viewer AS (SELECT id,role FROM app_users WHERE id = ?),
visible_projects AS (
 SELECT p.* FROM projects p CROSS JOIN viewer v
 WHERE v.role IN('admin','sales') OR (v.role='student' AND (
 EXISTS(SELECT 1 FROM scheduled_events e WHERE e.project_id=p.id AND e.student_id=v.id)
 OR EXISTS(SELECT 1 FROM interview_requests r WHERE r.project_id=p.id AND r.student_id=v.id)
 OR EXISTS(SELECT 1 FROM project_import_history h WHERE h.project_id=p.id AND h.student_id=v.id)))
 OR (v.role='leader' AND p.leader_id=v.id)
),
visible_events AS (
 SELECT e.* FROM scheduled_events e JOIN visible_projects p ON p.id=e.project_id CROSS JOIN viewer v
 WHERE v.role IN('sales','leader','admin') OR e.student_id=v.id
),
visible_requests AS (
 SELECT r.* FROM interview_requests r JOIN visible_projects p ON p.id=r.project_id CROSS JOIN viewer v
 WHERE v.role IN('sales','leader','admin') OR r.student_id=v.id
),
visible_import_history AS (
 SELECT h.* FROM project_import_history h JOIN visible_projects p ON p.id=h.project_id CROSS JOIN viewer v
 WHERE v.role IN('sales','leader','admin') OR h.student_id=v.id
),
visible_recruitments AS (
 SELECT a.* FROM recruitments a JOIN visible_projects p ON p.id=a.project_id CROSS JOIN viewer v
 WHERE v.role IN('sales','leader','admin')
),
tasks AS (
 SELECT t.*,a.acknowledged_at FROM active_tasks t JOIN visible_projects p ON p.id=t.project_id CROSS JOIN viewer v
 LEFT JOIN task_acknowledgements a ON a.user_id=CASE WHEN v.role IN('sales','leader') THEN t.sales_id ELSE v.id END AND a.task_key=t.key AND a.revision=t.revision
 WHERE v.role IN('sales','leader','admin') OR t.student_id=v.id
)
SELECT jsonb_build_object(
 'importedCases',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'projectId',h.project_id,'studentId',h.student_id,'person',u.display_name,'sourceRow',h.source_row,'sourceNumber',h.source_number,
 'interviewDate',h.interview_date,'entryDate',h.entry_date,'entryDateText',h.entry_date_text,'outcome',h.outcome,'status',h.status,'primeContractor',h.prime_contractor
 ) ORDER BY h.source_row) FROM visible_import_history h LEFT JOIN app_users u ON u.id=h.student_id),'[]'::jsonb),
 'events',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'key',e.id,'projectId',p.id,'date',extract(day FROM e.event_date)::integer,
 'time',to_char(e.start_time,'HH24:MI'),'end',COALESCE(to_char(e.end_time,'HH24:MI'),''),
 'project',p.name,'person',u.display_name,'studentId',u.id,'notes',p.notes,'route',e.route,'format',e.format,
 'entry',e.kind='entry','stamp',(extract(epoch FROM e.event_date::timestamp AT TIME ZONE 'UTC')*1000)::bigint,
 'type',e.kind,'requestId',e.request_id,'parentEventId',e.parent_event_id,'url',e.meeting_url,'meetingPlace',e.meeting_place,
 'guidance',e.guidance,'status',e.status,'result',e.result,'engineerConfirmedAt',e.engineer_confirmed_at,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana,'upperCompany',p.upper_company,'endCompany',p.end_company,
 'primeCompany',p.prime_company,'category',p.category,'remarks',CASE WHEN (SELECT role FROM viewer) IN('sales','admin') THEN p.remarks ELSE '' END,'executorName',p.executor_name,'followerNames',to_jsonb(p.follower_names),'round',e.interview_round,'totalRounds',COALESCE((SELECT r.total_rounds FROM interview_requests r WHERE r.id=e.request_id),p.total_rounds)
 ) || jsonb_build_object(
 'scheduleState',e.schedule_state,'noticeRevision',e.notice_revision,'noticeReadAt',e.notice_read_at,
 'prepStart',to_char(e.prep_start,'YYYY-MM-DD"T"HH24:MI'),'prepUrl',e.prep_url,'instructions',e.instructions,
 'meetingId',e.meeting_id,'passcode',e.passcode,'emergencyContact',e.emergency_contact,'shareFeedback',e.share_feedback,
 'clientFeedback',CASE WHEN e.share_feedback OR (SELECT role FROM viewer) IN('sales','admin') THEN e.client_feedback ELSE '' END,
 'changeReason',e.change_reason,
 'changes',COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',h.revision,'state',h.state,'at',h.changed_at,
 'start',to_char(h.start_at,'YYYY-MM-DD"T"HH24:MI'),'end',to_char(h.end_at,'YYYY-MM-DD"T"HH24:MI'),
 'prepStart',to_char(h.prep_start,'YYYY-MM-DD"T"HH24:MI'),'reason',h.reason) ORDER BY h.revision DESC)
 FROM event_notice_history h WHERE h.event_id=e.id),'[]'::jsonb)
 ) ORDER BY e.event_date,e.start_time,e.id) FROM visible_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id LEFT JOIN app_users lu ON lu.id=p.leader_id),'[]'::jsonb),
 'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',q.id,'project',q.project_id,'title',q.title,'tag',q.tag,'context',
 CASE WHEN v.role IN('sales','leader','admin') OR q.feedback_id IS NULL OR EXISTS(SELECT 1 FROM interview_feedback f WHERE f.id=q.feedback_id AND f.student_id=v.id) THEN q.context ELSE '' END,'eventId',q.event_id)
 ORDER BY q.display_order,q.id) FROM interview_questions q JOIN visible_projects p ON p.id=q.project_id CROSS JOIN viewer v),'[]'::jsonb),
 'tasks',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',key,'projectId',project_id,'project',project,'person',person,'owner',owner,'title',title,'body',body,'action',action,'requestId',request_id,'eventId',event_id,'recruitmentId',recruitment_id,'revision',revision,'unread',acknowledged_at IS NULL,'acknowledgedAt',acknowledged_at) ORDER BY key) FROM tasks),'[]'::jsonb),
 'students',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) FROM app_users u CROSS JOIN viewer v WHERE u.role='student' AND (v.role IN('sales','admin') OR u.id=v.id OR (v.role='leader' AND (
 EXISTS(SELECT 1 FROM visible_events e WHERE e.student_id=u.id) OR EXISTS(SELECT 1 FROM visible_requests r WHERE r.student_id=u.id)
 OR EXISTS(SELECT 1 FROM visible_import_history h WHERE h.student_id=u.id))))),'[]'::jsonb),
 'leaders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) FROM app_users u CROSS JOIN viewer v WHERE u.role='leader' AND v.role IN('sales','admin')),'[]'::jsonb),
 'teamMembers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) FROM leader_members m JOIN app_users u ON u.id=m.student_id CROSS JOIN viewer v WHERE v.role='leader' AND m.leader_id=v.id AND m.active AND u.role='student'),'[]'::jsonb),
 'projects',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'notes',p.notes,'salesId',p.sales_id,'salesName',su.display_name,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana,'upperCompany',p.upper_company,'endCompany',p.end_company,
 'primeCompany',p.prime_company,'category',p.category,'remarks',CASE WHEN (SELECT role FROM viewer) IN('sales','admin') THEN p.remarks ELSE '' END,'executorName',p.executor_name,'followerNames',to_jsonb(p.follower_names),'totalRounds',p.total_rounds) ORDER BY p.id)
 FROM visible_projects p JOIN app_users su ON su.id=p.sales_id LEFT JOIN app_users lu ON lu.id=p.leader_id),'[]'::jsonb),
 'recruitments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'projectId',p.id,'project',p.name,'summary',p.notes,'status',a.status,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana,'upperCompany',p.upper_company,'endCompany',p.end_company,
 'primeCompany',p.prime_company,'category',p.category,'remarks',CASE WHEN v.role IN('sales','admin') THEN p.remarks ELSE '' END,'executorName',p.executor_name,'followerNames',to_jsonb(p.follower_names),'totalRounds',p.total_rounds,
 'scheduleMode',a.schedule_mode,'requestedDates',to_jsonb(a.requested_dates),
 'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'start',to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI'),'end',to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI')) ORDER BY s.start_at,s.id) FROM recruitment_candidate_slots s WHERE s.recruitment_id=a.id),'[]'::jsonb),
 'studentIds',COALESCE((SELECT jsonb_agg(r.student_id ORDER BY r.student_id) FROM interview_requests r WHERE r.recruitment_id=a.id),'[]'::jsonb),
 'attachment',CASE WHEN v.role IN('sales','admin') THEN (SELECT jsonb_build_object('name',f.filename,'size',octet_length(f.content),'scope','project') FROM project_attachments f WHERE f.project_id=p.id) ELSE NULL END
 ) ORDER BY a.created_at,a.id) FROM visible_recruitments a JOIN projects p ON p.id=a.project_id LEFT JOIN app_users lu ON lu.id=p.leader_id CROSS JOIN viewer v),'[]'::jsonb),
 'requests',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'projectId',p.id,'project',p.name,'summary',p.notes,'studentId',r.student_id,'person',u.display_name,'status',r.status,'scheduleMode',r.schedule_mode,'requestedDates',to_jsonb(r.requested_dates),'confirmedSlotId',r.confirmed_slot_id,'leaderId',p.leader_id,'leaderName',lu.display_name,'participantName',p.participant_name,'participantNameKana',p.participant_name_kana,'upperCompany',p.upper_company,'endCompany',p.end_company,'attachment',CASE WHEN v.role='leader' THEN NULL ELSE COALESCE((SELECT jsonb_build_object('name',a.filename,'size',octet_length(a.content),'scope','project') FROM project_attachments a WHERE a.project_id=p.id),(SELECT jsonb_build_object('name',a.filename,'size',octet_length(a.content),'scope','request') FROM request_attachments a WHERE a.request_id=r.id)) END,
 'primeCompany',p.prime_company,'category',p.category,'remarks',CASE WHEN v.role IN('sales','admin') THEN p.remarks ELSE '' END,'executorName',p.executor_name,'followerNames',to_jsonb(p.follower_names),'round',r.interview_round,'totalRounds',r.total_rounds,
 'createdAt',r.created_at,'taskRevision',r.task_revision,'responseKind',r.response_kind,'responseNote',r.response_note,
 'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'start',to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI'),'end',to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI'),'proposed',s.proposed,'openEnded',s.open_ended) ORDER BY s.start_at,s.id) FROM candidate_slots s WHERE s.request_id=r.id AND s.interview_round=r.interview_round),'[]'::jsonb),
 'availableSlotIds',COALESCE((SELECT jsonb_agg(s.id ORDER BY s.start_at,s.id) FROM candidate_slots s WHERE s.request_id=r.id AND s.interview_round=r.interview_round AND s.available),'[]'::jsonb)
 ) ORDER BY r.created_at,r.id) FROM visible_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id LEFT JOIN app_users lu ON lu.id=p.leader_id CROSS JOIN viewer v),'[]'::jsonb),
 'feedbacks',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'eventId',f.event_id,'projectId',e.project_id,'studentId',f.student_id,'person',u.display_name,'duties',f.duties,'process',f.process,'remote',f.remote,'impression',f.impression,'submittedAt',f.submitted_at,
 'questions',COALESCE((SELECT jsonb_agg(q.title ORDER BY q.display_order,q.id) FROM interview_questions q WHERE q.feedback_id=f.id),'[]'::jsonb)) ORDER BY f.submitted_at,f.id)
 FROM interview_feedback f JOIN visible_events e ON e.id=f.event_id JOIN app_users u ON u.id=f.student_id),'[]'::jsonb),
 'notifications',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',n.id,'userId',n.recipient_id,'kind',n.kind,'title',n.title,'lines',n.lines,'body',n.body,'createdAt',n.created_at) ORDER BY n.created_at DESC,n.id)
 FROM notification_previews n JOIN visible_projects p ON p.id=n.project_id CROSS JOIN viewer v WHERE v.role IN('sales','leader','admin') OR n.recipient_id=v.id),'[]'::jsonb)
)::text;
