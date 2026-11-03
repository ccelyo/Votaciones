package votaciones.admin;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/** Servidor HTTP en memoria que responde por "MÉTODO ruta" y registra cada petición. */
final class FakeServer implements AutoCloseable {
    record Request(String method, String path, String authorization, String body) {
    }

    record Response(int status, String body) {
    }

    private final HttpServer server;
    private final Map<String, Response> routes = new ConcurrentHashMap<>();
    final List<Request> requests = new CopyOnWriteArrayList<>();

    FakeServer() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String key = exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath();
            if (exchange.getRequestHeaders().containsKey("Upgrade")) {
                // Como uvicorn: no acepta el upgrade a h2c.
                exchange.sendResponseHeaders(400, -1);
                exchange.close();
                return;
            }
            requests.add(new Request(exchange.getRequestMethod(), exchange.getRequestURI().getPath(),
                    exchange.getRequestHeaders().getFirst("Authorization"), body));
            Response response = routes.getOrDefault(key,
                    new Response(404, "{\"error\":{\"code\":\"not_found\",\"message\":\"" + key + "\"}}"));
            byte[] bytes = response.body().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            if (bytes.length == 0) {
                exchange.sendResponseHeaders(response.status(), -1);
            } else {
                exchange.sendResponseHeaders(response.status(), bytes.length);
                exchange.getResponseBody().write(bytes);
            }
            exchange.close();
        });
        server.start();
    }

    String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    FakeServer on(String methodAndPath, int status, String body) {
        routes.put(methodAndPath, new Response(status, body));
        return this;
    }

    List<Request> requestsTo(String method, String path) {
        return requests.stream().filter(r -> r.method().equals(method) && r.path().equals(path)).toList();
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
