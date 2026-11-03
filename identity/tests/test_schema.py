"""Detecta deriva entre los modelos SQLAlchemy y `identity/schema.sql` (fuente de verdad).

No sustituye una prueba contra PostgreSQL real, pero falla si alguien renombra,
agrega o quita columnas/tablas en uno de los dos lados sin actualizar el otro.
"""

import re
from pathlib import Path

from app.core.config import Settings, normalize_database_url
from app.db.census import CensusBase
from app.db.models import Base

SCHEMA = Path(__file__).parents[1] / "schema.sql"
CENSUS_SCHEMA = Path(__file__).parents[2] / "census" / "schema.sql"
TABLE = re.compile(r"CREATE TABLE (\w+) \((.*?)\n\);", re.DOTALL | re.IGNORECASE)
COLUMN = re.compile(
    r"^\s*(\w+)\s+(?:SERIAL|INTEGER|BIGINT|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|DATE|JSONB|BYTEA)\b",
    re.IGNORECASE,
)


def sql_columns(path: Path = SCHEMA) -> dict[str, set[str]]:
    tables = {}
    for name, body in TABLE.findall(path.read_text(encoding="utf-8")):
        tables[name] = {
            match.group(1)
            for line in body.splitlines()
            if (match := COLUMN.match(line))
        }
    return tables


def test_models_match_schema_sql_tables_and_columns():
    expected = sql_columns()
    declared = {
        table.name: {column.name for column in table.columns}
        for table in Base.metadata.sorted_tables
    }
    assert declared == expected


def test_census_models_match_census_schema_sql():
    declared = {
        table.name: {column.name for column in table.columns}
        for table in CensusBase.metadata.sorted_tables
    }
    assert declared == sql_columns(CENSUS_SCHEMA)


def test_census_schema_keeps_the_critical_unique_constraints():
    sql = CENSUS_SCHEMA.read_text(encoding="utf-8")
    assert "uq_issued_credentials_election_voter" in sql
    assert "UNIQUE (election_id, voter_id)" in sql


def test_census_is_independent_from_auth_and_has_no_exact_timestamps():
    sql = CENSUS_SCHEMA.read_text(encoding="utf-8").upper()
    assert "REFERENCES" not in sql  # sin claves foráneas hacia users/elections
    assert "TIMESTAMP" not in sql  # solo el día de emisión, no la hora


def test_database_url_accepts_env_example_format(monkeypatch):
    monkeypatch.delenv("IDENTITY_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:password@localhost:5432/votaciones")
    assert (
        Settings().database_url == "postgresql+psycopg://user:password@localhost:5432/votaciones"
    )


def test_normalize_database_url():
    assert normalize_database_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("postgresql+psycopg://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("sqlite:///x.db") == "sqlite:///x.db"
