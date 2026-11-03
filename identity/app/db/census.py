"""Modelo de Census: base PostgreSQL propia del padrón electoral.

Census es independiente de Auth: no hay claves foráneas hacia ``users`` ni hacia
``elections`` porque viven en otras bases. ``voter_id`` y ``election_id`` son
identificadores opacos (el id del usuario autenticado y el texto del id de la urna).

La fuente de verdad del esquema es ``census/schema.sql``; ``tests/test_schema.py``
falla si estos modelos dejan de coincidir.

Anonimato: ``issued_credentials`` solo guarda el DÍA de emisión, no la hora, para
que no se pueda cruzar con la hora de recepción de una papeleta en Ballot. Nunca
se guarda el mensaje cegado, la firma ni el token.
"""

from datetime import date

from sqlalchemy import Boolean, Date, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class CensusBase(DeclarativeBase):
    pass


class VoterRollEntry(CensusBase):
    """Padrón: ``voter_id`` puede votar en ``election_id`` si ``is_eligible``."""

    __tablename__ = "voter_roll"
    __table_args__ = (
        UniqueConstraint("election_id", "voter_id", name="uq_voter_roll_election_voter"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    election_id: Mapped[str] = mapped_column(String(128))
    voter_id: Mapped[str] = mapped_column(String(64))
    is_eligible: Mapped[bool] = mapped_column(Boolean, default=True)
    has_voted: Mapped[bool] = mapped_column(Boolean, default=False)


class IssuedCredential(CensusBase):
    """Registro de que un votante ya recibió su credencial anónima en una elección."""

    __tablename__ = "issued_credentials"
    __table_args__ = (
        # Restricción crítica: una credencial por votante y elección.
        UniqueConstraint("election_id", "voter_id", name="uq_issued_credentials_election_voter"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    election_id: Mapped[str] = mapped_column(String(128))
    voter_id: Mapped[str] = mapped_column(String(64))
    issued_on: Mapped[date] = mapped_column(Date, server_default=func.current_date())
