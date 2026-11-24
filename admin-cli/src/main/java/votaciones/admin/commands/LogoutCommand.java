package votaciones.admin.commands;

import picocli.CommandLine.Command;
import votaciones.admin.ApiException;
import votaciones.admin.NotLoggedInException;

@Command(name = "logout", description = "Revoca la sesión en el servidor y borra el JWT local.")
public class LogoutCommand extends AdminCommand {
    @Override
    void run() {
        try {
            cli().api().post("/api/auth/logout", null);
        } catch (NotLoggedInException | ApiException alreadyGone) {
            // Sin sesión vigente en el servidor: basta con borrar la copia local.
        } finally {
            cli().sessions().clear();
        }
        out().println("Sesión cerrada.");
    }
}
