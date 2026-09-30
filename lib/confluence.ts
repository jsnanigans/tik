import { type Credentials, makeAuthHeader } from "./credentials";
import { localConfig } from "./config";
import { markdownToAdf, adfToMarkdown } from "./markdown";

const CONFLUENCE_BASE = `${localConfig.jiraBase}/wiki`;

export interface ConfluencePage {
  id: string;
  spaceId: string;
  spaceKey: string | null;
  title: string;
  body: string | null;
  version: number;
  parentId: string | null;
  updated: string | null;
}

async function confluenceRequest(
  creds: Credentials,
  method: "GET" | "POST" | "PUT",
  endpoint: string,
  payload?: unknown
): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: makeAuthHeader(creds),
    "Content-Type": "application/json",
  };
  const options: RequestInit = {
    method,
    headers,
  };
  if (payload !== undefined) {
    options.body = JSON.stringify(payload);
  }

  const url = `${CONFLUENCE_BASE}${endpoint}`;
  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text();
    let errorMessage = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) errorMessage = parsed.message;
      else if (parsed.errorMessages) errorMessage = parsed.errorMessages.join(", ");
    } catch {}
    throw new Error(`Confluence API error: ${errorMessage}`);
  }

  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Resolve a space key (e.g., "ENG") to its space ID
export async function resolveSpaceId(creds: Credentials, spaceKey: string): Promise<string> {
  const data = await confluenceRequest(creds, "GET", `/api/v2/spaces?keys=${spaceKey}`);
  if (!data.results || data.results.length === 0) {
    throw new Error(`Confluence space not found for key: ${spaceKey}`);
  }
  return data.results[0].id;
}

// Fetch space key given spaceId
export async function resolveSpaceKey(creds: Credentials, spaceId: string): Promise<string | null> {
  try {
    const data = await confluenceRequest(creds, "GET", `/api/v2/spaces/${spaceId}`);
    return data.key || null;
  } catch {
    return null;
  }
}

// Get a page by ID, including its ADF body
export async function getConfluencePage(creds: Credentials, pageId: string): Promise<ConfluencePage> {
  const data = await confluenceRequest(creds, "GET", `/api/v2/pages/${pageId}?body-format=atlas_doc_format`);
  const adfString = data.body?.atlas_doc_format?.value;
  let bodyMarkdown = "";
  if (adfString) {
    try {
      const adfJson = JSON.parse(adfString);
      bodyMarkdown = adfToMarkdown(adfJson);
    } catch (err) {
      console.warn(`Warning: failed to parse ADF body for page ${pageId}:`, err);
    }
  }

  return {
    id: data.id,
    spaceId: data.spaceId,
    spaceKey: null,
    title: data.title,
    body: bodyMarkdown,
    version: data.version?.number || 1,
    parentId: data.parentId || null,
    updated: data.version?.createdAt || data.createdAt || null,
  };
}

// Create a new page
export async function createConfluencePage(
  creds: Credentials,
  params: {
    title: string;
    spaceId: string;
    markdown: string;
    parentId?: string;
  }
): Promise<ConfluencePage> {
  const adfJson = markdownToAdf(params.markdown);
  const payload = {
    spaceId: params.spaceId,
    status: "current",
    title: params.title,
    parentId: params.parentId || undefined,
    body: {
      representation: "atlas_doc_format",
      value: JSON.stringify(adfJson),
    },
  };

  const data = await confluenceRequest(creds, "POST", "/api/v2/pages", payload);
  return {
    id: data.id,
    spaceId: data.spaceId,
    spaceKey: null,
    title: data.title,
    body: params.markdown,
    version: data.version?.number || 1,
    parentId: data.parentId || null,
    updated: data.version?.createdAt || data.createdAt || null,
  };
}

// Update an existing page
export async function updateConfluencePage(
  creds: Credentials,
  pageId: string,
  params: {
    title: string;
    markdown: string;
    currentVersion: number;
  }
): Promise<ConfluencePage> {
  const adfJson = markdownToAdf(params.markdown);
  const payload = {
    id: pageId,
    status: "current",
    title: params.title,
    body: {
      representation: "atlas_doc_format",
      value: JSON.stringify(adfJson),
    },
    version: {
      number: params.currentVersion + 1,
      message: "Updated via tik CLI",
    },
  };

  const data = await confluenceRequest(creds, "PUT", `/api/v2/pages/${pageId}`, payload);
  return {
    id: data.id,
    spaceId: data.spaceId,
    spaceKey: null,
    title: data.title,
    body: params.markdown,
    version: data.version?.number || 1,
    parentId: data.parentId || null,
    updated: data.version?.createdAt || data.createdAt || null,
  };
}

// Fetch pages within a space (up to a limit)
export async function getPagesInSpace(
  creds: Credentials,
  spaceId: string,
  limit = 50
): Promise<ConfluencePage[]> {
  const data = await confluenceRequest(creds, "GET", `/api/v2/spaces/${spaceId}/pages?limit=${limit}`);
  const results: any[] = data.results || [];
  return results.map((page) => ({
    id: page.id,
    spaceId: page.spaceId,
    spaceKey: null,
    title: page.title,
    body: null, // Body is not returned in bulk listing endpoints typically
    version: page.version?.number || 1,
    parentId: page.parentId || null,
    updated: page.version?.createdAt || page.createdAt || null,
  }));
}

// Search pages using CQL search
export async function searchConfluence(
  creds: Credentials,
  cqlQuery: string,
  limit = 25
): Promise<any[]> {
  const encodedCql = encodeURIComponent(cqlQuery);
  const data = await confluenceRequest(creds, "GET", `/rest/api/search?cql=${encodedCql}&limit=${limit}`);
  return data.results || [];
}
