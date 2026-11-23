"""Punto de entrada compatible con `uvicorn main:app`.

La aplicación vive en `app/main.py`; aquí solo se reexporta para conservar el
comando original del equipo y se ofrece un lanzador (`python main.py`).
"""

import ssl
import uvicorn

from app.main import app  # noqa: F401  (reexportado para `uvicorn main:app`)
from app.core.config import get_settings


def main():
    settings = get_settings()
    tls = {}
    if settings.tls_required:
        tls = {
            "ssl_certfile": str(settings.tls_cert_file),
            "ssl_keyfile": str(settings.tls_key_file),
            "ssl_ca_certs": str(settings.tls_client_ca_file),
            "ssl_cert_reqs": ssl.CERT_REQUIRED,
        }
    uvicorn.run(app, host="0.0.0.0", port=8000, **tls)


if __name__ == "__main__":
    main()
