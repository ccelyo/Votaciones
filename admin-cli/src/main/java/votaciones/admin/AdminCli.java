package votaciones.admin;

import com.fasterxml.jackson.databind.ObjectMapper;
import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.ScopeType;
import votaciones.admin.commands.ElectionsCommand;
import votaciones.admin.commands.LoginCommand;
import votaciones.admin.commands.LogoutCommand;
import votaciones.admin.commands.UsersCommand;
import votaciones.admin.commands.VotersCommand;
import votaciones.admin.commands.WhoamiCommand;

import java.io.BufferedReader;
import java.io.Console;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.io.UncheckedIOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.time.Clock;
import java.time.ZoneId;
import java.util.Map;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/**
 * CLI administrativa del sistema de votaciones.
 *
 * <p>Habla con el API Gateway usando el JWT que obtiene en {@code login}. Las consultas
 * de resultados usan la ruta anónima del Gateway, que no reenvía credenciales a ballot.
 */
@Command(
        name = "votaciones-admin",
        mixinStandardHelpOptions = true,
        version = "votaciones-admin 0.1.0",
        description = "Administración de urnas, padrón y usuarios del sistema de votaciones.",
        subcommands = {
                LoginCommand.class,
                LogoutCommand.class,
                WhoamiCommand.class,
                ElectionsCommand.class,
                VotersCommand.class,
                UsersCommand.class,
                CommandLine.HelpCommand.class,
        })
public class AdminCli {
    public static final int EXIT_API_ERROR = 1;
    public static final int EXIT_USAGE = 2;
    public static final int EXIT_NOT_LOGGED_IN = 3;

    static final String DEFAULT_API_URL = "https://localhost:8088";

    @Option(names = "--api-url", scope = ScopeType.INHERIT, paramLabel = "URL",
            description = "API Gateway (env VOTACIONES_API_URL, por defecto " + DEFAULT_API_URL + ").")
    String apiUrl;

    @Option(names = "--json", scope = ScopeType.INHERIT, description = "Imprime la respuesta JSON tal cual.")
    boolean jsonOutput;

    private final Map<String, String> env;
    private final Path home;
    private final BufferedReader in;
    private final Console console;
    private final Clock clock;
    private final ZoneId zone;
    private final ObjectMapper json = new ObjectMapper();

    public AdminCli(Map<String, String> env, Path home, BufferedReader in, Console console, Clock clock, ZoneId zone) {
        this.env = env;
        this.home = home;
        this.in = in;
        this.console = console;
        this.clock = clock;
        this.zone = zone;
    }

    public static void main(String[] args) {
        Map<String, String> env = System.getenv();
        Path home = env.containsKey("VOTACIONES_HOME")
                ? Path.of(env.get("VOTACIONES_HOME"))
                : Path.of(System.getProperty("user.home"), ".votaciones");
        BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        AdminCli cli = new AdminCli(env, home, stdin, System.console(), Clock.systemUTC(), ZoneId.systemDefault());
        // La consola de Windows no siempre es UTF-8: se respeta la codificación que reporta la JVM.
        Charset stdout = Charset.forName(System.getProperty("stdout.encoding", "UTF-8"));
        Charset stderr = Charset.forName(System.getProperty("stderr.encoding", "UTF-8"));
        System.exit(cli.execute(
                new PrintWriter(System.out, true, stdout),
                new PrintWriter(System.err, true, stderr),
                args));
    }

    public int execute(PrintWriter out, PrintWriter err, String... args) {
        CommandLine commandLine = new CommandLine(this);
        commandLine.setOut(out);
        commandLine.setErr(err);
        commandLine.setExecutionExceptionHandler((error, cmd, parseResult) -> {
            PrintWriter stderr = cmd.getErr();
            if (error instanceof NotLoggedInException) {
                stderr.println(error.getMessage());
                return EXIT_NOT_LOGGED_IN;
            }
            if (error instanceof ApiException api) {
                if (api.status() == 401) {
                    stderr.println("Sesión inválida o expirada (" + api.getMessage() + "). Ejecuta: votaciones-admin login");
                    return EXIT_NOT_LOGGED_IN;
                }
                stderr.println("Error " + api.status() + " " + api.code()
                        + (api.getMessage().isBlank() ? "" : ": " + api.getMessage()));
                return EXIT_API_ERROR;
            }
            if (error instanceof IllegalArgumentException) {
                stderr.println(error.getMessage());
                return EXIT_USAGE;
            }
            if (error instanceof UncheckedIOException || error instanceof IllegalStateException) {
                stderr.println(error.getMessage());
                return EXIT_API_ERROR;
            }
            throw error;
        });
        return commandLine.execute(args);
    }

    // --- contexto compartido por los comandos -------------------------------

    public String apiUrl() {
        return firstNonBlank(apiUrl, env.get("VOTACIONES_API_URL"), DEFAULT_API_URL).replaceAll("/+$", "");
    }

    public boolean jsonOutput() {
        return jsonOutput;
    }

    public ObjectMapper json() {
        return json;
    }

    public SessionStore sessions() {
        return new SessionStore(json, home);
    }

    public BufferedReader in() {
        return in;
    }

    public Console console() {
        return console;
    }

    public Clock clock() {
        return clock;
    }

    public ZoneId zone() {
        return zone;
    }

    /** Cliente sin sesión (login). */
    public ApiClient anonymousIdentity() {
        return apiClient(apiUrl(), null);
    }

    /** Cliente con el JWT guardado; falla si no hay sesión vigente para este servidor. */
    public ApiClient identity() {
        SessionStore.Saved saved = sessions().load()
                .orElseThrow(() -> new NotLoggedInException("No hay sesión. Ejecuta: votaciones-admin login"));
        if (!saved.apiUrl().equals(apiUrl())) {
            throw new NotLoggedInException("La sesión guardada es de " + saved.apiUrl()
                    + ", no de " + apiUrl() + ". Ejecuta: votaciones-admin login");
        }
        if (saved.expired(clock.instant())) {
            throw new NotLoggedInException("La sesión expiró. Ejecuta: votaciones-admin login");
        }
        return apiClient(apiUrl(), saved.accessToken());
    }

    /** Ruta anónima del Gateway: nunca lleva el JWT a Ballot. */
    public ApiClient ballot() {
        return apiClient(apiUrl(), null);
    }

    private ApiClient apiClient(String baseUrl, String token) {
        return new ApiClient(json, baseUrl, token, tlsContext());
    }

    private SSLContext tlsContext() {
        String caFile = env.get("VOTACIONES_TLS_CA_FILE");
        if (caFile == null || caFile.isBlank()) {
            return null;
        }
        try (InputStream input = Files.newInputStream(Path.of(caFile))) {
            var certificate = CertificateFactory.getInstance("X.509").generateCertificate(input);
            KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
            trustStore.load(null);
            trustStore.setCertificateEntry("votaciones-ca", certificate);
            TrustManagerFactory trustManagers =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            trustManagers.init(trustStore);
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustManagers.getTrustManagers(), null);
            return context;
        } catch (Exception error) {
            throw new IllegalStateException("No se pudo cargar VOTACIONES_TLS_CA_FILE: " + error.getMessage(), error);
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        throw new IllegalStateException("unreachable");
    }
}
