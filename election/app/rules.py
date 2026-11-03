"""Reglas de negocio de una elección (FA-05). Documentadas en docs/reglas-negocio.md.

Estado persistido (``elections.status``) y fase derivada de la ventana de tiempo:

    draft ──open──▶ open ──close / fin de ventana──▶ closed

    fase:  draft | scheduled (open, antes de opens_at) | voting | ended (open,
           después de closes_at, a la espera del cierre automático) | closed
"""

from datetime import datetime, timedelta

from app.errors import InvalidRequest, InvalidTransition
from app.models import STATUS_CLOSED, STATUS_DRAFT, STATUS_OPEN, Election

MAX_NAME = 150
MAX_DESCRIPTION = 1000
MIN_OPTIONS = 2
MAX_OPTIONS = 100
MAX_OPTION_BYTES = 128
MIN_DURATION = timedelta(minutes=5)
MAX_DURATION = timedelta(days=31)

PHASE_DRAFT = "draft"
PHASE_SCHEDULED = "scheduled"
PHASE_VOTING = "voting"
PHASE_ENDED = "ended"
PHASE_CLOSED = "closed"


def _has_control_characters(value: str) -> bool:
    return any(ord(character) < 0x20 or 0x7F <= ord(character) < 0xA0 for character in value)


def validate_name(name: str) -> str:
    if not name or name != name.strip() or len(name) > MAX_NAME or _has_control_characters(name):
        raise InvalidRequest(f"name must be trimmed text of 1 to {MAX_NAME} characters")
    return name


def validate_description(description: str) -> str:
    if len(description) > MAX_DESCRIPTION or any(
        _has_control_characters(character) for character in description if character not in "\n\t"
    ):
        raise InvalidRequest(f"description must have at most {MAX_DESCRIPTION} characters")
    return description.strip()


def validate_options(options: list[str], blank_option: str | None) -> tuple[list[str], str | None]:
    if not MIN_OPTIONS <= len(options) <= MAX_OPTIONS:
        raise InvalidRequest(f"an election needs between {MIN_OPTIONS} and {MAX_OPTIONS} options")
    for option in options:
        if (
            not option
            or option != option.strip()
            or len(option.encode("utf-8")) > MAX_OPTION_BYTES
            or _has_control_characters(option)
        ):
            raise InvalidRequest(
                f"options must be non-empty trimmed text of at most {MAX_OPTION_BYTES} bytes"
            )
    if len(set(options)) != len(options):
        raise InvalidRequest("options must be unique")
    if blank_option is not None and blank_option not in options:
        raise InvalidRequest("blank_option must be one of the options")
    return options, blank_option


def validate_window(opens_at: datetime, closes_at: datetime, now: datetime) -> None:
    if opens_at.tzinfo is None or closes_at.tzinfo is None:
        raise InvalidRequest("dates must include a time zone")
    if closes_at <= opens_at:
        raise InvalidRequest("closes_at must be after opens_at")
    if closes_at - opens_at < MIN_DURATION:
        raise InvalidRequest(f"the voting window must last at least {MIN_DURATION}")
    if closes_at - opens_at > MAX_DURATION:
        raise InvalidRequest(f"the voting window must last at most {MAX_DURATION.days} days")
    if closes_at <= now + MIN_DURATION:
        raise InvalidRequest(f"closes_at must be at least {MIN_DURATION} in the future")


def phase(election: Election, now: datetime) -> str:
    if election.status == STATUS_DRAFT:
        return PHASE_DRAFT
    if election.status == STATUS_CLOSED:
        return PHASE_CLOSED
    if now < election.opens_at:
        return PHASE_SCHEDULED
    if now < election.closes_at:
        return PHASE_VOTING
    return PHASE_ENDED


def accepts_ballots(election: Election, now: datetime) -> bool:
    """Regla que Ballot debe aplicar con los datos de ``election.*``."""
    return phase(election, now) == PHASE_VOTING


# --- transiciones ------------------------------------------------------------


def require_editable(election: Election) -> None:
    if election.status != STATUS_DRAFT:
        raise InvalidTransition("only draft elections can be modified or deleted")


def require_can_open(election: Election, now: datetime) -> None:
    if election.status != STATUS_DRAFT:
        raise InvalidTransition(f"cannot open an election in status '{election.status}'")
    if election.closes_at <= now + MIN_DURATION:
        raise InvalidTransition("the voting window already ended; update closes_at first")


def require_can_close(election: Election) -> None:
    if election.status == STATUS_DRAFT:
        raise InvalidTransition("a draft election cannot be closed; delete it instead")


def require_closed(election: Election) -> None:
    if election.status != STATUS_CLOSED:
        raise InvalidTransition("the urn private key is only released after the election closes")


def is_open(election: Election) -> bool:
    return election.status == STATUS_OPEN
