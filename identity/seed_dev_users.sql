-- Usuarios de prueba (SOLO desarrollo / demo): 4 administradores y 10 votantes.
-- Contraseña de todos: prueba123 (hash argon2id generado con app.security.hash_password).
-- Código MFA: el de IDENTITY_MFA_CODE (por defecto 123456).
-- Idempotente: si el usuario ya existe, no se modifica.

INSERT INTO users (username, password_hash, role_id)
SELECT u.username,
       '$argon2id$v=19$m=65536,t=3,p=4$rtBMd3bKSCQmlwlbeRNTHg$GZj2rgy/+mKeU0Yfn29voXZBSQ/Z/RWQ95tvLCW2xNE',
       r.id
FROM (
    VALUES
        ('admin1', 'admin'),
        ('admin2', 'admin'),
        ('admin3', 'admin'),
        ('admin4', 'admin'),
        ('votante1', 'voter'),
        ('votante2', 'voter'),
        ('votante3', 'voter'),
        ('votante4', 'voter'),
        ('votante5', 'voter'),
        ('votante6', 'voter'),
        ('votante7', 'voter'),
        ('votante8', 'voter'),
        ('votante9', 'voter'),
        ('votante10', 'voter')
) AS u(username, role)
JOIN roles r ON r.name = u.role
ON CONFLICT (username) DO NOTHING;

-- Ids asignados (útiles para inscribir votantes con POST /elections/{id}/voters).
SELECT u.id, u.username, r.name AS role
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE u.username ~ '^(admin|votante)[0-9]+$'
ORDER BY r.name, u.id;
