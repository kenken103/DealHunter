import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.sql.*;
import java.text.Normalizer;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Persisted local workflow with optional Lark delivery for cancelled requests. */
public final class DealHunterServer {
    private static final ObjectMapper JSON = new ObjectMapper()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final String DATABASE_URL = env("DEALHUNTER_DATABASE_URL", "jdbc:postgresql://127.0.0.1:15432/dealhunter");
    private static final String DATABASE_USER = env("DEALHUNTER_DATABASE_USER", "dealhunter");
    private static final String DATABASE_PASSWORD = env("DEALHUNTER_DATABASE_PASSWORD", "");
    private static final String API_KEY = env("DEALHUNTER_API_KEY", "");
    private static final boolean LOCAL_DEMO = "1".equals(env("DEALHUNTER_LOCAL_DEMO", ""));
    private static final String API_VERSION = "workflow-v13";
    private static final int PASSWORD_ITERATIONS = 600_000;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String DUMMY_PASSWORD_HASH = passwordHash("unused-user-timing-padding");
    private static final Map<String,LoginAttempts> LOGIN_ATTEMPTS = new LinkedHashMap<>();
    static LarkAvailability larkAvailability = LarkAvailability.fromEnvironment();
    private record LoginAttempts(int count,long expiresAt) {}
    private static String dashboardSql;
    private record User(String id, String role, String name) {}
    private record Slot(LocalDateTime start, LocalDateTime end, boolean openEnded) {
        Slot(LocalDateTime start, LocalDateTime end) { this(start,end,false); }
    }
    private record Attachment(String name, byte[] content) {}
    private record IssuedRequests(List<String> ids, List<Map<String,Object>> previews) {}
    private static final class ApiError extends RuntimeException {
        final int status;
        ApiError(int status, String message) { super(message); this.status = status; }
    }
    private static String env(String key, String fallback) { return System.getenv().getOrDefault(key, fallback); }
    private static String id(String prefix) { return prefix + UUID.randomUUID(); }
    private static Connection connect() throws SQLException {
        Connection c = DriverManager.getConnection(DATABASE_URL, DATABASE_USER, DATABASE_PASSWORD);
        try (Statement s = c.createStatement()) { s.execute("SET TIME ZONE 'Asia/Tokyo'"); }
        return c;
    }

    public static void main(String[] args) throws Exception {
        if (API_KEY.length() < 32) throw new IllegalStateException("A local API key is required; use scripts/start-backend.ps1.");
        Path backend = Path.of(args.length > 0 ? args[0] : "backend");
        Class.forName("org.postgresql.Driver");
        try (Connection c = connect()) {
            c.setAutoCommit(false);
            execute(c, "SELECT pg_advisory_xact_lock(709031)");
            try (Statement s = c.createStatement()) {
                s.setQueryTimeout(20);
                s.execute(Files.readString(backend.resolve("schema.sql"), StandardCharsets.UTF_8));
                if (one(c,"SELECT version FROM app_migrations WHERE version='workbook-accounts-v1'")==null) {
                    s.execute(Files.readString(backend.resolve("seed-users.sql"), StandardCharsets.UTF_8));
                }
            }
            seedSampleCredentials(c);
            seedAdminCredentials(c,backend);
            c.commit();
        }
        dashboardSql = Files.readString(backend.resolve("dashboard.sql"), StandardCharsets.UTF_8);
        int port = Integer.parseInt(env("DEALHUNTER_API_PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", DealHunterServer::handle);
        var notificationWorker = Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().factory());
        notificationWorker.scheduleWithFixedDelay(DealHunterServer::deliverCancellationNotification, 0, 3, TimeUnit.SECONDS);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            notificationWorker.shutdownNow();
            server.stop(0);
        }));
        server.start();
        System.out.println("DealHunter Java workflow API ready: http://127.0.0.1:" + port + " (PostgreSQL, " + API_VERSION + ")");
    }

    private static PreparedStatement prepared(Connection c, String sql, Object... values) throws SQLException {
        PreparedStatement s = c.prepareStatement(sql);
        s.setQueryTimeout(10);
        for (int i = 0; i < values.length; i++) s.setObject(i + 1, values[i]);
        return s;
    }
    private static void execute(Connection c, String sql, Object... values) throws SQLException {
        try (PreparedStatement s = prepared(c, sql, values)) { s.execute(); }
    }
    private static Map<String, Object> one(Connection c, String sql, Object... values) throws SQLException {
        try (PreparedStatement s = prepared(c, sql, values); ResultSet r = s.executeQuery()) {
            if (!r.next()) return null;
            Map<String, Object> result = new HashMap<>();
            for (int i = 1; i <= r.getMetaData().getColumnCount(); i++) result.put(r.getMetaData().getColumnLabel(i), r.getObject(i));
            return result;
        }
    }
    private static String str(Map<String, Object> row, String key) { return Objects.toString(row.get(key), ""); }
    private static void require(boolean condition, int status, String message) { if (!condition) throw new ApiError(status, message); }
    private static void role(User user, String role) { require(user.role.equals(role), 403, "この操作を行う権限がありません。"); }
    private static String text(JsonNode body, String key) {
        JsonNode n = body.get(key);
        require(n != null && n.isTextual() && !n.asText().trim().isEmpty(), 400, key + "を入力してください。");
        return n.asText().trim();
    }
    private static String optionalText(JsonNode body, String key) {
        JsonNode n = body.get(key);
        require(n == null || n.isNull() || n.isTextual(), 400, key + "の形式が正しくありません。");
        return n == null || n.isNull() ? "" : n.asText().trim();
    }
    private static String boundedText(JsonNode body, String key, int maximum, boolean required) {
        String value=required?text(body,key):optionalText(body,key);
        require(value.length()<=maximum,400,key+"は"+maximum+"文字以内で入力してください。");
        return value;
    }
    private static int totalRounds(JsonNode body, int fallback, int minimum) {
        JsonNode value=body.get("totalRounds");
        if(value==null) return Math.max(fallback,minimum);
        require(value.isIntegralNumber() && value.canConvertToInt() && value.asInt()>=minimum && value.asInt()<=5,400,"面談回数は"+minimum+"～5回で入力してください。");
        return value.asInt();
    }
    private static String companyName(JsonNode body, String key, String label, boolean required) {
        JsonNode value=body.get(key);
        if(value==null) {
            require(!required,400,label+"を入力してください。");
            return "";
        }
        require(value.isTextual(),400,label+"は文字列で入力してください。");
        String name=trimCompanyName(value.asText());
        require(!required || !name.isEmpty(),400,label+"を入力してください。");
        require(name.length()<=200,400,label+"は200文字以内で入力してください。");
        return name;
    }
    private static String trimCompanyName(String name) {
        int start=0,end=name.length();
        while(start<end && companyWhitespace(name.codePointAt(start))) start+=Character.charCount(name.codePointAt(start));
        while(end>start && companyWhitespace(name.codePointBefore(end))) end-=Character.charCount(name.codePointBefore(end));
        return name.substring(start,end);
    }
    private static boolean companyWhitespace(int codePoint) {
        return Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint) || codePoint==0x85 || codePoint==0xFEFF;
    }
    private static void rememberEndCompany(Connection c,String projectId,String name) throws SQLException {
        String trimmed=trimCompanyName(name);
        // Callers hold the project row lock (or have just inserted that project),
        // so exact-name insertion is serialized without indexing unbounded legacy names.
        if(!trimmed.isEmpty()) execute(c,"INSERT INTO project_end_companies(project_id,name) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM project_end_companies WHERE project_id=? AND name=?)",projectId,trimmed,projectId,trimmed);
    }
    private static Map<String,Set<String>> sharedCompanyCandidates(Connection c) throws SQLException {
        Map<String,Set<String>> companies = Map.of("upper",new TreeSet<>(),"end",new TreeSet<>());
        String sql = """
                SELECT 'upper' AS company_role,upper_company AS company_name FROM projects
                UNION SELECT 'end',end_company FROM projects
                UNION SELECT 'end',name FROM project_end_companies
                UNION SELECT r.company_role,r.company_name FROM interviewer_company_restrictions r
                       JOIN app_users u ON u.id=r.student_id AND u.role='student'
                       WHERE r.company_role IN ('upper','end')
                """;
        try (PreparedStatement s = prepared(c,sql); ResultSet r = s.executeQuery()) {
            while (r.next()) {
                String name = trimCompanyName(r.getString("company_name"));
                if (!name.isEmpty()) companies.get(r.getString("company_role")).add(name);
            }
        }
        return companies;
    }
    private static Object engineerStatus(Connection c, User user) throws Exception {
        require(user.role.equals("sales") || user.role.equals("leader"),403,"営業またはリーダーのみ利用できます。");
        String sql = """
                WITH roster AS (
                    SELECT u.id, u.display_name FROM app_users u
                    WHERE u.role='student' AND (?='sales' OR EXISTS (
                        SELECT 1 FROM leader_members m WHERE m.student_id=u.id AND m.leader_id=? AND m.active
                    ))
                ), entries AS (
                    SELECT e.student_id, e.project_id, e.event_date AS entry_date, true AS confirmed
                    FROM scheduled_events e JOIN roster r ON r.id=e.student_id
                    WHERE e.kind='entry' AND e.schedule_state='scheduled' AND e.engineer_confirmed_at IS NOT NULL
                    UNION ALL
                    SELECT h.student_id, h.project_id, h.entry_date, false
                    FROM project_import_history h JOIN roster r ON r.id=h.student_id WHERE h.status='joined'
                ), assignments AS (
                    SELECT student_id, project_id,
                        COALESCE(min(entry_date) FILTER (WHERE confirmed), min(entry_date)) AS entry_date
                    FROM entries GROUP BY student_id, project_id
                ), projects_by_person AS (
                    SELECT a.student_id, jsonb_agg(jsonb_build_object(
                        'id', p.id, 'name', p.name, 'upperCompany', p.upper_company, 'notes', p.notes,
                        'primeCompany', p.prime_company, 'endCompany', p.end_company, 'category', p.category,
                        'participantName', p.participant_name, 'executorName', p.executor_name, 'followerNames', p.follower_names,
                        'salesName', sales.display_name, 'entryDate', a.entry_date
                    ) ORDER BY a.entry_date DESC NULLS LAST, p.name, p.id) AS projects
                    FROM assignments a JOIN projects p ON p.id=a.project_id JOIN app_users sales ON sales.id=p.sales_id
                    GROUP BY a.student_id
                )
                SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.display_name,
                    'projects', COALESCE(p.projects, '[]'::jsonb)) ORDER BY r.display_name, r.id), '[]'::jsonb) AS engineers
                FROM roster r LEFT JOIN projects_by_person p ON p.student_id=r.id
                """;
        return Map.of("engineers",JSON.readTree(str(one(c,sql,user.role,user.id),"engineers")));
    }

    private static Object engineerInterviewHistory(Connection c, User user, String studentId) throws Exception {
        require(user.role.equals("sales") || user.role.equals("leader"),403,"営業またはリーダーのみ利用できます。");
        String sql = """
                WITH engineer AS (
                    SELECT u.id, u.display_name FROM app_users u
                    WHERE u.id=? AND u.role='student' AND (?='sales' OR EXISTS (
                        SELECT 1 FROM leader_members m WHERE m.student_id=u.id AND m.leader_id=? AND m.active
                    ))
                ), interviews AS (
                    SELECT 'event:' || e.id AS id, e.id AS event_id, e.project_id, e.event_date AS interview_date,
                        e.start_time AS interview_time, e.interview_round,
                        COALESCE(r.total_rounds,p.total_rounds) AS total_rounds, e.result, NULL::text AS result_text
                    FROM scheduled_events e JOIN engineer u ON u.id=e.student_id
                    JOIN projects p ON p.id=e.project_id LEFT JOIN interview_requests r ON r.id=e.request_id
                    WHERE e.kind='meet' AND e.schedule_state='scheduled' AND e.event_date + e.start_time <= LOCALTIMESTAMP
                    UNION ALL
                    SELECT 'import:' || h.project_id, NULL::text, h.project_id, h.interview_date,
                        NULL::time, NULL::integer, NULL::integer, h.status, NULLIF(h.outcome,'')
                    FROM project_import_history h JOIN engineer u ON u.id=h.student_id
                    WHERE h.interview_date <= CURRENT_DATE
                       OR (h.interview_date IS NULL AND h.status IN ('joined','rejected'))
                )
                SELECT jsonb_build_object(
                    'engineer', jsonb_build_object('id',u.id,'name',u.display_name),
                    'interviews', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'id',i.id,'projectId',p.id,'projectName',p.name,'notes',p.notes,
                        'upperCompany',p.upper_company,'primeCompany',p.prime_company,'endCompany',p.end_company,
                        'interviewDate',i.interview_date,'interviewTime',to_char(i.interview_time,'HH24:MI'),
                        'round',i.interview_round,'totalRounds',i.total_rounds,'result',i.result,'resultText',i.result_text,
                        'questions',COALESCE((SELECT jsonb_agg(q.title ORDER BY q.display_order,q.id)
                            FROM interview_questions q WHERE q.event_id=i.event_id AND q.project_id=i.project_id
                            AND (q.feedback_id IS NULL OR q.feedback_id=f.id)),'[]'::jsonb),
                        'feedback',CASE WHEN f.id IS NOT NULL THEN jsonb_build_object(
                            'duties',f.duties,'process',f.process,'remote',f.remote,'impression',f.impression
                        ) END
                    ) ORDER BY i.interview_date DESC NULLS LAST, i.interview_time DESC NULLS LAST, i.id)
                    FROM interviews i JOIN projects p ON p.id=i.project_id
                    LEFT JOIN interview_feedback f ON f.event_id=i.event_id AND f.student_id=u.id), '[]'::jsonb)
                ) AS history FROM engineer u
                """;
        Map<String,Object> row = one(c,sql,studentId,user.role,user.id);
        require(row!=null,404,"対象のエンジニアが見つかりません。");
        return JSON.readTree(str(row,"history"));
    }

    private record InterviewedCompany(String studentId, String role, String name) {}

    private static Set<InterviewedCompany> interviewedCompanies(Connection c, String studentId) throws SQLException {
        // A request alone, an upcoming meeting, and a postponed or cancelled meeting are not interview history.
        String sql = """
                WITH past_interviews AS (
                    SELECT h.student_id,h.project_id FROM project_import_history h
                    WHERE h.interview_date <= CURRENT_DATE
                       OR (h.interview_date IS NULL AND h.status IN ('joined','rejected'))
                    UNION
                    SELECT e.student_id,e.project_id FROM scheduled_events e
                    WHERE e.kind='meet' AND e.schedule_state='scheduled'
                      AND e.event_date + e.start_time <= LOCALTIMESTAMP
                )
                SELECT DISTINCT i.student_id,company.role,company.name
                FROM past_interviews i
                JOIN app_users student ON student.id=i.student_id AND student.role='student'
                JOIN projects p ON p.id=i.project_id
                CROSS JOIN LATERAL (
                    VALUES ('upper',p.upper_company), ('prime',p.prime_company), ('end',p.end_company)
                ) company(role,name)
                WHERE (?::text IS NULL OR i.student_id=?) AND company.name<>''
                ORDER BY i.student_id,company.role,company.name
                """;
        Set<InterviewedCompany> history = new LinkedHashSet<>();
        try (PreparedStatement s = prepared(c,sql,studentId,studentId); ResultSet r = s.executeQuery()) {
            while (r.next()) {
                for (String part : r.getString("name").split("→")) {
                    String name = trimCompanyName(part);
                    if (!name.isEmpty()) history.add(new InterviewedCompany(r.getString("student_id"),r.getString("role"),name));
                }
            }
        }
        return history;
    }

    private static Object interviewerCompanyLookup(Connection c) throws SQLException {
        Map<String,Set<String>> companies = new HashMap<>(sharedCompanyCandidates(c));
        Set<String> primeCompanies = new TreeSet<>();
        try (PreparedStatement s = prepared(c,"SELECT DISTINCT prime_company FROM projects WHERE prime_company<>''");
             ResultSet r = s.executeQuery()) {
            while (r.next()) {
                String name = trimCompanyName(r.getString("prime_company"));
                if (!name.isEmpty()) primeCompanies.add(name);
            }
        }
        companies.put("prime",primeCompanies);
        companies.put("all",new TreeSet<>());
        List<Map<String,String>> students = new ArrayList<>();
        try (PreparedStatement s = prepared(c,"SELECT id,display_name FROM app_users WHERE role='student' ORDER BY display_name,id");
             ResultSet r = s.executeQuery()) {
            while (r.next()) students.add(Map.of("id",r.getString("id"),"name",r.getString("display_name")));
        }

        List<Map<String,String>> restrictions = new ArrayList<>();
        String sql = """
                SELECT DISTINCT r.student_id,r.company_role,r.company_name
                  FROM interviewer_company_restrictions r
                  JOIN app_users u ON u.id=r.student_id AND u.role='student'
                 ORDER BY r.student_id,r.company_role,r.company_name
                """;
        try (PreparedStatement s = prepared(c,sql); ResultSet r = s.executeQuery()) {
            while (r.next()) {
                String companyRole = r.getString("company_role"), name = r.getString("company_name");
                // Include a company whose first restriction appeared during this read.
                companies.get(companyRole).add(name);
                restrictions.add(Map.of("studentId",r.getString("student_id"),"companyRole",companyRole,"companyName",name));
            }
        }
        Set<Map<String,String>> historyCompanies = new LinkedHashSet<>();
        for (InterviewedCompany company : interviewedCompanies(c,null)) {
            companies.get(company.role).add(company.name);
            historyCompanies.add(Map.of("studentId",company.studentId,"companyName",company.name));
        }
        return Map.of("companies",companies,"students",students,"restrictions",restrictions,"historyCompanies",historyCompanies);
    }
    private static Object interviewerCompanyRestrictions(Connection c,User user,String studentId,JsonNode update) throws SQLException {
        // All salespeople serialize changes for this interviewer, including the first shared mark.
        String studentLock = update == null ? "" : " FOR NO KEY UPDATE";
        require(one(c,"SELECT id FROM app_users WHERE id=? AND role='student'"+studentLock,studentId)!=null,404,"対象の面談者が見つかりません。");
        if(update!=null) {
            require(update.isObject() && update.size()==3 && update.path("restricted").isBoolean() && update.path("companyName").isTextual(),400,"会社と設定内容を指定してください。");
            String companyRole=update.path("companyRole").asText();
            String name=trimCompanyName(update.get("companyName").asText());
            require(Set.of("end","upper","all").contains(companyRole) && !name.isEmpty(),400,"会社名を指定してください。");
            if(update.get("restricted").asBoolean()) {
                if (companyRole.equals("all")) require(name.length()<=200,400,"会社名は200文字以内で入力してください。");
                else require(sharedCompanyCandidates(c).get(companyRole).contains(name),400,"選択した区分の保存済みの会社を指定してください。");
                execute(c,"INSERT INTO interviewer_company_restrictions(sales_id,student_id,company_role,company_name) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM interviewer_company_restrictions WHERE sales_id=? AND student_id=? AND company_role=? AND company_name=?)",user.id,studentId,companyRole,name,user.id,studentId,companyRole,name);
            } else {
                try (PreparedStatement s=prepared(c,"DELETE FROM interviewer_company_restrictions WHERE sales_id=? AND student_id=? AND company_role=? AND company_name=?",user.id,studentId,companyRole,name)) {
                    if (s.executeUpdate()==0) require(one(c,"SELECT 1 FROM interviewer_company_restrictions WHERE student_id=? AND company_role=? AND company_name=? LIMIT 1",studentId,companyRole,name)==null,403,"他の営業が登録したNGは解除できません。");
                }
            }
        }
        Map<String,Set<String>> names=Map.of("end",new TreeSet<>(),"upper",new TreeSet<>(),"all",new TreeSet<>());
        Map<String,Set<String>> ownNames=Map.of("end",new TreeSet<>(),"upper",new TreeSet<>(),"all",new TreeSet<>());
        try(PreparedStatement s=prepared(c,"SELECT company_role,company_name,bool_or(sales_id=?) AS own FROM interviewer_company_restrictions WHERE student_id=? GROUP BY company_role,company_name",user.id,studentId);ResultSet r=s.executeQuery()) {
            while(r.next()) {
                String companyRole=r.getString("company_role"),name=r.getString("company_name");
                names.get(companyRole).add(name);
                if(r.getBoolean("own")) ownNames.get(companyRole).add(name);
            }
        }
        List<String> history = interviewedCompanies(c,studentId).stream()
                .map(InterviewedCompany::name).distinct().sorted().toList();
        return Map.of("studentId",studentId,"restrictions",names,"ownRestrictions",ownNames,"historyCompanies",history);
    }
    private static LocalDateTime date(String value) {
        try { return LocalDateTime.parse(value); }
        catch (DateTimeParseException e) { throw new ApiError(400, "日時は日本時間の年月日・時刻で入力してください。"); }
    }
    private static List<LocalDate> requestedDates(JsonNode value) {
        if (value == null) return List.of();
        require(value.isArray(),400,"指定日は日付の一覧で入力してください。");
        Set<LocalDate> dates = new TreeSet<>();
        for (JsonNode item : value) {
            require(item.isTextual() && item.asText().matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"),400,"指定日は年月日で入力してください。");
            LocalDate day;
            try { day = LocalDate.parse(item.asText()); }
            catch (DateTimeParseException e) { throw new ApiError(400,"指定日が正しくありません。"); }
            require(day.getYear() > 0,400,"指定日が正しくありません。");
            require(dates.add(day),400,"指定日が重複しています。");
        }
        return List.copyOf(dates);
    }
    private static Set<LocalDate> storedRequestedDates(Map<String,Object> request) throws SQLException {
        java.sql.Array array = (java.sql.Array) request.get("requested_dates");
        try {
            Set<LocalDate> dates = new HashSet<>();
            for (Object value : (Object[]) array.getArray()) dates.add(LocalDate.parse(value.toString()));
            return dates;
        } finally { array.free(); }
    }
    private static List<Slot> slots(JsonNode value, boolean proposals) {
        require(value != null && value.isArray() && !value.isEmpty(),400,proposals ? "参加可能な開始日時を1件以上入力してください。" : "候補日時を1件以上入力してください。");
        List<Slot> slots = new ArrayList<>();
        Set<LocalDateTime> seen = new HashSet<>();
        for (JsonNode item : value) {
            require(item.isObject(),400,"候補日時の形式が正しくありません。");
            LocalDateTime start = date(text(item,"start"));
            LocalDateTime end = item.hasNonNull("end") ? date(text(item,"end")) : null;
            boolean openEnded = booleanField(item,"openEnded",false);
            require(!openEnded || (proposals && end==null),400,"「以降」を選んだ場合は終了時刻を空にしてください。");
            require(end == null || (end.isAfter(start) && start.toLocalDate().equals(end.toLocalDate())),400,"候補の終了時刻は同日の開始時刻より後にしてください。");
            require(seen.add(start),400,"候補日時が重複しています。");
            slots.add(new Slot(start,end,openEnded));
        }
        slots.sort(Comparator.comparing(Slot::start));
        return slots;
    }
    private static String slotLabel(Slot slot) {
        return slot.start.toString().replace('T',' ') + (slot.openEnded ? "以降" : slot.end == null ? "" : "〜" + slot.end.toLocalTime());
    }
    private static boolean booleanField(JsonNode body,String key,boolean fallback) {
        if(!body.has(key)) return fallback;
        require(body.get(key).isBoolean(),400,key+"は真偽値で指定してください。");
        return body.get(key).booleanValue();
    }
    private static String scheduleLabel(String mode, List<LocalDate> dates, List<Slot> slots) {
        return mode.equals("availability")
            ? (dates.isEmpty() ? "日時の指定なし。参加可能な開始日時を回答してください。" : String.join(" ／ ",dates.stream().map(LocalDate::toString).toList()) + " の参加可能な開始日時を回答してください。")
            : String.join(" ／ ",slots.stream().map(DealHunterServer::slotLabel).toList());
    }
    private static String datesArray(List<LocalDate> dates) {
        return "{" + String.join(",",dates.stream().map(LocalDate::toString).toList()) + "}";
    }
    private static List<String> studentIds(JsonNode value) {
        require(value!=null && value.isArray() && !value.isEmpty(),400,"面談者を1名以上選んでください。");
        Set<String> ids=new LinkedHashSet<>();
        for(JsonNode member:value) {
            require(member.isTextual() && !member.asText().trim().isEmpty(),400,"面談者の選択が正しくありません。");
            require(ids.add(member.asText().trim()),400,"同じ面談者を重複して選択しないでください。");
        }
        return List.copyOf(ids);
    }
    private static String httpUrl(String value) {
        try {
            URI uri = URI.create(value);
            require(("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                && uri.getHost() != null && uri.getUserInfo() == null, 400, "面談URLはhttpまたはhttpsで入力してください。");
            return value;
        } catch (IllegalArgumentException e) { throw new ApiError(400, "面談URLが正しくありません。"); }
    }
    private static User authenticate(Connection c, HttpExchange exchange) throws SQLException {
        String userId = exchange.getRequestHeaders().getFirst("X-DealHunter-User");
        Map<String, Object> row = one(c, "SELECT id,role,display_name FROM app_users WHERE id=?", userId);
        require(row != null, 401, "ログインしてください。");
        return new User(str(row,"id"), str(row,"role"), str(row,"display_name"));
    }
    private static String passwordHash(String password) {
        byte[] salt=new byte[16]; RANDOM.nextBytes(salt);
        byte[] hash=derivePassword(password,salt,PASSWORD_ITERATIONS);
        return "pbkdf2-sha256$"+PASSWORD_ITERATIONS+"$"+Base64.getEncoder().encodeToString(salt)+"$"+Base64.getEncoder().encodeToString(hash);
    }
    private static byte[] derivePassword(String password, byte[] salt, int iterations) {
        PBEKeySpec spec=new PBEKeySpec(password.toCharArray(),salt,iterations,256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); }
        catch(java.security.GeneralSecurityException exception) { throw new IllegalStateException("Password hashing is unavailable",exception); }
        finally { spec.clearPassword(); }
    }
    private static boolean passwordMatches(String password, String encoded) {
        try {
            String[] parts=encoded.split("\\$",-1);
            if(parts.length!=4 || !parts[0].equals("pbkdf2-sha256")) return false;
            int iterations=Integer.parseInt(parts[1]);
            if(iterations<600_000 || iterations>2_000_000) return false;
            byte[] salt=Base64.getDecoder().decode(parts[2]), expected=Base64.getDecoder().decode(parts[3]);
            if(salt.length<16 || expected.length!=32) return false;
            return MessageDigest.isEqual(expected,derivePassword(password,salt,iterations));
        } catch(IllegalArgumentException exception) { return false; }
    }
    private static void seedSampleCredentials(Connection c) throws SQLException {
        List<String[]> samples=new ArrayList<>();
        samples.add(new String[]{"sales-aoki","sales.aoki@dealhunter.example","demo-sales"});
        for(String alias:List.of("takahashi","yamamoto","mori","ito","kobayashi","sasaki","tanaka","kimura","inoue"))
            samples.add(new String[]{"student-"+alias,"engineer."+alias+"@dealhunter.example","demo-engineer"});
        for(String alias:List.of("sato","suzuki")) samples.add(new String[]{"leader-"+alias,"leader."+alias+"@dealhunter.example","demo-leader"});
        for(String[] sample:samples) {
            if(one(c,"SELECT id FROM app_users WHERE id=? AND email IS NULL AND password_hash IS NULL",sample[0])!=null)
                execute(c,"UPDATE app_users SET email=?,password_hash=? WHERE id=? AND email IS NULL AND password_hash IS NULL",sample[1],passwordHash(sample[2]),sample[0]);
            String originalRole=sample[0].substring(0,sample[0].indexOf('-'));
            execute(c,"UPDATE app_users SET demo_login_profile=? WHERE id=? AND email=? AND password_hash IS NOT NULL AND demo_login_profile IS NULL",
                    "legacy-"+originalRole,sample[0],sample[1]);
        }
    }
    private static void seedAdminCredentials(Connection c, Path backend) throws Exception {
        if(one(c,"SELECT id FROM app_users WHERE role='admin' OR id='admin-initial' OR lower(email)='admin@legarea.jp' LIMIT 1")!=null) return;
        Path directory=backend.toAbsolutePath().normalize().getParent().resolve(".local");
        Files.createDirectories(directory);
        Path filename=directory.resolve("initial-admin-password.txt");
        String password;
        if(Files.exists(filename)) password=Files.readString(filename,StandardCharsets.UTF_8).strip();
        else {
            byte[] bytes=new byte[24]; RANDOM.nextBytes(bytes);
            password=Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
            Files.writeString(filename,password+System.lineSeparator(),StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE);
        }
        require(password.length()>=10 && password.length()<=128,500,"初期管理者パスワードの設定を確認してください。");
        execute(c,"INSERT INTO app_users(id,display_name,role,email,password_hash) VALUES('admin-initial','管理者','admin','admin@legarea.jp',?)",passwordHash(password));
    }
    private static Map<String,String> publicUser(Map<String,Object> row) {
        return Map.of("id",str(row,"id"),"name",str(row,"display_name"),"role",str(row,"role"));
    }
    private static Object demoLoginAccounts(Connection c) throws SQLException {
        List<Map<String,String>> accounts=new ArrayList<>();
        String sql="""
            SELECT id, display_name, role, email, demo_login_profile FROM app_users
            WHERE role IN ('sales','student','leader') AND password_hash IS NOT NULL
              AND email LIKE '%@dealhunter.example' AND demo_login_profile IS NOT NULL
              AND (demo_login_profile <> 'workbook' OR ?)
            ORDER BY CASE WHEN id IN ('student-takahashi','leader-sato') THEN 0 ELSE 1 END, display_name, id
            """;
        try(PreparedStatement statement=prepared(c,sql,LOCAL_DEMO); ResultSet rows=statement.executeQuery()) {
            while(rows.next()) accounts.add(Map.of("id",rows.getString("id"),"name",rows.getString("display_name"),
                    "role",rows.getString("role"),"email",rows.getString("email"),"profile",rows.getString("demo_login_profile")));
        }
        return Map.of("accounts",accounts);
    }
    private static String registrationEmail(JsonNode body) {
        JsonNode value=body.get("email");
        require(value!=null && value.isTextual() && value.asText().codePoints().noneMatch(Character::isISOControl),400,"メールアドレスを入力してください。");
        String email=value.asText().trim().toLowerCase(Locale.ROOT);
        String atom="[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
        require(email.length()<=254 && email.matches(atom+"(?:\\."+atom+")*@legarea\\.jp") && email.indexOf('@')<=64,400,"メールアドレスは @legarea.jp のものを入力してください。");
        return email;
    }
    private static Object registerUser(Connection c, JsonNode body) throws SQLException {
        require(body.size()==4 && body.has("name") && body.has("email") && body.has("password") && body.has("role"),400,"氏名・メールアドレス・パスワード・役割を指定してください。");
        String name=text(body,"name"), email=registrationEmail(body), selectedRole=text(body,"role");
        require(name.length()<=100 && name.codePoints().noneMatch(Character::isISOControl),400,"氏名は100文字以内で入力してください。");
        require(List.of("sales","student","leader").contains(selectedRole),400,"役割は営業・エンジニア・リーダーから選択してください。");
        JsonNode passwordNode=body.get("password");
        require(passwordNode!=null && passwordNode.isTextual() && passwordNode.asText().length()>=10 && passwordNode.asText().length()<=128,400,"パスワードは10文字以上128文字以内で入力してください。");
        require(one(c,"SELECT id FROM app_users WHERE lower(email)=?",email)==null,409,"このメールアドレスは登録済みです。");
        String userId=id("U-");
        execute(c,"INSERT INTO app_users(id,display_name,role,email,password_hash) VALUES(?,?,?,?,?)",userId,name,selectedRole,email,passwordHash(passwordNode.asText()));
        return Map.of("message","アカウントを登録しました。","user",Map.of("id",userId,"name",name,"role",selectedRole));
    }
    private static Object loginUser(Connection c, JsonNode body) throws SQLException {
        JsonNode emailNode=body.get("email"),passwordNode=body.get("password");
        require(emailNode!=null && emailNode.isTextual() && emailNode.asText().length()<=254 && passwordNode!=null && passwordNode.isTextual() && passwordNode.asText().length()<=128,401,"メールアドレスまたはパスワードが正しくありません。");
        String email=emailNode.asText().trim().toLowerCase(Locale.ROOT),password=passwordNode.asText();
        reserveLoginAttempt(email);
        Map<String,Object> row=one(c,"SELECT id,display_name,role,password_hash FROM app_users WHERE lower(email)=? AND (demo_login_profile IS DISTINCT FROM 'workbook' OR (? AND role<>'admin'))",email,LOCAL_DEMO);
        boolean valid=passwordMatches(password,row==null?DUMMY_PASSWORD_HASH:str(row,"password_hash"));
        require(row!=null && valid,401,"メールアドレスまたはパスワードが正しくありません。");
        synchronized(LOGIN_ATTEMPTS) { LOGIN_ATTEMPTS.remove(email); }
        return Map.of("user",publicUser(row));
    }
    private static void reserveLoginAttempt(String email) {
        synchronized(LOGIN_ATTEMPTS) {
            long now=System.currentTimeMillis();
            LOGIN_ATTEMPTS.entrySet().removeIf(entry -> entry.getValue().expiresAt()<=now);
            LoginAttempts attempts=LOGIN_ATTEMPTS.get(email);
            require(attempts==null || attempts.count()<10,429,"メールアドレスまたはパスワードが正しくありません。");
            if(attempts==null && LOGIN_ATTEMPTS.size()>=4096) LOGIN_ATTEMPTS.remove(LOGIN_ATTEMPTS.keySet().iterator().next());
            LOGIN_ATTEMPTS.put(email,new LoginAttempts(attempts==null?1:attempts.count()+1,attempts==null?now+300_000:attempts.expiresAt()));
        }
    }
    private static Object currentUser(Connection c, String userId) throws SQLException {
        Map<String,Object> row=one(c,"SELECT id,display_name,role FROM app_users WHERE id=?",userId);
        require(row!=null,404,"利用者が見つかりません。");
        return Map.of("user",publicUser(row));
    }
    private static Map<String,Object> adminUser(Map<String,Object> row) {
        Map<String,Object> value=new LinkedHashMap<>();
        value.put("id",str(row,"id")); value.put("name",str(row,"display_name")); value.put("email",row.get("email"));
        value.put("role",str(row,"role")); value.put("leaderId",row.get("leader_id")); value.put("leaderName",row.get("leader_name"));
        value.put("isDemo",str(row,"email").endsWith("@dealhunter.example"));
        return value;
    }
    private static final String ADMIN_USER_SELECT="SELECT u.id,u.display_name,u.email,u.role,m.leader_id,lu.display_name AS leader_name FROM app_users u LEFT JOIN leader_members m ON m.student_id=u.id AND m.active AND u.role='student' LEFT JOIN app_users lu ON lu.id=m.leader_id AND lu.role='leader'";
    private static Object listUsers(Connection c, User user) throws SQLException {
        role(user,"admin");
        List<Map<String,Object>> users=new ArrayList<>(); List<Map<String,String>> leaders=new ArrayList<>();
        try(PreparedStatement statement=prepared(c,ADMIN_USER_SELECT+" ORDER BY lower(COALESCE(u.email,'')),u.id"); ResultSet rows=statement.executeQuery()) {
            while(rows.next()) {
                Map<String,Object> row=new HashMap<>();
                for(int index=1;index<=rows.getMetaData().getColumnCount();index++) row.put(rows.getMetaData().getColumnLabel(index),rows.getObject(index));
                users.add(adminUser(row));
                if(str(row,"role").equals("leader")) leaders.add(Map.of("id",str(row,"id"),"name",str(row,"display_name")));
            }
        }
        return Map.of("users",users,"leaders",leaders);
    }
    private static Object updateUser(Connection c, User user, String userId, JsonNode body) throws SQLException {
        role(user,"admin");
        // The handler obtains the exclusive account-edit advisory lock before
        // authenticating. Ordinary user requests hold the matching shared lock.
        require(body.has("role") && body.size()==(body.has("leaderId")?2:1),400,"役割と所属リーダーを指定してください。");
        String nextRole=text(body,"role");
        require(List.of("sales","student","leader","admin").contains(nextRole),400,"役割を正しく選択してください。");
        Map<String,Object> target=one(c,"SELECT id,role,demo_login_profile FROM app_users WHERE id=? FOR UPDATE",userId);
        require(target!=null,404,"利用者が見つかりません。");
        require(!nextRole.equals("admin") || !str(target,"demo_login_profile").equals("workbook"),409,
                "管理者には個別のパスワードで登録したアカウントを指定してください。");
        String previousRole=str(target,"role");
        if(previousRole.equals("admin") && !nextRole.equals("admin"))
            require(((Number)one(c,"SELECT count(*) AS n FROM app_users WHERE role='admin'").get("n")).longValue()>1,409,"最後の管理者の役割は変更できません。別の管理者を先に登録してください。");
        if(previousRole.equals("leader") && !nextRole.equals("leader")) {
            require(one(c,"SELECT student_id FROM leader_members WHERE leader_id=? AND active LIMIT 1",userId)==null,409,"先に部下の所属リーダーを変更してください。");
            require(one(c,"SELECT a.id FROM recruitments a JOIN projects p ON p.id=a.project_id WHERE p.leader_id=? AND a.status='pending' AND a.cancelled_at IS NULL LIMIT 1",userId)==null,409,"面談者の選定待ち案件があります。選定を完了してから役割を変更してください。");
        }
        String leaderId=null;
        if(body.has("leaderId")) {
            JsonNode leader=body.get("leaderId");
            require(leader.isNull() || leader.isTextual(),400,"所属リーダーを正しく選択してください。");
            leaderId=leader.isNull()?null:leader.asText().trim();
            if(leaderId!=null && leaderId.isEmpty()) leaderId=null;
            require(nextRole.equals("student") || leaderId==null,400,"所属リーダーを指定できるのはエンジニアだけです。");
            if(leaderId!=null) require(!leaderId.equals(userId) && one(c,"SELECT id FROM app_users WHERE id=? AND role='leader'",leaderId)!=null,400,"登録済みのリーダーを選択してください。");
        } else if(previousRole.equals("student") && nextRole.equals("student")) {
            Map<String,Object> membership=one(c,"SELECT m.leader_id FROM leader_members m JOIN app_users l ON l.id=m.leader_id AND l.role='leader' WHERE m.student_id=? AND m.active",userId);
            if(membership!=null) leaderId=str(membership,"leader_id");
        }
        execute(c,"UPDATE app_users SET role=? WHERE id=?",nextRole,userId);
        if(!nextRole.equals("student") || leaderId==null) execute(c,"UPDATE leader_members SET active=false WHERE student_id=?",userId);
        else execute(c,"INSERT INTO leader_members(leader_id,student_id,active) VALUES(?,?,true) ON CONFLICT(student_id) DO UPDATE SET leader_id=EXCLUDED.leader_id,active=true",leaderId,userId);
        return Map.of("message","役割と所属を更新しました。","user",adminUser(one(c,ADMIN_USER_SELECT+" WHERE u.id=?",userId)));
    }
    private static Object listProjects(Connection c, User user) throws Exception {
        role(user,"admin");
        Map<String,Object> row=one(c,dashboardSql,user.id);
        JsonNode dashboard=JSON.readTree(row.values().iterator().next().toString());
        return Map.of("projects",dashboard.get("projects"),"events",dashboard.get("events"),"requests",dashboard.get("requests"),"importedCases",dashboard.get("importedCases"));
    }
    private static Object updateProject(Connection c, User user, String projectId, JsonNode body) throws SQLException {
        role(user,"admin");
        Map<String,String> fields=Map.ofEntries(Map.entry("name","name"),Map.entry("notes","notes"),Map.entry("participantName","participant_name"),Map.entry("participantNameKana","participant_name_kana"),Map.entry("upperCompany","upper_company"),Map.entry("primeCompany","prime_company"),Map.entry("endCompany","end_company"),Map.entry("category","category"),Map.entry("remarks","remarks"),Map.entry("executorName","executor_name"),Map.entry("followerNames","follower_names"));
        require(!body.isEmpty(),400,"更新する案件情報を指定してください。");
        for(Iterator<String> names=body.fieldNames();names.hasNext();) require(fields.containsKey(names.next()),400,"更新できない案件項目が指定されています。");
        Map<String,Object> previous=one(c,"SELECT id,end_company FROM projects WHERE id=? FOR UPDATE",projectId);
        require(previous!=null,404,"案件が見つかりません。");
        List<String> assignments=new ArrayList<>(); List<Object> values=new ArrayList<>();
        for(var field:fields.entrySet()) {
            String key=field.getKey();
            if(!body.has(key)) continue;
            if(key.equals("followerNames")) {
                JsonNode followers=body.get(key);
                require(followers.isArray() && followers.size()<=20,400,"案件フォロー者は20名以内で入力してください。");
                Set<String> names=new LinkedHashSet<>();
                for(JsonNode follower:followers) {
                    require(follower.isTextual() && !follower.asText().trim().isEmpty() && follower.asText().trim().length()<=100,400,"案件フォロー者は1名ずつ100文字以内で入力してください。");
                    require(names.add(follower.asText().trim()),400,"案件フォロー者が重複しています。");
                }
                assignments.add("follower_names=?"); values.add(c.createArrayOf("text",names.toArray(String[]::new)));
            } else {
                int maximum=key.equals("notes")?20000:key.equals("remarks")?2000:List.of("category","executorName").contains(key)?100:200;
                // Submitting an unchanged legacy value must not rewrite its spelling
                // or surrounding whitespace while editing unrelated project fields.
                boolean unchangedEndCompany=key.equals("endCompany") && body.get(key).isTextual() && body.get(key).asText().equals(str(previous,"end_company"));
                String value=unchangedEndCompany?str(previous,"end_company"):List.of("upperCompany","primeCompany","endCompany").contains(key)?companyName(body,key,key,false):boundedText(body,key,maximum,key.equals("name"));
                if(key.equals("participantNameKana")) {
                    value=Normalizer.normalize(value,Normalizer.Form.NFC);
                    require(value.isEmpty() || value.matches("[ぁ-ゖゝゞー・ 　]+"),400,"参画者のふりがなはひらがなで入力してください。");
                }
                assignments.add(field.getValue()+"=?"); values.add(value);
            }
        }
        values.add(projectId);
        execute(c,"UPDATE projects SET "+String.join(",",assignments)+" WHERE id=?",values.toArray());
        if(body.has("endCompany")) {
            rememberEndCompany(c,projectId,str(previous,"end_company"));
            rememberEndCompany(c,projectId,body.get("endCompany").asText());
        }
        return Map.of("message","案件情報を更新しました。","projectId",projectId);
    }
    private static Object deleteProject(Connection c, User user, String projectId, JsonNode body) throws SQLException {
        role(user,"sales");
        require(body.size()==1 && body.path("confirm").isBoolean() && body.path("confirm").booleanValue(),400,"案件削除の警告を確認してください。");
        try {
            execute(c,"SET LOCAL lock_timeout = '1s'");
            Map<String,Object> project=one(c,"SELECT sales_id FROM projects WHERE id=? FOR UPDATE NOWAIT",projectId);
            require(project!=null,404,"案件が見つかりません。");
            require(user.id.equals(str(project,"sales_id")),403,"担当案件のみ削除できます。");
            // Other workflow actions can already hold a child row before taking a project lock via a foreign key.
            execute(c,"SELECT id FROM interview_requests WHERE project_id=? FOR UPDATE NOWAIT",projectId);
            execute(c,"SELECT id FROM scheduled_events WHERE project_id=? FOR UPDATE NOWAIT",projectId);
            execute(c,"SELECT id FROM recruitments WHERE project_id=? FOR UPDATE NOWAIT",projectId);

            execute(c,"DELETE FROM interview_questions WHERE project_id=?",projectId);
            execute(c,"DELETE FROM interview_feedback f USING scheduled_events e WHERE f.event_id=e.id AND e.project_id=?",projectId);
            execute(c,"DELETE FROM scheduled_events WHERE project_id=?",projectId);
            execute(c,"DELETE FROM candidate_slots s USING interview_requests r WHERE s.request_id=r.id AND r.project_id=?",projectId);
            execute(c,"DELETE FROM interview_requests WHERE project_id=?",projectId);
            execute(c,"DELETE FROM pending_tasks WHERE project_id=?",projectId);
            execute(c,"DELETE FROM notification_previews WHERE project_id=?",projectId);
            execute(c,"DELETE FROM projects WHERE id=?",projectId);
            return Map.of("message","案件と関連データを削除しました。","projectId",projectId);
        } catch(SQLException error) {
            if(Set.of("55P03","40P01").contains(Objects.toString(error.getSQLState(),""))) {
                throw new ApiError(409,"案件の更新中です。最新の状態を確認してから、もう一度削除してください。");
            }
            throw error;
        }
    }
    private static Map<String, Object> request(Connection c, User user, String id, String requiredRole) throws SQLException {
        role(user, requiredRole);
        Map<String, Object> row = one(c, "SELECT r.*,p.sales_id,p.name AS project_name,p.notes,u.display_name AS person,su.display_name AS sales_name FROM interview_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id JOIN app_users su ON su.id=p.sales_id WHERE r.id=? AND r.cancelled_at IS NULL FOR UPDATE OF r", id);
        require(row != null, 404, "面談依頼が見つかりません。");
        require(user.id.equals(str(row, requiredRole.equals("sales") ? "sales_id" : "student_id")), 403, "この面談依頼は操作できません。");
        return row;
    }
    private static void checkResponseVersion(Map<String,Object> r,JsonNode expected) {
        // Older clients send only a slot ID. New clients also bind the action to the answer they viewed.
        if(expected==null) return;
        require(expected.isIntegralNumber() && expected.canConvertToLong() && expected.asLong()>0,400,"日程回答の版が正しくありません。");
        require(expected.asLong()==((Number)r.get("task_revision")).longValue(),409,"日程の依頼・回答が更新されました。最新の内容を読み込んでください。");
    }
    private static Map<String, Object> ownedEvent(Connection c, User user, String id, String requiredRole) throws SQLException {
        role(user, requiredRole);
        Map<String, Object> row = one(c, "SELECT e.*,p.sales_id,p.name AS project_name,p.participant_name,u.display_name AS person FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id WHERE e.id=? FOR UPDATE OF e", id);
        require(row != null, 404, "予定が見つかりません。");
        require(user.id.equals(str(row, requiredRole.equals("sales") ? "sales_id" : "student_id")), 403, "この予定は操作できません。");
        return row;
    }
    private static Map<String, Object> event(Connection c, User user, String id, String requiredRole) throws SQLException {
        Map<String,Object> row=ownedEvent(c,user,id,requiredRole);
        require(str(row,"kind").equals("meet"), 400, "面談の予定を選んでください。");
        require("scheduled".equals(row.get("schedule_state")),409,"延期・中止された面談ではこの操作はできません。");
        return row;
    }
    private static Map<String,String> line(String label, String value) { return Map.of("label", label, "value", value); }
    private static Map<String,Object> preview(Connection c, String projectId, String recipient, String kind, String title, List<Map<String,String>> lines, String body) throws Exception {
        Map<String,Object> result = Map.of("title",title,"lines",lines,"body",body);
        execute(c, "INSERT INTO notification_previews(id,project_id,recipient_id,kind,title,lines,body) VALUES(?,?,?,?,?,?::jsonb,?)",
            id("N-"), projectId, recipient, kind, title, JSON.writeValueAsString(lines), body);
        return result;
    }

    private static Attachment parseAttachment(JsonNode item) {
        require(item != null && item.isObject(),400,"添付ファイルの形式が正しくありません。");
        String name=text(item,"name");
        require(name.length()<=200 && !name.contains("/") && !name.contains("\\") && name.codePoints().noneMatch(Character::isISOControl) && name.matches("(?i).+\\.(pdf|xls|xlsx|doc|docx)"),400,"PDF、Excel、Wordのファイルを選択してください。");
        String encoded=text(item,"contentBase64");
        require(encoded.length()<=6990508,413,"添付ファイルは5MB以内にしてください。");
        byte[] bytes;
        try { bytes=Base64.getDecoder().decode(encoded); } catch(IllegalArgumentException ex) { throw new ApiError(400,"添付ファイルを読み取れませんでした。"); }
        require(bytes.length>0 && bytes.length<=5*1024*1024,413,"添付ファイルは5MB以内にしてください。");
        return new Attachment(name,bytes);
    }

    private static final String DRAFT_INFO = """
        jsonb_build_object('id',id,'revision',revision,'updatedAt',updated_at,
            'title',left(coalesce(content #>> '{values,project}',''),200))
        """;
    private static final class DraftConflict extends RuntimeException {
        DraftConflict() { super("下書きは他のタブで更新、削除、または本登録されています。下書き一覧から最新の状態を確認してください。"); }
    }

    private static int draftRevision(JsonNode body, String field) {
        JsonNode value=body.path(field);
        require(value.isIntegralNumber() && value.canConvertToInt() && value.intValue()>0,400,"下書きの版が正しくありません。");
        return value.intValue();
    }
    private static boolean draftString(JsonNode value) {
        return value.isTextual() && value.textValue().indexOf(0)<0;
    }
    private static ObjectNode draftContent(JsonNode body) {
        JsonNode content=body.path("content");
        require(content instanceof ObjectNode && content.path("version").isIntegralNumber() && content.path("version").asLong()==1,400,"下書きの形式が正しくありません。");
        Set<String> keys=Set.of("version","values","slots","selectedStudents","requestedDates","assignmentMode","scheduleMode","addingUpperCompany","addingEndCompany","attachment");
        content.fieldNames().forEachRemaining(k -> require(keys.contains(k),400,"未対応の下書き項目です。"));
        JsonNode values=content.path("values");
        require(values.isObject(),400,"下書きの入力項目が正しくありません。");
        Set<String> fields=Set.of("project","upperCompany","primeCompany","endCompany","category","remarks","totalRounds","summary","participantName","participantNameKana","leaderId");
        values.fields().forEachRemaining(f -> require(fields.contains(f.getKey()) && draftString(f.getValue()),400,"下書きの入力値が正しくありません。"));
        for(String array:List.of("slots","requestedDates","selectedStudents")) {
            JsonNode list=content.path(array);
            require(list.isArray(),400,"下書きの選択項目が正しくありません。");
            for(JsonNode item:list) require(draftString(item),400,"下書きの選択値が正しくありません。");
        }
        require(Set.of("direct","leader").contains(content.path("assignmentMode").asText()) &&
                Set.of("candidates","availability").contains(content.path("scheduleMode").asText()) &&
                content.path("addingUpperCompany").isBoolean() && content.path("addingEndCompany").isBoolean(),400,"下書きの選択方法が正しくありません。");
        return (ObjectNode)content;
    }
    private static void discardDraft(Connection c, User user, String draftId, int revision) throws SQLException {
        try (PreparedStatement s=prepared(c,"DELETE FROM interview_request_drafts WHERE id=? AND sales_id=? AND revision=?",draftId,user.id,revision)) {
            if(s.executeUpdate()!=1) throw new DraftConflict();
        }
    }
    private static Object requestDrafts(Connection c, User user, String draftId, String method, JsonNode body) throws Exception {
        if(method.equals("GET") && draftId==null) {
            Map<String,Object> row=one(c,"SELECT coalesce(jsonb_agg("+DRAFT_INFO+" ORDER BY updated_at DESC,id),'[]'::jsonb) AS drafts FROM interview_request_drafts WHERE sales_id=?",user.id);
            return Map.of("drafts",JSON.readTree(str(row,"drafts")));
        }
        if(method.equals("GET")) {
            Map<String,Object> row=one(c,"SELECT "+DRAFT_INFO+" AS info,content,filename,attachment FROM interview_request_drafts WHERE id=? AND sales_id=?",draftId,user.id);
            require(row!=null,404,"下書きが見つかりません。");
            ObjectNode info=(ObjectNode)JSON.readTree(str(row,"info"));
            ObjectNode content=(ObjectNode)JSON.readTree(str(row,"content"));
            if(row.get("attachment") instanceof byte[] bytes)
                content.putObject("attachment").put("name",str(row,"filename")).put("contentBase64",Base64.getEncoder().encodeToString(bytes));
            else content.putNull("attachment");
            info.set("content",content);
            return info;
        }
        if(method.equals("DELETE")) {
            discardDraft(c,user,draftId,draftRevision(body,"revision"));
            return Map.of("message","下書きを削除しました。");
        }
        ObjectNode content=draftContent(body);
        JsonNode file=content.remove("attachment");
        Attachment attachment=file!=null && !file.isNull()?parseAttachment(file):null;
        String filename=attachment==null?null:attachment.name;
        byte[] bytes=attachment==null?null:attachment.content;
        String serialized=JSON.writeValueAsString(content);
        Map<String,Object> row;
        if(method.equals("POST")) {
            String key=body.has("creationKey")?text(body,"creationKey"):UUID.randomUUID().toString();
            require(key.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"),400,"下書きの識別子が正しくありません。");
            draftId="D-"+key.toLowerCase(Locale.ROOT);
            row=one(c,"INSERT INTO interview_request_drafts(id,sales_id,content,filename,attachment) VALUES(?,?,?::jsonb,?,?) ON CONFLICT (id) DO NOTHING RETURNING "+DRAFT_INFO+" AS info",draftId,user.id,serialized,filename,bytes);
            if(row==null) row=one(c,"SELECT "+DRAFT_INFO+" AS info FROM interview_request_drafts WHERE id=? AND sales_id=? AND revision=1 AND content=?::jsonb AND filename IS NOT DISTINCT FROM ?::text AND attachment IS NOT DISTINCT FROM ?::bytea",draftId,user.id,serialized,filename,bytes);
        } else {
            int revision=draftRevision(body,"revision");
            row=one(c,"UPDATE interview_request_drafts SET content=?::jsonb,filename=?,attachment=?,revision=revision+1,updated_at=now() WHERE id=? AND sales_id=? AND revision=? RETURNING "+DRAFT_INFO+" AS info",serialized,filename,bytes,draftId,user.id,revision);
        }
        if(row==null) throw new DraftConflict();
        return JSON.readTree(str(row,"info"));
    }
    private static Object saveAttachment(Connection c, User user, String requestId, JsonNode body) throws SQLException {
        Map<String,Object> r=request(c,user,requestId,"sales");
        one(c,"SELECT id FROM projects WHERE id=? FOR UPDATE",r.get("project_id"));
        Attachment attachment=parseAttachment(body);
        execute(c,"INSERT INTO project_attachments(project_id,filename,content) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET filename=EXCLUDED.filename,content=EXCLUDED.content,created_at=now()",r.get("project_id"),attachment.name(),attachment.content());
        return Map.of("message","案件共通のスキルシートを保存しました。","attachment",Map.of("name",attachment.name(),"size",attachment.content().length,"scope","project"));
    }
    private static void downloadAttachment(Connection c, User user, String requestId, HttpExchange exchange) throws Exception {
        require(user.role.equals("sales") || user.role.equals("student"),403,"このファイルは利用できません。");
        Map<String,Object> r=one(c,"SELECT project_id,student_id FROM interview_requests WHERE id=? AND cancelled_at IS NULL",requestId);
        require(r!=null,404,"面談依頼が見つかりません。");
        require(user.role.equals("sales") || user.id.equals(r.get("student_id")),403,"このファイルは利用できません。");
        Map<String,Object> row=one(c,"SELECT filename,content FROM (SELECT filename,content,0 AS priority FROM project_attachments WHERE project_id=? UNION ALL SELECT filename,content,1 AS priority FROM request_attachments WHERE request_id=?) a ORDER BY priority LIMIT 1",r.get("project_id"),requestId);
        require(row!=null,404,"添付ファイルが見つかりません。");
        byte[] bytes=(byte[])row.get("content");
        String encoded=URLEncoder.encode(str(row,"filename"),StandardCharsets.UTF_8).replace("+","%20");
        exchange.getResponseHeaders().set("Content-Type","application/octet-stream");
        exchange.getResponseHeaders().set("Content-Disposition","attachment; filename=\"skill-sheet\"; filename*=UTF-8''"+encoded);
        exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");
        exchange.getResponseHeaders().set("Cache-Control","no-store");
        exchange.sendResponseHeaders(200,bytes.length);
        try(var output=exchange.getResponseBody()) { output.write(bytes); }
    }

    private static IssuedRequests issueRequests(Connection c, String projectId, String project, String summary,
            String scheduleMode, List<LocalDate> requestedDates, List<Slot> slots, Map<String,String> students, String recruitmentId) throws Exception {
        List<String> requestIds=new ArrayList<>();
        List<Map<String,Object>> previews=new ArrayList<>();
        String times=scheduleLabel(scheduleMode,requestedDates,slots);
        for(var member:students.entrySet()) {
            String requestId=id("R-");
            execute(c,"INSERT INTO interview_requests(id,project_id,student_id,status,schedule_mode,requested_dates,recruitment_id,total_rounds) VALUES(?,?,?,'requested',?,?::date[],?,(SELECT total_rounds FROM projects WHERE id=?))",requestId,projectId,member.getKey(),scheduleMode,datesArray(requestedDates),recruitmentId,projectId);
            for(Slot slot:slots) execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at) VALUES(?,?,?,?)",id("S-"),requestId,slot.start,slot.end);
            requestIds.add(requestId);
            previews.add(preview(c,projectId,member.getKey(),"lark","面談依頼の通知内容",List.of(line("宛先","面談連絡グループ"),line("メンション","@"+member.getValue()),line("案件",project),line("概要",summary),line(scheduleMode.equals("availability")?"日程の確認":"候補日時",times),line("面談ページ","http://127.0.0.1:3100/engineer?request="+requestId)),"面談依頼が来ました。概要を確認し、営業へ参加可能な日時を回答してください。外部送信は行っていません。"));
        }
        return new IssuedRequests(requestIds,previews);
    }

    private static Object createRequest(Connection c, User user, JsonNode body) throws Exception {
        role(user,"sales");
        if(body.has("draftId") || body.has("draftRevision"))
            discardDraft(c,user,text(body,"draftId"),draftRevision(body,"draftRevision"));
        String upperCompany=companyName(body,"upperCompany","上位会社",true),endCompany=companyName(body,"endCompany","エンド企業",false);
        String primeCompany=companyName(body,"primeCompany","元請け",false),category=boundedText(body,"category",100,false),remarks=boundedText(body,"remarks",2000,false);
        String project = boundedText(body,"project",200,true), summary = boundedText(body,"summary",20000,true);
        int plannedRounds=totalRounds(body,1,1);
        require(!body.has("executorName") && !body.has("followerNames"),400,"案件遂行者とフォロー者は管理画面で設定してください。");
        String assignmentMode=body.has("assignmentMode")?text(body,"assignmentMode"):"direct";
        require(assignmentMode.equals("direct") || assignmentMode.equals("leader"),400,"面談者の選定方法が正しくありません。");
        boolean leaderAssignment=assignmentMode.equals("leader");
        boolean multiplePayload=body.has("studentIds");
        List<String> memberIds=new ArrayList<>();
        if(leaderAssignment) {
            JsonNode members=body.get("studentIds");
            require(!body.has("studentId") && (members==null || (members.isArray() && members.isEmpty())),400,"リーダーに選定を依頼するときは面談者を指定しないでください。");
        } else if(multiplePayload) memberIds.addAll(studentIds(body.get("studentIds")));
        else memberIds.add(text(body,"studentId"));
        Map<String,String> students=new LinkedHashMap<>();
        for(String memberId:memberIds) {
            require(!students.containsKey(memberId),400,"同じ面談者を重複して選択しないでください。");
            Map<String,Object> member=one(c,"SELECT display_name FROM app_users WHERE id=? AND role='student'",memberId);
            require(member!=null,400,"受講者として登録された利用者を選んでください。");
            students.put(memberId,str(member,"display_name"));
        }
        String participantName=optionalText(body,"participantName"), participantNameKana=Normalizer.normalize(optionalText(body,"participantNameKana"),Normalizer.Form.NFC);
        require(participantName.length()<=200 && participantNameKana.length()<=200,400,"参画者とふりがなは200文字以内にしてください。");
        require(participantNameKana.isEmpty() || participantNameKana.matches("[ぁ-ゖゝゞー・ 　]+"),400,"参画者のふりがなはひらがなで入力してください。");
        JsonNode files=body.get("attachments");
        require(files==null || files.isNull() || (files.isArray() && files.isEmpty()),400,"スキルシートは案件共通のファイルを1つ選択してください。");
        Attachment attachment=body.hasNonNull("attachment")?parseAttachment(body.get("attachment")):null;
        String leaderId=leaderAssignment || multiplePayload?text(body,"leaderId"):optionalText(body,"leaderId");
        Map<String,Object> leader=null;
        if(!leaderId.isEmpty()) {
            leader=one(c,"SELECT display_name FROM app_users WHERE id=? AND role='leader'",leaderId);
            require(leader!=null,400,"担当リーダーとして登録された利用者を選んでください。");
        }
        String scheduleMode = body.has("scheduleMode") ? text(body,"scheduleMode") : "candidates";
        require(scheduleMode.equals("candidates") || scheduleMode.equals("availability"),400,"日程の確認方法が正しくありません。");
        require(!body.has("proposals") && !body.has("slotIds"),400,"依頼作成時に回答は指定できません。");
        List<LocalDate> requestedDates = requestedDates(body.get("requestedDates"));
        JsonNode candidates = body.get("candidates");
        boolean availability = scheduleMode.equals("availability");
        require(availability || requestedDates.isEmpty(),400,"指定日を選ぶ場合は参加可能な日時を確認する方法を選んでください。");
        require(!availability || candidates == null || (candidates.isArray() && candidates.isEmpty()),400,"参加可能な日時を確認する依頼には固定の候補日時を指定できません。");
        List<Slot> slots = availability ? List.of() : slots(candidates,false);
        String projectId=id("DH-");
        execute(c,"INSERT INTO projects(id,name,sales_id,notes,leader_id,participant_name,participant_name_kana,upper_company,end_company,prime_company,category,remarks,total_rounds) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",projectId,project,user.id,summary,leaderId.isEmpty()?null:leaderId,participantName,participantNameKana,upperCompany,endCompany,primeCompany,category,remarks,plannedRounds);
        rememberEndCompany(c,projectId,endCompany);
        if(attachment!=null) execute(c,"INSERT INTO project_attachments(project_id,filename,content) VALUES(?,?,?)",projectId,attachment.name(),attachment.content());
        if(leaderAssignment) {
            String recruitmentId=id("A-");
            execute(c,"INSERT INTO recruitments(id,project_id,schedule_mode,requested_dates) VALUES(?,?,?,?::date[])",recruitmentId,projectId,scheduleMode,datesArray(requestedDates));
            for(Slot slot:slots) execute(c,"INSERT INTO recruitment_candidate_slots(id,recruitment_id,start_at,end_at) VALUES(?,?,?,?)",id("T-"),recruitmentId,slot.start,slot.end);
            var p=preview(c,projectId,leaderId,"lark","面談者の選定依頼",List.of(line("メンション","@"+str(leader,"display_name")),line("案件",project),line("概要",summary),line("面談者","未定・担当リーダーが選定"),line(availability?"日程の確認":"候補日時",scheduleLabel(scheduleMode,requestedDates,slots)),line("選定ページ","http://127.0.0.1:3100/leader?project="+projectId)),"部下から面談者を1名以上選択してください。選定後、各面談者が自分の予定を回答します。外部送信は行っていません。");
            return Map.of("message","担当リーダーへの面談者の選定依頼を保存しました。","projectId",projectId,"recruitmentId",recruitmentId,"requestIds",List.of(),"preview",p,"previews",List.of(p),"leaderPreview",p);
        }
        IssuedRequests issued=issueRequests(c,projectId,project,summary,scheduleMode,requestedDates,slots,students,null);
        List<String> requestIds=issued.ids();
        List<Map<String,Object>> previews=issued.previews();
        Map<String,Object> response=new LinkedHashMap<>();
        response.put("message",students.size()+"名への面談依頼を保存しました。");
        response.put("projectId",projectId);
        response.put("requestId",requestIds.getFirst());
        response.put("requestIds",requestIds);
        response.put("preview",previews.getFirst());
        response.put("previews",previews);
        if(leader!=null) response.put("leaderPreview",Map.of("title","リーダーの閲覧リンク", "lines",List.of(
            line("担当リーダー",str(leader,"display_name")),line("案件",project),line("面談者",String.join("、",students.values())),
            line("閲覧ページ","http://127.0.0.1:3100/leader?project="+projectId)),
            "body","閲覧専用です。面談依頼・回答・日時の調整は営業と各面談者の間で直接行います。"));
        return response;
    }
    private static Map<String,Object> recruitment(Connection c, String recruitmentId) throws SQLException {
        Map<String,Object> recruitment=one(c,"SELECT a.*,p.leader_id,p.sales_id,p.name AS project_name,p.notes,su.display_name AS sales_name FROM recruitments a JOIN projects p ON p.id=a.project_id JOIN app_users su ON su.id=p.sales_id WHERE a.id=? AND a.cancelled_at IS NULL FOR UPDATE OF a",recruitmentId);
        require(recruitment!=null,404,"面談者の選定依頼が見つかりません。");
        return recruitment;
    }
    private static Object assignRecruitment(Connection c, User user, String recruitmentId, JsonNode body) throws Exception {
        role(user,"leader");
        Map<String,Object> recruitment=recruitment(c,recruitmentId);
        require(user.id.equals(str(recruitment,"leader_id")),403,"この案件の面談者は選定できません。");
        require(str(recruitment,"status").equals("pending"),409,"この依頼の面談者はすでに選定されています。");
        require(body.size()==1 && body.has("studentIds"),400,"選定する面談者だけを指定してください。");
        List<String> selected=studentIds(body.get("studentIds"));
        Map<String,String> students=new LinkedHashMap<>();
        // Use a stable order when protecting team membership and registered roles.
        for(String memberId:selected.stream().sorted().toList()) {
            Map<String,Object> member=one(c,"SELECT u.display_name FROM leader_members m JOIN app_users u ON u.id=m.student_id WHERE m.leader_id=? AND m.student_id=? AND m.active AND u.role='student' FOR SHARE OF m,u",user.id,memberId);
            require(member!=null,400,"自分の部下として登録されている面談者を選択してください。");
            students.put(memberId,str(member,"display_name"));
        }
        List<Slot> templates=new ArrayList<>();
        try(PreparedStatement statement=prepared(c,"SELECT start_at,end_at FROM recruitment_candidate_slots WHERE recruitment_id=? ORDER BY start_at,id",recruitmentId);
                ResultSet rows=statement.executeQuery()) {
            while(rows.next()) templates.add(new Slot(rows.getTimestamp("start_at").toLocalDateTime(),rows.getTimestamp("end_at")==null?null:rows.getTimestamp("end_at").toLocalDateTime()));
        }
        List<LocalDate> requestedDates=storedRequestedDates(recruitment).stream().sorted().toList();
        String projectId=str(recruitment,"project_id");
        IssuedRequests issued=issueRequests(c,projectId,str(recruitment,"project_name"),str(recruitment,"notes"),str(recruitment,"schedule_mode"),requestedDates,templates,students,recruitmentId);
        execute(c,"UPDATE recruitments SET status='assigned',assigned_at=now() WHERE id=?",recruitmentId);
        var salesPreview=preview(c,projectId,str(recruitment,"sales_id"),"lark","面談者の選定が完了",List.of(line("メンション","@"+str(recruitment,"sales_name")),line("案件",str(recruitment,"project_name")),line("担当リーダー",user.name),line("面談者",String.join("、",students.values())),line("面談ページ","http://127.0.0.1:3100/sales?request="+issued.ids().getFirst())),"担当リーダーが面談者を選定しました。各面談者の参加可能な日時への回答を待ってください。外部送信は行っていません。");
        return Map.of("message",students.size()+"名を面談者に選定し、各人への依頼を保存しました。","projectId",projectId,"recruitmentId",recruitmentId,"requestId",issued.ids().getFirst(),"requestIds",issued.ids(),"preview",issued.previews().getFirst(),"previews",issued.previews(),"salesPreview",salesPreview);
    }
    private static Object cancelInterviewRequest(Connection c, User user, String requestId, JsonNode body) throws SQLException {
        var request=request(c,user,requestId,"sales");
        require(body.size()==1 && body.has("revision"),400,"削除する依頼の版を指定してください。");
        checkResponseVersion(request,body.get("revision"));
        require(Set.of("requested","responded").contains(str(request,"status")),409,"日時が確定した面談依頼は削除できません。");
        execute(c,"UPDATE interview_requests SET cancelled_at=now(),task_revision=task_revision+1 WHERE id=?",requestId);
        return queueCancellation(c,str(request,"project_id"),str(request,"student_id"),str(request,"project_name"),"面談依頼");
    }
    private static Object cancelRecruitment(Connection c, User user, String recruitmentId, JsonNode body) throws SQLException {
        role(user,"sales");
        var recruitment=recruitment(c,recruitmentId);
        require(user.id.equals(str(recruitment,"sales_id")),403,"この面談者の選定依頼は操作できません。");
        require(body.isEmpty(),400,"削除には追加項目を指定できません。");
        require(str(recruitment,"status").equals("pending"),409,"面談者を選定した依頼は、面談者ごとの依頼を削除してください。");
        execute(c,"UPDATE recruitments SET cancelled_at=now() WHERE id=?",recruitmentId);
        return queueCancellation(c,str(recruitment,"project_id"),str(recruitment,"leader_id"),str(recruitment,"project_name"),"面談者の選定依頼");
    }
    private static Map<String,Object> queueCancellation(Connection c, String projectId, String recipientId, String project, String kind) throws SQLException {
        String safeName=project.replace('<','＜').replace('>','＞').replace('\r',' ').replace('\n',' ');
        String message="DealHunterで"+kind+"が削除されました。\n案件："+safeName+"\nこの依頼への対応は不要です。";
        execute(c,"INSERT INTO lark_cancellation_notifications(id,project_id,recipient_id,message) VALUES(?,?,?,?)",UUID.randomUUID(),projectId,recipientId,message);
        return Map.of("message",kind+"を削除しました。","notificationStatus",larkAvailability.canSendMessages()?"queued":"notConfigured");
    }
    private static void deliverCancellationNotification() {
        if(!larkAvailability.canSendMessages()) return;
        try {
            Map<String,Object> notification;
            // Claim with a retry lease in an autocommit statement before performing any network I/O.
            try (var c=connect()) {
                notification=one(c,"""
                    WITH next AS (
                        SELECT n.id,u.email FROM lark_cancellation_notifications n JOIN app_users u ON u.id=n.recipient_id
                        WHERE n.sent_at IS NULL AND n.next_attempt_at<=now()
                        AND (n.project_id IS NULL OR EXISTS (
                            SELECT 1 FROM projects p WHERE p.id=n.project_id FOR KEY SHARE SKIP LOCKED
                        ))
                        ORDER BY n.next_attempt_at,n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED
                    )
                    UPDATE lark_cancellation_notifications n
                    SET attempts=n.attempts+1,next_attempt_at=now()+make_interval(secs=>least(3600,60*(1<<least(n.attempts,6))))
                    FROM next WHERE n.id=next.id RETURNING n.id,n.message,COALESCE(next.email,'') AS email
                    """);
            }
            if(notification==null) return;
            larkAvailability.sendText(str(notification,"email"),str(notification,"message"),str(notification,"id"));
            try (var c=connect()) {
                execute(c,"UPDATE lark_cancellation_notifications SET sent_at=now() WHERE id=? AND sent_at IS NULL",notification.get("id"));
            }
        } catch(LarkAvailability.UnavailableException ex) {
            // Keep the recipient and delivery ID on the pending record for the scheduled retry.
        } catch(SQLException | RuntimeException ex) {
            System.err.println("Unable to process the Lark cancellation notification queue.");
        }
    }
    private static Object respondRequest(Connection c, User user, String requestId, JsonNode body) throws Exception {
        Map<String,Object> r = request(c,user,requestId,"student");
        checkResponseVersion(r,body.get("revision"));
        require(!str(r,"status").equals("confirmed"),409,"日時確定後は候補を変更できません。");
        String answer;
        String kind = body.has("responseKind") ? text(body,"responseKind") : "available";
        require(Set.of("available","alternative","unavailable").contains(kind),400,"回答の種類が正しくありません。");
        String note=boundedText(body,"responseNote",2000,false);
        boolean availability = str(r,"schedule_mode").equals("availability");
        int round=((Number)r.get("interview_round")).intValue();
        execute(c,"DELETE FROM candidate_slots WHERE request_id=? AND interview_round=? AND (proposed OR ?)",requestId,round,availability);
        execute(c,"UPDATE candidate_slots SET available=false WHERE request_id=? AND interview_round=?",requestId,round);
        if(kind.equals("unavailable")) {
            require(!body.has("slotIds") && !body.has("proposals") && !body.has("candidates"),400,"全候補不可の回答には日時を指定しないでください。");
            answer="全候補不可";
        } else if (availability || kind.equals("alternative")) {
            require(!body.has("slotIds") && !body.has("candidates"),400,"参加可能な開始日時を入力して回答してください。");
            List<Slot> proposed = slots(body.get("proposals"),true);
            Set<LocalDate> requestedDates = storedRequestedDates(r);
            LocalDateTime previous=previousInterviewTime(c,requestId,((Number)r.get("interview_round")).intValue());
            for (Slot slot : proposed) {
                require(kind.equals("alternative") || requestedDates.isEmpty() || requestedDates.contains(slot.start.toLocalDate()),400,"依頼で指定された日の開始日時を入力するか、別日時の提案を選択してください。");
                require(previous==null || slot.start.isAfter(previous),400,"前回面談より後の開始日時を入力してください。");
            }
            for (Slot slot : proposed) execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at,open_ended,proposed,available,interview_round) VALUES(?,?,?,?,?,true,true,?)",id("S-"),requestId,slot.start,slot.end,slot.openEnded,round);
            answer = String.join(" ／ ",proposed.stream().map(DealHunterServer::slotLabel).toList());
        } else {
            require(!body.has("proposals") && !body.has("candidates"),400,"依頼された候補日時から選んで回答してください。");
            JsonNode selected = body.get("slotIds");
            require(selected != null && selected.isArray() && !selected.isEmpty(),400,"参加可能な候補を1件以上選んでください。");
            Set<String> ids = new LinkedHashSet<>();
            for (JsonNode n : selected) {
                require(n.isTextual() && ids.add(n.asText()),400,"候補日時の選択が正しくありません。");
                require(one(c,"SELECT id FROM candidate_slots WHERE id=? AND request_id=? AND interview_round=?",n.asText(),requestId,r.get("interview_round")) != null,400,"今回の面談依頼の候補から選んでください。");
            }
            for (String slotId : ids) execute(c,"UPDATE candidate_slots SET available=true WHERE id=? AND request_id=? AND interview_round=?",slotId,requestId,r.get("interview_round"));
            answer = ids.size()+"件";
        }
        execute(c,"UPDATE interview_requests SET status='responded',response_kind=?,response_note=?,task_revision=task_revision+1 WHERE id=?",kind,note,requestId);
        var p=preview(c,str(r,"project_id"),str(r,"sales_id"),"lark","候補日時への回答",List.of(line("メンション","@"+str(r,"sales_name")),line("受講者",user.name),line("案件",str(r,"project_name")),line("参加可能な候補",answer),line("面談ページ","http://127.0.0.1:3100/sales?request="+requestId)),"受講者から回答が届きました。先方と調整し、面談日時を確定してください。外部送信は行っていません。");
        return Map.of("message",kind.equals("unavailable")?"全候補不可の回答を営業へ共有しました。":"参加可能な候補を保存しました。","preview",p);
    }
    private static Object reopenRequest(Connection c,User user,String requestId,JsonNode body) throws Exception {
        Map<String,Object> r=request(c,user,requestId,"sales");
        checkResponseVersion(r,body.get("revision"));
        require("responded".equals(r.get("status")),409,"未確定で回答済みの依頼だけ再調整できます。");
        boolean fixed=body.has("candidates");
        List<Slot> replacements=fixed?slots(body.get("candidates"),false):List.of();
        int round=((Number)r.get("interview_round")).intValue();
        LocalDateTime previous=previousInterviewTime(c,requestId,round);
        execute(c,"DELETE FROM candidate_slots WHERE request_id=? AND interview_round=?",requestId,round);
        for(Slot slot:replacements) {
            require(previous==null || slot.start.isAfter(previous),400,"次回面談は前回面談より後の日時を選択してください。");
            execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at,interview_round) VALUES(?,?,?,?,?)",id("S-"),requestId,slot.start,slot.end,round);
        }
        execute(c,"UPDATE interview_requests SET status='requested',response_kind='none',response_note='',schedule_mode=?,requested_dates='{}',task_revision=task_revision+1 WHERE id=?",fixed?"candidates":"availability",requestId);
        var p=preview(c,str(r,"project_id"),str(r,"student_id"),"lark","面談日程の再調整",List.of(line("案件",str(r,"project_name")),line("日程",scheduleLabel(fixed?"candidates":"availability",List.of(),replacements))),"新しい日程を回答してください。外部送信は行っていません。");
        return Map.of("message","面談者へ新しい日程の回答を依頼しました。","requestId",requestId,"preview",p);
    }
    private static LocalDateTime optionalDate(JsonNode body,String key,LocalDateTime fallback) {
        if(!body.has(key)) return fallback;
        String value=optionalText(body,key);
        return value.isEmpty()?null:date(value);
    }
    private static LocalDateTime timestamp(Map<String,Object> row,String key) {
        Timestamp value=(Timestamp)row.get(key);
        return value==null?null:value.toLocalDateTime();
    }
    private static String optionalUrl(String value) {
        require(value.length()<=2048,400,"URLは2048文字以内で入力してください。");
        return value.isEmpty()?"":httpUrl(value);
    }
    private static void validateWindow(LocalDateTime start,LocalDateTime end) {
        require(start!=null && (end==null || end.isAfter(start) && end.toLocalDate().equals(start.toLocalDate())),400,"終了時刻は同日の開始時刻より後にしてください。");
    }
    private record NoticeInfo(LocalDateTime prepStart,String prepUrl,String instructions,String emergencyContact,String meetingId,String passcode,String clientFeedback,boolean shareFeedback) {
        static NoticeInfo fromRow(Map<String,Object> row) {
            return new NoticeInfo(timestamp(row,"prep_start"),str(row,"prep_url"),str(row,"instructions"),str(row,"emergency_contact"),
                str(row,"meeting_id"),str(row,"passcode"),str(row,"client_feedback"),Boolean.TRUE.equals(row.get("share_feedback")));
        }
        private static String field(JsonNode body,String key,String fallback,int limit) {
            return body.has(key)?boundedText(body,key,limit,false):fallback;
        }
        NoticeInfo merge(JsonNode body,LocalDateTime start,boolean resuming) {
            LocalDateTime prep=optionalDate(body,"prepStart",resuming?null:prepStart);
            require(prep==null || prep.isBefore(start),400,"事前打合せは本面談より前の日時を選択してください。");
            String prepLink=prep==null?"":optionalUrl(field(body,"prepUrl",resuming?"":prepUrl,2048));
            return new NoticeInfo(prep,prepLink,field(body,"instructions",instructions,2000),field(body,"emergencyContact",emergencyContact,2000),
                field(body,"meetingId",resuming?"":meetingId,200),field(body,"passcode",resuming?"":passcode,200),field(body,"clientFeedback",clientFeedback,2000),
                booleanField(body,"shareFeedback",shareFeedback));
        }
        void save(Connection c,String eventId) throws SQLException {
            execute(c,"UPDATE scheduled_events SET prep_start=?,prep_url=?,instructions=?,emergency_contact=?,meeting_id=?,passcode=?,client_feedback=?,share_feedback=? WHERE id=?",
                prepStart,prepUrl,instructions,emergencyContact,meetingId,passcode,clientFeedback,shareFeedback,eventId);
        }
        boolean logisticsMatch(NoticeInfo other) {
            return Objects.equals(prepStart,other.prepStart) && prepUrl.equals(other.prepUrl)
                && emergencyContact.equals(other.emergencyContact) && meetingId.equals(other.meetingId) && passcode.equals(other.passcode);
        }
    }
    private static Map<String,Object> confirmRequest(Connection c, User user, String requestId, JsonNode body) throws Exception {
        Map<String,Object> r=request(c,user,requestId,"sales");
        checkResponseVersion(r,body.get("revision"));
        return confirmSlot(c,r,text(body,"slotId"),body);
    }
    private static Map<String,Object> confirmSlot(Connection c,Map<String,Object> r,String slotId,JsonNode body) throws Exception {
        String requestId=str(r,"id");
        require(!str(r,"status").equals("confirmed"),409,"この面談依頼はすでに日時確定しています。");
        require(str(r,"status").equals("responded"),409,"受講者の候補日時への回答を待ってください。");
        String url=optionalUrl(optionalText(body,"url"));
        Map<String,Object> slot=one(c,"SELECT * FROM candidate_slots WHERE id=? AND request_id=? AND interview_round=? AND available",slotId,requestId,r.get("interview_round"));
        require(slot!=null,400,"受講者が参加可能と回答した候補を選んでください。");
        LocalDateTime from=timestamp(slot,"start_at"),until=timestamp(slot,"end_at");
        LocalDateTime start=optionalDate(body,"start",from);
        LocalDateTime end=optionalDate(body,"end",body.has("start")?null:until);
        validateWindow(start,end);
        require(start.toLocalDate().equals(from.toLocalDate()) && !start.isBefore(from)
            && (until!=null?start.isBefore(until) && (end==null || !end.isAfter(until)):Boolean.TRUE.equals(slot.get("open_ended")) || start.equals(from)),
            400,"面談者が回答した時間帯から選択してください。");
        LocalDateTime previous=previousInterviewTime(c,requestId,((Number)r.get("interview_round")).intValue());
        require(previous==null || start.isAfter(previous),400,"次回面談は前回面談より後の日時を選択してください。");
        String eventId=id("E-");
        int round=((Number)r.get("interview_round")).intValue();
        String roundLabel=round==1?"一次面談":round==2?"二次面談":round+"次面談";
        execute(c,"INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,end_time,kind,route,format,request_id,meeting_url,interview_round) VALUES(?,?,?,?,?,?,'meet',?,'オンライン',?,?,?)",eventId,r.get("project_id"),r.get("student_id"),start.toLocalDate(),start.toLocalTime(),end==null?null:end.toLocalTime(),roundLabel,requestId,url,round);
        execute(c,"UPDATE interview_requests SET status='confirmed',confirmed_slot_id=? WHERE id=?",slotId,requestId);
        NoticeInfo info=NoticeInfo.fromRow(Map.of()).merge(body,start,false);
        require(previous==null || info.prepStart==null || info.prepStart.isAfter(previous),400,"事前打合せは前回面談より後の日時を選択してください。");
        info.save(c,eventId);
        storeChange(c,eventId,1,"scheduled",start,end,info.prepStart,"面談日時を確定");
        var p=preview(c,str(r,"project_id"),str(r,"student_id"),"calendar","面談予定の登録内容",List.of(line("案件",str(r,"project_name")),line("参加者",str(r,"person")),line("面談日時",slotLabel(new Slot(start,end))),line("面談URL",url.isEmpty()?"URL待ち":url),line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"面談日時を確定しました。Larkカレンダーへの実際の登録は行っていません。");
        return Map.of("message",url.isEmpty()?"日時を確定しました。面談URLは後から登録できます。":"面談日時とURLを保存しました。","eventId",eventId,"preview",p);
    }
    private static Object groupConfirm(Connection c,User user,JsonNode body) throws Exception {
        role(user,"sales");
        JsonNode ids=body.get("requestIds");
        require(ids!=null && ids.isArray() && ids.size()>=2 && ids.size()<=100,400,"面談依頼を2件以上、100件以内で選んでください。");
        SortedSet<String> ordered=new TreeSet<>();
        for(JsonNode id:ids) require(id.isTextual() && !id.asText().isBlank() && ordered.add(id.asText()),400,"面談依頼の選択が正しくありません。");
        JsonNode versions=body.get("revisions");
        require(versions==null || versions.isObject() && versions.size()==ordered.size(),400,"選択した各面談者の日程回答の版を指定してください。");
        LocalDateTime start=date(text(body,"start")),end=optionalDate(body,"end",null);
        validateWindow(start,end);
        String project=null;Object round=null;
        List<String> events=new ArrayList<>();
        List<Object> previews=new ArrayList<>();
        for(String id:ordered) {
            Map<String,Object> r=request(c,user,id,"sales");
            if(versions!=null) {
                require(versions.has(id),400,"選択した面談者の日程回答の版が不足しています。");
                checkResponseVersion(r,versions.get(id));
            }
            if(project==null) { project=str(r,"project_id"); round=r.get("interview_round"); }
            require(project.equals(r.get("project_id")) && round.equals(r.get("interview_round")),400,"同じ案件・面談回の依頼を選択してください。");
            require("responded".equals(r.get("status")),409,"全員の回答済み・未確定の依頼を選んでください。");
            Map<String,Object> slot=one(c,"""
                SELECT id FROM candidate_slots WHERE request_id=? AND interview_round=? AND available
                  AND start_at::date=? AND start_at<=? AND
                  ((end_at IS NULL AND (open_ended OR start_at=?))
                    OR (end_at>? AND end_at>=?))
                ORDER BY start_at DESC,id LIMIT 1
                """,id,round,start.toLocalDate(),start,start,start,end==null?start:end);
            require(slot!=null,400,"全員が回答した共通の時間帯を選択してください。");
            var result=confirmSlot(c,r,str(slot,"id"),body);
            events.add(result.get("eventId").toString());
            previews.add(result.get("preview"));
        }
        return Map.of("message",events.size()+"名の面談日時を確定しました。","eventIds",events,"eventId",events.getFirst(),"previews",previews,"preview",previews.getFirst());
    }
    private static void storeChange(Connection c,String id,long revision,String state,LocalDateTime start,LocalDateTime end,LocalDateTime prep,String reason) throws SQLException {
        execute(c,"INSERT INTO event_notice_history(event_id,revision,state,start_at,end_at,prep_start,reason) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id,revision) DO NOTHING",id,revision,state,start,end,prep,reason);
    }
    private static long noticeVersion(Map<String,Object> row,JsonNode body) {
        JsonNode supplied=body.get("revision");
        require(supplied!=null && supplied.isIntegralNumber() && supplied.canConvertToLong(),400,"確認・変更する案内の版を指定してください。");
        long current=((Number)row.get("notice_revision")).longValue();
        require(supplied.longValue()==current,409,"案内が更新されています。最新の内容を読み込んでください。");
        return current;
    }
    private static Object readNotice(Connection c,User user,String eventId,JsonNode body) throws SQLException {
        Map<String,Object> e=ownedEvent(c,user,eventId,"student");
        require("meet".equals(e.get("kind")),400,"面談の案内を選んでください。");
        long rev=noticeVersion(e,body);
        var saved=one(c,"UPDATE scheduled_events SET notice_read_at=COALESCE(notice_read_at,now()) WHERE id=? RETURNING to_jsonb(notice_read_at)#>>'{}' AS read_at",eventId);
        return Map.of("message","最新の面談案内を確認しました。","eventId",eventId,"revision",rev,"noticeReadAt",str(saved,"read_at"));
    }
    private static Object editNotice(Connection c,User user,String eventId,JsonNode body) throws Exception {
        Map<String,Object> e=ownedEvent(c,user,eventId,"sales");
        require("meet".equals(e.get("kind")),400,"面談の案内を選んでください。");
        long revision=noticeVersion(e,body);
        String was=str(e,"schedule_state");
        require(!was.equals("cancelled"),409,"中止した面談は変更できません。");
        String state=body.has("scheduleState")?text(body,"scheduleState"):was;
        require(Set.of("scheduled","postponed","cancelled").contains(state),400,"面談の予定状態が正しくありません。");
        LocalDate day=((java.sql.Date)e.get("event_date")).toLocalDate();
        LocalDateTime oldStart=day.atTime(((Time)e.get("start_time")).toLocalTime());
        LocalDateTime oldEnd=e.get("end_time")==null?null:day.atTime(((Time)e.get("end_time")).toLocalTime());
        LocalDateTime start=optionalDate(body,"start",oldStart);
        LocalDateTime defaultEnd=oldEnd==null || start==null?null:start.plus(java.time.Duration.between(oldStart,oldEnd));
        LocalDateTime end=optionalDate(body,"end",defaultEnd);
        boolean suspended=!state.equals("scheduled");
        boolean resuming=was.equals("postponed") && !suspended;
        boolean moved=state.equals("scheduled") && (!Objects.equals(start,oldStart) || !Objects.equals(end,oldEnd));
        boolean stateChanged=!was.equals(state);
        require(!resuming || body.hasNonNull("start"),400,"再確定する日時を入力してください。");
        if(suspended) { start=oldStart; end=oldEnd; }
        validateWindow(start,end);
        String reason=boundedText(body,"reason",2000,false);
        require(!(moved || stateChanged && suspended) || !reason.isEmpty(),400,"変更・延期・中止の理由を入力してください。");
        String oldUrl=str(e,"meeting_url");
        String url=body.has("url")?optionalUrl(optionalText(body,"url")):(resuming?"":oldUrl);
        NoticeInfo oldInfo=NoticeInfo.fromRow(e);
        NoticeInfo info=oldInfo.merge(body,start,resuming);
        boolean logistics=stateChanged || moved || !Objects.equals(end,oldEnd) || !url.equals(oldUrl) || !oldInfo.logisticsMatch(info);
        boolean instructionsChanged=!oldInfo.instructions.equals(info.instructions);
        boolean feedbackChanged=!oldInfo.clientFeedback.equals(info.clientFeedback) || info.shareFeedback!=oldInfo.shareFeedback;
        if(logistics) {
            require("scheduled".equals(e.get("status")) && "pending".equals(e.get("result")),409,"所感提出後・結果登録後の面談日程は変更できません。");
            if(e.get("request_id")!=null) {
                LocalDateTime previous=previousInterviewTime(c,str(e,"request_id"),((Number)e.get("interview_round")).intValue());
                require(previous==null || start.isAfter(previous),400,"前回面談より後の日時を選択してください。");
                require(previous==null || info.prepStart==null || info.prepStart.isAfter(previous),400,"事前打合せは前回面談より後の日時を選択してください。");
            }
        }
        if(!logistics && !instructionsChanged && !feedbackChanged) return Map.of("message","変更はありません。","eventId",eventId,"revision",revision);
        boolean publicChange=logistics || instructionsChanged || feedbackChanged && (info.shareFeedback || oldInfo.shareFeedback);
        if(publicChange && reason.isEmpty()) {
            if(stateChanged) reason="日程を再確定";
            else if(instructionsChanged && !logistics) reason="本人向けの案内・準備事項を更新";
            else reason=logistics?"参加案内を更新":"共有する先方評価を更新";
        }
        // Existing meetings predate the history table. Materialize their initial schedule once.
        if(revision==1) storeChange(c,eventId,revision,was,oldStart,oldEnd,oldInfo.prepStart,"変更前の日程");
        info.save(c,eventId);
        execute(c,"""
            UPDATE scheduled_events SET schedule_state=?,event_date=?,start_time=?,end_time=?,meeting_url=?,
              notice_revision=notice_revision+1,notice_read_at=CASE WHEN ? THEN NULL ELSE notice_read_at END,
              change_reason=CASE WHEN ? THEN ? ELSE change_reason END WHERE id=?
            """,state,start.toLocalDate(),start.toLocalTime(),end==null?null:end.toLocalTime(),url,publicChange,publicChange,reason,eventId);
        if(!publicChange) return Map.of("message","営業用の先方評価を保存しました。","eventId",eventId,"revision",revision+1);
        storeChange(c,eventId,revision+1,state,start,end,info.prepStart,reason);
        String stateLabel=state.equals("postponed")?"延期・再調整中":state.equals("cancelled")?"面談中止":slotLabel(new Slot(start,end));
        var p=preview(c,str(e,"project_id"),str(e,"student_id"),"lark","面談案内の更新",
            List.of(line("案件",str(e,"project_name")),line("面談",stateLabel),line("更新内容",reason),
                line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"案内が変わりました。最新の内容を確認してください。外部送信は行っていません。");
        return Map.of("message","面談案内を更新しました。","eventId",eventId,"revision",revision+1,"preview",p);
    }
    private static Object submitFeedback(Connection c, User user, String eventId, JsonNode body) throws Exception {
        Map<String,Object> e=event(c,user,eventId,"student");
        require(one(c,"SELECT id FROM interview_feedback WHERE event_id=?",eventId)==null,409,"この面談の所感は提出済みです。");
        String duties=text(body,"duties"),process=text(body,"process"),remote=text(body,"remote"),impression=text(body,"impression");
        JsonNode questions=body.get("questions");
        require(questions!=null && questions.isArray(),400,"質問は1問ずつ追加してください。");
        List<String> titles=new ArrayList<>();
        for(JsonNode q:questions) { require(q.isTextual() && !q.asText().trim().isEmpty(),400,"空の質問を入力しないでください。"); titles.add(q.asText().trim()); }
        String feedbackId=id("F-");
        execute(c,"INSERT INTO interview_feedback(id,event_id,student_id,duties,process,remote,impression) VALUES(?,?,?,?,?,?,?)",feedbackId,eventId,user.id,duties,process,remote,impression);
        int order=((Number)one(c,"SELECT COALESCE(max(display_order),0) AS n FROM interview_questions WHERE project_id=?",e.get("project_id")).get("n")).intValue();
        for(String title:titles) execute(c,"INSERT INTO interview_questions(id,project_id,title,tag,context,display_order,event_id,feedback_id) VALUES(?,?,?,'面談記録',?,?,?,?)",id("Q-"),e.get("project_id"),title,impression,++order,eventId,feedbackId);
        if(!str(e,"status").equals("entry-registered")) execute(c,"UPDATE scheduled_events SET status='feedback-submitted' WHERE id=?",eventId);
        var p=preview(c,str(e,"project_id"),str(e,"sales_id"),"lark","面談所感の提出",List.of(line("受講者",user.name),line("案件",str(e,"project_name")),line("聞かれた質問",titles.size()+"件"),line("面談ページ","http://127.0.0.1:3100/sales?event="+eventId)),"面談所感と質問を保存しました。外部送信は行っていません。");
        return Map.of("message","面談所感と質問を保存しました。","preview",p);
    }
    private record VisibleEntry(String when, String project) {}
    private record EntryWarning(List<VisibleEntry> visibleEntries, boolean hasHiddenEntries, String token) {}
    private static final class EntryDayConflict extends RuntimeException {
        final EntryWarning warning;
        EntryDayConflict(EntryWarning warning) { this.warning = warning; }
    }

    private static Map<String,Object> entryInterview(Connection c, User user, String eventId) throws SQLException {
        Map<String,Object> meeting = event(c, user, eventId, "sales");
        currentInterview(c, meeting);
        require(!"entry-registered".equals(meeting.get("status")) && List.of("pending","offered","passed").contains(str(meeting,"result")),
            409, "この面談の結果・初回入場は登録済みです。");
        return meeting;
    }

    private static LocalDateTime entryTime(Map<String,Object> meeting, JsonNode body) {
        LocalDateTime when = date(text(body,"when"));
        LocalDateTime interviewStart = ((java.sql.Date)meeting.get("event_date")).toLocalDate()
            .atTime(((Time)meeting.get("start_time")).toLocalTime());
        require(when.isAfter(interviewStart),400,"初回入場は面談より後の日時にしてください。");
        return when;
    }

    private static EntryWarning entryWarning(Connection c, User user, Map<String,Object> meeting, LocalDateTime when) throws Exception {
        // event_date and start_time store Japanese wall time. participant_name is free text;
        // the attendee on an entry is the student_id copied from the authenticated meeting.
        String sql = """
            SELECT e.id, e.start_time, p.name AS project
            FROM scheduled_events e JOIN projects p ON p.id=e.project_id
            WHERE e.kind='entry' AND e.schedule_state='scheduled'
              AND e.student_id=? AND e.event_date=? AND e.project_id<>?
            ORDER BY e.start_time, e.id
            """;
        List<VisibleEntry> visible = new ArrayList<>();
        List<List<Object>> snapshot = new ArrayList<>();
        try (PreparedStatement s = prepared(c, sql, meeting.get("student_id"), when.toLocalDate(), meeting.get("project_id"));
             ResultSet rows = s.executeQuery()) {
            while (rows.next()) {
                String project = rows.getString("project");
                String start = when.toLocalDate().atTime(rows.getObject("start_time",java.time.LocalTime.class)).toString();
                visible.add(new VisibleEntry(start, project));
                snapshot.add(List.of(rows.getString("id"), start, project));
            }
        }
        if (snapshot.isEmpty()) return null;
        // An intervening change must trigger a fresh confirmation before saving.
        byte[] context = JSON.writeValueAsBytes(List.of("entry-day-v1", user.id, meeting.get("id"), meeting.get("student_id"), when.toString(), snapshot));
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(API_KEY.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(context));
        return new EntryWarning(visible, false, token);
    }

    private static Object checkEntry(Connection c, User user, String eventId, JsonNode body) throws Exception {
        Map<String,Object> meeting = entryInterview(c, user, eventId);
        return Collections.singletonMap("entryWarning", entryWarning(c, user, meeting, entryTime(meeting, body)));
    }

    private static Object registerEntry(Connection c, User user, String eventId, JsonNode body) throws Exception {
        Map<String,Object> e=entryInterview(c,user,eventId);
        String result=text(body,"result");
        require(result.equals("passed") || result.equals("rejected"),400,"面談結果を選んでください。");
        if(result.equals("rejected")) {
            execute(c,"UPDATE scheduled_events SET result='rejected',engineer_confirmed_at=NULL WHERE id=?",eventId);
            var p=preview(c,str(e,"project_id"),str(e,"student_id"),"lark","面談結果のお知らせ",List.of(line("案件",str(e,"project_name")),line("受講者",str(e,"person")),line("結果","不合格"),line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"面談結果を保存しました。外部送信は行っていません。");
            return Map.of("message","面談結果を保存しました。","preview",p);
        }
        LocalDateTime when=entryTime(e,body);
        String where=text(body,"where"),memo=optionalText(body,"memo"),entryId=id("E-");
        // Different projects can be saved concurrently. Take the student/day lock before
        // the conflict SELECT so READ COMMITTED sees any entry saved by the preceding writer.
        execute(c, "SELECT pg_advisory_xact_lock(709033,hashtext(?))", str(e,"student_id") + ":" + when.toLocalDate());
        EntryWarning warning = entryWarning(c, user, e, when);
        if (warning != null && !warning.token().equals(body.path("entryWarningToken").textValue())) throw new EntryDayConflict(warning);
        execute(c,"INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,request_id,meeting_place,guidance,parent_event_id,result,interview_round) VALUES(?,?,?,?,?,'entry','初回入場',?,?,?,?,?,'passed',?)",entryId,e.get("project_id"),e.get("student_id"),when.toLocalDate(),when.toLocalTime(),where,e.get("request_id"),where,memo,eventId,e.get("interview_round"));
        execute(c,"UPDATE scheduled_events SET result='passed',status='entry-registered',engineer_confirmed_at=NULL WHERE id=?",eventId);
        var p=preview(c,str(e,"project_id"),str(e,"student_id"),"calendar","初回入場予定の登録内容",List.of(line("案件",str(e,"project_name")),line("面談者",str(e,"person")),line("参画者",str(e,"participant_name").isBlank()?"未登録":str(e,"participant_name")),line("集合日時",when.toString().replace('T',' ')),line("集合場所",where),line("当日の案内",memo.isBlank()?"記載なし":memo),line("面談ページ","http://127.0.0.1:3100/engineer?event="+entryId)),"合格と初回入場予定を保存しました。Larkカレンダーへの実際の登録は行っていません。");
        return Map.of("message","合格と初回入場予定を保存しました。","eventId",entryId,"preview",p);
    }

    private static Map<String,Object> currentInterview(Connection c, Map<String,Object> e) throws SQLException {
        if(e.get("request_id")==null) return null;
        Map<String,Object> r=one(c,"SELECT * FROM interview_requests WHERE id=? FOR UPDATE",e.get("request_id"));
        require(r!=null && Objects.equals(r.get("project_id"),e.get("project_id")) && Objects.equals(r.get("student_id"),e.get("student_id")),409,"面談情報の関連付けを確認してください。");
        require(Objects.equals(r.get("interview_round"),e.get("interview_round")) && str(r,"status").equals("confirmed"),409,"最新の面談を選択してください。");
        return r;
    }

    private static LocalDateTime previousInterviewTime(Connection c, String requestId, int round) throws SQLException {
        if(round<=1) return null;
        Map<String,Object> previous=one(c,"SELECT event_date,start_time FROM scheduled_events WHERE request_id=? AND kind='meet' AND interview_round<? ORDER BY interview_round DESC LIMIT 1",requestId,round);
        return previous==null?null:((java.sql.Date)previous.get("event_date")).toLocalDate().atTime(((Time)previous.get("start_time")).toLocalTime());
    }

    private static Object recordResult(Connection c, User user, String eventId, JsonNode body) throws Exception {
        Map<String,Object> e=event(c,user,eventId,"sales");
        currentInterview(c,e);
        require(body.size()==1 && body.has("result"),400,"登録する面談結果を指定してください。");
        String result=text(body,"result");
        require(List.of("offered","rejected","declined").contains(result),400,"オファー・見送り・辞退を選択してください。");
        require(!str(e,"status").equals("entry-registered") && List.of("pending","offered").contains(str(e,"result")) && !str(e,"result").equals(result),409,"この面談の結果は登録済みです。");
        execute(c,"UPDATE scheduled_events SET result=?,engineer_confirmed_at=NULL WHERE id=?",result,eventId);
        String label=result.equals("offered")?"オファー":result.equals("rejected")?"見送り":"辞退";
        var p=preview(c,str(e,"project_id"),str(e,"student_id"),"lark","面談結果のお知らせ",List.of(line("案件",str(e,"project_name")),line("面談者",str(e,"person")),line("結果",label),line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"面談結果を保存しました。外部送信は行っていません。");
        return Map.of("message",label+"を記録しました。","eventId",eventId,"preview",p);
    }

    private static Object nextRound(Connection c, User user, String eventId, JsonNode body) throws Exception {
        Map<String,Object> e=event(c,user,eventId,"sales");
        Map<String,Object> r=currentInterview(c,e);
        require(str(e,"result").equals("pending") && !str(e,"status").equals("entry-registered"),409,"次の面談に進められるのは結果未登録の最新面談だけです。");
        int round=((Number)e.get("interview_round")).intValue()+1;
        require(round<=5,400,"面談は5回まで登録できます。");
        int planned=totalRounds(body,r==null?round:((Number)r.get("total_rounds")).intValue(),round);
        String mode=body.has("scheduleMode")?text(body,"scheduleMode"):"candidates";
        require(mode.equals("candidates") || mode.equals("availability"),400,"日程の確認方法が正しくありません。");
        List<LocalDate> dates=requestedDates(body.get("requestedDates"));
        boolean availability=mode.equals("availability");
        require(availability || dates.isEmpty(),400,"候補日時を指定する場合は指定日を空にしてください。");
        JsonNode candidates=body.get("candidates");
        require(!availability || candidates==null || (candidates.isArray() && candidates.isEmpty()),400,"空き日時の確認には固定の候補を指定できません。");
        List<Slot> candidatesList=availability?List.of():slots(candidates,false);
        LocalDateTime previous=((java.sql.Date)e.get("event_date")).toLocalDate().atTime(((Time)e.get("start_time")).toLocalTime());
        for(LocalDate day:dates) require(!day.isBefore(previous.toLocalDate()),400,"次回面談の指定日は前回面談以降の日付を選択してください。");
        for(Slot slot:candidatesList) require(slot.start.isAfter(previous),400,"次回面談は前回面談より後の日時を入力してください。");
        String requestId=r==null?id("R-"):str(r,"id");
        if(r==null) execute(c,"INSERT INTO interview_requests(id,project_id,student_id,status,schedule_mode,requested_dates,interview_round,total_rounds) VALUES(?,?,?,'requested',?,?::date[],?,?)",requestId,e.get("project_id"),e.get("student_id"),mode,datesArray(dates),round,planned);
        else execute(c,"UPDATE interview_requests SET status='requested',confirmed_slot_id=NULL,response_kind='none',response_note='',schedule_mode=?,requested_dates=?::date[],interview_round=?,total_rounds=?,task_revision=task_revision+1 WHERE id=?",mode,datesArray(dates),round,planned,requestId);
        for(Slot slot:candidatesList) execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at,interview_round) VALUES(?,?,?,?,?)",id("S-"),requestId,slot.start,slot.end,round);
        execute(c,"UPDATE scheduled_events SET result='advanced',request_id=?,engineer_confirmed_at=NULL WHERE id=?",requestId,eventId);
        var p=preview(c,str(e,"project_id"),str(e,"student_id"),"lark","次回面談の依頼",List.of(line("案件",str(e,"project_name")),line("面談者",str(e,"person")),line("面談回数",round+"/"+planned),line(availability?"日程の確認":"候補日時",scheduleLabel(mode,dates,candidatesList)),line("面談ページ","http://127.0.0.1:3100/engineer?request="+requestId)),"前回の面談を通過しました。次回の参加可能な日時を回答してください。外部送信は行っていません。");
        return Map.of("message","面談通過と次回の依頼を保存しました。","projectId",str(e,"project_id"),"requestId",requestId,"round",round,"totalRounds",planned,"preview",p);
    }

    private static Object acknowledgeEvent(Connection c, User user, String eventId) throws SQLException {
        Map<String,Object> e=ownedEvent(c,user,eventId,"student");
        require(str(e,"kind").equals("entry") || (str(e,"kind").equals("meet")
            && List.of("passed","rejected","advanced","offered","declined").contains(str(e,"result"))),
            409,"面談結果が確定してから確認してください。");
        Map<String,Object> saved=one(c,"""
            UPDATE scheduled_events SET engineer_confirmed_at=COALESCE(engineer_confirmed_at,now())
            WHERE id=? RETURNING to_jsonb(engineer_confirmed_at)#>>'{}' AS engineer_confirmed_at
            """,eventId);
        return Map.of("message",str(e,"kind").equals("entry")?"初回入場の完了を確認しました。":"面談結果を確認しました。",
            "eventId",eventId,"engineerConfirmedAt",str(saved,"engineer_confirmed_at"));
    }

    private static Object acknowledgeTask(Connection c, User user, String taskKey, JsonNode body) throws Exception {
        role(user,"sales");
        JsonNode revisionNode=body.get("revision");
        require(revisionNode!=null && revisionNode.isIntegralNumber() && revisionNode.canConvertToLong() && revisionNode.asLong()>0,
            400,"確認する対応内容の版が正しくありません。");
        long expectedRevision=revisionNode.asLong();
        boolean requestTask=taskKey.startsWith("request-"), assignmentTask=taskKey.startsWith("assignment-");
        String prefix=assignmentTask?"assignment-":requestTask?"request-":taskKey.startsWith("entry-")?"entry-":taskKey.startsWith("feedback-")?"feedback-":taskKey.startsWith("result-")?"result-":taskKey.startsWith("notice-")?"notice-":null;
        require(prefix!=null,404,"対応待ちが見つかりません。");
        String sourceId=taskKey.substring(prefix.length());
        Map<String,Object> source=one(c,assignmentTask
            ?"SELECT a.id,p.sales_id FROM recruitments a JOIN projects p ON p.id=a.project_id WHERE a.id=? FOR UPDATE OF a"
            :requestTask
            ?"SELECT r.id,p.sales_id FROM interview_requests r JOIN projects p ON p.id=r.project_id WHERE r.id=? FOR UPDATE OF r"
            :"SELECT e.id,p.sales_id FROM scheduled_events e JOIN projects p ON p.id=e.project_id WHERE e.id=? FOR UPDATE OF e",sourceId);
        require(source!=null,404,"対応待ちが見つかりません。");
        require(user.id.equals(str(source,"sales_id")),403,"この対応待ちは操作できません。");
        Map<String,Object> task=one(c,"SELECT project_id,revision FROM active_tasks WHERE key=?",taskKey);
        require(task!=null,409,"この対応待ちは完了または変更されています。一覧を更新してください。");
        long currentRevision=((Number)task.get("revision")).longValue();
        require(currentRevision==expectedRevision,409,"新しい回答が届いています。一覧を更新して確認してください。");
        Map<String,Object> saved=one(c,"""
            INSERT INTO task_acknowledgements(user_id,project_id,task_key,revision)
            VALUES(?,?,?,?)
            ON CONFLICT(user_id,task_key) DO UPDATE SET
              project_id=EXCLUDED.project_id,
              revision=EXCLUDED.revision,
              acknowledged_at=CASE WHEN task_acknowledgements.revision=EXCLUDED.revision
                THEN task_acknowledgements.acknowledged_at ELSE now() END
            RETURNING to_jsonb(acknowledged_at)#>>'{}' AS acknowledged_at
            """,user.id,task.get("project_id"),taskKey,currentRevision);
        return Map.of("message","対応内容を確認済みにしました。","taskKey",taskKey,"revision",currentRevision,
            "acknowledgedAt",str(saved,"acknowledged_at"));
    }

    private static Slot availabilityInterval(JsonNode body,LocalDateTime now,LocalDate throughDate) {
        String date=text(body,"date"), start=text(body,"start"), end=text(body,"end");
        require(date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}") && start.matches("[0-9]{2}:[0-9]{2}") && end.matches("[0-9]{2}:[0-9]{2}"),
            400,"日付と開始・終了時刻を指定してください。");
        try {
            Slot slot=new Slot(LocalDateTime.parse(date+"T"+start),LocalDateTime.parse(date+"T"+end));
            require(!slot.start.isBefore(now) && !slot.start.toLocalDate().isAfter(throughDate),400,"日本時間で今日から14日間の、これから始まる枠を指定してください。");
            require(slot.end.isAfter(slot.start),400,"終了時刻は同日の開始時刻より後にしてください。");
            return slot;
        } catch(DateTimeParseException e) {
            throw new ApiError(400,"日付または時刻が正しくありません。");
        }
    }

    private static void changeAvailability(Connection c,String studentId,JsonNode body,LocalDateTime now,LocalDate throughDate) throws SQLException {
        String action=text(body,"action");
        boolean add=action.equals("add"), remove=action.equals("remove");
        require(add || remove || action.equals("update"),400,"面談可能枠の操作が正しくありません。");
        require(body.size()==(add?4:remove?2:5),400,"面談可能枠の入力項目が正しくありません。");
        String slotId=add?id("availability-"):text(body,"id");
        if(!add) {
            require(one(c,"SELECT id FROM interviewer_availability_slots WHERE student_id=? AND id=? AND start_at>=?",studentId,slotId,now)!=null,
                404,"対象の面談可能枠が見つかりません。");
        }
        if(remove) {
            execute(c,"DELETE FROM interviewer_availability_slots WHERE student_id=? AND id=?",studentId,slotId);
            return;
        }
        Slot slot=availabilityInterval(body,now,throughDate);
        require(one(c,"SELECT id FROM interviewer_availability_slots WHERE student_id=? AND id<>? AND start_at<? AND end_at>? LIMIT 1",
            studentId,slotId,slot.end,slot.start)==null,409,"登録済みの面談可能枠と時間帯が重なっています。");
        if(add) execute(c,"INSERT INTO interviewer_availability_slots(id,student_id,start_at,end_at) VALUES(?,?,?,?)",slotId,studentId,slot.start,slot.end);
        else execute(c,"UPDATE interviewer_availability_slots SET start_at=?,end_at=? WHERE student_id=? AND id=?",slot.start,slot.end,studentId,slotId);
    }

    private static void authorizeInterviewerSearch(Connection c, HttpExchange exchange) throws SQLException {
        c.setAutoCommit(false);
        execute(c, "SELECT pg_advisory_xact_lock_shared(709032)");
        role(authenticate(c, exchange), "sales");
    }

    private static Object findAvailableInterviewers(HttpExchange exchange) throws SQLException, IOException {
        ZoneId japan = ZoneId.of("Asia/Tokyo");
        Slot window;
        Map<String,String> emails = new LinkedHashMap<>();
        try (Connection c = connect()) {
            authorizeInterviewerSearch(c, exchange);
            require(exchange.getRequestMethod().equals("POST"), 405, "POSTで検索してください。");
            LocalDateTime now = LocalDateTime.now(japan);
            window = availabilityInterval(readBody(exchange, 4096), now, now.toLocalDate().plusDays(13));
            try (PreparedStatement query = prepared(c, "SELECT id,COALESCE(email,'') FROM app_users WHERE role='student' ORDER BY id");
                 ResultSet rows = query.executeQuery()) {
                while (rows.next()) emails.put(rows.getString(1), rows.getString(2));
            }
            c.commit();
        }

        // The external request must not hold a DB connection or block account changes.
        Map<String,LarkAvailability.Status> availability;
        try {
            availability = larkAvailability.check(emails, window.start.atZone(japan).toInstant(), window.end.atZone(japan).toInstant());
        } catch (LarkAvailability.UnavailableException e) {
            throw new ApiError(503, e.getMessage());
        }

        // Recheck both the viewer and the roster after waiting for Lark. Read local
        // bookings at this point so meetings added during the lookup are excluded.
        String sql = """
            WITH wanted AS (SELECT ?::timestamp AS s, ?::timestamp AS e),
            meetings AS (
                SELECT m.student_id,
                    bool_or(m.end_time IS NOT NULL OR m.start_time >= w.s::time) AS overlaps
                FROM scheduled_events m CROSS JOIN wanted w
                WHERE m.kind='meet' AND m.schedule_state='scheduled' AND m.event_date=w.s::date
                  AND m.start_time<w.e::time AND (m.end_time IS NULL OR m.end_time>w.s::time)
                GROUP BY m.student_id
            )
            SELECT u.id, COALESCE(u.email,'') AS email, CASE
                WHEN m.overlaps THEN 'booked'
                WHEN m.student_id IS NOT NULL THEN 'unknownEnd' END AS conflict
            FROM app_users u LEFT JOIN meetings m ON m.student_id=u.id
            WHERE u.role='student' ORDER BY u.id
            """;
        List<String> matches = new ArrayList<>();
        Map<String,Integer> counts = new HashMap<>(Map.of("busy",0,"unavailable",0,"booked",0,"unknownEnd",0));
        try (Connection c = connect()) {
            authorizeInterviewerSearch(c, exchange);
            try (PreparedStatement query = prepared(c, sql, window.start, window.end); ResultSet rows = query.executeQuery()) {
                while (rows.next()) {
                    String id = rows.getString("id");
                    LarkAvailability.Status status = Objects.equals(emails.get(id), rows.getString("email"))
                        ? availability.getOrDefault(id, LarkAvailability.Status.UNKNOWN) : LarkAvailability.Status.UNKNOWN;
                    String conflict = rows.getString("conflict");
                    if (status == LarkAvailability.Status.BUSY) counts.merge("busy", 1, Integer::sum);
                    else if (status != LarkAvailability.Status.FREE) counts.merge("unavailable", 1, Integer::sum);
                    else if (conflict != null) counts.merge(conflict, 1, Integer::sum);
                    else matches.add(id);
                }
            }
            c.commit();
        }
        return Map.of("matches",matches,"counts",counts);
    }

    private static Object interviewerAvailability(Connection c,User user,String studentId,JsonNode update) throws SQLException {
        boolean self=user.role.equals("student") && user.id.equals(studentId);
        require(self || (update==null && user.role.equals("sales")),403,"この面談可能枠を操作する権限がありません。");
        // The direct-assignment picker accepts any current student. Lock that individual
        // on writes so two overlapping first slots cannot both pass the interval check.
        String lookup="SELECT id FROM app_users WHERE id=? AND role='student'";
        require(one(c,update==null?lookup:lookup+" FOR UPDATE",studentId)!=null,404,"対象の面談担当者が見つかりません。");
        LocalDateTime now=LocalDateTime.now(ZoneId.of("Asia/Tokyo"));
        LocalDate fromDate=now.toLocalDate(), throughDate=fromDate.plusDays(13);
        if(update!=null) changeAvailability(c,studentId,update,now,throughDate);
        List<Map<String,String>> slots=new ArrayList<>();
        try(PreparedStatement s=prepared(c,"""
            SELECT id,to_char(start_at,'YYYY-MM-DD'),to_char(start_at,'HH24:MI'),to_char(end_at,'HH24:MI')
            FROM interviewer_availability_slots WHERE student_id=? AND start_at>=? AND start_at<?
            ORDER BY start_at,id
            """,studentId,now,throughDate.plusDays(1).atStartOfDay()); ResultSet r=s.executeQuery()) {
            while(r.next()) slots.add(Map.of("id",r.getString(1),"date",r.getString(2),"start",r.getString(3),"end",r.getString(4)));
        }
        return Map.of("studentId",studentId,"fromDate",fromDate.toString(),"throughDate",throughDate.toString(),"slots",slots);
    }

    private static void handle(HttpExchange exchange) throws IOException {
        String path=exchange.getRequestURI().getPath(),method=exchange.getRequestMethod();
        try {
            if(path.equals("/api/health") && method.equals("GET")) {
                try(Connection c=connect()) { one(c,"SELECT 1"); }
                respond(exchange,200,Map.of("service","dealhunter","status","ok","database","postgresql","version",API_VERSION,"referenceDate",LocalDate.now(ZoneId.of("Asia/Tokyo")).toString(),"timezone","Asia/Tokyo")); return;
            }
            String key=exchange.getRequestHeaders().getFirst("X-DealHunter-Key");
            require(key!=null && MessageDigest.isEqual(API_KEY.getBytes(StandardCharsets.UTF_8),key.getBytes(StandardCharsets.UTF_8)),401,"ログインしてください。");
            if (path.equals("/api/available-interviewers")) {
                respond(exchange, 200, findAvailableInterviewers(exchange));
                return;
            }
            try(Connection c=connect()) {
                // Checks following a writer lock must see the preceding writer's commit.
                if (path.startsWith("/api/request-drafts") || path.equals("/api/requests") || (method.equals("POST") && (path.matches("/api/events/[^/]+/entry") ||
                        path.matches("/api/interviewer-availability/[A-Za-z0-9_-]+") ||
                        path.matches("/api/interviewer-company-restrictions/[A-Za-z0-9_-]+")))) {
                    c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
                }
                c.setAutoCommit(false);
                try {
                    if(path.equals("/api/auth/demo-accounts")) {
                        require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                        Object response=demoLoginAccounts(c);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/auth/register") || path.equals("/api/auth/login")) {
                        require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                        JsonNode body=readBody(exchange,16*1024);
                        Object response=path.endsWith("/register")?registerUser(c,body):loginUser(c,body);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.matches("/api/auth/users/[A-Za-z0-9_-]+")) {
                        require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                        Object response=currentUser(c,path.split("/")[4]);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    boolean adminUpdate=path.matches("/api/admin/users/[A-Za-z0-9_-]+") && method.equals("POST");
                    // Hold a shared lock for each user-scoped transaction. An
                    // account edit waits for active operations and then blocks
                    // stale-role operations until the change commits.
                    execute(c,adminUpdate?"SELECT pg_advisory_xact_lock(709032)":"SELECT pg_advisory_xact_lock_shared(709032)");
                    User user=authenticate(c,exchange);
                    if(path.equals("/api/request-drafts") || path.matches("/api/request-drafts/[A-Za-z0-9_-]{1,100}")) {
                        role(user,"sales");
                        String draftId=path.equals("/api/request-drafts")?null:path.split("/")[3];
                        require(draftId==null ? Set.of("POST","GET").contains(method) : Set.of("PUT","DELETE","GET").contains(method),405,"この操作は利用できません。");
                        JsonNode body=method.equals("GET")?null:readBody(exchange,method.equals("DELETE")?1024:8*1024*1024);
                        Object response=requestDrafts(c,user,draftId,method,body);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/similar-projects")) {
                        role(user,"sales");
                        require(method.equals("POST"),405,"POST を使用してください。");
                        JsonNode body=readBody(exchange,128*1024);
                        Object matches=SimilarProjects.find(c,user.id,boundedText(body,"project",200,true),
                                boundedText(body,"summary",20000,true),companyName(body,"upperCompany","上位会社",false),
                                companyName(body,"endCompany","エンド企業",false));
                        c.commit(); respond(exchange,200,Map.of("matches",matches)); return;
                    }
                    if(path.equals("/api/question-groups")) {
                        role(user,"sales");
                        require(method.equals("GET"),405,"GET を使用してください。");
                        Object response=Map.of("groups",SimilarProjects.questionGroups(c));
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.matches("/api/interviewer-availability/[A-Za-z0-9_-]+")) {
                        require(method.equals("GET") || method.equals("POST"),405,"GET または POST を使用してください。");
                        Object response=interviewerAvailability(c,user,path.split("/")[3],method.equals("POST")?readBody(exchange,4096):null);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/end-companies")) {
                        require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                        require(user.role.equals("sales") || user.role.equals("admin"),403,"エンド企業の候補を参照する権限がありません。");
                        Object response=Map.of("endCompanies",sharedCompanyCandidates(c).get("end"));
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/interviewer-company-candidates")) {
                        role(user,"sales");
                        require(method.equals("GET"),405,"GET を使用してください。");
                        Object response=sharedCompanyCandidates(c);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/engineer-status")) {
                        require(method.equals("GET"),405,"GET を使用してください。");
                        Object response=engineerStatus(c,user);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.matches("/api/engineer-interview-history/[A-Za-z0-9_-]+")) {
                        require(method.equals("GET"),405,"GET を使用してください。");
                        Object response=engineerInterviewHistory(c,user,path.split("/")[3]);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/interviewer-company-lookup")) {
                        role(user,"sales");
                        require(method.equals("GET"),405,"GET を使用してください。");
                        Object response=interviewerCompanyLookup(c);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.matches("/api/interviewer-company-restrictions/[A-Za-z0-9_-]+")) {
                        role(user,"sales");
                        require(method.equals("GET") || method.equals("POST"),405,"GET または POST を使用してください。");
                        Object response=interviewerCompanyRestrictions(c,user,path.split("/")[3],method.equals("POST")?readBody(exchange,128*1024):null);
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/admin/users") || path.matches("/api/admin/users/[A-Za-z0-9_-]+")) {
                        role(user,"admin");
                        Object response;
                        if(path.equals("/api/admin/users")) {
                            require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                            response=listUsers(c,user);
                        } else {
                            require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                            response=updateUser(c,user,path.split("/")[4],readBody(exchange,16*1024));
                        }
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.equals("/api/admin/projects") || path.matches("/api/admin/projects/[A-Za-z0-9_-]+")) {
                        role(user,"admin");
                        Object response;
                        if(path.equals("/api/admin/projects")) {
                            require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                            response=listProjects(c,user);
                        } else {
                            require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                            response=updateProject(c,user,path.split("/")[4],readBody(exchange,128*1024));
                        }
                        c.commit(); respond(exchange,200,response); return;
                    }
                    if(path.matches("/api/projects/[A-Za-z0-9_-]+/delete")) {
                        require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                        Object response=deleteProject(c,user,path.split("/")[3],readBody(exchange,1024));
                        c.commit(); respond(exchange,200,response); return;
                    }
                    boolean assignmentRoute=path.matches("/api/recruitments/[^/]+/assign");
                    boolean recruitmentCancellationRoute=path.matches("/api/recruitments/[^/]+/cancel");
                    require(!user.role.equals("leader") || !method.equals("POST") || assignmentRoute,403,"リーダーが更新できるのは担当案件の面談者選定だけです。");
                    if(path.equals("/api/dashboard")) {
                        require(!user.role.equals("admin"),403,"業務画面は営業・エンジニア・リーダーが利用できます。");
                        require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                        Map<String,Object> row=one(c,dashboardSql,user.id);
                        respond(exchange,200,JSON.readTree(row.values().iterator().next().toString())); return;
                    }
                    if(path.matches("/api/requests/[^/]+/attachment") && method.equals("GET")) {
                        downloadAttachment(c,user,path.split("/")[3],exchange); c.commit(); return;
                    }
                    require(path.equals("/api/requests") || path.equals("/api/requests/group-confirm") || path.matches("/api/requests/[^/]+/(respond|confirm|reopen|cancel)")
                        || path.matches("/api/requests/[^/]+/attachment") || assignmentRoute || recruitmentCancellationRoute || path.matches("/api/events/[^/]+/(feedback|entry|entry-check|acknowledge|result|next-round|notice|notice-read)") || path.matches("/api/tasks/[^/]+/acknowledge"),404,"エンドポイントが見つかりません。");
                    require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                    JsonNode body=readBody(exchange,8*1024*1024);
                    Object response;
                    String[] parts=path.split("/");
                    if(path.equals("/api/requests")) response=createRequest(c,user,body);
                    else if(path.equals("/api/requests/group-confirm")) response=groupConfirm(c,user,body);
                    else if(recruitmentCancellationRoute) response=cancelRecruitment(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("recruitments") && parts[4].equals("assign")) response=assignRecruitment(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("cancel")) response=cancelInterviewRequest(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("respond")) response=respondRequest(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("confirm")) response=confirmRequest(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("reopen")) response=reopenRequest(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("attachment")) response=saveAttachment(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("feedback")) response=submitFeedback(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("notice")) response=editNotice(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("notice-read")) response=readNotice(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("entry")) response=registerEntry(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("entry-check")) response=checkEntry(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("result")) response=recordResult(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("next-round")) response=nextRound(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("acknowledge")) response=acknowledgeEvent(c,user,parts[3]);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("tasks") && parts[4].equals("acknowledge")) response=acknowledgeTask(c,user,parts[3],body);
                    else throw new ApiError(404,"エンドポイントが見つかりません。");
                    c.commit();
                    respond(exchange,200,response);
                } catch(Exception exception) { c.rollback(); throw exception; }
            }
        } catch(DraftConflict conflict) {
            respond(exchange,409,Map.of("error",conflict.getMessage(),"code","DRAFT_CONFLICT"));
        } catch(EntryDayConflict conflict) {
            respond(exchange,409,Map.of("error","同じ入場者の初回入場が同じ日に登録されています。内容を確認してください。",
                "code","ENTRY_DAY_CONFLICT","entryWarning",conflict.warning));
        } catch(ApiError exception) {
            if(exception.status==429) exchange.getResponseHeaders().set("Retry-After","300");
            respond(exchange,exception.status,Map.of("error",exception.getMessage()));
        }
        catch(SQLException exception) {
            System.err.println("Database request failed (SQL state " + exception.getSQLState() + ")");
            int status="23505".equals(exception.getSQLState())?409:503;
            respond(exchange,status,Map.of("error",status==409?"すでに登録されています。":"データベースに接続できません。"));
        } catch(Exception exception) {
            System.err.println("Request failed: "+exception.getClass().getSimpleName());
            respond(exchange,500,Map.of("error","処理に失敗しました。入力内容を確認してください。"));
        }
    }
    private static JsonNode readBody(HttpExchange exchange, int limit) throws IOException {
        require(Objects.toString(exchange.getRequestHeaders().getFirst("Content-Type"),"").toLowerCase(Locale.ROOT).startsWith("application/json"),400,"JSON形式で送信してください。");
        byte[] bytes=exchange.getRequestBody().readNBytes(limit+1);
        require(bytes.length<=limit,413,"送信データが大きすぎます。");
        JsonNode body;
        try { body=JSON.readTree(bytes); }
        catch(IOException exception) { throw new ApiError(400,"JSONの形式が正しくありません。"); }
        require(body!=null && body.isObject(),400,"入力データが正しくありません。");
        return body;
    }
    private static void respond(HttpExchange exchange,int status,Object data) throws IOException {
        byte[] response=JSON.writeValueAsBytes(data);
        exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control","no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");
        exchange.sendResponseHeaders(status,response.length);
        try(var output=exchange.getResponseBody()) { output.write(response); }
        finally { exchange.close(); }
    }
}
