import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import crypto from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";

const COOLIFY_URL = process.env.COOLIFY_URL || "https://cool.kompot.ai";
const COOLIFY_TOKEN = process.env.COOLIFY_API_TOKEN;
const ACCESS_CODE = process.env.ACCESS_CODE;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!COOLIFY_TOKEN) {
  console.error("COOLIFY_API_TOKEN is required");
  process.exit(1);
}

if (!ACCESS_CODE) {
  console.error("ACCESS_CODE is required");
  process.exit(1);
}

const AUTH_TOKEN = crypto.createHash("sha256").update(ACCESS_CODE).digest("hex").slice(0, 32);
const COOKIE_NAME = "status_auth";
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60; // 90 days

const APPS = [
  { uuid: "q0cogoo4cg00k80ccwkwco8o" },
  { uuid: "mcsgwc00404ss40ss0so48co" },
];

async function fetchAppInfo(uuid) {
  const res = await fetch(`${COOLIFY_URL}/api/v1/applications/${uuid}`, {
    headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`App fetch failed: ${res.status}`);
  return res.json();
}

async function fetchDeployments(uuid, take = 20, skip = 0) {
  const res = await fetch(
    `${COOLIFY_URL}/api/v1/deployments/applications/${uuid}?take=${take}&skip=${skip}`,
    { headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Deployments fetch failed: ${res.status}`);
  return res.json();
}

function mapDeployments(raw) {
  return (raw || []).map((d) => ({
    uuid: d.deployment_uuid,
    status: d.status,
    commit: d.commit,
    commitMessage: d.commit_message,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }));
}

const app = new Hono();

// Auth: login endpoint
app.post("/api/auth", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.code === ACCESS_CODE) {
    setCookie(c, COOKIE_NAME, AUTH_TOKEN, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: COOKIE_MAX_AGE,
    });
    return c.json({ ok: true });
  }
  return c.json({ ok: false, error: "Неверный код" }, 401);
});

app.post("/api/logout", async (c) => {
  setCookie(c, COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

// Auth middleware: protect everything except login page and auth endpoint
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/auth") return next();

  const token = getCookie(c, COOKIE_NAME);
  if (token === AUTH_TOKEN) return next();

  // Not authenticated — serve login page for HTML requests, 401 for API
  if (path.startsWith("/api/")) {
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }
  return c.html(loginPage());
});

function loginPage() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deploy Status — kompot.ai</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%23666'/></svg>">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a; color: #e0e0e0;
      height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .login-box {
      width: 340px; padding: 2rem;
      background: #111; border: 1px solid #1e1e1e; border-radius: 12px;
    }
    .login-box h1 { font-size: 1.1rem; margin-bottom: 0.3rem; color: #fff; }
    .login-box p { font-size: 0.8rem; color: #555; margin-bottom: 1.5rem; }
    .login-box input {
      width: 100%; padding: 0.6rem 0.8rem;
      background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 8px;
      color: #e0e0e0; font-size: 0.9rem; outline: none;
    }
    .login-box input:focus { border-color: #444; }
    .login-box button {
      width: 100%; padding: 0.6rem; margin-top: 0.75rem;
      background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px;
      color: #818cf8; font-size: 0.85rem; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    .login-box button:hover { background: #222244; }
    .error { color: #f87171; font-size: 0.8rem; margin-top: 0.5rem; display: none; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Deploy Status</h1>
    <p>Введите код доступа</p>
    <form id="f">
      <input type="password" id="code" placeholder="Код доступа" autofocus autocomplete="off">
      <button type="submit">Войти</button>
      <div class="error" id="err"></div>
    </form>
  </div>
  <script>
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const code = document.getElementById('code').value.trim();
      if (!code) return;
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.ok) {
        location.reload();
      } else {
        const err = document.getElementById('err');
        err.textContent = data.error || 'Ошибка';
        err.style.display = 'block';
      }
    };
  </script>
</body>
</html>`;
}

app.get("/api/status", async (c) => {
  try {
    const results = await Promise.all(
      APPS.map(async (appDef) => {
        const [appInfo, deployments] = await Promise.all([
          fetchAppInfo(appDef.uuid),
          fetchDeployments(appDef.uuid, 20),
        ]);
        return {
          uuid: appDef.uuid,
          name: appInfo.name || appDef.uuid,
          fqdn: appInfo.fqdn || null,
          status: appInfo.status || "unknown",
          repository: appInfo.git_repository
            ? `${appInfo.git_repository}:${appInfo.git_branch}`
            : null,
          total: deployments.count || 0,
          deployments: mapDeployments(deployments.deployments),
        };
      })
    );
    return c.json({ ok: true, apps: results });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

app.get("/api/apps/:appUuid/deployments", async (c) => {
  const appUuid = c.req.param("appUuid");
  const skip = parseInt(c.req.query("skip") || "0", 10);
  const take = parseInt(c.req.query("take") || "20", 10);
  if (!APPS.find((a) => a.uuid === appUuid)) {
    return c.json({ ok: false, error: "Unknown app" }, 404);
  }
  try {
    const data = await fetchDeployments(appUuid, take, skip);
    return c.json({
      ok: true,
      total: data.count || 0,
      deployments: mapDeployments(data.deployments),
    });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

app.get("/api/deployments/:uuid/logs", async (c) => {
  const uuid = c.req.param("uuid");
  try {
    const res = await fetch(`${COOLIFY_URL}/api/v1/deployments/${uuid}`, {
      headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Deployment fetch failed: ${res.status}`);
    const data = await res.json();
    let logs = [];
    try {
      const parsed = JSON.parse(data.logs || "[]");
      logs = parsed
        .filter((l) => !l.hidden)
        .map((l) => ({
          type: l.type,
          output: l.output || "",
          timestamp: l.timestamp || null,
        }));
    } catch {}
    return c.json({ ok: true, logs });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Status page running at http://localhost:${info.port}`);
});
