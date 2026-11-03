package votaciones.admin;

/** No hay sesión guardada válida para el servidor configurado. */
public class NotLoggedInException extends RuntimeException {
    public NotLoggedInException(String message) {
        super(message);
    }
}
