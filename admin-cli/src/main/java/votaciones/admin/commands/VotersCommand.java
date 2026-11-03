package votaciones.admin.commands;

import com.fasterxml.jackson.databind.JsonNode;
import picocli.CommandLine.ArgGroup;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.Parameters;
import votaciones.admin.ApiClient;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Command(
        name = "voters",
        description = "Padrón electoral de una urna.",
        subcommands = {VotersCommand.ListVoters.class, VotersCommand.Add.class, VotersCommand.Set.class})
public class VotersCommand {

    static String yesNo(JsonNode node, String field) {
        return node.path(field).asBoolean() ? "sí" : "no";
    }

    @Command(name = "list", description = "Muestra el padrón de la urna.")
    static class ListVoters extends AdminCommand {
        @Parameters(paramLabel = "ELECCIÓN")
        String electionId;

        @Override
        void run() {
            JsonNode voters = cli().identity().get(ElectionsCommand.path(electionId) + "/voters");
            if (printedAsJson(voters)) {
                return;
            }
            List<List<String>> rows = new ArrayList<>();
            for (JsonNode voter : voters) {
                rows.add(List.of(text(voter, "user_id"), yesNo(voter, "is_eligible"), yesNo(voter, "has_voted")));
            }
            if (rows.isEmpty()) {
                out().println("El padrón está vacío.");
                return;
            }
            table(List.of("USUARIO", "ELEGIBLE", "VOTÓ"), rows);
        }
    }

    @Command(name = "add", description = "Inscribe uno o varios usuarios en el padrón.")
    static class Add extends AdminCommand {
        @Parameters(index = "0", paramLabel = "ELECCIÓN")
        String electionId;

        @Parameters(index = "1..*", arity = "1..*", paramLabel = "USUARIO_ID")
        List<Integer> userIds;

        @Option(names = "--ineligible", description = "Inscribir como no elegibles.")
        boolean ineligible;

        @Override
        void run() {
            ApiClient identity = cli().identity();
            String path = ElectionsCommand.path(electionId) + "/voters";
            for (int userId : userIds) {
                JsonNode entry = identity.post(path, Map.of("user_id", userId, "is_eligible", !ineligible));
                if (!printedAsJson(entry)) {
                    out().println("Usuario " + userId + " inscrito en la urna " + electionId
                            + (ineligible ? " (no elegible)." : "."));
                }
            }
        }
    }

    @Command(name = "set", description = "Cambia la elegibilidad de un votante inscrito.")
    static class Set extends AdminCommand {
        @Parameters(index = "0", paramLabel = "ELECCIÓN")
        String electionId;

        @Parameters(index = "1", paramLabel = "USUARIO_ID")
        int userId;

        @ArgGroup(exclusive = true, multiplicity = "1")
        Eligibility eligibility;

        static class Eligibility {
            @Option(names = "--eligible", required = true)
            boolean eligible;

            @Option(names = "--ineligible", required = true)
            boolean ineligible;
        }

        @Override
        void run() {
            JsonNode entry = cli().identity().patch(
                    ElectionsCommand.path(electionId) + "/voters/" + userId,
                    Map.of("is_eligible", eligibility.eligible));
            if (!printedAsJson(entry)) {
                out().println("Usuario " + userId + " en la urna " + electionId + ": elegible "
                        + yesNo(entry, "is_eligible") + ".");
            }
        }
    }
}
