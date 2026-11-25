import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Starts DealHunter with a local Lark Open API fixture for the disposable integration database. */
public final class LarkAvailabilityHarness {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String APP_ID = "fixture-app";
    private static final String SECRET = "fixture-secret";
    private static final String TOKEN = "fixture-token";
    private static final String FIRST = "takahashi@example.test";
    private static final String SECOND = "yamamoto@example.test";
    private static final String FIRST_ID = "ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String SECOND_ID = "ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static final ZoneId JAPAN = ZoneId.of("Asia/Tokyo");

    private enum Fault { NONE, MISSING_USER, MISSING_ITEMS, INVALID_TIME, DENIED, EXPIRE_ONCE }
    private volatile Fault fault = Fault.NONE;
    private final AtomicInteger issuedTokens = new AtomicInteger();
    private final AtomicInteger contactRequests = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        LarkAvailabilityHarness fixture = new LarkAvailabilityHarness();
        server.createContext("/open-apis/", fixture::handle);
        server.start();
        try {
            URI base = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/open-apis/");
            fixture.checkResponses(base);
            fixture.checkConfiguredOpenIds(base);
            DealHunterServer.larkAvailability = new LarkAvailability(base, APP_ID, SECRET);
            Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
            DealHunterServer.main(args);
        } catch (Exception | Error failure) {
            server.stop(0);
            throw failure;
        }
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"POST".equals(exchange.getRequestMethod())) {
                respond(exchange, 405, Map.of("code", 405));
                return;
            }
            JsonNode body = JSON.readTree(exchange.getRequestBody());
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/open-apis/auth/v3/tenant_access_token/internal")) {
                if (APP_ID.equals(body.path("app_id").asText()) && SECRET.equals(body.path("app_secret").asText())) {
                    respond(exchange, 200, Map.of("code", 0, "tenant_access_token", TOKEN + issuedTokens.incrementAndGet(), "expire", 7200));
                } else {
                    respond(exchange, 401, Map.of("code", 10014));
                }
                return;
            }
            if (!("Bearer " + TOKEN + issuedTokens.get()).equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                respond(exchange, 401, Map.of("code", 99991663));
                return;
            }
            if (!"user_id_type=open_id".equals(exchange.getRequestURI().getQuery())) {
                respond(exchange, 400, Map.of("code", 190002));
                return;
            }
            if (path.equals("/open-apis/contact/v3/users/batch_get_id") && body.path("emails").isArray()) {
                contactRequests.incrementAndGet();
                List<Object> contacts = new ArrayList<>();
                for (JsonNode email : body.get("emails")) {
                    String id = switch (email.asText()) {
                        case FIRST -> FIRST_ID;
                        case SECOND -> SECOND_ID;
                        default -> null;
                    };
                    if (id != null) contacts.add(Map.of("email", email.asText(), "user_id", id,
                            "status", Map.of("is_activated", true, "is_resigned", false, "is_frozen", false)));
                }
                respond(exchange, 200, Map.of("code", 0, "data", Map.of("user_list", contacts)));
                return;
            }
            if (path.equals("/open-apis/calendar/v4/freebusy/batch")) {
                if (fault == Fault.EXPIRE_ONCE) {
                    fault = Fault.NONE;
                    respond(exchange, 200, Map.of("code", 99991663));
                    return;
                }
                if (fault == Fault.DENIED) {
                    respond(exchange, 403, Map.of("code", 99991672));
                    return;
                }
                JsonNode ids = body.path("user_ids");
                if (!ids.isArray() || ids.isEmpty() || ids.size() > 10 || !body.path("only_busy").asBoolean()) {
                    respond(exchange, 400, Map.of("code", 190002));
                    return;
                }
                Instant start = OffsetDateTime.parse(body.path("time_min").asText()).toInstant();
                Instant end = OffsetDateTime.parse(body.path("time_max").asText()).toInstant();
                LocalDate date = start.atZone(JAPAN).toLocalDate();
                OffsetDateTime busyStart = date.atTime(10, 0).atZone(JAPAN).toOffsetDateTime();
                OffsetDateTime busyEnd = busyStart.plusHours(1);
                List<Object> rows = new ArrayList<>();
                for (JsonNode id : ids) {
                    if (FIRST_ID.equals(id.asText())) {
                        switch (fault) {
                            case MISSING_USER -> { }
                            case MISSING_ITEMS -> rows.add(Map.of("user_id", FIRST_ID));
                            case INVALID_TIME -> rows.add(Map.of("user_id", FIRST_ID, "freebusy_items",
                                    List.of(Map.of("start_time", "invalid", "end_time", end.toString()))));
                            default -> rows.add(Map.of("user_id", FIRST_ID, "freebusy_items", List.of()));
                        }
                    } else if (SECOND_ID.equals(id.asText())) {
                        List<?> items = start.isBefore(busyEnd.toInstant()) && end.isAfter(busyStart.toInstant())
                                ? List.of(Map.of("start_time", busyStart.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                                        "end_time", busyEnd.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)))
                                : List.of();
                        rows.add(Map.of("user_id", SECOND_ID, "freebusy_items", items));
                    }
                }
                respond(exchange, 200, Map.of("code", 0, "data", Map.of("freebusy_lists", rows)));
                return;
            }
            respond(exchange, 404, Map.of("code", 404));
        }
    }

    private static void respond(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(value);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private void checkResponses(URI base) throws Exception {
        Map<String, String> roster = Map.of("first", FIRST, "second", SECOND, "unknown", "missing@example.test");
        Instant start = LocalDate.now(JAPAN).atTime(10, 0).atZone(JAPAN).toInstant();
        Instant end = start.plusSeconds(30 * 60);
        LarkAvailability client = new LarkAvailability(base, APP_ID, SECRET);
        Map<String, LarkAvailability.Status> normal = client.check(roster, start, end);
        if (normal.get("first") != LarkAvailability.Status.FREE || normal.get("second") != LarkAvailability.Status.BUSY
                || normal.getOrDefault("unknown", LarkAvailability.Status.UNKNOWN) != LarkAvailability.Status.UNKNOWN) {
            throw new AssertionError("Expected free, busy and unmapped fixture users");
        }
        for (Fault test : List.of(Fault.MISSING_USER, Fault.MISSING_ITEMS, Fault.INVALID_TIME, Fault.DENIED)) {
            fault = test;
            try {
                Map<String, LarkAvailability.Status> result = client.check(roster, start, end);
                if (result.getOrDefault("first", LarkAvailability.Status.UNKNOWN) != LarkAvailability.Status.UNKNOWN) {
                    throw new AssertionError("Unavailable calendar was classified despite " + test);
                }
            } catch (LarkAvailability.UnavailableException unavailable) {
                // A malformed or denied upstream response may invalidate the whole lookup.
            }
        }
        fault = Fault.EXPIRE_ONCE;
        int beforeRenewal = issuedTokens.get();
        if (client.check(roster, start, end).get("first") != LarkAvailability.Status.FREE
                || issuedTokens.get() != beforeRenewal + 1) {
            throw new AssertionError("An expired Lark token should be renewed once and the lookup retried");
        }
        System.out.println("PASS: loopback Lark mapping, free/busy, incomplete records, denied calendar access and expired token retry.");
    }

    private void checkConfiguredOpenIds(URI base) throws IOException {
        Path directory = Path.of(System.getenv("DEALHUNTER_END_TEST_ROOT"));
        Path config = Files.createTempFile(directory, "lark-test-settings-", ".json");
        String mappedEmail = "manual@dealhunter.example";
        Map<String, String> people = Map.of("manual", mappedEmail, "unmapped", SECOND);
        Instant start = LocalDate.now(JAPAN).atTime(10, 0).atZone(JAPAN).toInstant();
        Instant end = start.plusSeconds(1800);
        try {
            Map<String, String> mapping = Map.of(mappedEmail, FIRST_ID);
            JSON.writeValue(config.toFile(), Map.of("appId", APP_ID, "appSecret", SECRET, "openIds", mapping));
            int before = contactRequests.get();
            var result = LarkAvailability.fromFile(config, base).check(people, start, end);
            if (contactRequests.get() != before || result.get("manual") != LarkAvailability.Status.FREE
                    || result.getOrDefault("unmapped", LarkAvailability.Status.UNKNOWN) != LarkAvailability.Status.UNKNOWN) {
                throw new AssertionError("Manual mappings must work without contact lookup or fallback for an unregistered member");
            }

            Map<String, String> duplicate = Map.of(mappedEmail, FIRST_ID, SECOND, FIRST_ID);
            JSON.writeValue(config.toFile(), Map.of("appId", APP_ID, "appSecret", SECRET, "openIds", duplicate));
            expectUnconfigured(config, base, people, start, end);
        } finally {
            Files.deleteIfExists(config);
        }
        expectUnconfigured(config, base, people, start, end);
        System.out.println("PASS: configured Open IDs bypass directory lookup; missing mapping, duplicate IDs and absent configuration fail closed.");
    }

    private void expectUnconfigured(Path config, URI base, Map<String, String> people, Instant start, Instant end) {
        int tokensBefore = issuedTokens.get();
        try {
            LarkAvailability.fromFile(config, base).check(people, start, end);
            throw new AssertionError("The search should fail for missing or invalid calendar configuration");
        } catch (LarkAvailability.UnavailableException expected) {
            if (issuedTokens.get() != tokensBefore) throw new AssertionError("Invalid configuration should not contact Lark");
        }
    }
}
