package votaciones.admin.commands;

import com.fasterxml.jackson.databind.JsonNode;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import votaciones.admin.ApiClient;
import votaciones.admin.SessionStore;

import java.util.Map;

@Command(name = "login", description = "Inicia sesión (usuario, contraseña y código MFA) y guarda el JWT.")
public class LoginCommand extends AdminCommand {
    @Option(names = {"-u", "--username"}, description = "Usuario; si falta se pregunta.")
    String username;

    @Option(names = "--password-stdin", description = "Lee la contraseña de la primera línea de stdin.")
    boolean passwordStdin;

    @Option(names = "--mfa-code", description = "Código MFA; si falta se pregunta.")
    String mfaCode;

    @Override
    void run() {
        String user = username != null ? username : readLine("Usuario: ");
        String password = passwordStdin ? readLine("") : readSecret("Contraseña: ");

        ApiClient identity = cli().anonymousIdentity();
        JsonNode challenge = identity.post("/login", Map.of("username", user, "password", password));
        String code = mfaCode != null ? mfaCode : readLine("Código MFA: ");
        JsonNode session = identity.post("/login/mfa", Map.of(
                "challenge_id", challenge.path("challenge_id").asText(),
                "code", code));

        SessionStore.Saved saved = cli().sessions().save(cli().apiUrl(), session.path("access_token").asText());
        out().println("Sesión iniciada como " + saved.username() + " (" + saved.role() + ") en " + saved.apiUrl()
                + ". Expira: " + saved.expiresAt().atZone(cli().zone()).toLocalDateTime() + ".");
        if (!"admin".equals(saved.role())) {
            out().println("Aviso: este usuario no es administrador; los comandos de administración responderán 403.");
        }
    }
}
