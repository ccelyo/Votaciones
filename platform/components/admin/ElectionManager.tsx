"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { ElectionResults } from "@/components/admin/ElectionResults";
import {
  Icon,
  type RemixiconComponentType,
  RiBarChartBoxLine,
  RiFileList3Line,
  RiGroupLine,
  RiSearchLine,
  RiUserAddLine,
  RiUserFollowLine,
} from "@/components/icons";
import { PageHeader } from "@/components/layout/PageHeader";
import { IconTile } from "@/components/ui/IconTile";
import {
  closeElection,
  enrollVoter,
  getElectionSummary,
  getVoterRoll,
  listAllElections,
  listUsers,
  setVoterEligibility,
} from "@/lib/api";
import { STATUS_CLASS, STATUS_LABEL } from "@/lib/election-status";
import { formatDate } from "@/lib/format";
import type {
  AdminElection,
  ElectionSummary,
  VoterRollEntry,
} from "@/lib/types/election";
import type { DirectoryUser } from "@/lib/types/user";

type Row = DirectoryUser & { entry?: VoterRollEntry };

export function ElectionManager({ electionId }: { electionId: number }) {
  const [election, setElection] = useState<AdminElection | null>(null);
  const [summary, setSummary] = useState<ElectionSummary | null>(null);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [roll, setRoll] = useState<VoterRollEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    const [elections, currentRoll, currentSummary] = await Promise.all([
      listAllElections(),
      getVoterRoll(electionId),
      getElectionSummary(electionId).catch(() => null),
    ]);
    setElection(elections.find((item) => item.id === electionId) ?? null);
    setRoll(currentRoll);
    setSummary(currentSummary);
  }, [electionId]);

  useEffect(() => {
    Promise.all([refresh(), listUsers().then(setUsers)])
      .catch((error: unknown) =>
        setLoadError(
          error instanceof Error
            ? error.message
            : "No se pudo cargar la elección.",
        ),
      )
      .finally(() => setIsLoading(false));
  }, [refresh]);

  const rows = useMemo<Row[]>(() => {
    const byUser = new Map(roll.map((entry) => [entry.user_id, entry]));
    const term = query.trim().toLowerCase();
    return users
      .filter((user) => !term || user.username.toLowerCase().includes(term))
      .map((user) => ({ ...user, entry: byUser.get(user.id) }));
  }, [users, roll, query]);

  const enrolled = roll.filter((entry) => entry.is_eligible).length;
  const voted = roll.filter((entry) => entry.has_voted).length;
  const participation = enrolled > 0 ? Math.round((voted / enrolled) * 100) : 0;
  const pendingVoters = users.filter(
    (user) =>
      user.role === "voter" && !roll.some((entry) => entry.user_id === user.id),
  );
  const isClosed = election?.status === "closed";

  function run(action: () => Promise<unknown>, successMessage: string) {
    setActionError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await action();
        await refresh();
        setNotice(successMessage);
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "No se pudo completar la acción.",
        );
      }
    });
  }

  function enrollAll() {
    run(async () => {
      for (const user of pendingVoters) {
        await enrollVoter(electionId, user.id);
      }
    }, `Se inscribieron ${pendingVoters.length} votantes.`);
  }

  const title = election?.name ?? `Elección ${electionId}`;

  return (
    <>
      <PageHeader
        eyebrow="Gestión de la elección"
        title={title}
        description={
          election?.starts_at && election.ends_at
            ? `Del ${formatDate(election.starts_at)} al ${formatDate(election.ends_at)}`
            : undefined
        }
        breadcrumbs={[
          { href: "/admin", label: "Administración" },
          { label: title },
        ]}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-4 py-8 sm:px-6 sm:py-10">
        {isLoading ? (
          <p className="text-sm text-muted" aria-live="polite">
            Cargando elección...
          </p>
        ) : loadError ? (
          <p className="alert alert-error" role="alert">
            {loadError}
          </p>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Estado" icon={RiFileList3Line}>
                {election ? (
                  <span
                    className={`badge text-sm ${STATUS_CLASS[election.status]}`}
                  >
                    {STATUS_LABEL[election.status]}
                  </span>
                ) : (
                  "—"
                )}
              </Stat>
              <Stat label="Habilitados en el padrón" icon={RiGroupLine}>
                {enrolled}
              </Stat>
              <Stat
                label="Han votado"
                icon={RiUserFollowLine}
                footer={
                  <span
                    className="block h-1.5 overflow-hidden rounded-full bg-canvas"
                    aria-hidden
                  >
                    <span
                      className="block h-full bg-royal-700"
                      style={{ width: `${participation}%` }}
                    />
                  </span>
                }
              >
                {voted}
                <span className="ml-2 text-sm font-semibold text-muted">
                  {participation} %
                </span>
              </Stat>
              <Stat label="Papeletas en la urna" icon={RiBarChartBoxLine}>
                {summary?.total_ballots ?? "—"}
              </Stat>
            </dl>

            {actionError ? (
              <p className="alert alert-error" role="alert">
                {actionError}
              </p>
            ) : notice ? (
              <output className="alert alert-success block">{notice}</output>
            ) : null}

            <section className="card" aria-labelledby="roll-h">
              <header className="flex flex-col gap-4 border-b border-line px-5 py-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 id="roll-h" className="text-lg font-bold text-ink">
                    Padrón electoral
                  </h2>
                  <p className="text-sm text-muted">
                    Solo las personas habilitadas pueden obtener su credencial y
                    votar.
                  </p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <label className="relative">
                    <span className="sr-only">Buscar usuario</span>
                    <Icon
                      icon={RiSearchLine}
                      size={18}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
                    />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Buscar usuario"
                      className="field py-2 pl-9 text-sm sm:w-56"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={enrollAll}
                    disabled={
                      isPending || isClosed || pendingVoters.length === 0
                    }
                    className="btn btn-primary btn-sm"
                  >
                    <Icon icon={RiUserAddLine} size={18} />
                    Inscribir a todos los votantes ({pendingVoters.length})
                  </button>
                </div>
              </header>

              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Usuario</th>
                      <th scope="col">Rol</th>
                      <th scope="col">Padrón</th>
                      <th scope="col">Participación</th>
                      <th scope="col">
                        <span className="sr-only">Acciones</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="font-semibold text-ink">
                          {row.username}
                        </td>
                        <td className="text-muted">
                          {row.role === "admin" ? "Administrador" : "Votante"}
                        </td>
                        <td>
                          {!row.entry ? (
                            <span className="badge bg-canvas text-muted">
                              No inscrito
                            </span>
                          ) : row.entry.is_eligible ? (
                            <span className="badge bg-success-soft text-success">
                              Habilitado
                            </span>
                          ) : (
                            <span className="badge bg-danger-soft text-danger">
                              Inhabilitado
                            </span>
                          )}
                        </td>
                        <td className="text-muted">
                          {row.entry?.has_voted ? "Votó" : "—"}
                        </td>
                        <td className="text-right">
                          {!row.entry ? (
                            <button
                              type="button"
                              disabled={isPending || isClosed}
                              onClick={() =>
                                run(
                                  () => enrollVoter(electionId, row.id),
                                  `${row.username} quedó inscrito en el padrón.`,
                                )
                              }
                              className="btn btn-secondary btn-sm"
                            >
                              Inscribir
                            </button>
                          ) : row.entry.has_voted ? null : (
                            <button
                              type="button"
                              disabled={isPending || isClosed}
                              onClick={() =>
                                run(
                                  () =>
                                    setVoterEligibility(
                                      electionId,
                                      row.id,
                                      !row.entry?.is_eligible,
                                    ),
                                  `Se actualizó la habilitación de ${row.username}.`,
                                )
                              }
                              className={`btn btn-sm ${row.entry.is_eligible ? "btn-danger" : "btn-secondary"}`}
                            >
                              {row.entry.is_eligible
                                ? "Inhabilitar"
                                : "Habilitar"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-muted">
                          No hay usuarios que coincidan con la búsqueda.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            {isClosed ? <ElectionResults electionId={electionId} /> : null}

            {!isClosed ? (
              <section
                className="card border-danger/40 p-5"
                aria-labelledby="close-h"
              >
                <h2 id="close-h" className="text-lg font-bold text-ink">
                  Cerrar la elección
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Al cerrarla no se aceptan más votos. Esta acción no se puede
                  deshacer.
                </p>
                {confirmClose ? (
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <span className="text-sm font-semibold text-danger">
                      ¿Confirmas el cierre definitivo?
                    </span>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() =>
                        run(async () => {
                          await closeElection(electionId);
                          setConfirmClose(false);
                        }, "La elección quedó cerrada.")
                      }
                      className="btn btn-danger btn-sm"
                    >
                      Sí, cerrar elección
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClose(false)}
                      className="btn btn-ghost btn-sm"
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmClose(true)}
                    className="btn btn-danger btn-sm mt-4"
                  >
                    Cerrar elección
                  </button>
                )}
              </section>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}

function Stat({
  label,
  icon,
  footer,
  children,
}: {
  label: string;
  icon: RemixiconComponentType;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <dt className="text-xs font-bold uppercase tracking-wider text-muted">
          {label}
        </dt>
        <IconTile icon={icon} size="sm" />
      </div>
      <dd className="mt-3 text-3xl font-bold text-ink">{children}</dd>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </div>
  );
}
