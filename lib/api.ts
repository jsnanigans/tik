import { type Credentials, makeAuthHeader } from "./credentials";
import { customFields, localConfig } from "./config";

const JIRA_BASE = localConfig.jiraBase;

export async function jiraGet(creds: Credentials, endpoint: string): Promise<unknown> {
  const res = await fetch(`${JIRA_BASE}${endpoint}`, {
    headers: {
      Authorization: makeAuthHeader(creds),
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

/**
 * Resolve an attachment's media-service UUID — the id an ADF `media` node needs
 * to render inline in a comment/description. Jira's attachment REST responses
 * don't expose it; instead the attachment `content` URL 303-redirects to
 * `https://api.media.atlassian.com/file/<uuid>/binary`, so we read the redirect
 * Location (without following it) and pull the UUID out of the path.
 * Returns "" if it can't be resolved.
 */
export async function resolveMediaId(creds: Credentials, attachmentId: string): Promise<string> {
  try {
    const res = await fetch(`${JIRA_BASE}/rest/api/3/attachment/content/${attachmentId}`, {
      headers: { Authorization: makeAuthHeader(creds) },
      redirect: "manual",
    });
    const loc = res.headers.get("location") ?? "";
    return loc.match(/\/file\/([0-9a-f-]{36})/i)?.[1] ?? "";
  } catch {
    return "";
  }
}

export async function jiraPost(
  creds: Credentials,
  endpoint: string,
  payload: unknown
): Promise<unknown> {
  const res = await fetch(`${JIRA_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: makeAuthHeader(creds),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface real failures instead of returning the error body as if it
    // succeeded — a non-2xx here previously looked like success to callers.
    throw new Error(`POST ${endpoint} failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!text) return {};
  return JSON.parse(text);
}

export async function jiraPut(
  creds: Credentials,
  endpoint: string,
  payload: unknown
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${JIRA_BASE}${endpoint}`, {
    method: "PUT",
    headers: {
      Authorization: makeAuthHeader(creds),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  if (!res.ok) {
    try {
      const json = JSON.parse(text);
      return { ok: false, error: json.errorMessages?.join(", ") || JSON.stringify(json) };
    } catch {
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
  }
  return { ok: true };
}

export async function jiraDelete(
  creds: Credentials,
  endpoint: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${JIRA_BASE}${endpoint}`, {
    method: "DELETE",
    headers: {
      Authorization: makeAuthHeader(creds),
      "Content-Type": "application/json",
    },
  });
  if (res.status === 204 || res.ok) return { ok: true };
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return { ok: false, error: json.errorMessages?.join(", ") || JSON.stringify(json) };
  } catch {
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
}

export async function jiraUpload(
  creds: Credentials,
  endpoint: string,
  filename: string,
  data: Blob
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const form = new FormData();
  form.append("file", data, filename);
  const res = await fetch(`${JIRA_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: makeAuthHeader(creds),
      "X-Atlassian-Token": "no-check",
    },
    body: form,
  });
  if (res.ok) {
    const text = await res.text();
    if (text) {
      try { return { ok: true, data: JSON.parse(text) }; } catch {}
    }
    return { ok: true };
  }
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return { ok: false, error: json.errorMessages?.join(", ") || JSON.stringify(json) };
  } catch {
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
}

export async function jiraBulkFetch(creds: Credentials, ids: string[]): Promise<unknown> {
  return jiraPost(creds, "/rest/api/3/issue/bulkfetch", {
    issueIdsOrKeys: ids,
    fields: [
      "key",
      "summary",
      "status",
      "assignee",
      "priority",
      "issuetype",
      "created",
      "updated",
      "creator",
      "reporter",
      "resolution",
      "resolutiondate",
      "duedate",
      ...Object.values(customFields).filter(Boolean),
      "parent",
      "description",
      "labels",
      "issuelinks",
      "attachment",
    ],
  });
}

export type BulkChangelogItem = {
  field: string;
  fieldId?: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
};

export type BulkChangelogHistory = {
  id: string;
  created: number; // epoch millis
  items: BulkChangelogItem[];
  author?: { accountId?: string; displayName?: string; emailAddress?: string };
};

export type BulkChangelogIssue = {
  issueId: string;
  changeHistories: BulkChangelogHistory[];
};

export type BulkChangelogResult = {
  issues: BulkChangelogIssue[];
  nextPageToken?: string;
};

export async function jiraBulkChangelog(
  creds: Credentials,
  keys: string[],
  fieldIds?: string[],
): Promise<BulkChangelogResult> {
  const allIssues: BulkChangelogIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const payload: Record<string, unknown> = {
      issueIdsOrKeys: keys,
    };
    if (fieldIds) payload.fieldIds = fieldIds;
    if (nextPageToken) payload.nextPageToken = nextPageToken;

    const res = await jiraPost(creds, "/rest/api/3/changelog/bulkfetch", payload) as {
      issueChangeLogs?: Array<{ issueId: string; changeHistories?: BulkChangelogHistory[] }>;
      nextPageToken?: string;
    };

    for (const entry of res.issueChangeLogs || []) {
      // Merge: same issueId may appear across pages
      const existing = allIssues.find(i => i.issueId === entry.issueId);
      if (existing) {
        existing.changeHistories.push(...(entry.changeHistories || []));
      } else {
        allIssues.push({
          issueId: entry.issueId,
          changeHistories: entry.changeHistories || [],
        });
      }
    }

    nextPageToken = res.nextPageToken || undefined;
  } while (nextPageToken);

  return { issues: allIssues };
}

export async function jiraSearch(
  creds: Credentials,
  jql: string,
  maxResults: number
): Promise<unknown> {
  const searchResult = (await jiraPost(creds, "/rest/api/3/search/jql", {
    jql,
    maxResults,
  })) as { issues?: { id: string }[] };

  const issues = searchResult.issues;
  if (!issues || issues.length === 0) return searchResult;

  const ids = issues.map((i) => i.id);
  return jiraBulkFetch(creds, ids);
}

export type PaginatedSearchResult = {
  issues: unknown[];
  total: number;
  nextPageToken: string | null;
};

export async function jiraSearchPaginated(
  creds: Credentials,
  jql: string,
  maxResults: number,
  nextPageToken?: string | null
): Promise<PaginatedSearchResult> {
  const payload: Record<string, unknown> = {
    jql,
    maxResults,
  };
  if (nextPageToken) {
    payload.nextPageToken = nextPageToken;
  }

  const searchResult = (await jiraPost(creds, "/rest/api/3/search/jql", payload)) as {
    issues?: { id: string }[];
    total?: number;
    nextPageToken?: string;
    errorMessages?: string[];
  };

  if (searchResult.errorMessages) {
    throw new Error(`Jira API error: ${searchResult.errorMessages.join(", ")}`);
  }

  const issues = searchResult.issues || [];
  const total = searchResult.total || 0;

  if (issues.length === 0) {
    return { issues: [], total, nextPageToken: null };
  }

  const ids = issues.map((i) => i.id);
  const bulkResult = (await jiraBulkFetch(creds, ids)) as { issues?: unknown[] };

  return {
    issues: bulkResult.issues || [],
    total,
    nextPageToken: searchResult.nextPageToken || null,
  };
}
