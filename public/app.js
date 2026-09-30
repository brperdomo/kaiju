// kaiju UI: a Jira-like single-page app over /_mock/api. No framework, no build step.
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const svg = (html) => { const t = document.createElement("span"); t.innerHTML = html; return t.firstElementChild; };
const ICON = {
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  board: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/></svg>',
  bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  code: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>',
  clip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 8"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>',
};

let BOOT = null; let ME = null; let VERSION = null; let docClick = null;
const state = { showSubtasks: localStorage.getItem("jm.showSubtasks") !== "0", activityTab: "comments", showEmpty: false, filter: "" };

async function api(path, opts = {}) {
  const headers = { "X-Mock-User": ME || "", ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };
  const res = await fetch(`/_mock/api${path}`, { ...opts, headers, body: opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const msg = [...(data.errorMessages || []), ...Object.values(data.errors || {})].join(" ") || `HTTP ${res.status}`; throw new Error(msg); }
  return data;
}

function toast(msg, kind = "") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3500);
}
const fail = (e) => toast(e.message || String(e), "bad");

const go = (path) => { history.pushState({}, "", path); render(); };
window.addEventListener("popstate", () => render());
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-nav]");
  if (a && !e.metaKey && !e.ctrlKey && e.button === 0) { e.preventDefault(); go(a.getAttribute("href")); }
  if (docClick && !e.target.closest(".menu")) { docClick(); docClick = null; }
});

// ---------- small components ----------
const cat = (statusObj) => statusObj?.statusCategory?.key || "indeterminate";
const lozenge = (status) => h("span", { class: `lz ${cat(status)}` }, status?.name || "");
const avatar = (u, cls = "") => u ? h("img", { class: `avatar ${cls}`, src: `/_mock/avatar/${u.accountId}.svg`, alt: u.displayName, title: u.displayName }) : h("span", { class: `avatar ${cls}`, title: "Unassigned", style: { display: "inline-block", background: "var(--lz-new-bg)" } });
const typeIcon = (t) => h("img", { class: "ticon", src: `/_mock/icon/${encodeURIComponent(t?.name || "task")}.svg`, alt: t?.name || "", title: t?.name || "" });
const nav = (href, label, kids = []) => h("a", { href, "data-nav": true }, label, kids);
const userById = (id) => BOOT.users.find((u) => u.accountId === id);
const fieldDefs = () => BOOT.fields.filter((f) => f.custom);
const fmtDate = (s) => (s ? new Date(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toLocaleString() : "");
function ago(s) {
  if (!s) return "";
  const d = (Date.now() - new Date(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).getTime()) / 1000;
  if (d < 60) return "just now"; if (d < 3600) return `${Math.floor(d / 60)} minutes ago`; if (d < 86400) return `${Math.floor(d / 3600)} hours ago`;
  return new Date(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toLocaleDateString();
}
function menu(button, items) {
  const wrap = h("span", { class: "menu" });
  const pop = h("div", { class: "pop", hidden: true });
  for (const it of items) pop.append(h("button", { onclick: async () => { pop.hidden = true; docClick = null; await it.run(); } }, it.label, it.hint ? h("span", { class: "hint" }, it.hint) : null));
  button.addEventListener("click", (e) => { e.stopPropagation(); const open = pop.hidden; document.querySelectorAll(".menu .pop").forEach((p) => (p.hidden = true)); pop.hidden = !open; docClick = open ? () => (pop.hidden = true) : null; });
  wrap.append(button, pop);
  return wrap;
}
function project() {
  const m = location.pathname.match(/^\/projects\/([^/]+)/);
  const key = m?.[1] || localStorage.getItem("jm.project") || BOOT.projects[0]?.key;
  const p = BOOT.projects.find((x) => x.key === key) || BOOT.projects[0];
  if (p) localStorage.setItem("jm.project", p.key);
  return p;
}

// ---------- shell ----------
function shell(active, content) {
  const p = project();
  const search = h("input", { type: "search", placeholder: "Search or enter JQL", value: new URLSearchParams(location.search).get("jql") || "", onkeydown: (e) => { if (e.key === "Enter") { const v = e.target.value.trim(); const jql = /[=~<>]|\bORDER BY\b|\bin\s*\(/i.test(v) ? v : v ? `text ~ "${v.replace(/"/g, "")}" ORDER BY updated DESC` : ""; go(`/projects/${p.key}/list${jql ? `?jql=${encodeURIComponent(jql)}` : ""}`); } } });
  const who = h("select", { title: "Acting as (for UI actions)", style: { height: "32px", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)" }, onchange: (e) => { ME = e.target.value; localStorage.setItem("jm.me", ME); render(); } },
    BOOT.users.map((u) => h("option", { value: u.accountId, selected: u.accountId === ME }, u.displayName)));
  const item = (key, href, icon, label) => h("a", { class: `navitem ${active === key ? "active" : ""}`, href, "data-nav": true }, svg(ICON[icon]), label);
  return h("div", { class: "shell" },
    h("header", { class: "topnav" },
      h("div", { class: "brand" }, h("div", { class: "mark" }, "K"), h("span", { class: "txt" }, BOOT.site.name)),
      h("div", { class: "search" }, svg(ICON.search), search),
      h("div", { class: "right" }, h("button", { class: "btn primary", onclick: () => createDialog() }, svg(ICON.plus), "Create"), who, avatar(userById(ME), "lg"))),
    h("div", { class: "body" },
      h("nav", { class: "sidebar" },
        h("div", { class: "proj" }, h("div", { class: "av" }, p.key.slice(0, 2)), h("div", {}, h("div", { class: "name" }, p.name), h("div", { class: "sub" }, `Software space · ${p.simplified ? "team-managed" : "company-managed"}`))),
        BOOT.projects.length > 1 ? h("select", { style: { margin: "0 8px 8px", height: "28px" }, onchange: (e) => go(`/projects/${e.target.value}/board`) }, BOOT.projects.map((x) => h("option", { value: x.key, selected: x.key === p.key }, `${x.name} (${x.key})`))) : null,
        h("div", { class: "navlabel" }, "Planning"),
        item("board", `/projects/${p.key}/board`, "board", "Board"),
        item("list", `/projects/${p.key}/list`, "list", "List"),
        h("div", { class: "navlabel" }, "Space settings"),
        item("automation", "/automation", "bolt", "Automation"),
        item("settings", "/settings", "gear", "Fields & workflows"),
        h("div", { class: "navlabel" }, "Developers"),
        item("api", "/api-docs", "code", "API & credentials"),
        h("div", { class: "foot" }, "Kaiju · a local, Jira-compatible mock. Not affiliated with Atlassian.")),
      h("main", { class: "main", id: "main" }, content)));
}

// ---------- board ----------
async function boardView() {
  const p = project();
  const issues = await api(`/issues?project=${p.key}`);
  const statuses = [];
  for (const t of p.issueTypes) for (const s of BOOT.workflows[t.workflow].statuses) if (!statuses.find((x) => x.name === s.name)) statuses.push(s);
  const byKey = Object.fromEntries(issues.map((i) => [i.key, i]));
  const f = state.filter.toLowerCase();
  const visible = issues.filter((i) => (state.showSubtasks || !i.fields.issuetype.subtask) && (!f || `${i.key} ${i.fields.summary}`.toLowerCase().includes(f)));
  const cols = statuses.map((s) => {
    const cards = visible.filter((i) => i.fields.status.name === s.name).map((i) => {
      const subs = i.fields.subtasks || [];
      const done = subs.filter((x) => x.fields.status.statusCategory.key === "done").length;
      return h("div", { class: "card", draggable: true, "data-key": i.key, onclick: () => go(`/browse/${i.key}`), ondragstart: (e) => { e.dataTransfer.setData("text/plain", i.key); e.currentTarget.classList.add("dragging"); }, ondragend: (e) => e.currentTarget.classList.remove("dragging") },
        i.fields.parent ? h("div", { class: "parent" }, `${i.fields.parent.key} · ${i.fields.parent.fields.summary}`) : null,
        h("div", { class: "summary" }, i.fields.summary),
        h("div", { class: "meta" }, typeIcon(i.fields.issuetype), h("span", { class: "key" }, i.key), subs.length ? h("span", { title: "Subtasks done" }, `☑ ${done}/${subs.length}`) : null, h("span", { class: "grow" }), avatar(i.fields.assignee, "sm")));
    });
    const col = h("section", { class: "col", ondragover: (e) => { e.preventDefault(); col.classList.add("drop"); }, ondragleave: () => col.classList.remove("drop"),
      ondrop: async (e) => {
        e.preventDefault(); col.classList.remove("drop");
        const key = e.dataTransfer.getData("text/plain"); const issue = byKey[key];
        if (!issue || issue.fields.status.name === s.name) return;
        try {
          const full = await api(`/issue/${key}`);
          const t = full.transitions.find((x) => x.to.name === s.name);
          if (!t) return toast(`No transition from ${issue.fields.status.name} to ${s.name} for ${key}.`, "bad");
          await api(`/issue/${key}/transition`, { method: "POST", body: { id: t.id } });
          toast(`${key} moved to ${s.name}`, "good"); render();
        } catch (err) { fail(err); }
      } },
      h("div", { class: "head" }, s.name, h("span", { class: "muted" }, String(cards.length))), h("div", { class: "cards" }, cards));
    return col;
  });
  return shell("board", [
    h("div", { class: "crumbs" }, "Spaces / ", p.name),
    h("h1", {}, `${p.key} board`),
    h("div", { class: "toolbar" },
      h("input", { type: "search", placeholder: "Search this board", value: state.filter, oninput: (e) => { state.filter = e.target.value; clearTimeout(boardView.t); boardView.t = setTimeout(render, 200); } }),
      h("label", { class: "muted small" }, h("input", { type: "checkbox", checked: state.showSubtasks, onchange: (e) => { state.showSubtasks = e.target.checked; localStorage.setItem("jm.showSubtasks", e.target.checked ? "1" : "0"); render(); } }), " Show subtasks"),
      h("span", { class: "muted small" }, `${issues.length} work items · drag a card to transition it`)),
    h("div", { class: "board" }, cols),
  ]);
}

// ---------- list ----------
async function listView() {
  const p = project();
  const jql = new URLSearchParams(location.search).get("jql") || `project = ${p.key} ORDER BY created ASC`;
  let issues = []; let err = null;
  try { issues = await api(`/issues?jql=${encodeURIComponent(jql)}`); } catch (e) { err = e.message; }
  const custom = fieldDefs().slice(0, 4);
  const input = h("input", { type: "text", value: jql, style: { flex: "1", fontFamily: "var(--mono)" }, onkeydown: (e) => { if (e.key === "Enter") go(`/projects/${p.key}/list?jql=${encodeURIComponent(e.target.value)}`); } });
  return shell("list", [
    h("div", { class: "crumbs" }, "Spaces / ", p.name),
    h("h1", {}, "List"),
    h("div", { class: "toolbar" }, h("span", { class: "muted" }, "JQL"), input, h("button", { class: "btn", onclick: () => go(`/projects/${p.key}/list?jql=${encodeURIComponent(input.value)}`) }, "Search")),
    err ? h("div", { class: "toast bad", style: { marginBottom: "12px" } }, err) : null,
    h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, h("th", {}, "Type"), h("th", {}, "Key"), h("th", {}, "Summary"), h("th", {}, "Status"), h("th", {}, "Assignee"), h("th", {}, "Parent"), custom.map((f) => h("th", {}, f.name)), h("th", {}, "Updated"))),
      h("tbody", {}, issues.map((i) => h("tr", { class: "click", onclick: () => go(`/browse/${i.key}`) },
        h("td", {}, typeIcon(i.fields.issuetype)), h("td", { class: "mono" }, i.key), h("td", {}, i.fields.summary), h("td", {}, lozenge(i.fields.status)),
        h("td", {}, i.fields.assignee ? h("span", { class: "userchip" }, avatar(i.fields.assignee, "sm"), i.fields.assignee.displayName) : h("span", { class: "muted" }, "Unassigned")),
        h("td", { class: "mono" }, i.fields.parent?.key || ""),
        custom.map((f) => h("td", {}, fieldText(f, i.fields[f.id]))),
        h("td", { class: "muted small" }, ago(i.fields.updated)))))),
    !issues.length && !err ? h("div", { class: "empty" }, "No work items match this JQL.") : null,
    h("p", { class: "muted small" }, `${issues.length} results`),
  ]);
}

function fieldText(f, v) {
  if (v == null || v === "") return "";
  if (f.type === "select") return v.value;
  if (f.type === "user") return v.displayName;
  if (f.type === "url") return h("a", { href: v, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() }, v.length > 48 ? v.slice(0, 48) + "…" : v);
  return String(v);
}

// ---------- issue ----------
async function issueView(key) {
  let i;
  try { i = await api(`/issue/${key}`); } catch (e) { return shell("", [h("h1", {}, "Work item not found"), h("p", { class: "muted" }, e.message)]); }
  const f = i.fields; const p = BOOT.projects.find((x) => x.key === f.project.key);
  const save = async (fields) => { try { await api(`/issue/${i.key}`, { method: "PUT", body: { fields } }); toast("Saved", "good"); render(); } catch (e) { fail(e); } };

  const summary = h("div", { class: "summary-edit", title: "Click to edit", onclick: () => {
    const inp = h("input", { class: "summary-input", value: f.summary, onkeydown: (e) => { if (e.key === "Enter") save({ summary: inp.value }); if (e.key === "Escape") render(); }, onblur: () => inp.value !== f.summary ? save({ summary: inp.value }) : render() });
    summary.replaceWith(inp); inp.focus(); inp.select();
  } }, f.summary);

  const descText = docText(f.description);
  const desc = h("div", { class: "desc", title: "Click to edit", onclick: () => {
    const ta = h("textarea", {}, descText);
    const box = h("div", {}, ta, h("div", { class: "actions-row" }, h("button", { class: "btn primary small", onclick: () => save({ description: ta.value }) }, "Save"), h("button", { class: "btn subtle small", onclick: () => render() }, "Cancel")));
    desc.replaceWith(box); ta.focus();
  } }, descText || h("span", { class: "muted" }, "Add a description…"));

  // children / subtasks
  const subType = p.issueTypes.find((t) => t.subtask);
  const isSub = f.issuetype.subtask;
  const kids = i.children || [];
  const doneKids = kids.filter((k) => k.fields.status.statusCategory.key === "done").length;
  const childBox = h("div", {});
  const addChild = () => {
    const types = p.issueTypes.filter((t) => (f.issuetype.hierarchyLevel === 1 ? t.hierarchyLevel === 0 : t.subtask));
    const sel = h("select", { style: { height: "32px" } }, types.map((t) => h("option", { value: t.name }, t.name)));
    const inp = h("input", { type: "text", placeholder: "What needs to be done?", style: { flex: "1", height: "32px", border: "2px solid var(--focus)", borderRadius: "3px", padding: "0 8px", background: "var(--surface)" } });
    const create = async () => { if (!inp.value.trim()) return; try { await api("/issue", { method: "POST", body: { project: p.key, issueType: sel.value, summary: inp.value, parent: i.key } }); render(); } catch (e) { fail(e); } };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); if (e.key === "Escape") render(); });
    childBox.replaceChildren(h("div", { style: { display: "flex", gap: "6px", marginTop: "6px" } }, sel, inp, h("button", { class: "btn primary", onclick: create }, "Create")));
    inp.focus();
  };
  const canHaveChildren = !isSub && (f.issuetype.hierarchyLevel === 1 || subType);

  // attachments
  const fileInput = h("input", { type: "file", multiple: true, hidden: true, onchange: async (e) => { const fd = new FormData(); for (const file of e.target.files) fd.append("file", file); try { await api(`/issue/${i.key}/attachments`, { method: "POST", body: fd }); toast("Attached", "good"); render(); } catch (err) { fail(err); } } });

  // status + automation menus
  const statusBtn = h("button", { class: `btn status-btn ${cat(f.status)}` }, f.status.name, svg(ICON.chev));
  const statusMenu = menu(statusBtn, i.transitions.length ? i.transitions.map((t) => ({ label: t.name, hint: `→ ${t.to.name}`, run: async () => { try { await api(`/issue/${i.key}/transition`, { method: "POST", body: { id: t.id } }); toast(`${i.key}: ${f.status.name} → ${t.to.name}`, "good"); render(); } catch (e) { fail(e); } } })) : [{ label: "No transitions available", run: () => {} }]);
  const autoMenu = i.manualRules.length ? menu(h("button", { class: "btn" }, svg(ICON.bolt), "Automation", svg(ICON.chev)), i.manualRules.map((r) => ({ label: r.name, run: async () => { try { const a = await api(`/issue/${i.key}/automation/${r.id}`, { method: "POST" }); toast(`${r.name}: ${a.status}`, a.status === "SUCCESS" ? "good" : "bad"); render(); } catch (e) { fail(e); } } }))) : null;

  // details
  const defs = fieldDefs();
  const filled = defs.filter((d) => f[d.id] != null && f[d.id] !== "");
  const empty = defs.filter((d) => !(f[d.id] != null && f[d.id] !== ""));
  const detail = (d) => h("div", { class: "field" }, h("div", { class: "label", title: d.description || d.id }, d.name), editor(d, f[d.id], (v) => save({ [d.id]: v })));
  const assignee = h("select", { onchange: (e) => save({ assignee: e.target.value || null }) }, h("option", { value: "" }, "Unassigned"), BOOT.users.map((u) => h("option", { value: u.accountId, selected: f.assignee?.accountId === u.accountId }, u.displayName)));

  const tabs = ["comments", "history", "all"];
  const activity = activityList(i);
  const commentBox = h("textarea", { placeholder: "Add a comment…", style: { minHeight: "64px" } });

  const curlBase = `${BOOT.baseUrl}/rest/api/3/issue/${i.key}`;
  return shell("", [
    h("div", { class: "crumbs" }, nav(`/projects/${p.key}/board`, p.name), " / ", f.parent ? [nav(`/browse/${f.parent.key}`, f.parent.key), " / "] : null, h("span", { class: "userchip" }, typeIcon(f.issuetype), i.key)),
    h("div", { class: "issue" },
      h("div", {},
        summary,
        h("div", { class: "actions-row" },
          h("button", { class: "btn", onclick: () => fileInput.click() }, svg(ICON.clip), "Attach"), fileInput,
          canHaveChildren ? h("button", { class: "btn", onclick: addChild }, svg(ICON.plus), f.issuetype.hierarchyLevel === 1 ? "Add child work item" : "Add subtask") : null),
        h("h3", {}, "Description"), desc,
        canHaveChildren ? [
          h("h3", {}, f.issuetype.hierarchyLevel === 1 ? "Child work items" : "Subtasks", kids.length ? h("span", { class: "muted small" }, `  ${doneKids} of ${kids.length} done`) : null),
          kids.length ? h("div", { class: "progress" }, h("div", { style: { width: `${(doneKids / kids.length) * 100}%` } })) : null,
          h("div", { class: "panel" }, kids.length ? kids.map((k) => h("div", { class: "childrow", onclick: () => go(`/browse/${k.key}`) }, typeIcon(k.fields.issuetype), h("span", { class: "mono" }, k.key), h("span", { class: "grow" }, k.fields.summary), avatar(k.fields.assignee, "sm"), lozenge(k.fields.status))) : h("div", { class: "childrow muted", onclick: addChild }, "No subtasks yet. Add one.")),
          childBox,
        ] : null,
        f.attachment.length ? [h("h3", {}, `Attachments (${f.attachment.length})`), h("div", { class: "attachments" }, f.attachment.map((a) => h("a", { class: "att", href: `/_mock/api/attachment/${a.id}`, target: "_blank" }, h("div", { class: "fname", title: a.filename }, a.filename), h("div", { class: "muted small" }, `${(a.size / 1024).toFixed(1)} KB · ${a.mimeType}`), h("div", { class: "muted small" }, ago(a.created)))))] : null,
        h("h3", {}, "Activity"),
        h("div", { class: "tabs" }, tabs.map((t) => h("button", { class: state.activityTab === t ? "on" : "", onclick: () => { state.activityTab = t; render(); } }, t[0].toUpperCase() + t.slice(1)))),
        state.activityTab !== "history" ? h("div", { class: "comment" }, avatar(userById(ME)), h("div", { style: { flex: "1" } }, commentBox, h("div", { class: "actions-row" }, h("button", { class: "btn primary small", onclick: async () => { if (!commentBox.value.trim()) return; try { await api(`/issue/${i.key}/comment`, { method: "POST", body: { text: commentBox.value } }); render(); } catch (e) { fail(e); } } }, "Save")))) : null,
        activity),
      h("div", {},
        h("div", { class: "actions-row", style: { marginTop: "0" } }, statusMenu, autoMenu),
        h("div", { class: "panel" },
          h("div", { class: "ph" }, "Details"),
          h("div", { class: "field" }, h("div", { class: "label" }, "Assignee"), assignee),
          h("div", { class: "field" }, h("div", { class: "label" }, "Reporter"), f.reporter ? h("span", { class: "userchip" }, avatar(f.reporter, "sm"), f.reporter.displayName) : "None"),
          filled.map(detail),
          empty.length ? (state.showEmpty ? empty.map(detail) : h("div", { class: "field" }, h("button", { class: "btn subtle small", onclick: () => { state.showEmpty = true; render(); } }, `Show ${empty.length} more fields`))) : null),
        h("p", { class: "muted small" }, `Created ${fmtDate(f.created)}`, h("br"), `Updated ${fmtDate(f.updated)}`, f.resolutiondate ? [h("br"), `Resolved ${fmtDate(f.resolutiondate)}`] : null),
        h("details", { class: "dev" }, h("summary", { class: "muted" }, "Developer: this work item over the REST API"),
          h("pre", {}, `curl -u "$JIRA_USER:$JIRA_TOKEN" \\\n  "${curlBase}?expand=names"`),
          h("pre", {}, `curl -u "$JIRA_USER:$JIRA_TOKEN" -X POST -H "Content-Type: application/json" \\\n  "${curlBase}/transitions" \\\n  -d '{"transition":{"id":"${i.transitions[0]?.id || "11"}"}}'`),
          h("p", { class: "muted" }, "Field IDs: ", defs.map((d) => `${d.name} = ${d.id}`).join(" · ")),
          h("p", { class: "muted" }, "Transitions from here: ", i.transitions.map((t) => `${t.id} ${t.name} → ${t.to.name}`).join(" · ") || "none")))),
  ]);
}

function docText(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  const walk = (n) => (n.type === "text" ? n.text : n.type === "hardBreak" ? "\n" : (n.content || []).map(walk).join("") + (["paragraph", "heading", "listItem"].includes(n.type) ? "\n" : ""));
  return walk(doc).trim();
}

function editor(d, v, onSave) {
  if (d.type === "select") return h("select", { onchange: (e) => onSave(e.target.value ? { value: e.target.value } : null) }, h("option", { value: "" }, "None"), (d.options || []).map((o) => h("option", { value: o.value, selected: v?.value === o.value }, o.value)));
  if (d.type === "user") return h("select", { onchange: (e) => onSave(e.target.value || null) }, h("option", { value: "" }, "None"), BOOT.users.map((u) => h("option", { value: u.accountId, selected: v?.accountId === u.accountId }, u.displayName)));
  const input = h("input", { type: d.type === "number" ? "number" : "text", value: v ?? "", placeholder: "None", title: d.type === "url" && v ? v : "" });
  const commit = () => { const raw = input.value; if (String(raw) === String(v ?? "")) return; onSave(raw === "" ? null : d.type === "number" ? Number(raw) : raw); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("blur", commit);
  if (d.type === "url" && v) return h("div", { style: { display: "flex", gap: "4px", alignItems: "center" } }, input, h("a", { href: v, target: "_blank", rel: "noopener", title: "Open" }, "↗"));
  return input;
}

function activityList(i) {
  const f = i.fields;
  const comments = f.comment.comments.map((c) => ({ at: c.created, node: h("div", { class: "comment" }, avatar(c.author), h("div", {}, h("span", { class: "who" }, c.author?.displayName || "Automation"), h("span", { class: "when" }, ago(c.created)), h("div", { class: "text" }, docText(c.body)))) }));
  const hist = (i.changelog?.histories || []).map((hh) => ({ at: hh.created, node: h("div", { class: "hist comment" }, avatar(hh.author), h("div", { style: { flex: 1 } }, h("span", { class: "who" }, hh.author?.displayName || "Automation"), h("span", { class: "when" }, ago(hh.created)),
    hh.items.map((it) => h("div", { class: "item", style: { marginLeft: 0 } }, "changed ", h("b", {}, it.field), ": ", h("span", {}, it.fromString ?? "None"), " → ", h("span", {}, it.toString ?? "None"))))) }));
  const pick = state.activityTab === "comments" ? comments : state.activityTab === "history" ? hist : [...comments, ...hist];
  pick.sort((a, b) => (a.at < b.at ? 1 : -1));
  return pick.length ? pick.map((x) => x.node) : h("p", { class: "muted" }, state.activityTab === "history" ? "No changes yet." : "No comments yet.");
}

// ---------- create dialog ----------
function createDialog(defaults = {}) {
  const p = project();
  const close = () => bd.remove();
  const types = p.issueTypes;
  const typeSel = h("select", {}, types.map((t) => h("option", { value: t.name, selected: t.name === defaults.issueType }, t.name)));
  const parentRow = h("div", { class: "form-row" });
  const summary = h("input", { type: "text", placeholder: "Summary" });
  const desc = h("textarea", { placeholder: "Description" });
  const assignee = h("select", {}, h("option", { value: "" }, "Unassigned"), BOOT.users.map((u) => h("option", { value: u.accountId }, u.displayName)));
  const customRows = h("div", {});
  const values = {};
  const refreshParent = async () => {
    const t = types.find((x) => x.name === typeSel.value);
    parentRow.replaceChildren();
    if (t.subtask || t.hierarchyLevel === 0) {
      const all = await api(`/issues?project=${p.key}`);
      const candidates = all.filter((x) => (t.subtask ? !x.fields.issuetype.subtask : x.fields.issuetype.hierarchyLevel === 1));
      if (t.subtask || candidates.length) parentRow.append(h("label", {}, t.subtask ? "Parent (required)" : "Parent"), h("select", { id: "cparent" }, t.subtask ? null : h("option", { value: "" }, "None"), candidates.map((c) => h("option", { value: c.key, selected: c.key === defaults.parent }, `${c.key} ${c.fields.summary}`))));
    }
  };
  typeSel.addEventListener("change", refreshParent);
  for (const d of fieldDefs()) customRows.append(h("div", { class: "form-row" }, h("label", {}, d.name), d.type === "select" ? h("select", { onchange: (e) => (values[d.id] = e.target.value ? { value: e.target.value } : undefined) }, h("option", { value: "" }, "None"), d.options.map((o) => h("option", { value: o.value }, o.value))) : h("input", { type: d.type === "number" ? "number" : "text", oninput: (e) => (values[d.id] = e.target.value === "" ? undefined : d.type === "number" ? Number(e.target.value) : e.target.value) })));
  const submit = async () => {
    try {
      const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      const created = await api("/issue", { method: "POST", body: { project: p.key, issueType: typeSel.value, summary: summary.value, description: desc.value, parent: $("#cparent", bd)?.value || undefined, assignee: assignee.value || undefined, fields } });
      close(); toast(`Created ${created.key}`, "good"); go(`/browse/${created.key}`);
    } catch (e) { fail(e); }
  };
  const bd = h("div", { class: "backdrop", onclick: (e) => { if (e.target === bd) close(); } },
    h("div", { class: "modal", role: "dialog", "aria-label": "Create" },
      h("div", { class: "mh" }, "Create"),
      h("div", { class: "mb" },
        h("div", { class: "form-row" }, h("label", {}, "Space"), h("input", { type: "text", value: `${p.name} (${p.key})`, disabled: true })),
        h("div", { class: "form-row" }, h("label", {}, "Work type"), typeSel),
        parentRow,
        h("div", { class: "form-row" }, h("label", {}, "Summary (required)"), summary),
        h("div", { class: "form-row" }, h("label", {}, "Description"), desc),
        h("div", { class: "form-row" }, h("label", {}, "Assignee"), assignee),
        h("details", {}, h("summary", { class: "muted", style: { marginBottom: "8px" } }, "More fields"), customRows)),
      h("div", { class: "mf" }, h("button", { class: "btn subtle", onclick: close }, "Cancel"), h("button", { class: "btn primary", onclick: submit }, "Create"))));
  document.body.append(bd);
  refreshParent();
  summary.focus();
}

// ---------- automation ----------
function describeTrigger(t = {}) {
  const arr = (x) => [].concat(x).join(" or ");
  switch (t.type) {
    case "issue_transitioned": return `Work item transitioned${t.from ? ` from ${arr(t.from)}` : ""}${t.to ? ` to ${arr(t.to)}` : ""}`;
    case "field_value_changed": return `Field changed: ${arr(t.fields || t.field)}`;
    case "issue_created": return "Work item created";
    case "comment_added": return "Comment added";
    case "attachment_added": return "Attachment added";
    case "manual": return "Manual trigger from a work item";
    case "incoming_webhook": return "Incoming webhook";
    default: return t.type || "?";
  }
}
const auditLz = (s) => h("span", { class: `lz ${s === "SUCCESS" ? "done" : s === "SOME_ERRORS" ? "warn" : s === "FAILURE" ? "bad" : ""}` }, s.replace(/_/g, " "));

async function automationView() {
  const tab = new URLSearchParams(location.search).get("tab") || "rules";
  const [boot, audit] = await Promise.all([api("/bootstrap"), api("/audit?limit=200")]);
  BOOT.rules = boot.rules;
  const tabs = h("div", { class: "tabs" }, [["rules", "Rules"], ["audit", `Audit log (${audit.length})`]].map(([k, l]) => h("button", { class: tab === k ? "on" : "", onclick: () => go(`/automation?tab=${k}`) }, l)));
  let body;
  if (tab === "rules") {
    body = BOOT.rules.length ? BOOT.rules.map((r) => {
      const detail = h("div", { class: "rb", hidden: true },
        h("div", { class: "kv" }, h("div", {}, "Trigger"), h("div", {}, describeTrigger(r.trigger), r.trigger.issueTypes ? ` · work types: ${r.trigger.issueTypes.join(", ")}` : ""),
          h("div", {}, "Rule-triggered changes"), h("div", {}, r.allowRuleTrigger ? "Allowed (fires on changes made by other rules)" : "Ignored (default)"),
          r.trigger.type === "incoming_webhook" ? [h("div", {}, "Webhook URL"), h("div", { class: "mono" }, `POST ${BOOT.baseUrl}/_mock/automation/webhook/${r.id}`, h("br"), `X-Automation-Webhook-Token: ${r.trigger.token || "(none)"}`)] : null),
        h("h3", {}, "Definition"), h("pre", {}, JSON.stringify({ trigger: r.trigger, conditions: r.conditions, actions: r.actions }, null, 2)));
      const sw = h("button", { class: `switch ${r.enabled ? "on" : ""}`, title: r.enabled ? "Enabled" : "Disabled", onclick: async (e) => { e.stopPropagation(); try { await api(`/rules/${r.id}/toggle`, { method: "POST", body: { enabled: !r.enabled } }); render(); } catch (err) { fail(err); } } });
      const last = audit.find((a) => a.ruleId === r.id);
      return h("div", { class: "rule" },
        h("div", { class: "rh", onclick: () => (detail.hidden = !detail.hidden) }, sw, h("div", { class: "grow" }, h("div", { style: { fontWeight: 600 } }, r.name), h("div", { class: "muted small" }, describeTrigger(r.trigger), ` · ${countActions(r.actions)} actions`)), last ? h("span", { class: "small muted" }, "Last run ", ago(last.finished), " ", auditLz(last.status)) : h("span", { class: "small muted" }, "Never run")),
        detail);
    }) : h("div", { class: "empty" }, "No automation rules in this workspace.");
  } else {
    body = audit.length ? h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Rule"), h("th", {}, "Work item"), h("th", {}, "Status"), h("th", {}, "Duration"))),
      h("tbody", {}, audit.map((a) => {
        const row = h("tr", { class: "click" }, h("td", { class: "small" }, new Date(a.started).toLocaleString()), h("td", {}, a.ruleName, h("div", { class: "muted small" }, a.trigger)), h("td", {}, a.issueKey ? nav(`/browse/${a.issueKey}`, a.issueKey) : "—"), h("td", {}, auditLz(a.status)), h("td", { class: "small muted" }, `${a.durationMs} ms`));
        const det = h("tr", { hidden: true }, h("td", { colspan: 5 }, a.items.map((it) => h("div", { class: `audit-item ${it.ok ? "" : "bad"}` }, it.ok ? "✓ " : "✗ ", h("b", {}, it.kind.replace(/_/g, " ")), " — ", it.message, it.detail ? h("pre", {}, JSON.stringify(it.detail, null, 2)) : null))));
        row.addEventListener("click", (e) => { if (!e.target.closest("a")) det.hidden = !det.hidden; });
        return [row, det];
      }))) : h("div", { class: "empty" }, "No rule has run yet.");
  }
  return shell("automation", [h("div", { class: "crumbs" }, "Space settings"), h("h1", {}, "Automation"), tabs, body]);
}
const countActions = (acts = []) => acts.reduce((n, a) => n + 1 + countActions(a.actions || []) + countActions(a.then || []) + countActions(a.else || []), 0);

// ---------- settings ----------
function settingsView() {
  const tab = new URLSearchParams(location.search).get("tab") || "fields";
  const tabs = h("div", { class: "tabs" }, [["fields", "Fields"], ["workflows", "Workflows"], ["types", "Work types"], ["people", "People"], ["data", "Data"]].map(([k, l]) => h("button", { class: tab === k ? "on" : "", onclick: () => go(`/settings?tab=${k}`) }, l)));
  let body;
  if (tab === "fields") body = h("table", { class: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "ID"), h("th", {}, "Type"), h("th", {}, "Options"), h("th", {}, "JQL"))),
    h("tbody", {}, fieldDefs().map((f) => h("tr", {}, h("td", {}, f.name, f.description ? h("div", { class: "muted small" }, f.description) : null), h("td", { class: "mono" }, f.id), h("td", {}, f.type), h("td", {}, (f.options || []).map((o) => o.value).join(", ")), h("td", { class: "mono small" }, (f.clauseNames || []).join(" · "))))));
  else if (tab === "workflows") body = Object.values(BOOT.workflows).map((w) => [h("h2", {}, w.name),
    h("div", { class: "actions-row" }, w.statuses.map((s) => h("span", { class: `lz ${s.category}` }, s.name))),
    h("table", { class: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, "ID"), h("th", {}, "Transition"), h("th", {}, "From"), h("th", {}, "To"))), h("tbody", {}, w.transitions.map((t) => h("tr", {}, h("td", { class: "mono" }, t.id), h("td", {}, t.name), h("td", {}, t.from ? [].concat(t.from).join(", ") : "Any status"), h("td", {}, t.to)))))]);
  else if (tab === "types") body = BOOT.projects.map((p) => [h("h2", {}, `${p.name} (${p.key})`), h("table", { class: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Work type"), h("th", {}, "ID"), h("th", {}, "Level"), h("th", {}, "Workflow"))), h("tbody", {}, p.issueTypes.map((t) => h("tr", {}, h("td", {}, typeIcon(t)), h("td", {}, t.name, t.description ? h("div", { class: "muted small" }, t.description) : null), h("td", { class: "mono" }, t.id), h("td", {}, t.subtask ? "Subtask" : t.hierarchyLevel === 1 ? "Epic" : "Standard"), h("td", {}, t.workflow)))))]);
  else if (tab === "people") body = h("table", { class: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Account ID"), h("th", {}, "Email visible to API"), h("th", {}, "API access"))),
    h("tbody", {}, BOOT.users.map((u) => h("tr", {}, h("td", {}, h("span", { class: "userchip" }, avatar(u, "sm"), u.displayName)), h("td", {}, u.emailAddress), h("td", { class: "mono small" }, u.accountId), h("td", {}, u.emailVisible ? "Yes" : h("span", { class: "lz warn" }, "Hidden")), h("td", {}, u.apiAccess ? "Token" : "—")))));
  else body = h("div", {}, h("p", {}, "Workspace file: ", h("code", {}, BOOT.workspace)), h("p", { class: "muted" }, "Reset deletes every work item, comment, attachment and audit entry, then re-seeds from the workspace file."),
    h("button", { class: "btn danger", onclick: async () => { if (!confirm("Reset all mock data and re-seed?")) return; try { await api("/reset", { method: "POST" }); BOOT = await api("/bootstrap"); toast("Reset done", "good"); go(`/projects/${project().key}/board`); } catch (e) { fail(e); } } }, "Reset demo data"));
  return shell("settings", [h("div", { class: "crumbs" }, "Space settings"), h("h1", {}, "Fields & workflows"), tabs, body]);
}

// ---------- API ----------
const ENDPOINTS = [
  ["GET", "/rest/api/3/myself"], ["GET", "/rest/api/3/serverInfo"], ["GET", "/rest/api/3/user?accountId= · /user/search?query="],
  ["GET", "/rest/api/3/project · /project/{key} · /project/{key}/statuses · /project/search"], ["GET", "/rest/api/3/field · /field/{id}/context · /field/{id}/context/{ctx}/option"],
  ["GET", "/rest/api/3/issuetype · /status"], ["GET/POST", "/rest/api/3/search/jql (nextPageToken) · /rest/api/3/search (startAt) · /search/approximate-count"],
  ["POST", "/rest/api/3/issue"], ["GET/PUT/DELETE", "/rest/api/3/issue/{key}  (fields=, expand=names,schema,transitions,changelog)"], ["PUT", "/rest/api/3/issue/{key}/assignee"],
  ["GET/POST", "/rest/api/3/issue/{key}/transitions"], ["GET/POST", "/rest/api/3/issue/{key}/comment"], ["GET", "/rest/api/3/issue/{key}/changelog"],
  ["POST", "/rest/api/3/issue/{key}/attachments  (multipart 'file', X-Atlassian-Token: no-check)"], ["GET/DELETE", "/rest/api/3/attachment/{id} · GET /attachment/content/{id}"],
  ["—", "/rest/api/2/* mirrors v3 with plain-text description and comment bodies"], ["POST", "/_mock/automation/webhook/{ruleId}  (X-Automation-Webhook-Token)"],
];
async function apiView() {
  const [creds, log] = await Promise.all([api("/credentials"), api("/api-log?limit=60")]);
  const reveal = (t) => { const s = h("span", { class: "mono" }, t.slice(0, 6) + "•".repeat(12)); return h("span", {}, s, " ", h("button", { class: "btn subtle small", onclick: () => { s.textContent = t; } }, "Reveal"), h("button", { class: "btn subtle small", onclick: () => navigator.clipboard.writeText(t).then(() => toast("Copied", "good")) }, "Copy")); };
  return shell("api", [
    h("div", { class: "crumbs" }, "Developers"), h("h1", {}, "API & credentials"),
    h("div", { class: "kv" }, h("div", {}, "Base URL"), h("div", { class: "mono" }, BOOT.baseUrl), h("div", {}, "Auth"), h("div", {}, "Basic auth with email + API token (like Jira Cloud), or Bearer <token> (like a Data Center PAT).")),
    h("h2", {}, "API users"),
    h("table", { class: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, "User"), h("th", {}, "Email"), h("th", {}, "API token"))), h("tbody", {}, creds.map((c) => h("tr", {}, h("td", {}, c.displayName), h("td", { class: "mono" }, c.emailAddress), h("td", {}, reveal(c.apiToken)))))),
    h("pre", {}, `export JIRA_BASE=${BOOT.baseUrl}\nexport JIRA_USER=${creds[0]?.emailAddress || "svc@mock.local"}\nexport JIRA_TOKEN=<token above>\ncurl -u "$JIRA_USER:$JIRA_TOKEN" "$JIRA_BASE/rest/api/3/search/jql?jql=project%20%3D%20${project().key}&fields=summary,status"`),
    h("h2", {}, "Supported endpoints"),
    h("table", { class: "grid" }, h("tbody", {}, ENDPOINTS.map(([m, p]) => h("tr", {}, h("td", { class: "mono small", style: { whiteSpace: "nowrap" } }, m), h("td", { class: "mono small" }, p))))),
    h("p", { class: "muted small" }, "Anything else returns 404 with a kaiju message, so an unsupported call is obvious rather than silently wrong."),
    h("h2", {}, "Recent API calls"),
    log.length ? h("table", { class: "grid" }, h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Call"), h("th", {}, "Status"), h("th", {}, "User"), h("th", {}, "ms"))),
      h("tbody", {}, log.map((l) => { const row = h("tr", { class: l.body ? "click" : "" }, h("td", { class: "small" }, new Date(l.at).toLocaleTimeString()), h("td", { class: "mono small" }, `${l.method} ${l.path}`), h("td", {}, h("span", { class: `lz ${l.status < 300 ? "done" : l.status < 500 ? "warn" : "bad"}` }, String(l.status))), h("td", { class: "small" }, l.user || "anonymous"), h("td", { class: "small muted" }, String(l.ms)));
        const det = l.body ? h("tr", { hidden: true }, h("td", { colspan: 5 }, h("pre", {}, l.body))) : null; if (det) row.addEventListener("click", () => (det.hidden = !det.hidden)); return [row, det]; }))) : h("div", { class: "empty" }, "No API calls yet."),
  ]);
}

// ---------- router ----------
let rendering = false;
async function render() {
  if (rendering) return; rendering = true;
  try {
    const path = location.pathname;
    const scroll = $("#main")?.scrollTop || 0;
    let view;
    if (path === "/" || path === "/projects" || path === "/projects/") { history.replaceState({}, "", `/projects/${project().key}/board`); view = await boardView(); }
    else if (/^\/projects\/[^/]+\/list/.test(path)) view = await listView();
    else if (/^\/projects\/[^/]+/.test(path)) view = await boardView();
    else if (path.startsWith("/browse/")) view = await issueView(decodeURIComponent(path.split("/")[2]));
    else if (path === "/automation") view = await automationView();
    else if (path === "/settings") view = settingsView();
    else if (path === "/api-docs") view = await apiView();
    else view = await boardView();
    $("#app").replaceChildren(view);
    const m = $("#main"); if (m && sameRoute(path)) m.scrollTop = scroll;
    document.title = `${path.startsWith("/browse/") ? path.split("/")[2] + " · " : ""}${BOOT.site.name}`;
  } catch (e) { fail(e); } finally { rendering = false; }
}
let lastPath = null;
const sameRoute = (p) => { const same = lastPath === p; lastPath = p; return same; };

async function poll() {
  try {
    const { v } = await api("/version");
    const busy = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && document.activeElement.closest("#main");
    const open = $(".backdrop") || [...document.querySelectorAll(".menu .pop")].some((p) => !p.hidden) || [...document.querySelectorAll("tr:not([hidden]) pre, .rb:not([hidden])")].length;
    if (VERSION && v !== VERSION && !busy && !open) render();
    if (!busy && !open) VERSION = v;
  } catch { /* server restarting */ }
  setTimeout(poll, 2000);
}

(async function start() {
  BOOT = await api("/bootstrap").catch((e) => { $("#app").textContent = `Could not reach the mock: ${e.message}`; throw e; });
  ME = localStorage.getItem("jm.me");
  // Default to a person, not the integration account: site.defaultUser, else the second user, else the first.
  if (!BOOT.users.some((u) => u.accountId === ME)) ME = (BOOT.users.find((u) => u.emailAddress === BOOT.site.defaultUser) || BOOT.users[1] || BOOT.users[0]).accountId;
  await render();
  VERSION = (await api("/version")).v;
  poll();
})();
