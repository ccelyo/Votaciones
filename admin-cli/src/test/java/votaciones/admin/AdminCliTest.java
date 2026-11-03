package votaciones.admin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.PrintWriter;
import java.io.StringReader;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AdminCliTest {
    static final Instant NOW = Instant.parse("2026-11-02T15:00:00Z");
    static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path home;

    FakeServer identity;
    FakeServer ballot;

    record Result(int exit, String out, String err) {
    }

    @BeforeEach
    void start() {
        identity = new FakeServer();
        ballot = new FakeServer();
    }

    @AfterEach
    void stop() {
        identity.close();
        ballot.close();
    }

    Result runWithInput(String stdin, String... args) {
        Map<String, String> env = Map.of(
                "VOTACIONES_API_URL", identity.url(),
                "VOTACIONES_BALLOT_URL", ballot.url());
        AdminCli cli = new AdminCli(env, home, new BufferedReader(new StringReader(stdin)), null,
                Clock.fixed(NOW, ZoneOffset.UTC), ZoneId.of("America/Bogota"));
        StringWriter out = new StringWriter();
        StringWriter err = new StringWriter();
        int exit = cli.execute(new PrintWriter(out, true), new PrintWriter(err, true), args);
        return new Result(exit, out.toString(), err.toString());
    }

    Result run(String... args) {
        return runWithInput("", args);
    }

    static String jwt(String username, String role, Instant expiresAt) {
        Base64.Encoder b64 = Base64.getUrlEncoder().withoutPadding();
        String header = b64.encodeToString("{\"alg\":\"RS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = b64.encodeToString(("{\"sub\":\"1\",\"username\":\"" + username + "\",\"role\":\"" + role
                + "\",\"exp\":" + expiresAt.getEpochSecond() + "}").getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + ".firma";
    }

    /** Sesión ya guardada, como tras un login. */
    String loggedIn() {
        String token = jwt("admin1", "admin", NOW.plusSeconds(3600));
        new SessionStore(JSON, home).save(identity.url(), token);
        return token;
    }

    static JsonNode body(FakeServer.Request request) throws Exception {
        return JSON.readTree(request.body());
    }

    // --- autenticación -------------------------------------------------------

    @Test
    void loginRunsPasswordAndMfaStepsAndStoresTheJwt() throws Exception {
        String token = jwt("admin1", "admin", NOW.plusSeconds(3600));
        identity.on("POST /login", 200, "{\"mfa_required\":true,\"challenge_id\":\"ch-1\"}")
                .on("POST /login/mfa", 200, "{\"access_token\":\"" + token + "\",\"token_type\":\"bearer\",\"expires_in\":3600}")
                .on("GET /auth/me", 200, "{\"id\":1,\"username\":\"admin1\",\"role\":\"admin\"}");

        Result login = runWithInput("prueba123\n", "login", "-u", "admin1", "--password-stdin", "--mfa-code", "123456");

        assertEquals(0, login.exit(), login.err());
        assertTrue(login.out().contains("Sesión iniciada como admin1 (admin)"), login.out());
        JsonNode credentials = body(identity.requestsTo("POST", "/login").get(0));
        assertEquals("admin1", credentials.get("username").asText());
        assertEquals("prueba123", credentials.get("password").asText());
        JsonNode mfa = body(identity.requestsTo("POST", "/login/mfa").get(0));
        assertEquals("ch-1", mfa.get("challenge_id").asText());
        assertEquals("123456", mfa.get("code").asText());

        Result whoami = run("whoami");
        assertEquals(0, whoami.exit(), whoami.err());
        assertEquals("Bearer " + token, identity.requestsTo("GET", "/auth/me").get(0).authorization());
    }

    @Test
    void loginPromptsForMissingValues() {
        identity.on("POST /login", 200, "{\"challenge_id\":\"ch-1\"}")
                .on("POST /login/mfa", 200, "{\"access_token\":\"" + jwt("v1", "voter", NOW.plusSeconds(60)) + "\"}");

        Result login = runWithInput("v1\nclave\n654321\n", "login");

        assertEquals(0, login.exit(), login.err());
        assertTrue(login.out().contains("no es administrador"), login.out());
    }

    @Test
    void wrongCredentialsExitWithTheServerError() {
        identity.on("POST /login", 401, "{\"error\":{\"code\":\"unauthenticated\",\"message\":\"invalid username or password\"}}");

        Result login = runWithInput("mala\n", "login", "-u", "admin1", "--password-stdin", "--mfa-code", "123456");

        assertEquals(AdminCli.EXIT_NOT_LOGGED_IN, login.exit());
        assertTrue(login.err().contains("invalid username or password"), login.err());
        assertFalse(Files.exists(home.resolve("session.json")));
    }

    @Test
    void commandsWithoutSessionAskToLogIn() {
        Result result = run("elections", "list");
        assertEquals(AdminCli.EXIT_NOT_LOGGED_IN, result.exit());
        assertTrue(result.err().contains("votaciones-admin login"));
        assertTrue(identity.requests.isEmpty());
    }

    @Test
    void expiredSessionIsNotSent() {
        new SessionStore(JSON, home).save(identity.url(), jwt("admin1", "admin", NOW.minusSeconds(1)));
        Result result = run("elections", "list");
        assertEquals(AdminCli.EXIT_NOT_LOGGED_IN, result.exit());
        assertTrue(result.err().contains("expiró"));
        assertTrue(identity.requests.isEmpty());
    }

    @Test
    void sessionForAnotherServerIsNotSent() {
        new SessionStore(JSON, home).save("http://otro:8000", jwt("admin1", "admin", NOW.plusSeconds(60)));
        assertEquals(AdminCli.EXIT_NOT_LOGGED_IN, run("elections", "list").exit());
        assertTrue(identity.requests.isEmpty());
    }

    @Test
    void serverRejectingTheTokenMeansLoggedOut() {
        loggedIn();
        identity.on("GET /elections", 401, "{\"error\":{\"code\":\"unauthenticated\",\"message\":\"invalid or expired session\"}}");
        assertEquals(AdminCli.EXIT_NOT_LOGGED_IN, run("elections", "list").exit());
    }

    @Test
    void logoutRevokesAndDeletesTheSession() {
        String token = loggedIn();
        identity.on("POST /logout", 204, "");

        Result result = run("logout");

        assertEquals(0, result.exit(), result.err());
        assertEquals("Bearer " + token, identity.requestsTo("POST", "/logout").get(0).authorization());
        assertFalse(Files.exists(home.resolve("session.json")));
    }

    // --- urnas ----------------------------------------------------------------

    @Test
    void listElectionsPrintsATable() {
        loggedIn();
        identity.on("GET /elections", 200, "[{\"id\":2,\"name\":\"Consejo\",\"status\":\"open\","
                + "\"starts_at\":\"2026-11-02T13:00:00+00:00\",\"ends_at\":\"2026-11-02T21:00:00+00:00\"}]");

        Result result = run("elections", "list");

        assertEquals(0, result.exit(), result.err());
        assertTrue(result.out().contains("ESTADO"), result.out());
        assertTrue(result.out().lines().anyMatch(line -> line.startsWith("2 ") && line.endsWith("Consejo")), result.out());
    }

    @Test
    void createDraftElectionSendsTheAgreedBody() throws Exception {
        loggedIn();
        identity.on("POST /elections", 201, "{\"election_id\":\"7\",\"status\":\"draft\"}");

        Result result = run("elections", "create", "--name", "Consejo 2026", "--option", "Alpha",
                "--option", "Beta", "--opens", "2026-11-03T08:00", "--duration", "8h",
                "--encryption-key", "cHVibGlj", "--draft");

        assertEquals(0, result.exit(), result.err());
        JsonNode sent = body(identity.requestsTo("POST", "/elections").get(0));
        long opensAt = Instant.parse("2026-11-03T13:00:00Z").getEpochSecond(); // 08:00 en Bogotá
        assertEquals("Consejo 2026", sent.get("name").asText());
        assertEquals("[\"Alpha\",\"Beta\"]", sent.get("options").toString());
        assertEquals("cHVibGlj", sent.get("encryption_public_key").asText());
        assertEquals(opensAt, sent.get("opens_at").asLong());
        assertEquals(opensAt + 8 * 3600, sent.get("closes_at").asLong());
        assertFalse(sent.get("open").asBoolean());
        assertTrue(result.out().contains("elections open 7"), result.out());
    }

    @Test
    void createReadsTheEncryptionKeyFromAFile() throws Exception {
        loggedIn();
        identity.on("POST /elections", 201, "{\"election_id\":\"8\",\"status\":\"open\"}");
        Path key = Files.write(home.resolve("key.pem"), new byte[] {(byte) 0xfb, (byte) 0xff});

        Result result = run("elections", "create", "--name", "X", "--option", "A", "--option", "B",
                "--closes", "2026-11-02T20:00:00Z", "--encryption-key-file", key.toString());

        assertEquals(0, result.exit(), result.err());
        JsonNode sent = body(identity.requestsTo("POST", "/elections").get(0));
        assertEquals("-_8", sent.get("encryption_public_key").asText());
        assertEquals(NOW.getEpochSecond(), sent.get("opens_at").asLong());
        assertTrue(sent.get("open").asBoolean());
    }

    @Test
    void createRejectsBadDatesBeforeCallingTheServer() {
        loggedIn();
        Result result = run("elections", "create", "--name", "X", "--option", "A", "--option", "B",
                "--closes", "mañana", "--encryption-key", "a");
        assertEquals(AdminCli.EXIT_USAGE, result.exit());
        assertTrue(identity.requests.isEmpty());
    }

    @Test
    void openPublishesADraft() {
        loggedIn();
        identity.on("POST /elections/7/open", 200, "{\"election_id\":\"7\",\"status\":\"open\"}");
        Result result = run("elections", "open", "7");
        assertEquals(0, result.exit(), result.err());
        assertTrue(result.out().contains("Urna 7: open."), result.out());
    }

    @Test
    void closeAsksForConfirmation() {
        loggedIn();
        identity.on("POST /elections/7/close", 200, "{\"election_id\":\"7\",\"status\":\"closed\"}");

        Result declined = runWithInput("n\n", "elections", "close", "7");
        assertEquals(0, declined.exit());
        assertTrue(identity.requestsTo("POST", "/elections/7/close").isEmpty());

        Result confirmed = runWithInput("s\n", "elections", "close", "7");
        assertEquals(0, confirmed.exit(), confirmed.err());
        assertEquals(1, identity.requestsTo("POST", "/elections/7/close").size());

        assertEquals(0, run("elections", "close", "7", "--yes").exit());
        assertEquals(2, identity.requestsTo("POST", "/elections/7/close").size());
    }

    @Test
    void apiErrorsAreReportedWithTheirCode() {
        loggedIn();
        identity.on("POST /elections/7/open", 409,
                "{\"error\":{\"code\":\"election_closed\",\"message\":\"a closed election cannot be reopened\"}}");

        Result result = run("elections", "open", "7");

        assertEquals(AdminCli.EXIT_API_ERROR, result.exit());
        assertTrue(result.err().contains("409 election_closed"), result.err());
    }

    @Test
    void malformedElectionIdIsRejectedLocally() {
        loggedIn();
        assertEquals(AdminCli.EXIT_USAGE, run("elections", "status", "../users").exit());
        assertTrue(identity.requests.isEmpty());
    }

    // --- escrutinio ------------------------------------------------------------

    static final String RESULTS = "{\"election_id\":\"7\",\"total_ballots\":4,\"invalid_ballots\":1,"
            + "\"results\":[{\"option\":\"Alpha\",\"votes\":2},{\"option\":\"Beta\",\"votes\":1}]}";

    @Test
    void tallyClosesAnOpenElectionAndCountsWithoutSendingTheJwtToBallot() {
        loggedIn();
        identity.on("GET /elections/7/status", 200,
                        "{\"election_id\":\"7\",\"identity_status\":\"open\",\"ballot_status\":\"open\",\"total_ballots\":4}")
                .on("POST /elections/7/close", 200, "{\"election_id\":\"7\",\"status\":\"closed\"}");
        ballot.on("GET /v1/elections/7/results", 200, RESULTS);

        Result result = run("elections", "tally", "7", "--yes");

        assertEquals(0, result.exit(), result.err());
        assertEquals(1, identity.requestsTo("POST", "/elections/7/close").size());
        FakeServer.Request count = ballot.requestsTo("GET", "/v1/elections/7/results").get(0);
        assertNull(count.authorization(), "ballot no debe recibir credenciales de identidad");
        assertTrue(result.out().contains("66.7%"), result.out());
        assertTrue(result.out().contains("Papeletas: 4 (válidas 3, inválidas 1)"), result.out());
    }

    @Test
    void tallyOfAClosedElectionDoesNotCloseAgain() {
        loggedIn();
        identity.on("GET /elections/7/status", 200,
                "{\"election_id\":\"7\",\"identity_status\":\"closed\",\"ballot_status\":\"closed\",\"total_ballots\":4}");
        ballot.on("GET /v1/elections/7/results", 200, RESULTS);

        Result result = run("elections", "tally", "7");

        assertEquals(0, result.exit(), result.err());
        assertTrue(identity.requestsTo("POST", "/elections/7/close").isEmpty());
    }

    @Test
    void declinedTallyLeavesTheElectionOpen() {
        loggedIn();
        identity.on("GET /elections/7/status", 200,
                "{\"election_id\":\"7\",\"identity_status\":\"open\",\"ballot_status\":\"open\",\"total_ballots\":0}");

        Result result = runWithInput("no\n", "elections", "tally", "7");

        assertEquals(0, result.exit());
        assertTrue(identity.requestsTo("POST", "/elections/7/close").isEmpty());
        assertTrue(ballot.requests.isEmpty());
    }

    @Test
    void resultsOfAnOpenElectionReportBallotsError() {
        ballot.on("GET /v1/elections/7/results", 409, "{\"error\":\"election_not_closed\"}");
        Result result = run("elections", "results", "7");
        assertEquals(AdminCli.EXIT_API_ERROR, result.exit());
        assertTrue(result.err().contains("election_not_closed"), result.err());
    }

    @Test
    void jsonFlagPrintsTheRawResponse() throws Exception {
        ballot.on("GET /v1/elections/7/results", 200, RESULTS);
        Result result = run("elections", "results", "7", "--json");
        assertEquals(0, result.exit(), result.err());
        assertEquals(JSON.readTree(RESULTS), JSON.readTree(result.out()));
    }

    // --- padrón y usuarios -----------------------------------------------------

    @Test
    void votersAddEnrollsEveryUser() throws Exception {
        loggedIn();
        identity.on("POST /elections/7/voters", 201, "{\"user_id\":5,\"election_id\":7,\"is_eligible\":true,\"has_voted\":false}");

        Result result = run("voters", "add", "7", "5", "6");

        assertEquals(0, result.exit(), result.err());
        var calls = identity.requestsTo("POST", "/elections/7/voters");
        assertEquals(2, calls.size());
        assertEquals(6, body(calls.get(1)).get("user_id").asInt());
        assertTrue(body(calls.get(1)).get("is_eligible").asBoolean());
    }

    @Test
    void votersSetChangesEligibility() throws Exception {
        loggedIn();
        identity.on("PATCH /elections/7/voters/5", 200, "{\"user_id\":5,\"election_id\":7,\"is_eligible\":false,\"has_voted\":false}");

        Result result = run("voters", "set", "7", "5", "--ineligible");

        assertEquals(0, result.exit(), result.err());
        assertFalse(body(identity.requestsTo("PATCH", "/elections/7/voters/5").get(0)).get("is_eligible").asBoolean());
    }

    @Test
    void usersCreateReadsThePasswordFromStdin() throws Exception {
        loggedIn();
        identity.on("POST /users", 201, "{\"id\":20,\"username\":\"votante20\",\"role\":\"voter\",\"is_active\":true}");

        Result result = runWithInput("segura123\n", "users", "create", "votante20", "--password-stdin");

        assertEquals(0, result.exit(), result.err());
        JsonNode sent = body(identity.requestsTo("POST", "/users").get(0));
        assertEquals("votante20", sent.get("username").asText());
        assertEquals("segura123", sent.get("password").asText());
        assertEquals("voter", sent.get("role").asText());
        assertTrue(result.out().contains("id 20"), result.out());
    }

    @Test
    void usersCreateRejectsMismatchedPasswords() {
        loggedIn();
        Result result = runWithInput("segura123\notra4567\n", "users", "create", "votante20");
        assertEquals(AdminCli.EXIT_USAGE, result.exit());
        assertTrue(identity.requests.isEmpty());
    }

    @Test
    void usersDisable() throws Exception {
        loggedIn();
        identity.on("PATCH /users/20", 200, "{\"id\":20,\"username\":\"votante20\",\"role\":\"voter\",\"is_active\":false}");
        Result result = run("users", "disable", "20");
        assertEquals(0, result.exit(), result.err());
        assertFalse(body(identity.requestsTo("PATCH", "/users/20").get(0)).get("is_active").asBoolean());
    }

    @Test
    void apiUrlOptionOverridesTheEnvironment() {
        Result result = run("--api-url", "http://127.0.0.1:1", "whoami");
        assertEquals(AdminCli.EXIT_NOT_LOGGED_IN, result.exit());
    }
}
