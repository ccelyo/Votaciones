package votaciones.admin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import javax.net.ssl.SSLContext;
import java.time.Duration;

/**
 * Cliente HTTP/JSON del API Gateway (detrás del WAF).
 *
 * <p>Solo acepta rutas del catálogo público ({@code /api/...}): así la CLI no puede
 * depender de rutas internas de un servicio ni saltarse el Gateway.
 */
public class ApiClient {
    private static final Duration TIMEOUT = Duration.ofSeconds(20);
    /** Prefijo de todas las rutas públicas del Gateway. */
    public static final String API_PREFIX = "/api/";

    // HTTP/1.1: con http:// el cliente de Java intenta el upgrade a h2c y uvicorn lo rechaza con 400.
    private final HttpClient http;
    private final ObjectMapper json;
    private final String baseUrl;
    private final String accessToken;

    public ApiClient(ObjectMapper json, String baseUrl, String accessToken) {
        this(json, baseUrl, accessToken, null);
    }

    public ApiClient(ObjectMapper json, String baseUrl, String accessToken, SSLContext sslContext) {
        this.json = json;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.accessToken = accessToken;
        HttpClient.Builder builder = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(TIMEOUT);
        if (sslContext != null) {
            builder.sslContext(sslContext);
        }
        this.http = builder.build();
    }

    public JsonNode get(String path) {
        return send("GET", path, null);
    }

    public JsonNode post(String path, Object body) {
        return send("POST", path, body);
    }

    public JsonNode patch(String path, Object body) {
        return send("PATCH", path, body);
    }

    public JsonNode send(String method, String path, Object body) {
        requireCatalogPath(path);
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(TIMEOUT)
                .header("Accept", "application/json");
        if (accessToken != null) {
            request.header("Authorization", "Bearer " + accessToken);
        }
        try {
            if (body == null) {
                request.method(method, HttpRequest.BodyPublishers.noBody());
            } else {
                request.header("Content-Type", "application/json");
                request.method(method, HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body)));
            }
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            return handle(response);
        } catch (IOException error) {
            throw new UncheckedIOException("No se pudo conectar con " + baseUrl + ": " + error.getMessage(), error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Petición interrumpida", error);
        }
    }

    /**
     * Exige una ruta del catálogo: empieza por {@code /api/} y no tiene segmentos vacíos,
     * {@code .} ni {@code ..} (tampoco codificados como {@code %2e}), barras invertidas ni
     * {@code %2f}. Solo se mira la parte anterior a {@code ?}: la consulta va tal cual.
     */
    static void requireCatalogPath(String path) {
        String route = path == null ? "" : path.split("[?#]", 2)[0];
        boolean valid = route.startsWith(API_PREFIX) && !route.contains("//") && !route.contains("\\")
                && !route.toLowerCase(java.util.Locale.ROOT).contains("%2f")
                && !route.toLowerCase(java.util.Locale.ROOT).contains("%5c");
        if (valid) {
            for (String segment : route.split("/")) {
                String decoded = segment.replaceAll("(?i)%2e", ".");
                if (decoded.equals(".") || decoded.equals("..")) {
                    valid = false;
                    break;
                }
            }
        }
        if (!valid) {
            throw new IllegalArgumentException("Ruta fuera del catálogo del Gateway: " + path);
        }
    }

    private JsonNode handle(HttpResponse<String> response) throws IOException {
        String text = response.body();
        JsonNode node = text == null || text.isBlank() ? NullNode.getInstance() : parse(text);
        int status = response.statusCode();
        if (status >= 200 && status < 300) {
            return node;
        }
        JsonNode error = node.path("error");
        if (error.isObject()) {
            throw new ApiException(status, error.path("code").asText("error"), error.path("message").asText(""));
        }
        if (error.isTextual()) {
            throw new ApiException(status, error.asText(), "");
        }
        // FastAPI responde 422 con {"detail": [...]} cuando el cuerpo no cumple el esquema.
        String detail = node.has("detail") ? node.get("detail").toString() : (text == null ? "" : text);
        throw new ApiException(status, "http_" + status, detail);
    }

    private JsonNode parse(String text) {
        try {
            return json.readTree(text);
        } catch (IOException notJson) {
            return json.getNodeFactory().textNode(text);
        }
    }
}
