from app.models import Role, User
from app.security import hash_password


def create_login_user(session_factory):
    with session_factory() as session:
        role = Role(name="voter")
        session.add(role)
        session.flush()

        user = User(
            username="kevin",
            password_hash=hash_password("prueba123"),
            role_id=role.id,
            is_active=True,
        )

        session.add(user)
        session.commit()

        return user.id


def test_login_accepts_valid_credentials(client, session_factory):
    user_id = create_login_user(session_factory)

    response = client.post(
        "/login",
        json={
            "username": "kevin",
            "password": "prueba123",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "user_id": user_id,
        "roles": ["voter"],
        "mfa_required": True,
    }


def test_login_rejects_wrong_password(client, session_factory):
    create_login_user(session_factory)

    response = client.post(
        "/login",
        json={
            "username": "kevin",
            "password": "incorrecta",
        },
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_login_rejects_unknown_user(client):
    response = client.post(
        "/login",
        json={
            "username": "nadie",
            "password": "prueba123",
        },
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"