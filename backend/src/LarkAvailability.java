import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.time.*;
import java.time.format.DateTimeParseException;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Uses the configured Lark app for calendar occupancy and direct notifications. */
final class LarkAvailability {
    enum Status { FREE, BUSY, UNKNOWN }
    static class UnavailableException extends RuntimeException {
        UnavailableException(String message) { super(message); }
    }
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();
    private static final URI LARK = URI.create("https://open.larksuite.com/open-apis/");
    private static final String NOT_CONFIGURED = "Larkカレンダーは未設定です。管理者に連携設定を依頼してください。";
    private static final String INVALID_CONFIG = "Larkカレンダーの設定ファイルを確認できません。管理者に連絡してください。";
    private static final String BAD_RESPONSE = "Larkカレンダーから有効な応答を取得できませんでした。時間をおいて再検索してください。";
    private final URI api;
    private final String appId, secret;
    // A provided mapping selects explicit identity binding instead of directory lookup.
    private final Map<String,String> openIds;
    private final String configError;
    private String token;
    private long tokenExpiresAt;

    LarkAvailability(URI api, String appId, String secret) {
        this(api, appId, secret, null, null);
    }
    private LarkAvailability(URI api, String appId, String secret, Map<String,String> openIds, String configError) {
        this.api = api;
        this.appId = appId;
        this.secret = secret;
        this.openIds = openIds;
        this.configError = configError;
    }
    static LarkAvailability fromEnvironment() {
        return fromFile(Path.of(".local", "lark-calendar.json"), LARK);
    }
    static LarkAvailability fromFile(Path config, URI api) {
        if (Files.notExists(config)) return new LarkAvailability(api, "", "");
        try {
            JsonNode settings = JSON.readTree(Files.readString(config));
            if (settings == null || !settings.isObject()) throw new IOException();
            Map<String,String> mapping = null;
            if (settings.has("openIds")) {
                JsonNode ids = settings.get("openIds");
                if (!ids.isObject()) throw new IOException();
                mapping = new HashMap<>();
                Set<String> assigned = new HashSet<>();
                var fields = ids.fields();
                while (fields.hasNext()) {
                    var field = fields.next();
                    String email = field.getKey().strip().toLowerCase(Locale.ROOT);
                    String id = field.getValue().asText("").strip();
                    if (email.isEmpty() || !id.matches("ou_[A-Za-z0-9_-]+") ||
                            mapping.putIfAbsent(email, id) != null || !assigned.add(id)) throw new IOException();
                }
            }
            return new LarkAvailability(api, settings.path("appId").asText("").strip(),
                settings.path("appSecret").asText("").strip(), mapping, null);
        } catch (IOException | RuntimeException invalid) {
            return new LarkAvailability(api, "", "", null, INVALID_CONFIG);
        }
    }

    boolean canSendMessages() {
        return configError == null && !appId.isBlank() && !secret.isBlank();
    }

    String sendText(String email, String message, String notificationId) {
        if (!canSendMessages()) throw new UnavailableException("Lark通知の連携設定を確認してください。");
        if (message == null || message.isBlank() || notificationId == null ||
                !notificationId.matches("[A-Fa-f0-9]{8}(-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}")) {
            throw new UnavailableException("Lark通知の内容を確認できませんでした。");
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(18);
        String normalizedEmail = email == null ? "" : email.strip().toLowerCase(Locale.ROOT);
        String openId = null;
        if (openIds != null) {
            openId = openIds.get(normalizedEmail);
        } else if (!normalizedEmail.isBlank() && !normalizedEmail.endsWith("@dealhunter.example")) {
            try {
                openId = resolveEmails(List.of(normalizedEmail), deadline).get(normalizedEmail);
            } catch (UnavailableException e) {
                throw new UnavailableException("Lark通知の宛先を照合できませんでした。");
            }
        }
        if (openId == null || openId.isBlank()) {
            throw new UnavailableException("Lark通知の宛先が見つかりませんでした。");
        }

        JsonNode data;
        try {
            String content = JSON.writeValueAsString(Map.of("text", message));
            data = authorized("im/v1/messages?receive_id_type=open_id",
                Map.of("receive_id", openId, "msg_type", "text", "content", content, "uuid", notificationId), deadline);
        } catch (IOException | UnavailableException e) {
            throw new UnavailableException("Lark通知を送信できませんでした。");
        }
        JsonNode messageId = data.path("message_id");
        if (!messageId.isTextual() || messageId.asText().isBlank()) {
            throw new UnavailableException("Lark通知の送信結果を確認できませんでした。");
        }
        return messageId.asText();
    }

    Map<String,Status> check(Map<String,String> emailsById, Instant start, Instant end) {
        if (configError != null) throw new UnavailableException(configError);
        if (appId.isBlank() || secret.isBlank()) throw new UnavailableException(NOT_CONFIGURED);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(18);
        Map<String,String> normalized = new LinkedHashMap<>();
        emailsById.forEach((id, email) -> {
            if (email != null && !email.isBlank()) normalized.put(id, email.strip().toLowerCase(Locale.ROOT));
        });
        Set<String> emails = new LinkedHashSet<>(normalized.values());
        Map<String,String> identities = openIds;
        if (identities == null) {
            emails.removeIf(email -> email.endsWith("@dealhunter.example"));
            identities = resolveEmails(new ArrayList<>(emails), deadline);
        }
        Map<String,Status> byOpenId = new HashMap<>();
        Set<String> relevant = new LinkedHashSet<>();
        for (String email : emails) {
            String id = identities.get(email);
            if (id != null && !id.isEmpty()) relevant.add(id);
        }
        var ids = List.copyOf(relevant);
        for (int i=0; i<ids.size(); i+=10) {
            readOccupancy(ids.subList(i, Math.min(i+10, ids.size())), start, end, deadline, byOpenId);
        }
        Map<String,Status> result = new HashMap<>();
        for (var entry : emailsById.entrySet()) {
            String email = normalized.get(entry.getKey());
            String id = email == null ? null : identities.get(email);
            result.put(entry.getKey(), byOpenId.getOrDefault(id, Status.UNKNOWN));
        }
        return result;
    }

    private Map<String,String> resolveEmails(List<String> emails, long deadline) {
        Map<String,String> result = new HashMap<>();
        for (int i=0; i<emails.size(); i+=50) {
            var batch = emails.subList(i, Math.min(i+50, emails.size()));
            JsonNode data = authorized("contact/v3/users/batch_get_id?user_id_type=open_id",
                Map.of("emails",batch,"include_resigned",false),deadline);
            JsonNode users = data.path("user_list");
            if (!users.isArray()) throw new UnavailableException(BAD_RESPONSE);
            for (var user : users) {
                String email = user.path("email").asText("").strip().toLowerCase(Locale.ROOT);
                if (!batch.contains(email)) continue;
                JsonNode state = user.path("status");
                boolean inactive = state.path("is_resigned").asBoolean() || state.path("is_frozen").asBoolean()
                    || state.path("is_exited").asBoolean() || state.path("is_unjoin").asBoolean()
                    || (state.has("is_activated") && !state.path("is_activated").asBoolean());
                String id = user.path("user_id").asText("");
                result.merge(email, !inactive && id.matches("ou_[A-Za-z0-9_-]+") ? id : "", (a,b) -> "");
            }
        }
        return result;
    }

    private void readOccupancy(List<String> ids, Instant start, Instant end, long deadline, Map<String,Status> result) {
        JsonNode data;
        try {
            data = authorized("calendar/v4/freebusy/batch?user_id_type=open_id", Map.of(
                "user_ids",ids,"time_min",start.toString(),"time_max",end.toString(),
                "include_external_calendar",true,"only_busy",true),deadline);
        } catch (ApiError e) {
            // A departed user can invalidate the entire batch. Isolate that user's result.
            if (e.code != 195100) throw e;
            if (ids.size() > 1) {
                int half = ids.size()/2;
                readOccupancy(ids.subList(0,half),start,end,deadline,result);
                readOccupancy(ids.subList(half,ids.size()),start,end,deadline,result);
            }
            return;
        }
        JsonNode users = data.path("freebusy_lists");
        if (!users.isArray()) throw new UnavailableException(BAD_RESPONSE);
        for (var user : users) {
            String id = user.path("user_id").asText("");
            if (ids.contains(id)) result.merge(id, classify(user.path("freebusy_items"),start,end), (a,b) -> Status.UNKNOWN);
        }
    }
    private static Status classify(JsonNode items, Instant start, Instant end) {
        if (!items.isArray()) return Status.UNKNOWN;
        for (JsonNode item : items) {
            try {
                Instant from = Instant.parse(item.path("start_time").asText(""));
                Instant to = Instant.parse(item.path("end_time").asText(""));
                if (!from.isBefore(to)) return Status.UNKNOWN;
                if (from.isBefore(end) && start.isBefore(to)) return Status.BUSY;
            } catch (DateTimeParseException invalid) { return Status.UNKNOWN; }
        }
        return Status.FREE;
    }

    private static final class ApiError extends UnavailableException {
        final int code, status;
        ApiError(int code, int status) {
            super(status == 429 || code == 190004 || code == 190005 ? "Larkの照会上限に達しました。時間をおいて再検索してください。"
                : "Larkに照会できませんでした。アプリの認証情報・公開状態・閲覧権限を確認してください。");
            this.code = code;
            this.status = status;
        }
    }
    private JsonNode authorized(String path, Object body, long deadline) {
        String current = token(deadline);
        try {
            return post(path, body, current, deadline).path("data");
        } catch (ApiError e) {
            if (e.status != 401 && e.code != 99991663 && e.code != 99991664 && e.code != 99991668) throw e;
            synchronized (this) { if (current.equals(token)) token = null; }
            return post(path, body, token(deadline), deadline).path("data");
        }
    }
    private synchronized String token(long deadline) {
        if (token != null && System.nanoTime() < tokenExpiresAt) return token;
        JsonNode response = post("auth/v3/tenant_access_token/internal",
            Map.of("app_id",appId,"app_secret",secret),null,deadline);
        String value = response.path("tenant_access_token").asText("");
        if (value.isBlank()) throw new UnavailableException(BAD_RESPONSE);
        long seconds = Math.max(0, Math.min(86400, response.path("expire").asLong(0)) - 60);
        tokenExpiresAt = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        return token = value;
    }
    private JsonNode post(String path, Object body, String bearer, long deadline) {
        long millis = Math.min(6000, TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime()));
        if (millis < 1) throw new UnavailableException(BAD_RESPONSE);
        try {
            var builder = HttpRequest.newBuilder(api.resolve(path)).timeout(Duration.ofMillis(millis))
                .header("Content-Type","application/json; charset=utf-8");
            if (bearer != null) builder.header("Authorization","Bearer " + bearer);
            var response = HTTP.send(builder.POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body))).build(),
                HttpResponse.BodyHandlers.ofByteArray());
            JsonNode json = JSON.readTree(response.body());
            int code = json == null || !json.path("code").isIntegralNumber() ? -1 : json.get("code").asInt();
            if (response.statusCode()!=200 || code!=0) throw new ApiError(code,response.statusCode());
            return json;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new UnavailableException(BAD_RESPONSE);
        } catch (IOException e) { throw new UnavailableException(BAD_RESPONSE); }
    }
}
