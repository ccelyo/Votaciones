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
RUN useradd --system --uid 10001 --home-dir /app identity \
    && mkdir -p /app/keys \
    && chown identity /app/keys
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY app ./app
COPY main.py schema.sql ./
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    IDENTITY_KEYS_DIR=/app/keys
# Las claves privadas se generan al primer arranque; móntalo como volumen para conservarlas.
VOLUME /app/keys
USER identity
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD ["python", "-c", "import os,ssl,urllib.request; c=ssl.create_default_context(cafile=os.environ['IDENTITY_TLS_CLIENT_CA_FILE']); c.load_cert_chain(os.environ['IDENTITY_TLS_CERT_FILE'], os.environ['IDENTITY_TLS_KEY_FILE']); urllib.request.urlopen('https://localhost:8000/health', context=c, timeout=2)"]
CMD ["python", "main.py"]
