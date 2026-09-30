// kaiju: a local, API-compatible stand-in for Jira Cloud (REST v3 + v2 subset) with a Jira-like UI and
// Jira-style automation. Not affiliated with or endorsed by Atlassian.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, JiraError, mimeOf } from "./store.js";
import { Automation } from "./automation.js";
import { JqlError } from "./jql.js";
import { textToAdf } from "./adf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PORT = Number(process.env.KAIJU_PORT || process.env.PORT || 8790);
const BASE_URL = (process.env.KAIJU_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const WORKSPACE = path.resolve(root, process.env.KAIJU_WORKSPACE || "workspaces/example.json");
const DATA_DIR = path.resolve(root, process.env.KAIJU_DATA_DIR || `data/${path.basename(WORKSPACE, ".json")}`);
const UI_PUBLIC = /^(1|true|yes)$/i.test(process.env.KAIJU_UI_PUBLIC || "");
const UI_PASSWORD = process.env.KAIJU_UI_PASSWORD || "";

const store = new Store({ workspaceFile: WORKSPACE, dataDir: DATA_DIR, baseUrl: BASE_URL });
const automation = new Automation(store);
const app = express();
app.disable("x-powered-by");
app.set("json spaces", 0);

// ---------- helpers ----------
const send = (res, e) => {
  if (e instanceof JiraError) return res.status(e.status).json(e.toJSON());
  if (e instanceof JqlError) return res.status(400).json({ errorMessages: [e.message], errors: {}, warningMessages: [] });
  console.error(e);
  return res.status(500).json({ errorMessages: [e.message], errors: {} });
};
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { send(res, e); } };
const notFound = () => new JiraError(404, {}, ["Issue does not exist or you do not have permission to see it."]);
const getIssue = (ref) => { const i = store.issue(ref); if (!i) throw notFound(); return i; };
const list = (q) => [].concat(q ?? []).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);

async function readMultipart(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = new Request("http://local/", { method: "POST", headers: { "content-type": req.headers["content-type"] || "" }, body: Buffer.concat(chunks) });
  const fd = await r.formData();
  const files = [];
  for (const [, v] of fd.entries()) if (typeof v === "object" && v && "arrayBuffer" in v) files.push({ filename: v.name || "file", mimeType: v.type || mimeOf(v.name), buffer: Buffer.from(await v.arrayBuffer()) });
  return files;
}

function authUser(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const [email, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    return store.userByToken(email, rest.join(":"));
  }
  if (h.startsWith("Bearer ")) return store.userByToken(null, h.slice(7).trim());
  return null;
}

// Every REST call is logged for the UI's "API log" panel (bodies trimmed, credentials never stored).
const apiLog = [];
function logApi(req, res, user, started) {
  let body = req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) body = JSON.stringify(body).slice(0, 2000);
  apiLog.unshift({ at: new Date().toISOString(), method: req.method, path: req.originalUrl, status: res.statusCode, user: user?.displayName || null, ms: Date.now() - started, body: typeof body === "string" ? body : undefined });
  if (apiLog.length > 300) apiLog.length = 300;
}

// ---------- REST API (v3 and v2) ----------
function restRouter(v) {
  const r = express.Router();
  r.use((req, res, next) => {
    const started = Date.now();
    const user = authUser(req);
    res.on("finish", () => logApi(req, res, user, started));
    if (!user) return res.status(401).json({ errorMessages: ["Client must be authenticated to access this resource."], errors: {} });
    req.user = user;
    next();
  });
  r.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json", "text/plain"] }));

  r.get("/serverInfo", (req, res) => res.json({ baseUrl: BASE_URL, version: "1001.0.0-SNAPSHOT", versionNumbers: [1001, 0, 0], deploymentType: "Cloud", buildNumber: 100000, serverTitle: store.ws.site.name, defaultLocale: { locale: "en_US" } }));
  r.get("/myself", (req, res) => res.json({ ...store.userJson(req.user.accountId), locale: "en_US", groups: { size: 1, items: [] }, applicationRoles: { size: 1, items: [] } }));
  r.get("/user", wrap((req, res) => { const u = store.userJson(req.query.accountId); if (!u) throw new JiraError(404, {}, ["Specified user does not exist or you do not have required permissions"]); res.json(u); }));
  r.get(["/user/search", "/users/search", "/user/assignable/search"], (req, res) => {
    const q = String(req.query.query || req.query.username || "").toLowerCase();
    res.json(store.ws.users.filter((u) => !q || u.displayName.toLowerCase().includes(q) || (u.emailAddress || "").toLowerCase().includes(q)).map((u) => store.userJson(u.accountId)));
  });

  r.get("/project", (req, res) => res.json(store.ws.projects.map((p) => store.projectJson(p))));
  r.get("/project/search", (req, res) => { const values = store.ws.projects.map((p) => store.projectJson(p)); res.json({ self: `${BASE_URL}${req.originalUrl}`, maxResults: 50, startAt: 0, total: values.length, isLast: true, values }); });
  r.get("/project/:ref", wrap((req, res) => { const p = store.project(req.params.ref); if (!p) throw new JiraError(404, {}, ["No project could be found with key '" + req.params.ref + "'."]); res.json(store.projectJson(p)); }));
  r.get("/project/:ref/statuses", wrap((req, res) => {
    const p = store.project(req.params.ref); if (!p) throw new JiraError(404, {}, ["No project found"]);
    res.json(p.issueTypes.map((t) => ({ id: t.id, name: t.name, subtask: !!t.subtask, statuses: store.workflow(t).statuses.map((s) => ({ id: s.id, name: s.name, statusCategory: { key: s.category } })) })));
  }));
  r.get("/issuetype", (req, res) => res.json(store.ws.projects.flatMap((p) => p.issueTypes.map((t) => ({ ...store.typeJson(p, t), scope: { type: "PROJECT", project: { id: p.id } } })))));
  r.get("/field", (req, res) => res.json(store.allFields.map((f) => store.fieldJson(f))));
  r.get("/field/:id/context", wrap((req, res) => { const f = store.fieldById(req.params.id); if (!f) throw new JiraError(404, {}, ["Field not found"]); res.json({ maxResults: 50, startAt: 0, total: 1, isLast: true, values: [{ id: "10100", name: `Default context for ${f.name}`, isGlobalContext: true, isAnyIssueType: true }] }); }));
  r.get("/field/:id/context/:ctx/option", wrap((req, res) => { const f = store.fieldById(req.params.id); if (!f?.options) throw new JiraError(404, {}, ["Field has no options"]); res.json({ maxResults: 100, startAt: 0, total: f.options.length, isLast: true, values: f.options.map((o) => ({ id: o.id, value: o.value, disabled: false })) }); }));
  r.get("/status", (req, res) => res.json(Object.values(store.ws.workflows).flatMap((w) => w.statuses).map((s) => ({ id: s.id, name: s.name, statusCategory: { key: s.category } }))));

  // search: new token-paged endpoint and the legacy one
  const search = (jql, user, { startAt = 0, maxResults = 50, fields, expand }) => {
    const all = store.search(jql || "", user);
    const page = all.slice(startAt, startAt + maxResults);
    return { all, page: page.map((i) => store.toJira(i, { v, fields, expand })) };
  };
  r.all(["/search/jql", "/search"], wrap((req, res) => {
    const q = { ...req.query, ...(req.method === "POST" ? req.body || {} : {}) };
    const maxResults = Math.min(Number(q.maxResults ?? 50), 5000);
    const legacy = req.path === "/search";
    const startAt = legacy ? Number(q.startAt || 0) : Number(q.nextPageToken ? Buffer.from(String(q.nextPageToken), "base64").toString() : 0);
    const { all, page } = search(q.jql, req.user, { startAt, maxResults, fields: list(q.fields), expand: list(q.expand) });
    if (legacy) return res.json({ expand: "names,schema", startAt, maxResults, total: all.length, issues: page });
    const end = startAt + page.length;
    res.json({ issues: page, isLast: end >= all.length, ...(end < all.length ? { nextPageToken: Buffer.from(String(end)).toString("base64") } : {}) });
  }));
  r.post("/search/approximate-count", wrap((req, res) => { res.json({ count: store.search(req.body?.jql || "", req.user).length }); }));

  // issues
  r.post("/issue", wrap((req, res) => {
    const f = { ...(req.body?.fields || {}) };
    const { project, issuetype, summary, description, parent, assignee, reporter, labels, ...custom } = f;
    const i = store.createIssue({
      project, issueType: issuetype, summary, description: description ? (typeof description === "string" ? textToAdf(description) : description) : null,
      parent, assignee: assignee ? store.user(assignee)?.accountId : null, reporter: reporter ? store.user(reporter)?.accountId : req.user.accountId, labels, fields: custom,
    }, req.user);
    res.status(201).json({ id: i.id, key: i.key, self: `${BASE_URL}/rest/api/${v}/issue/${i.id}` });
  }));
  r.get("/issue/:ref", wrap((req, res) => res.json(store.toJira(getIssue(req.params.ref), { v, fields: list(req.query.fields), expand: list(req.query.expand) }))));
  r.put("/issue/:ref", wrap((req, res) => {
    const i = getIssue(req.params.ref);
    const fields = { ...(req.body?.fields || {}) };
    for (const [ref, ops] of Object.entries(req.body?.update || {})) {
      for (const op of [].concat(ops)) {
        if ("set" in op) fields[ref] = op.set;
        else if (ref === "labels" && ("add" in op || "remove" in op)) {
          const cur = new Set(fields.labels || i.labels);
          if ("add" in op) cur.add(op.add); if ("remove" in op) cur.delete(op.remove);
          fields.labels = [...cur];
        } else if (ref === "comment" && op.add) store.addComment(i, op.add.body, req.user);
      }
    }
    if (typeof fields.description === "string" && v === 2) fields.description = textToAdf(fields.description);
    store.applyFields(i, fields, req.user);
    res.status(204).end();
  }));
  r.delete("/issue/:ref", wrap((req, res) => { store.deleteIssue(getIssue(req.params.ref), { deleteSubtasks: String(req.query.deleteSubtasks) === "true" }); res.status(204).end(); }));
  r.put("/issue/:ref/assignee", wrap((req, res) => { const i = getIssue(req.params.ref); store.applyFields(i, { assignee: req.body?.accountId ?? null }, req.user); res.status(204).end(); }));
  r.get("/issue/:ref/transitions", wrap((req, res) => { const i = getIssue(req.params.ref); res.json({ expand: "transitions", transitions: store.transitions(i).map((t) => store.transitionJson(i, t)) }); }));
  r.post("/issue/:ref/transitions", wrap((req, res) => {
    const i = getIssue(req.params.ref);
    const id = req.body?.transition?.id ?? req.body?.transition?.name;
    if (id == null) throw new JiraError(400, {}, ["Missing 'transition' identifier"]);
    const comment = (req.body?.update?.comment || []).map((c) => c.add?.body).find(Boolean);
    store.doTransition(i, String(id), req.user, { comment, fields: req.body?.fields });
    res.status(204).end();
  }));
  r.get("/issue/:ref/comment", wrap((req, res) => { const i = getIssue(req.params.ref); const comments = i.comments.map((c) => store.commentJson(i, c, v)); res.json({ startAt: 0, maxResults: comments.length, total: comments.length, comments }); }));
  r.post("/issue/:ref/comment", wrap((req, res) => {
    const i = getIssue(req.params.ref);
    if (!req.body?.body) throw new JiraError(400, { comment: "Comment body can not be empty!" });
    const c = store.addComment(i, req.body.body, req.user);
    res.status(201).json(store.commentJson(i, c, v));
  }));
  r.get("/issue/:ref/changelog", wrap((req, res) => { const cl = store.changelogJson(getIssue(req.params.ref)); res.json({ self: `${BASE_URL}${req.originalUrl}`, maxResults: cl.total, startAt: 0, total: cl.total, isLast: true, values: cl.histories }); }));
  r.post("/issue/:ref/attachments", wrap(async (req, res) => {
    const i = getIssue(req.params.ref);
    if ((req.headers["x-atlassian-token"] || "").toLowerCase() !== "no-check") return res.status(403).json({ errorMessages: ["XSRF check failed"], errors: {} });
    if (!String(req.headers["content-type"] || "").startsWith("multipart/form-data")) throw new JiraError(415, {}, ["Attachments must be sent as multipart/form-data with a 'file' part."]);
    const files = await readMultipart(req);
    if (!files.length) throw new JiraError(400, {}, ["No file was sent in the 'file' part."]);
    res.json(files.map((f) => store.attachmentJson(store.addAttachment(i, f, req.user))));
  }));
  r.get("/attachment/:id", wrap((req, res) => { const hit = store.findAttachment(req.params.id); if (!hit) throw new JiraError(404, {}, ["Attachment not found"]); res.json(store.attachmentJson(hit.att)); }));
  r.get("/attachment/content/:id", wrap((req, res) => {
    const hit = store.findAttachment(req.params.id); if (!hit) throw new JiraError(404, {}, ["Attachment not found"]);
    res.setHeader("Content-Type", hit.att.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${hit.att.filename.replace(/"/g, "")}"`);
    fs.createReadStream(store.attachmentPath(hit.att)).pipe(res);
  }));
  r.delete("/attachment/:id", wrap((req, res) => { const hit = store.findAttachment(req.params.id); if (!hit) throw new JiraError(404, {}, ["Attachment not found"]); hit.issue.attachments = hit.issue.attachments.filter((a) => a !== hit.att); fs.rmSync(store.attachmentPath(hit.att), { force: true }); store.save(); res.status(204).end(); }));
  r.all("*", (req, res) => res.status(404).json({ errorMessages: [`kaiju does not implement ${req.method} ${req.baseUrl}${req.path}. See /_mock/api-docs for the supported endpoints.`], errors: {} }));
  return r;
}
app.use("/rest/api/3", restRouter(3));
app.use("/rest/api/2", restRouter(2));
app.use("/rest/api/latest", restRouter(3));

// ---------- incoming automation webhooks (token-authenticated, like Jira's) ----------
app.post("/_mock/automation/webhook/:ruleId", express.json({ limit: "2mb" }), async (req, res) => {
  const token = req.headers["x-automation-webhook-token"] || req.query.token;
  const out = await automation.runWebhook(req.params.ruleId, token, req.body || {});
  if (out.status !== 200) return res.status(out.status).json({ message: out.message || "not accepted" });
  res.json({ ok: true, runs: out.audits.map((a) => ({ id: a.id, status: a.status, issueKey: a.issueKey })) });
});

// ---------- avatars and icons (public, tiny SVGs) ----------
const PALETTE = ["#0052CC", "#00875A", "#FF5630", "#6554C0", "#FF991F", "#00B8D9", "#36B37E", "#403294"];
app.get("/_mock/avatar/:id.svg", (req, res) => {
  const u = store.user(req.params.id);
  const name = u?.displayName || "Automation";
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const color = PALETTE[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="${color}"/><text x="24" y="30" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="600" fill="#fff">${initials}</text></svg>`);
});
app.get("/_mock/icon/:name.svg", (req, res) => {
  const n = req.params.name.toLowerCase();
  const icons = {
    task: ["#4BADE8", '<path d="M5 8.5l2 2 4-4.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>'],
    subtask: ["#4BADE8", '<rect x="4" y="4" width="4" height="4" fill="none" stroke="#fff" stroke-width="1.4"/><rect x="8" y="8" width="4" height="4" fill="#fff"/>'],
    epic: ["#904EE2", '<path d="M9.5 3L5 9h3l-1.5 4L11 7H8z" fill="#fff"/>'],
    story: ["#63BA3C", '<path d="M5.5 3.5h5v9l-2.5-2-2.5 2z" fill="#fff"/>'],
    bug: ["#E5493A", '<circle cx="8" cy="8" r="3" fill="#fff"/>'],
  };
  const [bg, glyph] = icons[n] || icons[n.includes("sub") ? "subtask" : n.includes("epic") ? "epic" : "task"];
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${bg}"/>${glyph}</svg>`);
});

// ---------- UI + its private API ----------
function uiGuard(req, res, next) {
  if (UI_PASSWORD) {
    const h = req.headers.authorization || "";
    const pass = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
    if (pass === UI_PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="kaiju"');
    return res.status(401).send("Authentication required");
  }
  const forwarded = req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"];
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  if (UI_PUBLIC || (local && !forwarded)) return next();
  res.status(403).send("The kaiju UI is local-only. Set KAIJU_UI_PASSWORD (or KAIJU_UI_PUBLIC=true) to expose it.");
}

const ui = express.Router();
ui.use(uiGuard);
ui.use(express.json({ limit: "10mb" }));
const actorOf = (req) => store.user(req.headers["x-mock-user"]) || store.ws.users[0];
const uiIssue = (i) => ({
  ...store.toJira(i, { expand: ["names", "changelog"] }),
  transitions: store.transitions(i).map((t) => store.transitionJson(i, t)),
  manualRules: automation.rules.filter((r) => r.trigger?.type === "manual" && automation.enabled(r) && automation.scopeOk(r, i)).map((r) => ({ id: r.id, name: r.name })),
  children: store.children(i.key).map((c) => store.toJira(c)),
});

ui.get("/bootstrap", (req, res) => res.json({
  site: store.ws.site, baseUrl: BASE_URL, workspace: path.relative(root, WORKSPACE),
  projects: store.ws.projects.map((p) => ({ ...store.projectJson(p), issueTypes: p.issueTypes.map((t) => ({ ...store.typeJson(p, t), workflow: store.workflow(t).name })) })),
  workflows: store.ws.workflows,
  users: store.ws.users.map((u) => ({ ...store.userJson(u.accountId), emailAddress: u.emailAddress, emailVisible: u.emailVisible !== false, apiAccess: !!u.apiToken })),
  fields: store.allFields.map((f) => ({ ...store.fieldJson(f), type: f.type, options: f.options, description: f.description })),
  rules: automation.rules.map((r) => ({ ...r, enabled: automation.enabled(r) })),
}));
ui.get("/credentials", (req, res) => res.json(store.ws.users.filter((u) => u.apiToken).map((u) => ({ displayName: u.displayName, emailAddress: u.emailAddress, apiToken: u.apiToken }))));
ui.get("/issues", wrap((req, res) => { const jql = req.query.jql || (req.query.project ? `project = ${req.query.project} ORDER BY created ASC` : "ORDER BY created ASC"); res.json(store.search(jql, actorOf(req)).map((i) => store.toJira(i))); }));
ui.get("/issue/:ref", wrap((req, res) => res.json(uiIssue(getIssue(req.params.ref)))));
ui.post("/issue", wrap((req, res) => {
  const b = req.body || {};
  const i = store.createIssue({ project: b.project, issueType: b.issueType, summary: b.summary, description: b.description ? textToAdf(b.description) : null, parent: b.parent || undefined, assignee: store.user(b.assignee)?.accountId || null, reporter: actorOf(req).accountId, fields: b.fields }, actorOf(req), { trusted: true });
  res.status(201).json(uiIssue(i));
}));
ui.put("/issue/:ref", wrap((req, res) => { const i = getIssue(req.params.ref); store.applyFields(i, req.body?.fields || {}, actorOf(req), { trusted: true }); res.json(uiIssue(i)); }));
ui.delete("/issue/:ref", wrap((req, res) => { store.deleteIssue(getIssue(req.params.ref)); res.status(204).end(); }));
ui.post("/issue/:ref/transition", wrap((req, res) => { const i = getIssue(req.params.ref); store.doTransition(i, String(req.body?.id), actorOf(req)); res.json(uiIssue(i)); }));
ui.post("/issue/:ref/comment", wrap((req, res) => { const i = getIssue(req.params.ref); store.addComment(i, String(req.body?.text || ""), actorOf(req)); res.json(uiIssue(i)); }));
ui.post("/issue/:ref/attachments", wrap(async (req, res) => { const i = getIssue(req.params.ref); for (const f of await readMultipart(req)) store.addAttachment(i, f, actorOf(req)); res.json(uiIssue(i)); }));
ui.post("/issue/:ref/automation/:rule", wrap(async (req, res) => { const a = await automation.runManual(req.params.rule, req.params.ref, actorOf(req)); res.json(a); }));
ui.get("/attachment/:id", wrap((req, res) => { const hit = store.findAttachment(req.params.id); if (!hit) throw new JiraError(404, {}, ["Attachment not found"]); res.setHeader("Content-Type", hit.att.mimeType); res.setHeader("Content-Disposition", `inline; filename="${hit.att.filename.replace(/"/g, "")}"`); fs.createReadStream(store.attachmentPath(hit.att)).pipe(res); }));
ui.get("/audit", (req, res) => res.json(store.state.audit.slice(0, Number(req.query.limit || 200))));
ui.get("/api-log", (req, res) => res.json(apiLog.slice(0, Number(req.query.limit || 100))));
ui.post("/rules/:id/toggle", wrap((req, res) => { automation.toggle(req.params.id, !!req.body?.enabled); res.json({ ok: true }); }));
ui.post("/reset", wrap((req, res) => { store.reset(); apiLog.length = 0; res.json({ ok: true }); }));
ui.get("/version", (req, res) => { const s = JSON.stringify({ n: Object.keys(store.state.issues).length, a: store.state.audit[0]?.id, u: Object.values(store.state.issues).map((i) => i.updated).sort().at(-1), l: apiLog[0]?.at }); res.json({ v: s }); });
app.use("/_mock/api", ui);
// Echo endpoint for testing automation web requests without an external service.
app.all("/_mock/echo", uiGuard, express.text({ type: "*/*", limit: "2mb" }), (req, res) => {
  let body = req.body; try { body = JSON.parse(req.body); } catch { /* keep text */ }
  res.json({ ok: true, instanceGuid: `echo-${Date.now()}`, method: req.method, query: req.query, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/authorization|cookie|api-key|token/i.test(k))), body });
});

app.get(["/", "/browse/:key", "/jira/*", "/projects/*", "/automation", "/settings", "/api-docs"], uiGuard, (req, res) => res.sendFile(path.join(root, "public", "index.html")));
app.use("/_mock/static", uiGuard, express.static(path.join(root, "public"), { maxAge: 0 }));

app.listen(PORT, () => {
  console.log(`kaiju on ${BASE_URL}  (workspace ${path.relative(root, WORKSPACE)}, data ${path.relative(root, DATA_DIR)})`);
  for (const u of store.ws.users.filter((x) => x.apiToken)) console.log(`  API user: ${u.emailAddress}  token: ${u.apiToken.slice(0, 6)}…  (full value: GET /_mock/api/credentials from localhost)`);
});
