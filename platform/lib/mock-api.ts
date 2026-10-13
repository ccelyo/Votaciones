import type {
  AdminElection,
  CreatedElection,
  Election,
  ElectionCreatePayload,
  ElectionEstatus,
  ElectionSummary,
  ElectionVote,
  Eligibility,
  VoterRollEntry,
} from "@/lib/types/election";
import type {
  DirectoryUser,
  LoginPayload,
  MessageResponse,
  RegisterPayload,
  User,
} from "@/lib/types/user";

const STORAGE_KEYS = {
  currentUser: "votaciones.mock.currentUser",
  registeredUsers: "votaciones.mock.registeredUsers",
  elections: "votaciones.mock.elections",
  votes: "votaciones.mock.votes",
} as const;

const FIXTURE_USERS: User[] = [
  {
    id: 1,
    email: "admin@votaciones.test",
    full_name: "Administradora Demo",
    role: "admin",
  },
  {
    id: 2,
    email: "voter@votaciones.test",
    full_name: "Usuario Demo",
    role: "voter",
  },
];

function readStored<T>(key: string, fallback: T): T {
  const value = localStorage.getItem(key);
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function getRegisteredUsers(): User[] {
  return readStored<User[]>(STORAGE_KEYS.registeredUsers, []);
}

function getElectionsFromStorage(): Election[] {
  const stored = localStorage.getItem(STORAGE_KEYS.elections);
  if (stored) {
    try {
      return JSON.parse(stored) as Election[];
    } catch {
      localStorage.removeItem(STORAGE_KEYS.elections);
    }
  }

  const now = Date.now();
  const fixtures: Election[] = [
    {
      id: 1,
      name: "Representación estudiantil",
      starts_at: new Date(now - 60 * 60 * 1000).toISOString(),
      ends_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      options: ["Candidatura A", "Candidatura B", "Voto en blanco"],
    },
    {
      id: 2,
      name: "Consejo académico",
      starts_at: new Date(now - 30 * 60 * 1000).toISOString(),
      ends_at: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      options: ["Opción 1", "Opción 2", "Voto en blanco"],
    },
  ];
  localStorage.setItem(STORAGE_KEYS.elections, JSON.stringify(fixtures));
  return fixtures;
}

export async function login(payload: LoginPayload): Promise<User> {
  const username = payload.username.trim().toLowerCase();
  if (!username || !payload.password) {
    throw new Error("Ingresa un usuario y una contraseña.");
  }

  const user = [...FIXTURE_USERS, ...getRegisteredUsers()].find(
    (candidate) =>
      candidate.email?.toLowerCase() === username ||
      candidate.username?.toLowerCase() === username,
  );
  if (!user) {
    throw new Error(
      "No existe ese usuario en el mock. Usa una cuenta demo o regístrate.",
    );
  }

  localStorage.setItem(STORAGE_KEYS.currentUser, JSON.stringify(user));
  return user;
}

export async function logout(): Promise<void> {
  localStorage.removeItem(STORAGE_KEYS.currentUser);
}

export async function register(
  payload: RegisterPayload,
): Promise<MessageResponse> {
  const email = payload.email.trim().toLowerCase();
  const users = [...FIXTURE_USERS, ...getRegisteredUsers()];
  if (users.some((user) => user.email?.toLowerCase() === email)) {
    throw new Error("Ya existe una cuenta con ese correo.");
  }

  const newUser: User = {
    id: Math.max(0, ...users.map((user) => user.id)) + 1,
    email,
    full_name: payload.full_name.trim(),
    role: "voter",
  };
  localStorage.setItem(
    STORAGE_KEYS.registeredUsers,
    JSON.stringify([...getRegisteredUsers(), newUser]),
  );
  return { message: "Cuenta de prueba creada correctamente." };
}

export async function getElections(
  status: ElectionEstatus,
): Promise<Election[]> {
  return status === "open" ? getElectionsFromStorage() : [];
}

export async function createElection(
  payload: ElectionCreatePayload,
): Promise<CreatedElection> {
  const currentUser = readStored<User | null>(STORAGE_KEYS.currentUser, null);
  if (currentUser?.role !== "admin") {
    throw new Error("Solo un administrador puede crear una elección.");
  }

  const elections = getElectionsFromStorage();
  const election: Election = {
    id: Math.max(0, ...elections.map((item) => item.id)) + 1,
    name: payload.name,
    starts_at: new Date(payload.opens_at * 1000).toISOString(),
    ends_at: new Date(payload.closes_at * 1000).toISOString(),
    created_at: new Date().toISOString(),
    options: payload.options,
  };
  localStorage.setItem(
    STORAGE_KEYS.elections,
    JSON.stringify([...elections, election]),
  );
  return { election_id: String(election.id), status: "open" };
}

export async function getElectionForVoting(
  electionId: number,
): Promise<Election | null> {
  return (
    getElectionsFromStorage().find((election) => election.id === electionId) ??
    null
  );
}

export async function getVoteForCurrentUser(
  electionId: number,
): Promise<ElectionVote | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  return (
    readStored<ElectionVote[]>(STORAGE_KEYS.votes, []).find(
      (vote) => vote.election_id === electionId && vote.user_id === user.id,
    ) ?? null
  );
}

export async function castVote(
  electionId: number,
  option: string,
): Promise<ElectionVote> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Debes iniciar sesión para votar.");

  const election = await getElectionForVoting(electionId);
  if (!election) throw new Error("No se encontró la elección.");
  if (!election.options?.includes(option)) {
    throw new Error("Selecciona una opción válida.");
  }

  const now = Date.now();
  if (
    new Date(election.starts_at).getTime() > now ||
    new Date(election.ends_at).getTime() <= now
  ) {
    throw new Error("Esta elección no está abierta para votar.");
  }

  const votes = readStored<ElectionVote[]>(STORAGE_KEYS.votes, []);
  if (
    votes.some(
      (vote) => vote.election_id === electionId && vote.user_id === user.id,
    )
  ) {
    throw new Error("Ya registraste tu voto en esta elección.");
  }

  const vote: ElectionVote = {
    election_id: electionId,
    user_id: user.id,
    option,
    created_at: new Date(now).toISOString(),
  };
  localStorage.setItem(STORAGE_KEYS.votes, JSON.stringify([...votes, vote]));
  return vote;
}

export async function getCurrentUser(): Promise<User | null> {
  return readStored<User | null>(STORAGE_KEYS.currentUser, null);
}

// ---- Administración (modo demo) --------------------------------------------

const ROLL_KEY = "votaciones.mock.roll";

function readRoll(): VoterRollEntry[] {
  return readStored<VoterRollEntry[]>(ROLL_KEY, []);
}

export async function listAllElections(): Promise<AdminElection[]> {
  const now = Date.now();
  return getElectionsFromStorage().map((election) => ({
    id: election.id,
    name: election.name,
    status: new Date(election.ends_at).getTime() > now ? "open" : "closed",
    starts_at: election.starts_at,
    ends_at: election.ends_at,
    created_at: election.created_at,
  }));
}

export async function getElectionSummary(
  electionId: number,
): Promise<ElectionSummary> {
  const votes = readStored<ElectionVote[]>(STORAGE_KEYS.votes, []);
  const [election] = (await listAllElections()).filter(
    (item) => item.id === electionId,
  );
  return {
    election_id: String(electionId),
    identity_status: election?.status ?? "closed",
    ballot_status: election?.status ?? "closed",
    total_ballots: votes.filter((vote) => vote.election_id === electionId)
      .length,
  };
}

export async function closeElection(electionId: number): Promise<void> {
  const elections = getElectionsFromStorage().map((election) =>
    election.id === electionId
      ? { ...election, ends_at: new Date().toISOString() }
      : election,
  );
  localStorage.setItem(STORAGE_KEYS.elections, JSON.stringify(elections));
}

export async function listUsers(): Promise<DirectoryUser[]> {
  return [...FIXTURE_USERS, ...getRegisteredUsers()].map((user) => ({
    id: user.id,
    username: user.username ?? user.email ?? `usuario-${user.id}`,
    role: user.role,
  }));
}

export async function getVoterRoll(
  electionId: number,
): Promise<VoterRollEntry[]> {
  const votes = readStored<ElectionVote[]>(STORAGE_KEYS.votes, []);
  return readRoll()
    .filter((entry) => entry.election_id === String(electionId))
    .map((entry) => ({
      ...entry,
      has_voted: votes.some(
        (vote) =>
          vote.election_id === electionId && vote.user_id === entry.user_id,
      ),
    }));
}

export async function enrollVoter(
  electionId: number,
  userId: number,
): Promise<void> {
  const roll = readRoll();
  if (
    roll.some(
      (entry) =>
        entry.election_id === String(electionId) && entry.user_id === userId,
    )
  ) {
    throw new Error("El usuario ya está inscrito en esta elección.");
  }
  roll.push({
    user_id: userId,
    election_id: String(electionId),
    is_eligible: true,
    has_voted: false,
  });
  localStorage.setItem(ROLL_KEY, JSON.stringify(roll));
}

export async function setVoterEligibility(
  electionId: number,
  userId: number,
  isEligible: boolean,
): Promise<void> {
  const roll = readRoll().map((entry) =>
    entry.election_id === String(electionId) && entry.user_id === userId
      ? { ...entry, is_eligible: isEligible }
      : entry,
  );
  localStorage.setItem(ROLL_KEY, JSON.stringify(roll));
}

export async function getEligibility(electionId: number): Promise<Eligibility> {
  // En el modo demo cualquier usuario con sesión puede votar.
  const vote = await getVoteForCurrentUser(electionId);
  return {
    election_id: String(electionId),
    is_eligible: true,
    has_voted: vote !== null,
    token_issued: vote !== null,
  };
}
