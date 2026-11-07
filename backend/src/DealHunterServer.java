import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
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
import java.security.MessageDigest;
import java.sql.*;
import java.text.Normalizer;
import java.time.LocalDateTime;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.concurrent.Executors;

/** Persisted local demo. Notifications and calendar entries remain saved previews. */
public final class DealHunterServer {
    private static final ObjectMapper JSON = new ObjectMapper()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final String DATABASE_URL = env("DEALHUNTER_DATABASE_URL", "jdbc:postgresql://127.0.0.1:55432/dealhunter");
    private static final String DATABASE_USER = env("DEALHUNTER_DATABASE_USER", "dealhunter");
    private static final String DATABASE_PASSWORD = env("DEALHUNTER_DATABASE_PASSWORD", "");
    private static final String API_KEY = env("DEALHUNTER_API_KEY", "");
    private static final String API_VERSION = "workflow-v6";
    private static String dashboardSql;
    private record User(String id, String role, String name) {}
    private record Slot(LocalDateTime start, LocalDateTime end) {}
    private record Attachment(String name, byte[] content) {}
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
                s.execute(Files.readString(backend.resolve("seed-users.sql"), StandardCharsets.UTF_8));
            }
            c.commit();
        }
        dashboardSql = Files.readString(backend.resolve("dashboard.sql"), StandardCharsets.UTF_8);
        int port = Integer.parseInt(env("DEALHUNTER_API_PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", DealHunterServer::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
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
    private static LocalDateTime date(String value) {
        try { return LocalDateTime.parse(value); }
        catch (DateTimeParseException e) { throw new ApiError(400, "日時は日本時間の年月日・時刻で入力してください。"); }
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
    private static Map<String, Object> request(Connection c, User user, String id, String requiredRole) throws SQLException {
        role(user, requiredRole);
        Map<String, Object> row = one(c, "SELECT r.*,p.sales_id,p.name AS project_name,p.notes,u.display_name AS person FROM interview_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id WHERE r.id=? FOR UPDATE OF r", id);
        require(row != null, 404, "面談依頼が見つかりません。");
        require(user.id.equals(str(row, requiredRole.equals("sales") ? "sales_id" : "student_id")), 403, "この面談依頼は操作できません。");
        return row;
    }
    private static Map<String, Object> ownedEvent(Connection c, User user, String id, String requiredRole) throws SQLException {
        role(user, requiredRole);
        Map<String, Object> row = one(c, "SELECT e.*,p.sales_id,p.name AS project_name,u.display_name AS person FROM scheduled_events e JOIN projects p ON p.id=e.project_id JOIN app_users u ON u.id=e.student_id WHERE e.id=? FOR UPDATE OF e", id);
        require(row != null, 404, "予定が見つかりません。");
        require(user.id.equals(str(row, requiredRole.equals("sales") ? "sales_id" : "student_id")), 403, "この予定は操作できません。");
        return row;
    }
    private static Map<String, Object> event(Connection c, User user, String id, String requiredRole) throws SQLException {
        Map<String,Object> row=ownedEvent(c,user,id,requiredRole);
        require(str(row,"kind").equals("meet"), 400, "面談の予定を選んでください。");
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
    private static Object saveAttachment(Connection c, User user, String requestId, JsonNode body) throws SQLException {
        Map<String,Object> r=request(c,user,requestId,"sales");
        one(c,"SELECT id FROM projects WHERE id=? FOR UPDATE",r.get("project_id"));
        Attachment attachment=parseAttachment(body);
        execute(c,"INSERT INTO project_attachments(project_id,filename,content) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET filename=EXCLUDED.filename,content=EXCLUDED.content,created_at=now()",r.get("project_id"),attachment.name(),attachment.content());
        return Map.of("message","案件共通のスキルシートを保存しました。","attachment",Map.of("name",attachment.name(),"size",attachment.content().length,"scope","project"));
    }
    private static void downloadAttachment(Connection c, User user, String requestId, HttpExchange exchange) throws Exception {
        require(user.role.equals("sales") || user.role.equals("student"),403,"このファイルは利用できません。");
        Map<String,Object> r=request(c,user,requestId,user.role);
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

    private static Object createRequest(Connection c, User user, JsonNode body) throws Exception {
        role(user,"sales");
        String project = text(body,"project"), summary = text(body,"summary");
        boolean multiplePayload=body.has("studentIds");
        List<String> memberIds=new ArrayList<>();
        if(multiplePayload) {
            JsonNode members=body.get("studentIds");
            require(members.isArray() && !members.isEmpty(),400,"面談者を1名以上選んでください。");
            for(JsonNode member:members) {
                require(member.isTextual() && !member.asText().trim().isEmpty(),400,"面談者の選択が正しくありません。");
                memberIds.add(member.asText().trim());
            }
        } else memberIds.add(text(body,"studentId"));
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
        String leaderId=multiplePayload?text(body,"leaderId"):optionalText(body,"leaderId");
        Map<String,Object> leader=null;
        if(!leaderId.isEmpty()) {
            leader=one(c,"SELECT display_name FROM app_users WHERE id=? AND role='leader'",leaderId);
            require(leader!=null,400,"担当リーダーとして登録された利用者を選んでください。");
        }
        JsonNode candidates = body.get("candidates");
        require(candidates != null && candidates.isArray() && !candidates.isEmpty(),400,"候補日時を1件以上入力してください。");
        List<Slot> slots = new ArrayList<>();
        Set<LocalDateTime> seen = new HashSet<>();
        for (JsonNode n : candidates) {
            LocalDateTime start = date(text(n,"start")), end = date(text(n,"end"));
            require(end.isAfter(start) && start.toLocalDate().equals(end.toLocalDate()),400,"候補の終了時刻は同日の開始時刻より後にしてください。");
            require(seen.add(start),400,"候補日時が重複しています。");
            slots.add(new Slot(start,end));
        }
        slots.sort(Comparator.comparing(Slot::start));
        String projectId=id("DH-");
        execute(c,"INSERT INTO projects(id,name,sales_id,notes,leader_id,participant_name,participant_name_kana) VALUES(?,?,?,?,?,?,?)",projectId,project,user.id,summary,leaderId.isEmpty()?null:leaderId,participantName,participantNameKana);
        if(attachment!=null) execute(c,"INSERT INTO project_attachments(project_id,filename,content) VALUES(?,?,?)",projectId,attachment.name(),attachment.content());
        String times = String.join(" ／ ",slots.stream().map(s -> s.start.toString().replace('T',' ') + "〜" + s.end.toLocalTime()).toList());
        List<String> requestIds=new ArrayList<>();
        List<Map<String,Object>> previews=new ArrayList<>();
        for(var member:students.entrySet()) {
            String requestId=id("R-");
            execute(c,"INSERT INTO interview_requests(id,project_id,student_id,status) VALUES(?,?,?,'requested')",requestId,projectId,member.getKey());
            for(Slot slot:slots) execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at) VALUES(?,?,?,?)",id("S-"),requestId,slot.start,slot.end);
            requestIds.add(requestId);
            previews.add(preview(c,projectId,member.getKey(),"lark","面談依頼の通知内容",List.of(line("宛先","面談連絡グループ"),line("メンション","@"+member.getValue()),line("案件",project),line("概要",summary),line("候補日時",times),line("面談ページ","http://127.0.0.1:3100/engineer?request="+requestId)),"面談依頼が来ました。概要を確認し、営業へ参加可能な日時を回答してください。外部送信は行っていません。"));
        }
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
    private static Object respondRequest(Connection c, User user, String requestId, JsonNode body) throws Exception {
        Map<String,Object> r = request(c,user,requestId,"student");
        require(!str(r,"status").equals("confirmed"),409,"日時確定後は候補を変更できません。");
        JsonNode selected = body.get("slotIds");
        require(selected != null && selected.isArray() && !selected.isEmpty(),400,"参加可能な候補を1件以上選んでください。");
        Set<String> ids = new LinkedHashSet<>();
        for (JsonNode n : selected) {
            require(n.isTextual() && ids.add(n.asText()),400,"候補日時の選択が正しくありません。");
            require(one(c,"SELECT id FROM candidate_slots WHERE id=? AND request_id=?",n.asText(),requestId) != null,400,"この依頼の候補から選んでください。");
        }
        execute(c,"UPDATE candidate_slots SET available=false WHERE request_id=?",requestId);
        for (String slotId : ids) execute(c,"UPDATE candidate_slots SET available=true WHERE id=? AND request_id=?",slotId,requestId);
        execute(c,"UPDATE interview_requests SET status='responded',task_revision=task_revision+1 WHERE id=?",requestId);
        var p=preview(c,str(r,"project_id"),str(r,"sales_id"),"lark","候補日時への回答",List.of(line("メンション","@青木 美咲"),line("受講者",user.name),line("案件",str(r,"project_name")),line("参加可能な候補",ids.size()+"件"),line("面談ページ","http://127.0.0.1:3100/sales?request="+requestId)),"受講者から回答が届きました。先方と調整し、面談日時を確定してください。外部送信は行っていません。");
        return Map.of("message","参加可能な候補を保存しました。","preview",p);
    }
    private static Object confirmRequest(Connection c, User user, String requestId, JsonNode body) throws Exception {
        Map<String,Object> r=request(c,user,requestId,"sales");
        require(!str(r,"status").equals("confirmed"),409,"この面談依頼はすでに日時確定しています。");
        require(str(r,"status").equals("responded"),409,"受講者の候補日時への回答を待ってください。");
        String slotId=text(body,"slotId"), url=httpUrl(text(body,"url"));
        Map<String,Object> slot=one(c,"SELECT * FROM candidate_slots WHERE id=? AND request_id=? AND available",slotId,requestId);
        require(slot!=null,400,"受講者が参加可能と回答した候補を選んでください。");
        LocalDateTime start=((Timestamp)slot.get("start_at")).toLocalDateTime(), end=((Timestamp)slot.get("end_at")).toLocalDateTime();
        String eventId=id("E-");
        execute(c,"INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,end_time,kind,route,format,request_id,meeting_url) VALUES(?,?,?,?,?,?,'meet','一次面談','オンライン',?,?)",eventId,r.get("project_id"),r.get("student_id"),start.toLocalDate(),start.toLocalTime(),end.toLocalTime(),requestId,url);
        execute(c,"UPDATE interview_requests SET status='confirmed',confirmed_slot_id=? WHERE id=?",slotId,requestId);
        var p=preview(c,str(r,"project_id"),str(r,"student_id"),"calendar","面談予定の登録内容",List.of(line("案件",str(r,"project_name")),line("参加者",str(r,"person")),line("面談日時",start.toString().replace('T',' ')+"〜"+end.toLocalTime()),line("面談URL",url),line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"面談日時を確定しました。Larkカレンダーへの実際の登録は行っていません。");
        return Map.of("message","面談日時とURLを保存しました。","eventId",eventId,"preview",p);
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
    private static Object registerEntry(Connection c, User user, String eventId, JsonNode body) throws Exception {
        Map<String,Object> e=event(c,user,eventId,"sales");
        String result=text(body,"result");
        require(result.equals("passed") || result.equals("rejected"),400,"面談結果を選んでください。");
        require(!str(e,"status").equals("entry-registered") && !str(e,"result").equals("rejected"),409,"この面談の結果・初回入場は登録済みです。");
        if(result.equals("rejected")) {
            execute(c,"UPDATE scheduled_events SET result='rejected' WHERE id=?",eventId);
            var p=preview(c,str(e,"project_id"),str(e,"student_id"),"lark","面談結果のお知らせ",List.of(line("案件",str(e,"project_name")),line("受講者",str(e,"person")),line("結果","不合格"),line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"面談結果を保存しました。外部送信は行っていません。");
            return Map.of("message","面談結果を保存しました。","preview",p);
        }
        LocalDateTime when=date(text(body,"when"));
        String where=text(body,"where"),memo=optionalText(body,"memo"),entryId=id("E-");
        LocalDateTime meeting=((java.sql.Date)e.get("event_date")).toLocalDate().atTime(((Time)e.get("start_time")).toLocalTime());
        require(when.isAfter(meeting),400,"初回入場は面談より後の日時にしてください。");
        execute(c,"INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,request_id,meeting_place,guidance,parent_event_id,result) VALUES(?,?,?,?,?,'entry','初回入場',?,?,?,?,?,'passed')",entryId,e.get("project_id"),e.get("student_id"),when.toLocalDate(),when.toLocalTime(),where,e.get("request_id"),where,memo,eventId);
        execute(c,"UPDATE scheduled_events SET result='passed',status='entry-registered' WHERE id=?",eventId);
        var p=preview(c,str(e,"project_id"),str(e,"student_id"),"calendar","初回入場予定の登録内容",List.of(line("案件",str(e,"project_name")),line("入場者",str(e,"person")),line("集合日時",when.toString().replace('T',' ')),line("集合場所",where),line("当日の案内",memo.isBlank()?"記載なし":memo),line("面談ページ","http://127.0.0.1:3100/engineer?event="+entryId)),"合格と初回入場予定を保存しました。Larkカレンダーへの実際の登録は行っていません。");
        return Map.of("message","合格と初回入場予定を保存しました。","eventId",entryId,"preview",p);
    }

    private static Object acknowledgeEvent(Connection c, User user, String eventId) throws SQLException {
        Map<String,Object> e=ownedEvent(c,user,eventId,"student");
        require(str(e,"kind").equals("entry") || (str(e,"kind").equals("meet")
            && (str(e,"result").equals("passed") || str(e,"result").equals("rejected"))),
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
        boolean requestTask=taskKey.startsWith("request-");
        String prefix=requestTask?"request-":taskKey.startsWith("entry-")?"entry-":taskKey.startsWith("feedback-")?"feedback-":taskKey.startsWith("result-")?"result-":null;
        require(prefix!=null,404,"対応待ちが見つかりません。");
        String sourceId=taskKey.substring(prefix.length());
        Map<String,Object> source=one(c,requestTask
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

    private static void handle(HttpExchange exchange) throws IOException {
        String path=exchange.getRequestURI().getPath(),method=exchange.getRequestMethod();
        try {
            if(path.equals("/api/health") && method.equals("GET")) {
                try(Connection c=connect()) { one(c,"SELECT 1"); }
                respond(exchange,200,Map.of("service","dealhunter","status","ok","database","postgresql","version",API_VERSION,"referenceDate","2026-11-05","timezone","Asia/Tokyo")); return;
            }
            String key=exchange.getRequestHeaders().getFirst("X-DealHunter-Key");
            require(key!=null && MessageDigest.isEqual(API_KEY.getBytes(StandardCharsets.UTF_8),key.getBytes(StandardCharsets.UTF_8)),401,"ログインしてください。");
            try(Connection c=connect()) {
                c.setAutoCommit(false);
                try {
                    User user=authenticate(c,exchange);
                    require(!user.role.equals("leader") || !method.equals("POST"),403,"リーダーは担当案件の閲覧のみ利用できます。");
                    if(path.equals("/api/dashboard")) {
                        require(method.equals("GET"),405,"このエンドポイントではGETを使用してください。");
                        Map<String,Object> row=one(c,dashboardSql,user.id);
                        respond(exchange,200,JSON.readTree(row.values().iterator().next().toString())); return;
                    }
                    if(path.matches("/api/requests/[^/]+/attachment") && method.equals("GET")) {
                        downloadAttachment(c,user,path.split("/")[3],exchange); c.commit(); return;
                    }
                    require(path.equals("/api/requests") || path.matches("/api/requests/[^/]+/(respond|confirm)")
                        || path.matches("/api/requests/[^/]+/attachment") || path.matches("/api/events/[^/]+/(feedback|entry|acknowledge)") || path.matches("/api/tasks/[^/]+/acknowledge"),404,"エンドポイントが見つかりません。");
                    require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                    require(Objects.toString(exchange.getRequestHeaders().getFirst("Content-Type"),"").toLowerCase(Locale.ROOT).startsWith("application/json"),400,"JSON形式で送信してください。");
                    byte[] bytes=exchange.getRequestBody().readNBytes(8*1024*1024+1);
                    require(bytes.length<=8*1024*1024,413,"送信データが大きすぎます。");
                    JsonNode body;
                    try { body=JSON.readTree(bytes); }
                    catch(IOException exception) { throw new ApiError(400,"JSONの形式が正しくありません。"); }
                    require(body!=null && body.isObject(),400,"入力データが正しくありません。");
                    Object response;
                    String[] parts=path.split("/");
                    if(path.equals("/api/requests")) response=createRequest(c,user,body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("respond")) response=respondRequest(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("confirm")) response=confirmRequest(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("requests") && parts[4].equals("attachment")) response=saveAttachment(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("feedback")) response=submitFeedback(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("entry")) response=registerEntry(c,user,parts[3],body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("events") && parts[4].equals("acknowledge")) response=acknowledgeEvent(c,user,parts[3]);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("tasks") && parts[4].equals("acknowledge")) response=acknowledgeTask(c,user,parts[3],body);
                    else throw new ApiError(404,"エンドポイントが見つかりません。");
                    c.commit();
                    respond(exchange,200,response);
                } catch(Exception exception) { c.rollback(); throw exception; }
            }
        } catch(ApiError exception) { respond(exchange,exception.status,Map.of("error",exception.getMessage())); }
        catch(SQLException exception) {
            System.err.println("Database request failed (SQL state " + exception.getSQLState() + ")");
            int status="23505".equals(exception.getSQLState())?409:503;
            respond(exchange,status,Map.of("error",status==409?"すでに登録されています。":"データベースに接続できません。"));
        } catch(Exception exception) {
            System.err.println("Request failed: "+exception.getClass().getSimpleName());
            respond(exchange,500,Map.of("error","処理に失敗しました。入力内容を確認してください。"));
        }
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
