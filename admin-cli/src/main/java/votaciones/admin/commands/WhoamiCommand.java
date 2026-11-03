package votaciones.admin.commands;

import com.fasterxml.jackson.databind.JsonNode;
import picocli.CommandLine.Command;

@Command(name = "whoami", description = "Muestra el usuario de la sesión actual (validada por el servidor).")
public class WhoamiCommand extends AdminCommand {
    @Override
    void run() {
        JsonNode me = cli().identity().get("/auth/me");
        if (printedAsJson(me)) {
            return;
        }
        out().println(text(me, "username") + " (id " + text(me, "id") + ", rol " + text(me, "role") + ") en "
                + cli().apiUrl());
    }
}
