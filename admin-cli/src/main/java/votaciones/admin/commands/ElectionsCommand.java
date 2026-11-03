package votaciones.admin.commands;

import com.fasterxml.jackson.databind.JsonNode;
import picocli.CommandLine.ArgGroup;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.Parameters;
import votaciones.admin.ApiClient;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Command(
        name = "elections",
        description = "Urnas: crear, abrir, cerrar, consultar estado, escrutar y ver resultados.",
        subcommands = {
                ElectionsCommand.ListElections.class,
                ElectionsCommand.Create.class,
                ElectionsCommand.Open.class,
                ElectionsCommand.Close.class,
                ElectionsCommand.Status.class,
                ElectionsCommand.Tally.class,
                ElectionsCommand.Results.class,
        })
public class ElectionsCommand {

    static String path(String electionId) {
        if (!electionId.matches("[1-9][0-9]{0,9}")) {
            throw new IllegalArgumentException("El id de la elección debe ser un entero positivo: " + electionId);
        }
        return "/elections/" + electionId;
    }

    @Command(name = "list", description = "Lista todas las urnas, las más recientes primero.")
    static class ListElections extends AdminCommand {
        @Override
        void run() {
            JsonNode elections = cli().identity().get("/elections");
            if (printedAsJson(elections)) {
                return;
            }
            List<List<String>> rows = new ArrayList<>();
            for (JsonNode election : elections) {
                rows.add(List.of(text(election, "id"), text(election, "status"), text(election, "starts_at"),
                        text(election, "ends_at"), text(election, "name")));
            }
            if (rows.isEmpty()) {
                out().println("No hay urnas.");
                return;
            }
            table(List.of("ID", "ESTADO", "APERTURA (UTC)", "CIERRE (UTC)", "NOMBRE"), rows);
        }
    }

    @Command(name = "create", description = "Crea una urna. Por defecto queda abierta; con --draft, en borrador.")
    static class Create extends AdminCommand {
        @Option(names = "--name", required = true, description = "Nombre de la elección.")
        String name;

        @Option(names = "--option", required = true, paramLabel = "OPCIÓN",
                description = "Opción de la papeleta (repetir; mínimo 2).")
        List<String> options;

        @Option(names = "--opens", defaultValue = "now", paramLabel = "FECHA",
                description = "Apertura: 'now' o ISO-8601 (2026-11-03T08:00, hora local, o con Z/offset). "
                        + "Por defecto: now.")
        String opens;

        @ArgGroup(exclusive = true, multiplicity = "1")
        Closing closing;

        static class Closing {
            @Option(names = "--closes", paramLabel = "FECHA", description = "Cierre en ISO-8601.")
            String closes;

            @Option(names = "--duration", paramLabel = "DURACIÓN", description = "Cierre relativo a la apertura: 90m, 8h, 2d.")
            String duration;
        }

        @ArgGroup(exclusive = true, multiplicity = "1")
        EncryptionKey key;

        static class EncryptionKey {
            @Option(names = "--encryption-key", paramLabel = "BASE64URL",
                    description = "Clave pública de cifrado de la elección, base64url sin relleno.")
            String base64url;

            @Option(names = "--encryption-key-file", paramLabel = "ARCHIVO",
                    description = "Archivo con la clave pública (PEM o binario); se envía en base64url.")
            Path file;
        }

        @Option(names = "--draft", description = "Crea la urna en borrador; se publica luego con 'elections open'.")
        boolean draft;

        @Override
        void run() {
            Instant opensAt = Times.parseInstant(opens, cli().clock(), cli().zone());
            Instant closesAt = closing.closes != null
                    ? Times.parseInstant(closing.closes, cli().clock(), cli().zone())
                    : opensAt.plus(Times.parseDuration(closing.duration));

            Map<String, Object> body = new LinkedHashMap<>();
            body.put("name", name.trim());
            body.put("options", options.stream().map(String::trim).toList());
            body.put("encryption_public_key", encryptionKey());
            body.put("opens_at", opensAt.getEpochSecond());
            body.put("closes_at", closesAt.getEpochSecond());
            body.put("open", !draft);

            JsonNode created = cli().identity().post("/elections", body);
            if (printedAsJson(created)) {
                return;
            }
            out().println("Urna " + text(created, "election_id") + " creada (" + text(created, "status") + ").");
            if (draft) {
                out().println("Para publicarla: votaciones-admin elections open " + text(created, "election_id"));
            }
        }

        private String encryptionKey() {
            if (key.base64url != null) {
                return key.base64url.trim();
            }
            try {
                return Base64.getUrlEncoder().withoutPadding().encodeToString(Files.readAllBytes(key.file));
            } catch (IOException error) {
                throw new UncheckedIOException("No se pudo leer " + key.file, error);
            }
        }
    }

    @Command(name = "open", description = "Abre (publica en ballot) una urna en borrador.")
    static class Open extends AdminCommand {
        @Parameters(paramLabel = "ID")
        String electionId;

        @Override
        void run() {
            JsonNode opened = cli().identity().post(path(electionId) + "/open", null);
            if (!printedAsJson(opened)) {
                out().println("Urna " + text(opened, "election_id") + ": " + text(opened, "status") + ".");
            }
        }
    }

    @Command(name = "close", description = "Cierra la urna en ballot y en identity. Es irreversible.")
    static class Close extends AdminCommand {
        @Parameters(paramLabel = "ID")
        String electionId;

        @Option(names = {"-y", "--yes"}, description = "No pedir confirmación.")
        boolean yes;

        @Override
        void run() {
            if (!confirm("Cerrar la urna " + electionId + " es irreversible. ¿Continuar?", yes)) {
                out().println("Cancelado.");
                return;
            }
            JsonNode closed = cli().identity().post(path(electionId) + "/close", null);
            if (!printedAsJson(closed)) {
                out().println("Urna " + text(closed, "election_id") + ": " + text(closed, "status") + ".");
            }
        }
    }

    @Command(name = "status", description = "Estado en identity y en ballot, y papeletas recibidas.")
    static class Status extends AdminCommand {
        @Parameters(paramLabel = "ID")
        String electionId;

        @Override
        void run() {
            JsonNode status = cli().identity().get(path(electionId) + "/status");
            if (printedAsJson(status)) {
                return;
            }
            out().println("Urna " + text(status, "election_id"));
            out().println("  identity:   " + text(status, "identity_status"));
            out().println("  ballot:     " + text(status, "ballot_status"));
            out().println("  papeletas:  " + text(status, "total_ballots"));
        }
    }

    /**
     * Escrutinio: cierra la urna si sigue abierta (con confirmación) y pide el conteo a
     * ballot, que solo lo entrega con la urna cerrada.
     */
    @Command(name = "tally", description = "Lanza el escrutinio: cierra la urna si hace falta y muestra el conteo.")
    static class Tally extends AdminCommand {
        @Parameters(paramLabel = "ID")
        String electionId;

        @Option(names = {"-y", "--yes"}, description = "Cerrar sin pedir confirmación si la urna sigue abierta.")
        boolean yes;

        @Override
        void run() {
            ApiClient identity = cli().identity();
            JsonNode status = identity.get(path(electionId) + "/status");
            boolean closed = "closed".equals(status.path("identity_status").asText())
                    && "closed".equals(status.path("ballot_status").asText());
            if (!closed) {
                if (!confirm("La urna " + electionId + " sigue abierta. Cerrarla es irreversible. ¿Cerrar y escrutar?", yes)) {
                    out().println("Cancelado: no se cerró la urna.");
                    return;
                }
                identity.post(path(electionId) + "/close", null);
                if (!cli().jsonOutput()) {
                    out().println("Urna " + electionId + " cerrada.");
                }
            }
            Results.print(this, cli().ballot().get("/v1/elections/" + electionId + "/results"));
        }
    }

    @Command(name = "results", description = "Consulta el conteo de una urna ya cerrada (API pública de ballot).")
    static class Results extends AdminCommand {
        @Parameters(paramLabel = "ID")
        String electionId;

        @Override
        void run() {
            path(electionId); // valida el id
            print(this, cli().ballot().get("/v1/elections/" + electionId + "/results"));
        }

        static void print(AdminCommand command, JsonNode results) {
            if (command.printedAsJson(results)) {
                return;
            }
            long total = results.path("total_ballots").asLong();
            long invalid = results.path("invalid_ballots").asLong();
            long valid = total - invalid;
            List<List<String>> rows = new ArrayList<>();
            for (JsonNode result : results.path("results")) {
                long votes = result.path("votes").asLong();
                String share = valid == 0 ? "-" : String.format(Locale.ROOT, "%.1f%%", 100.0 * votes / valid);
                rows.add(List.of(result.path("option").asText(), Long.toString(votes), share));
            }
            command.out().println("Resultados de la urna " + text(results, "election_id"));
            command.table(List.of("OPCIÓN", "VOTOS", "%"), rows);
            command.out().println("Papeletas: " + total + " (válidas " + valid + ", inválidas " + invalid + ")");
        }
    }

    /** Fechas y duraciones de la línea de comandos. */
    static final class Times {
        private Times() {
        }

        static Instant parseInstant(String value, java.time.Clock clock, java.time.ZoneId zone) {
            String text = value.trim();
            if (text.equalsIgnoreCase("now")) {
                return clock.instant();
            }
            try {
                return java.time.OffsetDateTime.parse(text).toInstant();
            } catch (java.time.format.DateTimeParseException withoutOffset) {
                try {
                    return java.time.LocalDateTime.parse(text).atZone(zone).toInstant();
                } catch (java.time.format.DateTimeParseException error) {
                    throw new IllegalArgumentException(
                            "Fecha inválida '" + value + "': usa 'now' o ISO-8601, p. ej. 2026-11-03T08:00");
                }
            }
        }

        static Duration parseDuration(String value) {
            String text = value.trim().toLowerCase(Locale.ROOT);
            if (text.matches("[1-9][0-9]*[mhd]")) {
                long amount = Long.parseLong(text.substring(0, text.length() - 1));
                return switch (text.charAt(text.length() - 1)) {
                    case 'm' -> Duration.ofMinutes(amount);
                    case 'h' -> Duration.ofHours(amount);
                    default -> Duration.ofDays(amount);
                };
            }
            throw new IllegalArgumentException("Duración inválida '" + value + "': usa p. ej. 90m, 8h o 2d");
        }
    }
}
