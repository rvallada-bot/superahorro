const form = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const loginMessage = document.getElementById("login-message");
const registerMessage = document.getElementById("register-message");
const title = document.getElementById("login-title");
const intro = document.getElementById("login-intro");

function showForm(mode) {
    const registering = mode === "register";
    form.hidden = registering;
    registerForm.hidden = !registering;
    title.textContent = registering ? "Crear cuenta" : "Bienvenido";
    intro.textContent = registering
        ? "Completa tus datos para crear tu cuenta y empezar a comparar."
        : "Inicia sesión para comparar productos y supermercados cerca de ti.";
    loginMessage.textContent = "";
    registerMessage.textContent = "";
}

async function checkExistingSession() {
    try {
        const response = await fetch("/api/session", { credentials: "same-origin" });
        if (response.ok) {
            window.location.replace("/superahorro.html");
        }
    } catch {
        loginMessage.textContent = "No se pudo conectar con el servidor. Comprueba que la aplicación esté iniciada.";
    }
}

async function submitForm(event, targetForm, message, button, endpoint, successMessage) {
    event.preventDefault();
    message.textContent = "";
    button.disabled = true;
    button.textContent = endpoint === "/api/register" ? "Creando cuenta..." : "Verificando...";

    try {
        const formData = new FormData(targetForm);
        const response = await fetch(endpoint, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(formData))
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || successMessage);
        }
        window.location.replace("/superahorro.html");
    } catch (error) {
        message.textContent = error instanceof TypeError
            ? "No se pudo conectar con el servidor. Comprueba que la aplicación esté iniciada."
            : error.message;
        button.disabled = false;
        button.textContent = endpoint === "/api/register" ? "Crear cuenta" : "Iniciar sesión";
    }
}

form.addEventListener("submit", (event) => {
    submitForm(
        event,
        form,
        loginMessage,
        document.getElementById("submit-button"),
        "/api/login",
        "No se pudo iniciar sesión."
    );
});

registerForm.addEventListener("submit", (event) => {
    submitForm(
        event,
        registerForm,
        registerMessage,
        document.getElementById("register-button"),
        "/api/register",
        "No se pudo crear la cuenta."
    );
});

document.getElementById("show-register").addEventListener("click", () => showForm("register"));
document.getElementById("show-login").addEventListener("click", () => showForm("login"));
checkExistingSession();
