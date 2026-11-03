import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture(scope="session")
def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


TOKEN = "test-internal-token"


@pytest.fixture
def anonymous_client(tmp_path) -> TestClient:
    """Cliente SIN cabecera X-Internal-Token."""
    return TestClient(create_app(Settings(keys_dir=tmp_path / "keys", api_key=TOKEN)))


@pytest.fixture
def client(tmp_path) -> TestClient:
    """Cliente autorizado: envía el secreto compartido en cada petición."""
    app = create_app(Settings(keys_dir=tmp_path / "keys", api_key=TOKEN))
    return TestClient(app, headers={"X-Internal-Token": TOKEN})
