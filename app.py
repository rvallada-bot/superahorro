import argparse
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SUPERAHORRO_DB", ROOT / "superahorro.db")).resolve()
SEED_PATH = ROOT / "seed_data.json"
SESSION_COOKIE = "superahorro_session"
SESSION_LIFETIME = 12 * 60 * 60
PASSWORD_ITERATIONS = 310_000
COOKIE_SECURE = os.environ.get("SUPERAHORRO_COOKIE_SECURE", "").lower() in {"1", "true", "yes"}
PUBLIC_FILES = {
    "login.html",
    "login.css",
    "scripts/login.js",
    "superahorro.html",
    "superahorro.css",
    "scripts/basemaps-config.js",
    "scripts/superahorro.js",
    "scripts/advanced.js",
    "scripts/tailwind-config.js",
}
sessions = {}
login_failures = defaultdict(deque)
registration_attempts = defaultdict(deque)
state_lock = threading.Lock()


@contextmanager
def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return salt.hex(), digest.hex()


def verify_password(password, salt_hex, expected_hex):
    _, actual = hash_password(password, bytes.fromhex(salt_hex))
    return hmac.compare_digest(actual, expected_hex)


DUMMY_SALT, DUMMY_HASH = hash_password("invalid-account-placeholder")


def initialize_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                full_name TEXT NOT NULL,
                address TEXT NOT NULL DEFAULT '',
                commune TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS supermarkets (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                chain TEXT NOT NULL,
                address TEXT NOT NULL,
                commune TEXT NOT NULL DEFAULT '',
                latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
                longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
                brand_color TEXT NOT NULL,
                background_color TEXT NOT NULL,
                logo TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                brand TEXT NOT NULL,
                category TEXT NOT NULL,
                image_url TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS prices (
                supermarket_id INTEGER NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                price_clp INTEGER NOT NULL CHECK (price_clp >= 0),
                in_stock INTEGER NOT NULL CHECK (in_stock IN (0, 1)),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (supermarket_id, product_id)
            );
            CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY,
                supermarket_id INTEGER NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                price_clp INTEGER NOT NULL CHECK (price_clp >= 0),
                in_stock INTEGER NOT NULL CHECK (in_stock IN (0, 1)),
                recorded_at TEXT NOT NULL,
                UNIQUE (supermarket_id, product_id, recorded_at)
            );
            CREATE INDEX IF NOT EXISTS idx_price_history_product_date
                ON price_history(product_id, recorded_at);
            CREATE TABLE IF NOT EXISTS search_events (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
                longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_search_events_date
                ON search_events(created_at);
            """
        )
        user_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(users)")
        }
        for column in ("address", "commune", "phone", "is_admin"):
            if column not in user_columns:
                db.execute(
                    f"ALTER TABLE users ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                    if column == "is_admin"
                    else f"ALTER TABLE users ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                )

        if db.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0:
            if not SEED_PATH.exists():
                raise FileNotFoundError(f"No se encontró el catálogo inicial: {SEED_PATH}")
            seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
            db.executemany(
                """INSERT INTO supermarkets
                   (id, name, chain, address, commune, latitude, longitude,
                    brand_color, background_color, logo)
                   VALUES (:id, :name, :chain, :address, :commune, :lat, :lng,
                           :brandColor, :bgBrand, :logo)""",
                seed["stores"],
            )
            db.executemany(
                """INSERT INTO products (id, name, brand, category, image_url, unit)
                   VALUES (:id, :name, :brand, :category, :img, :unit)""",
                seed["products"],
            )
            timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            db.executemany(
                """INSERT INTO prices
                   (supermarket_id, product_id, price_clp, in_stock, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                [
                    (item["store_id"], item["product_id"], item["price"], int(item["stock"]), timestamp)
                    for item in seed["prices"]
                ],
            )

        baseline_timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        db.execute(
            """INSERT OR IGNORE INTO price_history
               (supermarket_id, product_id, price_clp, in_stock, recorded_at)
               SELECT supermarket_id, product_id, price_clp, in_stock, ?
               FROM prices""",
            (baseline_timestamp,),
        )

        demo_email = os.environ.get("SUPERAHORRO_ADMIN_EMAIL", "demo@superahorro.cl").strip().lower()
        demo_password = os.environ.get("SUPERAHORRO_ADMIN_PASSWORD", "AhorroDemo2026!")
        db.execute("UPDATE users SET is_admin = 1 WHERE email = ?", (demo_email,))
        if db.execute("SELECT 1 FROM users WHERE email = ?", (demo_email,)).fetchone() is None:
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", demo_email):
                raise ValueError("SUPERAHORRO_ADMIN_EMAIL debe ser un correo válido.")
            if len(demo_password) < 12:
                raise ValueError("SUPERAHORRO_ADMIN_PASSWORD debe tener al menos 12 caracteres.")
            salt, digest = hash_password(demo_password)
            db.execute(
                """INSERT INTO users (email, full_name, is_admin, password_salt, password_hash)
                   VALUES (?, ?, 1, ?, ?)""",
                (demo_email, "Usuario de demostración", salt, digest),
            )


def add_user(email, full_name, password, address="", commune="", phone=""):
    email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("Ingresa un correo electrónico válido.")
    if len(password) < 12:
        raise ValueError("La contraseña debe tener al menos 12 caracteres.")
    salt, digest = hash_password(password)
    with connect_db() as db:
        db.execute(
            """INSERT INTO users
               (email, full_name, address, commune, phone, password_salt, password_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                email,
                full_name.strip() or email.split("@", 1)[0],
                address.strip(),
                commune.strip(),
                phone.strip(),
                salt,
                digest,
            ),
        )


def set_user_password(email, password):
    email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("Ingresa un correo electrónico válido.")
    if len(password) < 12:
        raise ValueError("La contraseña debe tener al menos 12 caracteres.")
    salt, digest = hash_password(password)
    with connect_db() as db:
        cursor = db.execute(
            "UPDATE users SET password_salt = ?, password_hash = ? WHERE email = ?",
            (salt, digest, email),
        )
        if cursor.rowcount == 0:
            raise ValueError(f"No existe una cuenta para {email}.")
        user_id = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()["id"]
    with state_lock:
        for token, (session_user_id, _) in list(sessions.items()):
            if session_user_id == user_id:
                del sessions[token]


def set_user_admin(email, enabled):
    with connect_db() as db:
        cursor = db.execute(
            "UPDATE users SET is_admin = ? WHERE email = ?",
            (int(enabled), email.strip().lower()),
        )
        if cursor.rowcount == 0:
            raise ValueError(f"No existe una cuenta para {email}.")


class SuperAhorroHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format_string % args))

    def _send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _session_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        if not morsel:
            return None
        now = time.time()
        with state_lock:
            for token, (_, expires_at) in list(sessions.items()):
                if expires_at <= now:
                    del sessions[token]
            entry = sessions.get(morsel.value)
        if not entry:
            return None
        user_id, _ = entry
        with connect_db() as db:
            return db.execute(
                "SELECT id, email, full_name, is_admin FROM users WHERE id = ?", (user_id,)
            ).fetchone()

    def _require_session(self):
        user = self._session_user()
        if user is None:
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Inicia sesión para continuar."})
            return None
        return user

    def _same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return urlparse(origin).netloc == self.headers.get("Host")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/login.html")
            self.end_headers()
            return
        if path == "/api/session":
            user = self._session_user()
            if user is None:
                self._send_json(HTTPStatus.UNAUTHORIZED, {"authenticated": False})
            else:
                self._send_json(
                    HTTPStatus.OK,
                    {"authenticated": True, "user": {
                        "email": user["email"],
                        "name": user["full_name"],
                        "is_admin": bool(user["is_admin"]),
                    }},
                )
            return
        if path == "/api/analytics":
            user = self._require_session()
            if user is None:
                return
            query_params = parse_qs(urlparse(self.path).query)
            try:
                latitude = float(query_params["lat"][0]) if "lat" in query_params else None
                longitude = float(query_params["lng"][0]) if "lng" in query_params else None
                if (latitude is None) != (longitude is None):
                    raise ValueError
                if latitude is not None and not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    raise ValueError
            except (TypeError, ValueError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Ubicación inválida para el informe."})
                return
            with connect_db() as db:
                categories = [
                    dict(row)
                    for row in db.execute(
                        """SELECT p.category,
                                  AVG(CASE WHEN datetime(h.recorded_at) >= datetime('now', '-30 days')
                                           THEN h.price_clp END) AS recent_average,
                                  AVG(CASE WHEN datetime(h.recorded_at) < datetime('now', '-30 days')
                                           AND datetime(h.recorded_at) >= datetime('now', '-90 days')
                                           THEN h.price_clp END) AS previous_average,
                                  COUNT(DISTINCT CASE WHEN datetime(h.recorded_at) >= datetime('now', '-30 days')
                                                      THEN date(h.recorded_at) END) AS recent_days,
                                  COUNT(DISTINCT CASE WHEN datetime(h.recorded_at) < datetime('now', '-30 days')
                                                      AND datetime(h.recorded_at) >= datetime('now', '-90 days')
                                                      THEN date(h.recorded_at) END) AS previous_days
                           FROM price_history h
                           JOIN products p ON p.id = h.product_id
                           JOIN supermarkets s ON s.id = h.supermarket_id
                           WHERE (? IS NULL OR (ABS(s.latitude - ?) <= 0.06
                                                AND ABS(s.longitude - ?) <= 0.075))
                           GROUP BY p.category ORDER BY p.category""",
                        (latitude, latitude, longitude),
                    )
                ]
                product_id = query_params.get("product_id", [None])[0]
                product_history = []
                if product_id:
                    try:
                        product_id = int(product_id)
                    except ValueError:
                        self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Producto inválido."})
                        return
                    if product_id < 1 or product_id > 2147483647:
                        self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Producto inválido."})
                        return
                    product_history = [
                        dict(row)
                        for row in db.execute(
                            """SELECT h.recorded_at, h.price_clp, s.name AS store_name
                               FROM price_history h JOIN supermarkets s ON s.id = h.supermarket_id
                               WHERE h.product_id = ? AND datetime(h.recorded_at) >= datetime('now', '-90 days')
                               ORDER BY h.recorded_at, s.name""",
                            (product_id,),
                        )
                    ]

                admin_data = None
                if user["is_admin"]:
                    heatmap = [
                        dict(row)
                        for row in db.execute(
                            """SELECT ROUND(latitude, 2) AS lat, ROUND(longitude, 2) AS lng,
                                      COUNT(*) AS searches
                               FROM search_events
                               WHERE datetime(created_at) >= datetime('now', '-30 days')
                               GROUP BY ROUND(latitude, 2), ROUND(longitude, 2)
                               ORDER BY searches DESC LIMIT 500"""
                        )
                    ]
                    competitiveness = [
                        dict(row)
                        for row in db.execute(
                            """SELECT s.chain, p.category, ROUND(AVG(pr.price_clp), 0) AS average_price,
                                      COUNT(*) AS products_count
                               FROM prices pr
                               JOIN supermarkets s ON s.id = pr.supermarket_id
                               JOIN products p ON p.id = pr.product_id
                               WHERE pr.in_stock = 1
                               GROUP BY s.chain, p.category
                               ORDER BY p.category, average_price"""
                        )
                    ]
                    admin_data = {"heatmap": heatmap, "competitiveness": competitiveness}

            inflation = []
            for row in categories:
                previous = row["previous_average"]
                recent = row["recent_average"]
                change = round((recent - previous) / previous * 100, 1) if previous and recent is not None else None
                inflation.append({
                    "category": row["category"],
                    "change_percent": change,
                    "enough_history": bool(row["recent_days"] and row["previous_days"]),
                })
            self._send_json(
                HTTPStatus.OK,
                {
                    "price_history": product_history,
                    "inflation": inflation,
                    "admin": admin_data,
                    "history_notice": "El historial empieza cuando se activó el registro; no se reconstruyen precios anteriores.",
                },
            )
            return
        if path == "/api/catalog":
            user = self._require_session()
            if user is None:
                return
            with connect_db() as db:
                observed_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
                db.execute(
                    """INSERT INTO price_history
                       (supermarket_id, product_id, price_clp, in_stock, recorded_at)
                       SELECT pr.supermarket_id, pr.product_id, pr.price_clp, pr.in_stock, ?
                       FROM prices pr
                       WHERE NOT EXISTS (
                           SELECT 1 FROM price_history h
                           WHERE h.supermarket_id = pr.supermarket_id
                             AND h.product_id = pr.product_id
                             AND h.id = (
                                 SELECT latest.id FROM price_history latest
                                 WHERE latest.supermarket_id = pr.supermarket_id
                                   AND latest.product_id = pr.product_id
                                 ORDER BY datetime(latest.recorded_at) DESC, latest.id DESC LIMIT 1
                             )
                             AND h.price_clp = pr.price_clp
                             AND h.in_stock = pr.in_stock
                       )""",
                    (observed_at,),
                )
                stores = [
                    dict(row)
                    for row in db.execute(
                        """SELECT id, name, chain, latitude AS lat, longitude AS lng, address,
                                  brand_color AS brandColor, background_color AS bgBrand, logo
                           FROM supermarkets ORDER BY id"""
                    )
                ]
                products = [
                    dict(row)
                    for row in db.execute(
                        """SELECT id, name, brand, category, image_url AS img, unit
                           FROM products ORDER BY id"""
                    )
                ]
                inventory = {
                    f"{row['supermarket_id']}_{row['product_id']}": {
                        "price": row["price_clp"],
                        "stock": bool(row["in_stock"]),
                    }
                    for row in db.execute(
                        "SELECT supermarket_id, product_id, price_clp, in_stock FROM prices"
                    )
                }
            self._send_json(
                HTTPStatus.OK,
                {
                    "stores": stores,
                    "products": products,
                    "inventory": inventory,
                    "user": {
                        "email": user["email"],
                        "name": user["full_name"],
                        "is_admin": bool(user["is_admin"]),
                    },
                },
            )
            return
        if path == "/superahorro.html":
            if self._session_user() is None:
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", "/login.html")
                self.end_headers()
                return
        if path == "/login.html" and self._session_user() is not None:
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/superahorro.html")
            self.end_headers()
            return
        if path.lstrip("/") not in PUBLIC_FILES:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path == "/superahorro.html" and self._session_user() is None:
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/login.html")
            self.end_headers()
            return
        if path in {"/", "/login.html"}:
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", "GET")
            self.end_headers()
            return
        if path.lstrip("/") not in PUBLIC_FILES:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_HEAD()

    def end_headers(self):
        if urlparse(self.path).path == "/superahorro.html":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in {
            "/api/login", "/api/logout", "/api/register",
            "/api/search-events",
        }:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Recurso no encontrado."})
            return
        if not self._same_origin():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Solicitud de origen no permitido."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Solicitud inválida."})
            return
        if length <= 0 or length > 16384:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Solicitud inválida."})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "El contenido enviado no es válido."})
            return
        if not isinstance(payload, dict):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "El contenido enviado no es válido."})
            return

        if path == "/api/search-events":
            user = self._require_session()
            if user is None:
                return
            try:
                product_id = payload.get("product_id")
                latitude = float(payload.get("latitude"))
                longitude = float(payload.get("longitude"))
            except (TypeError, ValueError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Producto o ubicación inválidos."})
                return
            if isinstance(product_id, bool) or not isinstance(product_id, int) or not 1 <= product_id <= 2147483647:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Producto inválido."})
                return
            with connect_db() as db:
                product_exists = db.execute(
                    "SELECT 1 FROM products WHERE id = ?", (product_id,)
                ).fetchone()
                if not product_exists or not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Producto o ubicación fuera de rango."})
                    return
                db.execute(
                    """INSERT INTO search_events (user_id, product_id, latitude, longitude)
                       VALUES (?, ?, ?, ?)""",
                    (user["id"], product_id, round(latitude, 2), round(longitude, 2)),
                )
            self._send_json(HTTPStatus.CREATED, {"ok": True})
            return

        if path == "/api/register":
            remote_address = self.client_address[0]
            now = time.time()
            with state_lock:
                attempts = registration_attempts[remote_address]
                while attempts and attempts[0] <= now - 60:
                    attempts.popleft()
                if len(attempts) >= 5:
                    self._send_json(
                        HTTPStatus.TOO_MANY_REQUESTS,
                        {"error": "Demasiados intentos de registro. Espera un minuto e inténtalo nuevamente."},
                    )
                    return
                attempts.append(now)

            fields = {
                "name": ("nombre", 120),
                "address": ("dirección", 240),
                "commune": ("comuna", 120),
                "phone": ("teléfono", 40),
                "email": ("correo electrónico", 254),
            }
            values = {}
            for key, (label, maximum) in fields.items():
                value = payload.get(key)
                if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": f"Ingresa un(a) {label} válido(a) (máximo {maximum} caracteres)."},
                    )
                    return
                values[key] = value.strip()

            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", values["email"]):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Ingresa un correo electrónico válido."})
                return
            phone_digits = re.sub(r"\D", "", values["phone"])
            if not 8 <= len(phone_digits) <= 15:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "El teléfono debe tener entre 8 y 15 dígitos."},
                )
                return
            password = payload.get("password")
            if not isinstance(password, str) or len(password) < 12 or len(password) > 1024:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "La contraseña debe tener entre 12 y 1024 caracteres."},
                )
                return

            try:
                add_user(
                    values["email"],
                    values["name"],
                    password,
                    values["address"],
                    values["commune"],
                    values["phone"],
                )
            except sqlite3.IntegrityError:
                self._send_json(
                    HTTPStatus.CONFLICT,
                    {"error": "Ya existe una cuenta con ese correo electrónico. Inicia sesión."},
                )
                return

            with connect_db() as db:
                user = db.execute(
                    "SELECT id, email, full_name FROM users WHERE email = ?",
                    (values["email"].lower(),),
                ).fetchone()
            token = secrets.token_urlsafe(32)
            with state_lock:
                sessions[token] = (user["id"], time.time() + SESSION_LIFETIME)
            self._send_json(
                HTTPStatus.CREATED,
                {"ok": True, "user": {"email": user["email"], "name": user["full_name"]}},
                {"Set-Cookie": self._cookie(token, SESSION_LIFETIME)},
            )
            return

        if path == "/api/logout":
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = cookie.get(SESSION_COOKIE)
            if morsel:
                with state_lock:
                    sessions.pop(morsel.value, None)
            self._send_json(
                HTTPStatus.OK,
                {"ok": True},
                { "Set-Cookie": self._cookie("", 0) },
            )
            return

        remote_address = self.client_address[0]
        now = time.time()
        with state_lock:
            failures = login_failures[remote_address]
            while failures and failures[0] <= now - 60:
                failures.popleft()
            if len(failures) >= 5:
                self._send_json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "Demasiados intentos. Espera un minuto e inténtalo nuevamente."},
                )
                return

        email = payload.get("email", "")
        password = payload.get("password", "")
        if not isinstance(email, str) or not isinstance(password, str) or len(email) > 254 or len(password) > 1024:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Ingresa un correo y una contraseña válidos."})
            return
        with connect_db() as db:
            user = db.execute(
                "SELECT id, email, full_name, password_salt, password_hash FROM users WHERE email = ?",
                (email.strip().lower(),),
            ).fetchone()
        salt = user["password_salt"] if user is not None else DUMMY_SALT
        expected_hash = user["password_hash"] if user is not None else DUMMY_HASH
        password_valid = verify_password(password, salt, expected_hash)
        if user is None or not password_valid:
            with state_lock:
                login_failures[remote_address].append(now)
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Correo o contraseña incorrectos."})
            return

        with state_lock:
            login_failures.pop(remote_address, None)
            token = secrets.token_urlsafe(32)
            sessions[token] = (user["id"], now + SESSION_LIFETIME)
        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "user": {"email": user["email"], "name": user["full_name"]}},
            {"Set-Cookie": self._cookie(token, SESSION_LIFETIME)},
        )

    def _cookie(self, value, max_age):
        secure_flag = "; Secure" if COOKIE_SECURE else ""
        return (
            f"{SESSION_COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; "
            f"SameSite=Lax{secure_flag}"
        )

    def translate_path(self, path):
        url_path = urlparse(path).path.lstrip("/")
        resolved = (ROOT / url_path).resolve()
        if resolved != ROOT and ROOT not in resolved.parents:
            return str(ROOT / "__not_found__")
        return str(resolved)


def main():
    parser = argparse.ArgumentParser(description="Servidor local de SuperAhorro")
    user_action = parser.add_mutually_exclusive_group()
    user_action.add_argument("--create-user", metavar="EMAIL", help="Crear una cuenta de acceso")
    user_action.add_argument("--reset-password", metavar="EMAIL", help="Cambiar la contraseña de una cuenta")
    user_action.add_argument("--grant-admin", metavar="EMAIL", help="Conceder acceso al panel B2B")
    user_action.add_argument("--revoke-admin", metavar="EMAIL", help="Retirar acceso al panel B2B")
    parser.add_argument("--name", default="", help="Nombre de la persona al crear una cuenta")
    args = parser.parse_args()

    initialize_database()
    if args.create_user or args.reset_password:
        import getpass

        first = getpass.getpass("Nueva contraseña (mínimo 12 caracteres): ")
        second = getpass.getpass("Repite la contraseña: ")
        if first != second:
            parser.error("Las contraseñas no coinciden.")
        try:
            if args.create_user:
                add_user(args.create_user, args.name, first)
                print(f"Cuenta creada para {args.create_user.strip().lower()}.")
            else:
                set_user_password(args.reset_password, first)
                print(f"Contraseña actualizada para {args.reset_password.strip().lower()}.")
        except (ValueError, sqlite3.IntegrityError) as error:
            parser.error(str(error))
        return
    if args.grant_admin or args.revoke_admin:
        try:
            email = args.grant_admin or args.revoke_admin
            set_user_admin(email, bool(args.grant_admin))
            action = "Acceso de administrador concedido" if args.grant_admin else "Acceso de administrador retirado"
            print(f"{action} para {email.strip().lower()}.")
        except ValueError as error:
            parser.error(str(error))
        return

    host = os.environ.get("SUPERAHORRO_HOST", "127.0.0.1")
    port = int(os.environ.get("SUPERAHORRO_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), SuperAhorroHandler)
    print(f"SuperAhorro disponible en http://{host}:{port}")
    if host in {"127.0.0.1", "localhost"}:
        print("Cuenta de demostración: demo@superahorro.cl / AhorroDemo2026!")
        print("Cambie la contraseña antes de usar este servidor fuera de su equipo.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
