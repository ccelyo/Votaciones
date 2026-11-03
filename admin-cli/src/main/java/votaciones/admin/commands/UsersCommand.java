package votaciones.admin.commands;

import com.fasterxml.jackson.databind.JsonNode;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.Parameters;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Command(
        name = "users",
        description = "Usuarios del sistema (administradores y votantes).",
        subcommands = {
                UsersCommand.ListUsers.class,
                UsersCommand.Create.class,
                UsersCommand.Disable.class,
                UsersCommand.Enable.class,
        })
public class UsersCommand {

    @Command(name = "list", description = "Lista los usuarios activos.")
    static class ListUsers extends AdminCommand {
        @Override
        void run() {
            JsonNode users = cli().identity().get("/users");
            if (printedAsJson(users)) {
                return;
            }
            List<List<String>> rows = new ArrayList<>();
            for (JsonNode user : users) {
                rows.add(List.of(text(user, "id"), text(user, "role"), text(user, "username")));
            }
            table(List.of("ID", "ROL", "USUARIO"), rows);
        }
    }

    @Command(name = "create", description = "Crea un usuario. La contraseña se pide sin eco o se lee de stdin.")
    static class Create extends AdminCommand {
        @Parameters(paramLabel = "USUARIO")
        String username;

        @Option(names = "--role", defaultValue = "voter", description = "admin o voter (por defecto: voter).")
        String role;

        @Option(names = "--password-stdin", description = "Lee la contraseña de la primera línea de stdin.")
        boolean passwordStdin;

        @Override
        void run() {
            String password;
            if (passwordStdin) {
                password = readLine("");
            } else {
                password = readSecret("Contraseña para " + username + ": ");
                if (!password.equals(readSecret("Repite la contraseña: "))) {
                    throw new IllegalArgumentException("Las contraseñas no coinciden");
                }
            }
            JsonNode user = cli().identity().post("/users",
                    Map.of("username", username, "password", password, "role", role));
            if (!printedAsJson(user)) {
                out().println("Usuario " + text(user, "username") + " creado con id " + text(user, "id")
                        + " (" + text(user, "role") + ").");
            }
        }
    }

    abstract static class SetActive extends AdminCommand {
        @Parameters(paramLabel = "USUARIO_ID")
        int userId;

        void setActive(boolean active) {
            JsonNode user = cli().identity().patch("/users/" + userId, Map.of("is_active", active));
            if (!printedAsJson(user)) {
                out().println("Usuario " + text(user, "username") + (active ? " activado." : " desactivado."));
            }
        }
    }

    @Command(name = "disable", description = "Desactiva un usuario: no puede iniciar sesión y pierde sus sesiones.")
    static class Disable extends SetActive {
        @Override
        void run() {
            setActive(false);
        }
    }

    @Command(name = "enable", description = "Reactiva un usuario.")
    static class Enable extends SetActive {
        @Override
        void run() {
            setActive(true);
        }
    }
}
