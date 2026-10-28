//! Acceso al panel web de analytics con email y contraseña.
//!
//! - Usuarios en `dashboard_users` (`_id` = email en minúsculas, hash argon2id).
//! - Sesiones en `dashboard_sessions`: el navegador guarda un token aleatorio en
//!   una cookie `HttpOnly; SameSite=Strict`; en Mongo solo se guarda su SHA-256,
//!   con índice TTL sobre `expires_at`.
//! - Tras `MAX_FAILURES` intentos fallidos seguidos, el email queda bloqueado
//!   `LOCKOUT` (en memoria, por instancia).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use bson::{DateTime as BsonDateTime, Document, doc};
use chrono::{Duration, Utc};
use mongodb::options::IndexOptions;
use mongodb::{Collection, Database, IndexModel};
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

pub const COOKIE_NAME: &str = "analytics_session";
pub const SESSION_HOURS: i64 = 8;
const MAX_FAILURES: u32 = 5;
const LOCKOUT: StdDuration = StdDuration::from_secs(5 * 60);
const MAX_EMAIL_LEN: usize = 254;
const MAX_PASSWORD_LEN: usize = 128;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DashboardUser {
    pub email: String,
    pub name: String,
}

#[derive(Debug, PartialEq)]
pub enum LoginError {
    InvalidCredentials,
    Locked,
    Storage,
}

#[derive(Default)]
struct Attempts {
    failures: u32,
    locked_until: Option<Instant>,
}

#[derive(Clone)]
pub struct Auth {
    users: Collection<Document>,
    sessions: Collection<Document>,
    attempts: Arc<Mutex<HashMap<String, Attempts>>>,
    /// Hash de referencia para que un email inexistente tarde lo mismo que uno válido.
    dummy_hash: Arc<String>,
    pub secure_cookie: bool,
}

pub fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 hash")
        .to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

impl Auth {
    pub fn new(db: &Database, secure_cookie: bool) -> Self {
        Self {
            users: db.collection("dashboard_users"),
            sessions: db.collection("dashboard_sessions"),
            attempts: Arc::default(),
            dummy_hash: Arc::new(hash_password("not-a-real-password")),
            secure_cookie,
        }
    }

    pub async fn ensure_indexes(&self) -> mongodb::error::Result<()> {
        self.sessions
            .create_index(
                IndexModel::builder()
                    .keys(doc! { "expires_at": 1 })
                    .options(
                        IndexOptions::builder()
                            .expire_after(StdDuration::ZERO)
                            .build(),
                    )
                    .build(),
            )
            .await
            .map(|_| ())
    }

    /// Crea o actualiza el usuario administrador configurado por entorno.
    pub async fn upsert_user(
        &self,
        email: &str,
        name: &str,
        password: &str,
    ) -> mongodb::error::Result<()> {
        let password = password.to_owned();
        let hash = tokio::task::spawn_blocking(move || hash_password(&password))
            .await
            .expect("hash task");
        self.users
            .update_one(
                doc! { "_id": normalize_email(email) },
                doc! {
                    "$set": { "name": name, "password_hash": hash },
                    "$setOnInsert": { "created_at": BsonDateTime::now() },
                },
            )
            .upsert(true)
            .await
            .map(|_| ())
    }

    fn locked(&self, email: &str) -> bool {
        let attempts = self.attempts.lock().expect("attempts lock");
        attempts
            .get(email)
            .and_then(|a| a.locked_until)
            .is_some_and(|until| Instant::now() < until)
    }

    fn record(&self, email: &str, success: bool) {
        let mut attempts = self.attempts.lock().expect("attempts lock");
        if success {
            attempts.remove(email);
            return;
        }
        let entry = attempts.entry(email.to_owned()).or_default();
        if entry
            .locked_until
            .is_some_and(|until| Instant::now() >= until)
        {
            *entry = Attempts::default();
        }
        entry.failures += 1;
        if entry.failures >= MAX_FAILURES {
            entry.locked_until = Some(Instant::now() + LOCKOUT);
        }
    }

    /// Verifica las credenciales y abre una sesión. Devuelve el token para la cookie.
    pub async fn login(
        &self,
        email: &str,
        password: &str,
    ) -> Result<(String, DashboardUser), LoginError> {
        let email = normalize_email(email);
        if email.is_empty()
            || email.len() > MAX_EMAIL_LEN
            || password.is_empty()
            || password.len() > MAX_PASSWORD_LEN
        {
            return Err(LoginError::InvalidCredentials);
        }
        if self.locked(&email) {
            return Err(LoginError::Locked);
        }
        let user = self
            .users
            .find_one(doc! { "_id": &email })
            .await
            .map_err(|_| LoginError::Storage)?;
        let stored = user
            .as_ref()
            .and_then(|u| u.get_str("password_hash").ok())
            .map(str::to_owned)
            .unwrap_or_else(|| self.dummy_hash.to_string());
        let password = password.to_owned();
        let valid = tokio::task::spawn_blocking(move || verify_password(&password, &stored))
            .await
            .unwrap_or(false);
        let Some(user) = user.filter(|_| valid) else {
            self.record(&email, false);
            return Err(LoginError::InvalidCredentials);
        };
        self.record(&email, true);

        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let expires = Utc::now() + Duration::hours(SESSION_HOURS);
        self.sessions
            .insert_one(doc! {
                "_id": token_hash(&token),
                "email": &email,
                "created_at": BsonDateTime::now(),
                "expires_at": BsonDateTime::from_chrono(expires),
            })
            .await
            .map_err(|_| LoginError::Storage)?;
        let name = user.get_str("name").unwrap_or(&email).to_owned();
        Ok((token, DashboardUser { email, name }))
    }

    pub async fn session_user(&self, token: &str) -> mongodb::error::Result<Option<DashboardUser>> {
        let session = self
            .sessions
            .find_one(doc! {
                "_id": token_hash(token),
                "expires_at": { "$gt": BsonDateTime::now() },
            })
            .await?;
        let Some(email) = session.as_ref().and_then(|s| s.get_str("email").ok()) else {
            return Ok(None);
        };
        let user = self.users.find_one(doc! { "_id": email }).await?;
        Ok(user.map(|u| DashboardUser {
            email: email.to_owned(),
            name: u.get_str("name").unwrap_or(email).to_owned(),
        }))
    }

    pub async fn logout(&self, token: &str) -> mongodb::error::Result<()> {
        self.sessions
            .delete_one(doc! { "_id": token_hash(token) })
            .await
            .map(|_| ())
    }

    pub fn session_cookie(&self, token: &str) -> String {
        format!(
            "{COOKIE_NAME}={token}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age={}{}",
            SESSION_HOURS * 3600,
            if self.secure_cookie { "; Secure" } else { "" }
        )
    }

    pub fn clear_cookie(&self) -> String {
        format!(
            "{COOKIE_NAME}=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0{}",
            if self.secure_cookie { "; Secure" } else { "" }
        )
    }
}

/// Extrae el token de sesión de la cabecera `Cookie`.
pub fn token_from_cookies(header: &str) -> Option<&str> {
    header
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value)
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_and_verifies_passwords() {
        let hash = hash_password("prueba123");
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("prueba123", &hash));
        assert!(!verify_password("otra", &hash));
        assert!(!verify_password("prueba123", "no-es-un-hash"));
    }

    #[test]
    fn parses_session_cookie() {
        let token = "a".repeat(64);
        let header = format!("theme=dark; {COOKIE_NAME}={token}; other=1");
        assert_eq!(token_from_cookies(&header), Some(token.as_str()));
        assert_eq!(
            token_from_cookies(&format!("{COOKIE_NAME}=../../etc")),
            None
        );
        assert_eq!(token_from_cookies("theme=dark"), None);
    }

    #[test]
    fn normalizes_email() {
        assert_eq!(
            normalize_email("  Admin@Espivota.DEV "),
            "admin@espivota.dev"
        );
    }
}
