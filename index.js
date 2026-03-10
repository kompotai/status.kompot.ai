import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

const COOLIFY_URL = process.env.COOLIFY_URL || "https://cool.kompot.ai";
const COOLIFY_TOKEN = process.env.COOLIFY_API_TOKEN;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!COOLIFY_TOKEN) {
  console.error("COOLIFY_API_TOKEN is required");
  process.exit(1);
}

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
