from app.models import Election, Role, User
from app.security import hash_password
from tests.conftest import ADMIN


def create_user_and_election(session_factory):
    with session_factory() as session:
        role = Role(name="voter")
        session.add(role)
        session.flush()

        user = User(
            username="votante1",
            password_hash=hash_password("prueba123"),
            role_id=role.id,
            is_active=True,
        )

        election = Election(
            name="Elección de prueba",
            status="open",
        )

        session.add_all([user, election])
        session.commit()

        return user.id, str(election.id)


def test_admin_can_enroll_voter(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    response = client.post(
        f"/elections/{election_id}/voters",
        json={
            "user_id": user_id,
            "is_eligible": True,
        },
        headers=ADMIN,
    )

    assert response.status_code == 201

    body = response.json()

    assert body["user_id"] == user_id
    assert body["election_id"] == election_id
    assert body["is_eligible"] is True
    assert body["has_voted"] is False


def test_admin_can_list_voters(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    client.post(
        f"/elections/{election_id}/voters",
        json={"user_id": user_id},
        headers=ADMIN,
    )

    response = client.get(
        f"/elections/{election_id}/voters",
        headers=ADMIN,
    )

    assert response.status_code == 200

    voters = response.json()

    assert len(voters) == 1
    assert voters[0]["user_id"] == user_id


def test_admin_can_disable_voter(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    client.post(
        f"/elections/{election_id}/voters",
        json={"user_id": user_id},
        headers=ADMIN,
    )

    response = client.patch(
        f"/elections/{election_id}/voters/{user_id}",
        json={"is_eligible": False},
        headers=ADMIN,
    )

    assert response.status_code == 200
    assert response.json()["is_eligible"] is False


def test_duplicate_voter_is_rejected(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    payload = {
        "user_id": user_id,
        "is_eligible": True,
    }

    assert (
        client.post(
            f"/elections/{election_id}/voters",
            json=payload,
            headers=ADMIN,
        ).status_code
        == 201
    )

    response = client.post(
        f"/elections/{election_id}/voters",
        json=payload,
        headers=ADMIN,
    )

    assert response.status_code == 400

def test_voter_can_confirm_vote(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    client.post(
        f"/elections/{election_id}/voters",
        json={"user_id": user_id},
        headers=ADMIN,
    )

    voter_headers = {
        "X-Dev-User": str(user_id),
        "X-Dev-Roles": "voter",
    }

    response = client.post(
        "/vote-confirmation",
        json={"election_id": election_id},
        headers=voter_headers,
    )

    assert response.status_code == 200
    assert response.json()["election_id"] == election_id
    assert response.json()["has_voted"] is True


def test_vote_confirmation_is_idempotent(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    client.post(
        f"/elections/{election_id}/voters",
        json={"user_id": user_id},
        headers=ADMIN,
    )

    voter_headers = {
        "X-Dev-User": str(user_id),
        "X-Dev-Roles": "voter",
    }

    first = client.post(
        "/vote-confirmation",
        json={"election_id": election_id},
        headers=voter_headers,
    )

    second = client.post(
        "/vote-confirmation",
        json={"election_id": election_id},
        headers=voter_headers,
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["has_voted"] is True


def test_non_enrolled_user_cannot_confirm_vote(client, session_factory):
    user_id, election_id = create_user_and_election(session_factory)

    voter_headers = {
        "X-Dev-User": str(user_id),
        "X-Dev-Roles": "voter",
    }

    response = client.post(
        "/vote-confirmation",
        json={"election_id": election_id},
        headers=voter_headers,
    )

    assert response.status_code == 400