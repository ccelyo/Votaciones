package votaciones.admin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Sesión del administrador en {@code <home>/session.json}: el JWT de acceso y los
 * claims que la CLI muestra. La CLI no verifica la firma (eso lo hacen identity y
 * el Gateway); solo lee {@code exp} para no enviar un token ya vencido.
 */
public class SessionStore {
    public record Saved(String apiUrl, String accessToken, String username, String role, Instant expiresAt) {
        public boolean expired(Instant now) {
            return !now.isBefore(expiresAt);
        }
    }

    private final ObjectMapper json;
    private final Path file;

    public SessionStore(ObjectMapper json, Path home) {
        this.json = json;
        this.file = home.resolve("session.json");
    }

    public Path file() {
        return file;
    }

    public Saved save(String apiUrl, String accessToken) {
        JsonNode claims = claims(accessToken);
        Saved saved = new Saved(
                apiUrl,
                accessToken,
                claims.path("username").asText(""),
                claims.path("role").asText(""),
                Instant.ofEpochSecond(claims.path("exp").asLong()));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("api_url", saved.apiUrl());
        body.put("access_token", saved.accessToken());
        body.put("username", saved.username());
        body.put("role", saved.role());
        body.put("expires_at", saved.expiresAt().getEpochSecond());
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, json.writeValueAsString(body), StandardCharsets.UTF_8);
            restrictToOwner(file);
        } catch (IOException error) {
            throw new UncheckedIOException("No se pudo guardar la sesión en " + file, error);
        }
        return saved;
    }

    public Optional<Saved> load() {
        if (!Files.exists(file)) {
            return Optional.empty();
        }
        try {
            JsonNode node = json.readTree(file.toFile());
            return Optional.of(new Saved(
                    node.path("api_url").asText(),
                    node.path("access_token").asText(),
                    node.path("username").asText(),
                    node.path("role").asText(),
                    Instant.ofEpochSecond(node.path("expires_at").asLong())));
        } catch (IOException corrupt) {
            return Optional.empty();
        }
    }

    public void clear() {
        try {
            Files.deleteIfExists(file);
        } catch (IOException error) {
            throw new UncheckedIOException("No se pudo borrar " + file, error);
        }
    }

    /** Payload del JWT sin verificar la firma. */
    JsonNode claims(String jwt) {
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) {
            throw new IllegalArgumentException("El servidor no devolvió un JWT válido");
        }
        try {
            return json.readTree(Base64.getUrlDecoder().decode(parts[1]));
        } catch (IOException | IllegalArgumentException error) {
            throw new IllegalArgumentException("El servidor no devolvió un JWT válido", error);
        }
    }

    private static void restrictToOwner(Path path) throws IOException {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException windows) {
            // En Windows el perfil del usuario ya restringe el acceso.
        }
    }
}
