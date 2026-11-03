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
import java.time.Duration;

/** Cliente HTTP/JSON de identity (o del Gateway) y de la API pública de ballot. */
public class ApiClient {
    private static final Duration TIMEOUT = Duration.ofSeconds(20);

    // HTTP/1.1: con http:// el cliente de Java intenta el upgrade a h2c y uvicorn lo rechaza con 400.
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(TIMEOUT)
            .build();
    private final ObjectMapper json;
    private final String baseUrl;
    private final String accessToken;

    public ApiClient(ObjectMapper json, String baseUrl, String accessToken) {
        this.json = json;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.accessToken = accessToken;
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
