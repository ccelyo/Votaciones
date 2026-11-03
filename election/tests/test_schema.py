"""Detecta deriva entre los modelos SQLAlchemy y ``election/schema.sql``.

``test_postgres.py`` además aplica el esquema sobre un PostgreSQL real cuando hay uno.
"""

import re
from pathlib import Path

from app.config import Settings, normalize_database_url
from app.models import Base

SCHEMA = Path(__file__).parents[1] / "schema.sql"
TABLE = re.compile(r"CREATE TABLE (\w+) \((.*?)\n\);", re.DOTALL | re.IGNORECASE)
COLUMN = re.compile(
    r"^\s*(\w+)\s+(?:SERIAL|BIGSERIAL|INTEGER|SMALLINT|BIGINT|VARCHAR|TEXT|BOOLEAN|TIMESTAMPTZ|JSONB|BYTEA|UUID)\b",
    re.IGNORECASE,
)
NAMED = re.compile(r"\b((?:ck|uq|fk|pk|ix)_\w+)")


def sql_columns() -> dict[str, set[str]]:
    return {
        name: {match.group(1) for line in body.splitlines() if (match := COLUMN.match(line))}
        for name, body in TABLE.findall(SCHEMA.read_text())
    }


def test_models_match_schema_sql_tables_and_columns():
    declared = {table.name: {column.name for column in table.columns} for table in Base.metadata.sorted_tables}
    assert declared == sql_columns()


def test_model_constraints_and_indexes_exist_in_schema_sql():
    in_sql = set(NAMED.findall(SCHEMA.read_text()))
    in_models = set()
    for table in Base.metadata.sorted_tables:
        in_models |= {c.name for c in table.constraints if c.name}
        in_models |= {i.name for i in table.indexes if i.name}
    assert in_models <= in_sql


def test_database_url_formats(monkeypatch):
    monkeypatch.delenv("ELECTION_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db:5432/elections")
    assert Settings().database_url == "postgresql+psycopg://u:p@db:5432/elections"
    assert normalize_database_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("sqlite://") == "sqlite://"
