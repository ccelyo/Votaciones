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


def login_and_get_challenge(client):
    response = client.post(
        "/login",
        json={
            "username": "kevin",
            "password": "prueba123",
        },
    )

    assert response.status_code == 200
    assert response.json()["mfa_required"] is True

    return response.json()["challenge_id"]


def test_login_accepts_valid_credentials(client, session_factory):
    create_login_user(session_factory)

    response = client.post(
        "/login",
        json={
            "username": "kevin",
            "password": "prueba123",
        },
    )

    assert response.status_code == 200
    assert response.json()["mfa_required"] is True
    assert response.json()["challenge_id"]


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


def test_login_rejects_unknown_user(client):
    response = client.post(
        "/login",
        json={
            "username": "nadie",
            "password": "prueba123",
        },
    )

    assert response.status_code == 401


def test_mfa_creates_session(client, session_factory):
    create_login_user(session_factory)
    challenge_id = login_and_get_challenge(client)

    response = client.post(
        "/login/mfa",
        json={
            "challenge_id": challenge_id,
            "code": "123456",
        },
    )

    assert response.status_code == 200
    assert response.json()["access_token"]
    assert response.json()["token_type"] == "bearer"


def test_mfa_rejects_wrong_code(client, session_factory):
    create_login_user(session_factory)
    challenge_id = login_and_get_challenge(client)

    response = client.post(
        "/login/mfa",
        json={
            "challenge_id": challenge_id,
            "code": "999999",
        },
    )

    assert response.status_code == 401


def test_session_authenticates_protected_endpoint(
    client,
    session_factory,
):
    create_login_user(session_factory)
    challenge_id = login_and_get_challenge(client)

    mfa = client.post(
        "/login/mfa",
        json={
            "challenge_id": challenge_id,
            "code": "123456",
        },
    )

    token = mfa.json()["access_token"]

    response = client.get(
        "/elections/999/parameters",
        headers={
            "Authorization": f"Bearer {token}",
        },
    )

    # 404 demuestra que la autenticación sí pasó.
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "election_not_found"


def test_current_user_returns_username_and_role(client, session_factory):
    user_id = create_login_user(session_factory)
    challenge_id = login_and_get_challenge(client)
    mfa = client.post(
        "/login/mfa",
        json={"challenge_id": challenge_id, "code": "123456"},
    )
    token = mfa.json()["access_token"]

    response = client.get(
        "/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": user_id,
        "username": "kevin",
        "role": "voter",
    }


def test_logout_revokes_the_current_session(client, session_factory):
    create_login_user(session_factory)
    challenge_id = login_and_get_challenge(client)
    mfa = client.post(
        "/login/mfa",
        json={"challenge_id": challenge_id, "code": "123456"},
    )
    token = mfa.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    logout = client.post("/logout", headers=headers)

    assert logout.status_code == 204
    assert client.get("/auth/me", headers=headers).status_code == 401