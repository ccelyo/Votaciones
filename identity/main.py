"""Punto de entrada compatible con `uvicorn main:app`.

La aplicación vive en `app/main.py`; aquí solo se reexporta para conservar el
comando original del equipo y se ofrece un lanzador (`python main.py`).
"""

import uvicorn

from app.main import app  # noqa: F401  (reexportado para `uvicorn main:app`)


def main():
    uvicorn.run("main:app", host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
