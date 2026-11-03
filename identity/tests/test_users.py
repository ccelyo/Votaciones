from sqlalchemy import select

from app.db.models import Role
from tests.conftest import ADMIN, voter


def seed_roles(session_factory):
    with session_factory() as session:
        for name in ("admin", "voter"):
            if session.scalar(select(Role).where(Role.name == name)) is None:
                session.add(Role(name=name))
        session.commit()


def create(client, **body):
    payload = {"username": "nuevo", "password": "segura123", "role": "voter"} | body
    return client.post("/users", json=payload, headers=ADMIN)


def test_admin_creates_a_user_who_can_log_in(client, session_factory):
    seed_roles(session_factory)
    response = create(client)
    assert response.status_code == 201
    body = response.json()
    assert body["username"] == "nuevo" and body["role"] == "voter" and body["is_active"] is True
    assert "password" not in body and "password_hash" not in body

    login = client.post("/login", json={"username": "nuevo", "password": "segura123"})
    assert login.status_code == 200


def test_created_user_appears_in_directory(client, session_factory):
    seed_roles(session_factory)
    user_id = create(client, role="admin").json()["id"]
    directory = client.get("/users", headers=ADMIN).json()
    assert {"id": user_id, "username": "nuevo", "role": "admin"} in directory


def test_duplicate_username_is_409(client, session_factory):
    seed_roles(session_factory)
    assert create(client).status_code == 201
    response = create(client)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "user_already_exists"


def test_invalid_user_input_is_400(client, session_factory):
    seed_roles(session_factory)
    assert create(client, password="corta").status_code == 400
    assert create(client, role="superuser").status_code == 400
    assert create(client, username="a b").status_code == 400
    assert create(client, username="ab").status_code == 400


def test_user_management_requires_admin(client, session_factory, new_user):
    seed_roles(session_factory)
    user = voter(new_user())
    body = {"username": "x123", "password": "segura123"}
    assert client.post("/users", json=body, headers=user).status_code == 403
    assert client.patch("/users/1", json={"is_active": False}, headers=user).status_code == 403


def test_deactivated_user_cannot_log_in_and_can_be_reactivated(client, session_factory):
    seed_roles(session_factory)
    user_id = create(client).json()["id"]
    credentials = {"username": "nuevo", "password": "segura123"}

    deactivated = client.patch(f"/users/{user_id}", json={"is_active": False}, headers=ADMIN)
    assert deactivated.json()["is_active"] is False
    assert client.post("/login", json=credentials).status_code == 401

    client.patch(f"/users/{user_id}", json={"is_active": True}, headers=ADMIN)
    assert client.post("/login", json=credentials).status_code == 200


def test_unknown_user_is_404(client):
    response = client.patch("/users/999", json={"is_active": False}, headers=ADMIN)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "user_not_found"
