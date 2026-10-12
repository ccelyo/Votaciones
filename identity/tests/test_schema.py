"""Detecta deriva entre los modelos SQLAlchemy y `identity/schema.sql` (fuente de verdad).

No sustituye una prueba contra PostgreSQL real, pero falla si alguien renombra,
agrega o quita columnas/tablas en uno de los dos lados sin actualizar el otro.
"""

import re
from pathlib import Path

from app.config import Settings, normalize_database_url
from app.models import Base

SCHEMA = Path(__file__).parents[1] / "schema.sql"
TABLE = re.compile(r"CREATE TABLE (\w+) \((.*?)\n\);", re.DOTALL | re.IGNORECASE)
COLUMN = re.compile(
    r"^\s*(\w+)\s+(?:SERIAL|INTEGER|BIGINT|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|JSONB|BYTEA)\b",
    re.IGNORECASE,
)


def sql_columns() -> dict[str, set[str]]:
    tables = {}
    for name, body in TABLE.findall(SCHEMA.read_text()):
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


def test_schema_sql_keeps_the_critical_unique_constraints():
    sql = SCHEMA.read_text()
    assert "uq_issued_tokens_user_election" in sql
    assert "UNIQUE (user_id, election_id)" in sql


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
