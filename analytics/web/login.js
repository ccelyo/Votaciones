// Inicio de sesión del panel de analytics (email + contraseña).
"use strict";

const MESSAGES = {
  invalid_credentials: "Correo o contraseña incorrectos.",
  too_many_attempts: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.",
  storage_unavailable: "El servicio no está disponible en este momento. Inténtalo más tarde.",
};

document.querySelectorAll("[data-year]").forEach((el) => {
  el.textContent = String(new Date().getFullYear());
});

const form = document.getElementById("login-form");
const email = document.getElementById("email");
const password = document.getElementById("password");
const submit = document.getElementById("submit");
const errorBox = document.getElementById("login-error");
const toggle = document.getElementById("toggle-password");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

toggle.addEventListener("click", () => {
  const visible = password.type === "text";
  password.type = visible ? "password" : "text";
  toggle.textContent = visible ? "Mostrar" : "Ocultar";
  toggle.setAttribute("aria-pressed", String(!visible));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  if (!email.value.trim() || !email.checkValidity()) {
    showError("Escribe un correo electrónico válido.");
    email.focus();
    return;
  }
  if (!password.value) {
    showError("Escribe tu contraseña.");
    password.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = "Ingresando...";
  try {
    const response = await fetch("/dashboard/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "espivota-analytics",
      },
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    });
    if (response.ok) {
      // Conserva el enlace profundo (#/elections/...) con el que se llegó al login.
      const target = /^#\/[\w\-/%?=&.]*$/.test(window.location.hash) ? window.location.hash : "";
      window.location.replace(`/dashboard${target}`);
      return;
    }
    const body = await response.json().catch(() => ({}));
    showError(MESSAGES[body.error] ?? "No se pudo iniciar sesión.");
    password.value = "";
    password.focus();
  } catch {
    showError("No se pudo contactar el servicio de analítica.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Ingresar";
  }
});
