# Recipe: Jira Data Center

## What it does

Paste a Jira issue link into an interactive prompt and the provider
attaches the issue's summary, description and comments. How hooks run,
and the limits they must respect, are in
[the URL hooks extension point](../../extension-points/url-hooks.md).

Jira Data Center serves REST API v2. One request returns everything the
hook needs:

```
GET /rest/api/2/issue/{KEY}?fields=summary,status,assignee,reporter,description,comment
Authorization: Bearer <personal access token>
```

Personal access tokens exist since Jira DC 8.14 (Profile → Personal
Access Tokens). Prefer them over basic auth: a PAT can be revoked on its
own and never puts a password in the environment.

## The code

`src/url-hooks/jira.ts`:

```ts
import type { UrlHook } from "@chatbridge/provider";

const JIRA_BASE = "https://jira.example.com";
// Browse URL: https://jira.example.com/browse/PROJ-123
const BROWSE = new RegExp(`^${JIRA_BASE}/browse/([A-Z][A-Z0-9_]+-\\d+)`);

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string } | null;
    reporter: { displayName: string } | null;
    description: string | null;
    comment: {
      total: number;
      comments: Array<{
        author: { displayName: string };
        created: string;
        body: string;
      }>;
    };
  };
}

async function fetchIssue(key: string): Promise<JiraIssue> {
  const token = process.env.JIRA_PAT;
  if (!token) throw new Error("JIRA_PAT is not set");

  const fields = "summary,status,assignee,reporter,description,comment";
  const res = await fetch(
    `${JIRA_BASE}/rest/api/2/issue/${key}?fields=${fields}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    },
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} from Jira: check JIRA_PAT`);
  }
  if (res.status === 404) throw new Error(`${key} not found in Jira`);
  if (!res.ok) throw new Error(`${res.status} from Jira`);
  return (await res.json()) as JiraIssue;
}

function render(issue: JiraIssue): string {
  const f = issue.fields;
  const lines = [
    `# ${issue.key}: ${f.summary}`,
    `Status: ${f.status.name}`,
    `Reporter: ${f.reporter?.displayName ?? "-"}`,
    `Assignee: ${f.assignee?.displayName ?? "-"}`,
    "",
    "## Description",
    f.description?.trim() || "(none)",
    "",
    `## Comments (${f.comment.total})`,
  ];
  if (f.comment.comments.length === 0) lines.push("(none)");
  for (const c of f.comment.comments) {
    lines.push(
      "",
      `### ${c.author.displayName} — ${c.created.slice(0, 16).replace("T", " ")}`,
      c.body.trim(),
    );
  }
  return lines.join("\n");
}

export const jiraHook: UrlHook = {
  match: BROWSE,
  async resolve(url) {
    const key = BROWSE.exec(url)?.[1];
    if (!key) throw new Error("not a Jira issue URL");
    const issue = await fetchIssue(key);
    return {
      label: `Jira: ${issue.key} ${issue.fields.summary}`,
      content: render(issue),
    };
  },
};
```

## Register it

```ts
// src/provider.ts
import { defineProvider } from "@chatbridge/provider";
import { jiraHook } from "./url-hooks/jira.js";

export default defineProvider({
  // ...page methods
  urlHooks: [jiraHook],
});
```

## Use it

```sh
export JIRA_PAT=…
```

Then, in the TUI or the VSCode view:

```
https://jira.example.com/browse/PROJ-123 — suggest a fix plan
```

The history shows one attachment line, `Jira: PROJ-123 <summary>`, and the
prompt the service receives ends with the rendered issue.

## Variations

- **Basic auth** (Jira DC older than 8.14): replace the header with
  `Authorization: Basic ${btoa(`${user}:${password}`)}`. This puts a
  password in the environment; use a PAT whenever the server allows it.
- **Long comment threads** hit the 200 KB cap. Keep the newest N with
  `f.comment.comments.slice(-20)`, or fetch
  `/rest/api/2/issue/{KEY}/comment?orderBy=-created&maxResults=20`
  separately instead of the `comment` field.
- **Wiki markup** (`{code}`, `h2.`, `*bold*`) is passed through as is.
  A chat model reads it fine; no conversion is needed.
- **Fetching through a script** instead of `fetch`: run it from `resolve`
  (`Bun.spawn`, `child_process`) and put its stdout in `content`. The
  framework only sees the returned `{ label, content }`.
- **Several hosts** (Jira and Confluence, say): one hook per host, in
  the order they should be tried. The first `match` wins.

## Verify

`bun run check` in the provider repository, then paste a matching URL into
an interactive prompt: the composer shows the attachment with your label
and the turn succeeds. A wrong token surfaces as
`https://jira.example.com/browse/PROJ-123: 401 from Jira: check JIRA_PAT`
and the input is refilled.
