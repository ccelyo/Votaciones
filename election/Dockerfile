# syntax=docker/dockerfile:1
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

FROM python:3.13-slim
RUN useradd --system --uid 10001 --home-dir /app election \
    && mkdir -p /app/keys \
    && chown election /app/keys
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY app ./app
COPY schema.sql run.py ./
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    ELECTION_KEYS_DIR=/app/keys
# Llave de firma de parámetros y, si no se pasa ELECTION_URN_KEK, la llave maestra
# de las urnas. Móntalo como volumen para conservarlas entre reinicios.
VOLUME /app/keys
USER election
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD ["python", "-c", "import os,ssl,urllib.request; c=ssl.create_default_context(cafile=os.environ['ELECTION_TLS_CLIENT_CA_FILE']); c.load_cert_chain(os.environ['ELECTION_TLS_CERT_FILE'], os.environ['ELECTION_TLS_KEY_FILE']); urllib.request.urlopen('https://localhost:8000/health', context=c, timeout=2)"]
CMD ["python", "run.py"]
