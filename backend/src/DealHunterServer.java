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
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.sql.*;
import java.text.Normalizer;
import java.time.LocalDate;
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
    private static final String API_VERSION = "workflow-v10";
    private static final int PASSWORD_ITERATIONS = 600_000;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String DUMMY_PASSWORD_HASH = passwordHash("unused-user-timing-padding");
    private static final Map<String,LoginAttempts> LOGIN_ATTEMPTS = new LinkedHashMap<>();
    private record LoginAttempts(int count,long expiresAt) {}
    private static String dashboardSql;
    private record User(String id, String role, String name) {}
    private record Slot(LocalDateTime start, LocalDateTime end) {}
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
                s.execute(Files.readString(backend.resolve("seed-users.sql"), StandardCharsets.UTF_8));
            }
            seedCredentials(c,backend);
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
    private static String companyName(JsonNode body, String key, String label, boolean required) {
        JsonNode value=body.get(key);
        if(value==null) {
            require(!required,400,label+"を入力してください。");
            return "";
        }
        require(value.isTextual(),400,label+"は文字列で入力してください。");
        String name=value.asText();
        int start=0,end=name.length();
        while(start<end && companyWhitespace(name.codePointAt(start))) start+=Character.charCount(name.codePointAt(start));
        while(end>start && companyWhitespace(name.codePointBefore(end))) end-=Character.charCount(name.codePointBefore(end));
        name=name.substring(start,end);
        require(!required || !name.isEmpty(),400,label+"を入力してください。");
        require(name.length()<=200,400,label+"は200文字以内で入力してください。");
        return name;
    }
    private static boolean companyWhitespace(int codePoint) {
        return Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint) || codePoint==0x85 || codePoint==0xFEFF;
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
            require(!proposals || !item.has("end"),400,"参加可能な日時は開始日時だけを入力してください。");
            LocalDateTime start = date(text(item,"start"));
            LocalDateTime end = item.hasNonNull("end") ? date(text(item,"end")) : null;
            require(end == null || (end.isAfter(start) && start.toLocalDate().equals(end.toLocalDate())),400,"候補の終了時刻は同日の開始時刻より後にしてください。");
            require(seen.add(start),400,"候補日時が重複しています。");
            slots.add(new Slot(start,end));
        }
        slots.sort(Comparator.comparing(Slot::start));
        return slots;
    }
    private static String slotLabel(Slot slot) {
        return slot.start.toString().replace('T',' ') + (slot.end == null ? "" : "〜" + slot.end.toLocalTime());
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
    private static void seedCredentials(Connection c, Path backend) throws Exception {
        List<String[]> samples=new ArrayList<>();
        samples.add(new String[]{"sales-aoki","sales.aoki@dealhunter.example","demo-sales"});
        for(String alias:List.of("takahashi","yamamoto","mori","ito","kobayashi","sasaki","tanaka","kimura","inoue"))
            samples.add(new String[]{"student-"+alias,"engineer."+alias+"@dealhunter.example","demo-engineer"});
        for(String alias:List.of("sato","suzuki")) samples.add(new String[]{"leader-"+alias,"leader."+alias+"@dealhunter.example","demo-leader"});
        for(String[] sample:samples) {
            if(one(c,"SELECT id FROM app_users WHERE id=? AND email IS NULL AND password_hash IS NULL",sample[0])!=null)
                execute(c,"UPDATE app_users SET email=?,password_hash=? WHERE id=? AND email IS NULL AND password_hash IS NULL",sample[1],passwordHash(sample[2]),sample[0]);
        }
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
        Map<String,Object> row=one(c,"SELECT id,display_name,role,password_hash FROM app_users WHERE lower(email)=?",email);
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
        Map<String,Object> target=one(c,"SELECT id,role FROM app_users WHERE id=? FOR UPDATE",userId);
        require(target!=null,404,"利用者が見つかりません。");
        String previousRole=str(target,"role");
        if(previousRole.equals("admin") && !nextRole.equals("admin"))
            require(((Number)one(c,"SELECT count(*) AS n FROM app_users WHERE role='admin'").get("n")).longValue()>1,409,"最後の管理者の役割は変更できません。別の管理者を先に登録してください。");
        if(previousRole.equals("leader") && !nextRole.equals("leader")) {
            require(one(c,"SELECT student_id FROM leader_members WHERE leader_id=? AND active LIMIT 1",userId)==null,409,"先に部下の所属リーダーを変更してください。");
            require(one(c,"SELECT a.id FROM recruitments a JOIN projects p ON p.id=a.project_id WHERE p.leader_id=? AND a.status='pending' LIMIT 1",userId)==null,409,"面談者の選定待ち案件があります。選定を完了してから役割を変更してください。");
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
    private static Map<String, Object> request(Connection c, User user, String id, String requiredRole) throws SQLException {
        role(user, requiredRole);
        Map<String, Object> row = one(c, "SELECT r.*,p.sales_id,p.name AS project_name,p.notes,u.display_name AS person,su.display_name AS sales_name FROM interview_requests r JOIN projects p ON p.id=r.project_id JOIN app_users u ON u.id=r.student_id JOIN app_users su ON su.id=p.sales_id WHERE r.id=? FOR UPDATE OF r", id);
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

    private static IssuedRequests issueRequests(Connection c, String projectId, String project, String summary,
            String scheduleMode, List<LocalDate> requestedDates, List<Slot> slots, Map<String,String> students, String recruitmentId) throws Exception {
        List<String> requestIds=new ArrayList<>();
        List<Map<String,Object>> previews=new ArrayList<>();
        String times=scheduleLabel(scheduleMode,requestedDates,slots);
        for(var member:students.entrySet()) {
            String requestId=id("R-");
            execute(c,"INSERT INTO interview_requests(id,project_id,student_id,status,schedule_mode,requested_dates,recruitment_id) VALUES(?,?,?,'requested',?,?::date[],?)",requestId,projectId,member.getKey(),scheduleMode,datesArray(requestedDates),recruitmentId);
            for(Slot slot:slots) execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at) VALUES(?,?,?,?)",id("S-"),requestId,slot.start,slot.end);
            requestIds.add(requestId);
            previews.add(preview(c,projectId,member.getKey(),"lark","面談依頼の通知内容",List.of(line("宛先","面談連絡グループ"),line("メンション","@"+member.getValue()),line("案件",project),line("概要",summary),line(scheduleMode.equals("availability")?"日程の確認":"候補日時",times),line("面談ページ","http://127.0.0.1:3100/engineer?request="+requestId)),"面談依頼が来ました。概要を確認し、営業へ参加可能な日時を回答してください。外部送信は行っていません。"));
        }
        return new IssuedRequests(requestIds,previews);
    }

    private static Object createRequest(Connection c, User user, JsonNode body) throws Exception {
        role(user,"sales");
        String upperCompany=companyName(body,"upperCompany","上位会社",true),endCompany=companyName(body,"endCompany","エンド企業",false);
        String project = text(body,"project"), summary = text(body,"summary");
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
        execute(c,"INSERT INTO projects(id,name,sales_id,notes,leader_id,participant_name,participant_name_kana,upper_company,end_company) VALUES(?,?,?,?,?,?,?,?,?)",projectId,project,user.id,summary,leaderId.isEmpty()?null:leaderId,participantName,participantNameKana,upperCompany,endCompany);
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
    private static Object assignRecruitment(Connection c, User user, String recruitmentId, JsonNode body) throws Exception {
        role(user,"leader");
        Map<String,Object> recruitment=one(c,"SELECT a.*,p.leader_id,p.sales_id,p.name AS project_name,p.notes,su.display_name AS sales_name FROM recruitments a JOIN projects p ON p.id=a.project_id JOIN app_users su ON su.id=p.sales_id WHERE a.id=? FOR UPDATE OF a",recruitmentId);
        require(recruitment!=null,404,"面談者の選定依頼が見つかりません。");
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
    private static Object respondRequest(Connection c, User user, String requestId, JsonNode body) throws Exception {
        Map<String,Object> r = request(c,user,requestId,"student");
        require(!str(r,"status").equals("confirmed"),409,"日時確定後は候補を変更できません。");
        String answer;
        if (str(r,"schedule_mode").equals("availability")) {
            require(!body.has("slotIds") && !body.has("candidates"),400,"参加可能な開始日時を入力して回答してください。");
            List<Slot> proposed = slots(body.get("proposals"),true);
            Set<LocalDate> requestedDates = storedRequestedDates(r);
            for (Slot slot : proposed) require(requestedDates.isEmpty() || requestedDates.contains(slot.start.toLocalDate()),400,"依頼で指定された日の開始日時を入力してください。");
            // The request row stays locked through replacement and revision update.
            execute(c,"DELETE FROM candidate_slots WHERE request_id=?",requestId);
            for (Slot slot : proposed) execute(c,"INSERT INTO candidate_slots(id,request_id,start_at,end_at,available) VALUES(?,?,?,NULL,true)",id("S-"),requestId,slot.start);
            answer = String.join(" ／ ",proposed.stream().map(DealHunterServer::slotLabel).toList());
        } else {
            require(!body.has("proposals") && !body.has("candidates"),400,"依頼された候補日時から選んで回答してください。");
            JsonNode selected = body.get("slotIds");
            require(selected != null && selected.isArray() && !selected.isEmpty(),400,"参加可能な候補を1件以上選んでください。");
            Set<String> ids = new LinkedHashSet<>();
            for (JsonNode n : selected) {
                require(n.isTextual() && ids.add(n.asText()),400,"候補日時の選択が正しくありません。");
                require(one(c,"SELECT id FROM candidate_slots WHERE id=? AND request_id=?",n.asText(),requestId) != null,400,"この依頼の候補から選んでください。");
            }
            execute(c,"UPDATE candidate_slots SET available=false WHERE request_id=?",requestId);
            for (String slotId : ids) execute(c,"UPDATE candidate_slots SET available=true WHERE id=? AND request_id=?",slotId,requestId);
            answer = ids.size()+"件";
        }
        execute(c,"UPDATE interview_requests SET status='responded',task_revision=task_revision+1 WHERE id=?",requestId);
        var p=preview(c,str(r,"project_id"),str(r,"sales_id"),"lark","候補日時への回答",List.of(line("メンション","@"+str(r,"sales_name")),line("受講者",user.name),line("案件",str(r,"project_name")),line("参加可能な候補",answer),line("面談ページ","http://127.0.0.1:3100/sales?request="+requestId)),"受講者から回答が届きました。先方と調整し、面談日時を確定してください。外部送信は行っていません。");
        return Map.of("message","参加可能な候補を保存しました。","preview",p);
    }
    private static Object confirmRequest(Connection c, User user, String requestId, JsonNode body) throws Exception {
        Map<String,Object> r=request(c,user,requestId,"sales");
        require(!str(r,"status").equals("confirmed"),409,"この面談依頼はすでに日時確定しています。");
        require(str(r,"status").equals("responded"),409,"受講者の候補日時への回答を待ってください。");
        String slotId=text(body,"slotId"), url=httpUrl(text(body,"url"));
        Map<String,Object> slot=one(c,"SELECT * FROM candidate_slots WHERE id=? AND request_id=? AND available",slotId,requestId);
        require(slot!=null,400,"受講者が参加可能と回答した候補を選んでください。");
        LocalDateTime start=((Timestamp)slot.get("start_at")).toLocalDateTime();
        LocalDateTime end=slot.get("end_at")==null?null:((Timestamp)slot.get("end_at")).toLocalDateTime();
        String eventId=id("E-");
        execute(c,"INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,end_time,kind,route,format,request_id,meeting_url) VALUES(?,?,?,?,?,?,'meet','一次面談','オンライン',?,?)",eventId,r.get("project_id"),r.get("student_id"),start.toLocalDate(),start.toLocalTime(),end==null?null:end.toLocalTime(),requestId,url);
        execute(c,"UPDATE interview_requests SET status='confirmed',confirmed_slot_id=? WHERE id=?",slotId,requestId);
        var p=preview(c,str(r,"project_id"),str(r,"student_id"),"calendar","面談予定の登録内容",List.of(line("案件",str(r,"project_name")),line("参加者",str(r,"person")),line("面談日時",slotLabel(new Slot(start,end))),line("面談URL",url),line("面談ページ","http://127.0.0.1:3100/engineer?event="+eventId)),"面談日時を確定しました。Larkカレンダーへの実際の登録は行っていません。");
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
        boolean requestTask=taskKey.startsWith("request-"), assignmentTask=taskKey.startsWith("assignment-");
        String prefix=assignmentTask?"assignment-":requestTask?"request-":taskKey.startsWith("entry-")?"entry-":taskKey.startsWith("feedback-")?"feedback-":taskKey.startsWith("result-")?"result-":null;
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
                    boolean assignmentRoute=path.matches("/api/recruitments/[^/]+/assign");
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
                    require(path.equals("/api/requests") || path.matches("/api/requests/[^/]+/(respond|confirm)")
                        || path.matches("/api/requests/[^/]+/attachment") || assignmentRoute || path.matches("/api/events/[^/]+/(feedback|entry|acknowledge)") || path.matches("/api/tasks/[^/]+/acknowledge"),404,"エンドポイントが見つかりません。");
                    require(method.equals("POST"),405,"このエンドポイントではPOSTを使用してください。");
                    JsonNode body=readBody(exchange,8*1024*1024);
                    Object response;
                    String[] parts=path.split("/");
                    if(path.equals("/api/requests")) response=createRequest(c,user,body);
                    else if(parts.length==5 && parts[1].equals("api") && parts[2].equals("recruitments") && parts[4].equals("assign")) response=assignRecruitment(c,user,parts[3],body);
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
