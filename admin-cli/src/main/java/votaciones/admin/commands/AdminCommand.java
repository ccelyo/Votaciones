package votaciones.admin.commands;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import picocli.CommandLine.Model.CommandSpec;
import picocli.CommandLine.Spec;
import votaciones.admin.AdminCli;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;

/** Base de los comandos: acceso al contexto de la CLI, salida y entrada interactiva. */
abstract class AdminCommand implements Callable<Integer> {
    @Spec
    CommandSpec spec;

    @Override
    public Integer call() {
        run();
        return 0;
    }

    abstract void run();

    AdminCli cli() {
        return (AdminCli) spec.root().userObject();
    }

    PrintWriter out() {
        return spec.commandLine().getOut();
    }

    /** Con {@code --json} imprime la respuesta y devuelve true para saltarse la tabla. */
    boolean printedAsJson(JsonNode node) {
        if (!cli().jsonOutput()) {
            return false;
        }
        try {
            out().println(cli().json().writerWithDefaultPrettyPrinter().writeValueAsString(node));
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
        return true;
    }

    String readLine(String prompt) {
        out().print(prompt);
        out().flush();
        try {
            String line = cli().in().readLine();
            if (line == null) {
                throw new IllegalArgumentException("Se esperaba una respuesta en la entrada estándar");
            }
            return line.trim();
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    /** Lee un secreto sin eco si hay consola; si no (tubería, pruebas), una línea de stdin. */
    String readSecret(String prompt) {
        if (cli().console() != null) {
            char[] secret = cli().console().readPassword(prompt);
            if (secret == null) {
                throw new IllegalArgumentException("Entrada cancelada");
            }
            return new String(secret);
        }
        try {
            String line = cli().in().readLine();
            if (line == null) {
                throw new IllegalArgumentException("Se esperaba el secreto en la entrada estándar");
            }
            return line;
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    /** Confirmación para operaciones irreversibles; {@code assumeYes} viene de {@code --yes}. */
    boolean confirm(String question, boolean assumeYes) {
        if (assumeYes) {
            return true;
        }
        String answer = readLine(question + " [s/N] ").toLowerCase(Locale.ROOT);
        return answer.equals("s") || answer.equals("si") || answer.equals("sí") || answer.equals("y");
    }

    void table(List<String> headers, List<List<String>> rows) {
        int[] widths = new int[headers.size()];
        for (int column = 0; column < widths.length; column++) {
            widths[column] = headers.get(column).length();
            for (List<String> row : rows) {
                widths[column] = Math.max(widths[column], row.get(column).length());
            }
        }
        printRow(headers, widths);
        for (List<String> row : rows) {
            printRow(row, widths);
        }
    }

    private void printRow(List<String> cells, int[] widths) {
        StringBuilder line = new StringBuilder();
        for (int column = 0; column < cells.size(); column++) {
            if (column > 0) {
                line.append("  ");
            }
            String cell = cells.get(column);
            line.append(column == cells.size() - 1 ? cell : String.format("%-" + widths[column] + "s", cell));
        }
        out().println(line);
    }

    static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isMissingNode() || value.isNull() ? "-" : value.asText();
    }
}
