"""Launch Election with its configured HTTPS/mTLS listener."""

import ssl

import uvicorn

from app.config import get_settings
from app.main import app


def main() -> None:
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
