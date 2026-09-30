# Kaiju

*A smaller monster for your laptop.* Jira's name began as a nickname: Atlassian's developers called Bugzilla "Gojira", Japanese for Godzilla. Kaiju is that family of monster.

Kaiju is a local, API-compatible stand-in for **Jira Cloud** for proofs of concept, demos and integration tests. It serves a practical subset of the Jira REST API (v3 and v2), runs Jira-style **automation rules** (web requests, branches, conditions, smart values, audit log) and has a Jira-like UI (board, list, issue view, automation, settings).

Point code that talks to Jira at `http://localhost:8790` instead of `https://<site>.atlassian.net`. When the real site is ready, change only the base URL, the credential and the field and transition IDs.

> Not affiliated with or endorsed by Atlassian. "Jira" is a trademark of Atlassian; it is used here only to describe API compatibility. The UI follows familiar layout conventions and carries no Atlassian logos or branding.

## Quick start

Requires Node 20 or later.

```bash
npm install
```

```bash
KAIJU_TOKEN=dev-token npm start
```

Open `http://localhost:8790` for the UI. Call the API with Basic auth, exactly like Jira Cloud:

```bash
curl -u "svc@mock.local:dev-token" "http://localhost:8790/rest/api/3/search/jql?jql=project%20%3D%20DEMO&fields=summary,status"
```

Run the smoke test, which starts its own instance on a spare port:

```bash
npm test
```

## Your own workspace

Everything project-specific lives in one JSON workspace file: users, custom fields, workflows, projects and work types, automation rules and seed data. The bundled `workspaces/example.json` is a small generic software project. Point at your own file:

```bash
KAIJU_WORKSPACE=/path/to/my.workspace.json KAIJU_DATA_DIR=/path/to/data npm start
```

State (work items, comments, attachments, audit log) is kept in the data directory. It survives restarts, and **Reset demo data** in the UI (Fields & workflows → Data) re-seeds it from the workspace.

<details>
<summary><b>Workspace file reference</b></summary>

```jsonc
{
  "site": { "name": "Kaiju", "defaultUser": "sam@example.com" },
  "users": [
    // apiToken: literal, "env:NAME" or "env:NAME|default". Omitted = generated and stored in <data>/tokens.json.
    { "displayName": "Integration Service", "emailAddress": "svc@mock.local", "apiToken": "env:KAIJU_TOKEN" },
    // emailVisible:false reproduces Jira hiding a user's email from the API and automation.
    { "displayName": "Chris Park", "emailAddress": "chris@example.com", "emailVisible": false }
  ],
  "fields": [
    // types: string | text | url | number | select | user | labels | date
    { "id": "customfield_10016", "name": "Story Points", "type": "number" },
    { "name": "Environment", "type": "select", "options": ["Dev", "Staging", "Production"] }
  ],
  "workflows": {
    "software": {
      "statuses": [{ "name": "To Do", "category": "new" }, { "name": "In Progress", "category": "indeterminate" }, { "name": "Done", "category": "done" }],
      // omit "from" for a global transition (available from any status)
      "transitions": [{ "id": "21", "name": "Start", "from": ["To Do"], "to": "In Progress" }, { "id": "41", "name": "Done", "to": "Done" }]
    }
  },
  "projects": [
    { "key": "DEMO", "name": "Demo Project", "style": "team-managed",
      "issueTypes": [{ "name": "Epic", "epic": true, "workflow": "software" }, { "name": "Task", "workflow": "software" }, { "name": "Subtask", "subtask": true, "workflow": "software" }] }
  ],
  "variables": { "TARGET_URL": "env:TARGET_URL|http://localhost:8790/_mock/echo" },   // {{var.TARGET_URL}}
  "secrets": { "TARGET_TOKEN": "env:TARGET_TOKEN" },                                     // {{secret.TARGET_TOKEN}}, masked in the audit log
  "automation": [ /* see below */ ],
  "seed": { "issues": [
    { "ref": "e1", "issueType": "Epic", "summary": "Onboarding", "status": "In Progress" },
    { "issueType": "Task", "parent": "e1", "summary": "Sign-up form", "assignee": "sam@example.com",
      "fields": { "Story Points": 3 }, "attachments": ["./files/spec.pdf"], "comments": ["First comment"] }
  ] }
}
```

Field IDs are assigned from `customfield_10000` upward when omitted. Pin them if your integration hard-codes IDs.

</details>

## Automation

Rules run one at a time, and every run is written to the audit log (Automation → Audit log). Each log entry records the trigger, every condition, and every web request with its request and response. The mock deliberately keeps the Jira Cloud behaviours that catch people out:

- **Rule-made changes don't trigger other rules** unless the rule sets `"allowRuleTrigger": true`. Skipped runs still appear in the audit log with a note.
- **Smart values read a snapshot** taken when the rule started. Add `{ "type": "refetch" }` after an edit if later actions need the new value.
- **A failed web request stops the rule** unless the action sets `"continueOnError": true`.
- **Number fields render as `2.0`** in smart values. Use `.format("0")` for an integer.

<details>
<summary><b>Triggers, conditions and actions</b></summary>

**Triggers:** `issue_created`, `issue_transitioned` (`from`, `to`), `field_value_changed` (`fields`), `comment_added`, `attachment_added`, `manual` (a button in the issue view's Automation menu), `incoming_webhook` (`POST /_mock/automation/webhook/{ruleId}` with `X-Automation-Webhook-Token`). All take optional `issueTypes`, and rules take an optional `project`.

**Conditions:** `from_status`, `status`, `issue_type`, `field` (`op`: `= != > < >= <= in contains is_empty is_not_empty`), `subtasks` / `children` (`match`: `all | any | none`, `status: [...]`), `compare` (two smart-value strings), `jql`.

**Actions:** `send_web_request` (`url`, `method`, `headers`, `body` as a string template or a JSON object whose strings are templates, `timeoutMs`), `edit_issue` (`fields` by name or ID), `transition_issue` (`to`: a status or transition name), `comment`, `create_issue`, `branch` (`on`: `subtasks | children | parent | jql`, with its own conditions and actions), `if` (`conditions`, `then`, `else`), `refetch`, `log`. Add `continueOnError` to any action.

```json
{
  "id": "close-parent", "name": "When all subtasks are done, close the parent",
  "trigger": { "type": "issue_transitioned", "to": "Done", "issueTypes": ["Subtask"] },
  "actions": [{ "type": "branch", "on": "parent",
    "conditions": [{ "type": "subtasks", "match": "all", "status": ["Done"] }],
    "actions": [{ "type": "transition_issue", "to": "Done", "comment": "All subtasks are done." }] }]
}
```

</details>

<details>
<summary><b>Smart values</b></summary>

| Expression | Value |
| --- | --- |
| `{{issue.key}}`, `{{issue.summary}}`, `{{issue.status}}`, `{{issue.url}}` | Work item basics |
| `{{issue.Story Points}}` or `{{issue.customfield_10016}}` | A custom field by name or ID; select fields render their value |
| `{{issue.assignee.emailAddress}}`, `{{issue.reporter.displayName}}` | People; email is empty when the user hides it |
| `{{issue.parent.key}}`, `{{issue.parent.Story Points}}` | The parent's fields |
| `{{issue.attachment.last.content}}`, `.filename` | Attachments (also `issue.attachments`) |
| `{{#issue.subtasks}}{{key}}{{^last}},{{/}}{{/}}` | Loop over subtasks or children |
| `{{webResponse.status}}`, `{{webResponse.body.some.path}}` | The last web request's response |
| `{{webhookData.anything}}` | The incoming webhook payload |
| `{{var.NAME}}`, `{{secret.NAME}}`, `{{now}}`, `{{rule.name}}`, `{{initiator.displayName}}` | Context |
| `{{#=}}{{issue.Story Points}} * 2{{/}}` | Arithmetic |

Methods: `.plus(n) .minus(n) .multiply(n) .divide(n) .format("0.0") .asNumber .jsonEncode .asJsonString .urlEncode .toLowerCase .toUpperCase .trim .size .first .last .isEmpty .isNotEmpty .substring(a,b) .replace("a","b")`.

</details>

## REST API coverage

Authenticate with **Basic** (`email:apiToken`, as on Jira Cloud) or **Bearer** (`<apiToken>`, as a Data Center personal access token). Responses use Jira's shapes and error format (`{"errorMessages":[],"errors":{}}`). Any call the mock doesn't implement returns a 404 that says so, rather than something that looks right but isn't.

<details>
<summary><b>Supported endpoints</b></summary>

| Method | Path (under `/rest/api/3`, also `/rest/api/2` and `/rest/api/latest`) |
| --- | --- |
| GET | `/myself`, `/serverInfo`, `/user?accountId=`, `/user/search?query=`, `/user/assignable/search` |
| GET | `/project`, `/project/search`, `/project/{key}`, `/project/{key}/statuses` |
| GET | `/field`, `/field/{id}/context`, `/field/{id}/context/{ctx}/option`, `/issuetype`, `/status` |
| GET/POST | `/search/jql` (with `nextPageToken`), `/search` (legacy, with `startAt`), `/search/approximate-count` |
| POST | `/issue` |
| GET/PUT/DELETE | `/issue/{key}`; GET takes `fields=` and `expand=names,schema,transitions,changelog`; PUT takes `fields` and `update` (set, label add and remove, comment add) |
| PUT | `/issue/{key}/assignee` |
| GET/POST | `/issue/{key}/transitions` (POST takes `transition`, `fields`, `update.comment`) |
| GET/POST | `/issue/{key}/comment` |
| GET | `/issue/{key}/changelog` |
| POST | `/issue/{key}/attachments` (multipart `file`, requires `X-Atlassian-Token: no-check`) |
| GET/DELETE | `/attachment/{id}`; GET `/attachment/content/{id}` |

v2 differs from v3 as it does on Jira: descriptions and comment bodies are plain text instead of Atlassian Document Format.

**JQL subset:** `AND`, `OR`, `NOT`, parentheses; `= != ~ !~ > < >= <= IN`, `NOT IN`, `IS EMPTY`, `IS NOT EMPTY`; fields `project key issuetype status statusCategory parent assignee reporter summary description text comment labels created updated resolved`, `cf[10016]` or a custom field name; `currentUser()`; `ORDER BY`.

**Behaviours reproduced on purpose:** select fields must be sent as `{"value": ...}`; unknown or read-only fields return 400 "cannot be set"; invalid transition IDs return 400; attachments without the XSRF header return 403; hidden user emails are omitted; number fields render as `2.0` in smart values.

**Not implemented:** permissions and roles (every API user can do everything), boards and sprints (Agile API), worklogs, issue links, versions and components, screens, webhooks registered through the admin API (use automation `send_web_request` instead), OAuth.

</details>

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAIJU_PORT` | `8790` | Port |
| `KAIJU_BASE_URL` | `http://localhost:<port>` | Base URL used in `self` and attachment links; set it to the public URL behind a tunnel |
| `KAIJU_WORKSPACE` | `workspaces/example.json` | Workspace file |
| `KAIJU_DATA_DIR` | `data/<workspace name>` | State, attachments, generated tokens |
| `KAIJU_UI_PASSWORD` | unset | Protects the UI with Basic auth (any username); needed to expose the UI |
| `KAIJU_UI_PUBLIC` | unset | `true` exposes the UI without a password (trusted networks only) |

The REST API always requires a token. The UI and its private `/_mock/api` are **local-only by default**: requests that arrive through a proxy or tunnel are refused unless `KAIJU_UI_PASSWORD` is set. The UI's "API & credentials" page shows tokens, so treat it as sensitive.

**Docker:**

```bash
docker build -t kaiju .
```

```bash
docker run -p 8790:8790 -e KAIJU_TOKEN=secret -e KAIJU_UI_PASSWORD=changeme -v kaiju-data:/data kaiju
```

Mount your own workspace with `-v $PWD/my.workspace.json:/app/workspaces/my.json -e KAIJU_WORKSPACE=workspaces/my.json`.

## Exposing it to a cloud service

If a hosted service (for example, a workflow platform's REST connector) must call the mock, put it behind an HTTPS tunnel and set the base URL:

```bash
cloudflared tunnel --url http://localhost:8790
```

```bash
KAIJU_BASE_URL=https://<random>.trycloudflare.com KAIJU_UI_PASSWORD=changeme KAIJU_TOKEN=secret npm start
```

## Project layout

| Path | What |
| --- | --- |
| `src/server.js` | HTTP server: REST routes, auth, UI API, webhooks |
| `src/store.js` | Workspace loading, state, validation, Jira JSON shapes |
| `src/automation.js` | Rule engine and audit log |
| `src/smart.js` | Smart-value templates |
| `src/jql.js` | JQL parser and evaluator |
| `src/adf.js` | Atlassian Document Format helpers |
| `public/` | The UI (no build step) |
| `workspaces/example.json` | Generic example workspace |
| `test/smoke.sh` | End-to-end smoke test |

## License

[MIT](LICENSE)
