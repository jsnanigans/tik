import { Database } from "bun:sqlite";
import { type IssueData, parseIssue } from "./parser";
import { getSearchIndex } from "./search";
import { getCacheDir } from "./util";
import { DIMENSIONS, computeContentHash } from "./embeddings";
import { customFields, localConfig } from "./config";

export type CachedIssue = {
  key: string;
  summary: string;
  status: string;
  project: string;
  updated: string;
  raw: unknown;
};

export type CacheSearchOpts = {
  text?: string;
  fuzzy?: boolean; // Enable fuzzy matching (typo tolerance, subsequence matching)
  minScore?: number; // Minimum fuzzy score threshold (default: 50)
  project?: string[];
  status?: string[];
  assignee?: string; // "me" | "none" | account_id
  currentUserEmail?: string;
  issueType?: string[];
  priority?: string[];
  storyPoints?: { op: "=" | ">" | "<" | ">=" | "<="; value: number } | "none" | "any";
  epicKey?: string;
  labels?: string[];
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
  orderBy?: "updated" | "created" | "key" | "priority";
  orderDir?: "asc" | "desc";
};

const KNOWN_PROJECTS = [
  ...new Set([localConfig.defaultProject, ...localConfig.syncProjects, ...Object.keys(localConfig.projectAliases)]),
].filter(Boolean);
const KEY_PATTERN = /^([A-Z]+)-(\d+)$/;
const SCHEMA_VERSION = 13; // Bump when schema changes
const DEFAULT_PROJECT = localConfig.defaultProject;
const PROJECT_ALIASES = localConfig.projectAliases;

function resolveProjectAlias(alias: string): string | null {
  const upper = alias.toUpperCase();
  // Direct match first
  if (KNOWN_PROJECTS.includes(upper)) return upper;
  // Check aliases
  for (const [project, aliases] of Object.entries(PROJECT_ALIASES)) {
    if (aliases.includes(upper)) return project;
  }
  // Prefix match on known projects
  for (const project of KNOWN_PROJECTS) {
    if (project.startsWith(upper)) return project;
  }
  return null;
}

const SCHEMA = `
-- Main issues table with indexed columns
CREATE TABLE IF NOT EXISTS issues (
  key TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  testing_instructions TEXT,
  status TEXT NOT NULL,
  status_category TEXT,
  assignee TEXT,
  assignee_id TEXT,
  priority TEXT,
  priority_id TEXT,
  issue_type TEXT,
  story_points REAL,
  epic_key TEXT,
  epic_name TEXT,
  parent_key TEXT,
  created TEXT,
  updated TEXT,
  labels TEXT,
  raw TEXT,
  cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
  changelog_synced INTEGER NOT NULL DEFAULT 0
);

-- Indexes for common filters
CREATE INDEX IF NOT EXISTS idx_project ON issues(project);
CREATE INDEX IF NOT EXISTS idx_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_assignee_id ON issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_updated ON issues(updated);
CREATE INDEX IF NOT EXISTS idx_issue_type ON issues(issue_type);
CREATE INDEX IF NOT EXISTS idx_priority_id ON issues(priority_id);
CREATE INDEX IF NOT EXISTS idx_story_points ON issues(story_points);
CREATE INDEX IF NOT EXISTS idx_epic_key ON issues(epic_key);
CREATE INDEX IF NOT EXISTS idx_parent_key ON issues(parent_key);

-- FTS5 virtual table for full-text search with porter stemming
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  key,
  summary,
  description,
  acceptance_criteria,
  testing_instructions,
  content='issues',
  content_rowid='rowid',
  tokenize='porter ascii'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, key, summary, description, acceptance_criteria, testing_instructions)
  VALUES (NEW.rowid, NEW.key, NEW.summary, NEW.description, NEW.acceptance_criteria, NEW.testing_instructions);
END;

CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, key, summary, description, acceptance_criteria, testing_instructions)
  VALUES ('delete', OLD.rowid, OLD.key, OLD.summary, OLD.description, OLD.acceptance_criteria, OLD.testing_instructions);
END;

CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, key, summary, description, acceptance_criteria, testing_instructions)
  VALUES ('delete', OLD.rowid, OLD.key, OLD.summary, OLD.description, OLD.acceptance_criteria, OLD.testing_instructions);
  INSERT INTO issues_fts(rowid, key, summary, description, acceptance_criteria, testing_instructions)
  VALUES (NEW.rowid, NEW.key, NEW.summary, NEW.description, NEW.acceptance_criteria, NEW.testing_instructions);
END;

-- User mapping table to resolve "me" to account IDs
CREATE TABLE IF NOT EXISTS user_mapping (
  email TEXT PRIMARY KEY,
  account_id TEXT NOT NULL
);

-- Sync metadata table
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Previous assignees from changelog (for "was mine" filtering)
CREATE TABLE IF NOT EXISTS issue_previous_assignees (
  key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (key, account_id)
);
CREATE INDEX IF NOT EXISTS idx_prev_assignee_account ON issue_previous_assignees(account_id);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  account_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_main_account INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  team TEXT,
  notes TEXT
);

-- Changelog entries for offline log viewing
CREATE TABLE IF NOT EXISTS issue_changelog (
  key TEXT NOT NULL,
  created INTEGER NOT NULL,
  field TEXT NOT NULL,
  from_string TEXT,
  to_string TEXT,
  author TEXT
);
CREATE INDEX IF NOT EXISTS idx_changelog_key_created ON issue_changelog(key, created);

-- Cached state for git/GitHub workflow commands
CREATE TABLE IF NOT EXISTS flow_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL,
  branch_name TEXT,
  repo TEXT,
  worktree_name TEXT,
  worktree_path TEXT,
  jira_summary TEXT,
  jira_status TEXT,
  pr_number INTEGER,
  pr_title TEXT,
  pr_url TEXT,
  pr_state TEXT,
  pr_is_draft INTEGER,
  pr_review_decision TEXT,
  pr_checks_status TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(ticket_key, branch_name)
);
CREATE INDEX IF NOT EXISTS idx_flow_state_ticket ON flow_state(ticket_key);
CREATE INDEX IF NOT EXISTS idx_flow_state_branch ON flow_state(branch_name);

-- Local cache storage for Confluence pages
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  space_key TEXT,
  title TEXT NOT NULL,
  body TEXT,
  version INTEGER NOT NULL,
  parent_id TEXT,
  updated TEXT,
  cached_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_page_space ON pages(space_key);
CREATE INDEX IF NOT EXISTS idx_page_updated ON pages(updated);

-- FTS5 Virtual Table for full-text search on page content
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  id,
  title,
  body,
  content='pages',
  content_rowid='rowid',
  tokenize='porter ascii'
);

-- Triggers to synchronize FTS indexes automatically
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, id, title, body) VALUES (NEW.rowid, NEW.id, NEW.title, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, id, title, body) VALUES ('delete', OLD.rowid, OLD.id, OLD.title, OLD.body);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, id, title, body) VALUES ('delete', OLD.rowid, OLD.id, OLD.title, OLD.body);
  INSERT INTO pages_fts(rowid, id, title, body) VALUES (NEW.rowid, NEW.id, NEW.title, NEW.body);
END;

-- Cache for tik pr --mine PR summary data
CREATE TABLE IF NOT EXISTS pr_cache (
  cache_key TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_cache_repo ON pr_cache(repo);
CREATE INDEX IF NOT EXISTS idx_pr_cache_state ON pr_cache(state);
`;

function getDbPath(): string {
  return `${getCacheDir()}/tickets.db`;
}

let db: Database | null = null;

function seedUsersFromConfig(database: Database): void {
  const users = localConfig.users;
  if (!users?.length) return;

  const stmt = database.prepare(`
    INSERT INTO users (account_id, display_name, email, active, is_main_account, role, team, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = excluded.display_name,
      email = excluded.email,
      active = excluded.active,
      is_main_account = excluded.is_main_account,
      role = excluded.role,
      team = excluded.team,
      notes = excluded.notes
  `);

  for (const user of users) {
    stmt.run(
      user.accountId,
      user.displayName,
      user.email ?? null,
      user.active ? 1 : 0,
      user.isMainAccount ? 1 : 0,
      user.role ?? null,
      user.team ?? null,
      user.notes ?? null,
    );
  }

  if (localConfig.myEmail) {
    const mainUser = users.find(u => u.email === localConfig.myEmail);
    if (mainUser) {
      database.run(
        "INSERT OR REPLACE INTO user_mapping (email, account_id) VALUES (?, ?)",
        [localConfig.myEmail, mainUser.accountId]
      );
    }
  }
}

function getDb(): Database {
  if (!db) {
    const { mkdirSync, existsSync } = require("fs");

    const cacheDir = getCacheDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    db = new Database(getDbPath());
    db.exec(SCHEMA);
    migrateIfNeeded(db);
    seedUsersFromConfig(db);
  }
  return db;
}

function migrateIfNeeded(database: Database): void {
  const versionRow = database.query("SELECT value FROM sync_meta WHERE key = 'schema_version'").get() as { value: string } | null;
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 1;

  if (currentVersion < 2) {
    // Version 1→2: Recreate FTS with porter stemmer
    database.exec(`
      DROP TRIGGER IF EXISTS issues_ai;
      DROP TRIGGER IF EXISTS issues_ad;
      DROP TRIGGER IF EXISTS issues_au;
      DROP TABLE IF EXISTS issues_fts;
    `);

    database.exec(`
      CREATE VIRTUAL TABLE issues_fts USING fts5(
        key,
        summary,
        description,
        acceptance_criteria,
        testing_instructions,
        content='issues',
        content_rowid='rowid',
        tokenize='porter ascii'
      );

      CREATE TRIGGER issues_ai AFTER INSERT ON issues BEGIN
        INSERT INTO issues_fts(rowid, key, summary, description, acceptance_criteria, testing_instructions)
        VALUES (NEW.rowid, NEW.key, NEW.summary, NEW.description, NEW.acceptance_criteria, NEW.testing_instructions);
      END;

      CREATE TRIGGER issues_ad AFTER DELETE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, key, summary, description, acceptance_criteria, testing_instructions)
        VALUES ('delete', OLD.rowid, OLD.key, OLD.summary, OLD.description, OLD.acceptance_criteria, OLD.testing_instructions);
      END;

      CREATE TRIGGER issues_au AFTER UPDATE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, key, summary, description, acceptance_criteria, testing_instructions)
        VALUES ('delete', OLD.rowid, OLD.key, OLD.summary, OLD.description, OLD.acceptance_criteria, OLD.testing_instructions);
        INSERT INTO issues_fts(rowid, key, summary, description, acceptance_criteria, testing_instructions)
        VALUES (NEW.rowid, NEW.key, NEW.summary, NEW.description, NEW.acceptance_criteria, NEW.testing_instructions);
      END;
    `);

    database.exec("INSERT INTO issues_fts(issues_fts) VALUES('rebuild')");
  }

  if (currentVersion < 3) {
    // Version 2→3: Add parent_key column
    const columns = database.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    const hasParentKey = columns.some(col => col.name === "parent_key");
    if (!hasParentKey) {
      database.exec("ALTER TABLE issues ADD COLUMN parent_key TEXT");
      database.exec("CREATE INDEX IF NOT EXISTS idx_parent_key ON issues(parent_key)");
    }
  }

  if (currentVersion < 4) {
    // Version 3→4: Add timeline date columns
    const columns = database.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has("started_at")) {
      database.exec("ALTER TABLE issues ADD COLUMN started_at TEXT");
    }
    if (!colNames.has("done_at")) {
      database.exec("ALTER TABLE issues ADD COLUMN done_at TEXT");
    }
  }

  if (currentVersion < 5) {
    // Version 4→5: Add users table and seed from users.json
    const tables = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (!tables) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS users (
          account_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          email TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          is_main_account INTEGER NOT NULL DEFAULT 0,
          role TEXT,
          team TEXT,
          notes TEXT
        )
      `);
    }

  }

  if (currentVersion < 6) {
    // Version 5→6: Add previous assignees table and changelog_synced column
    database.exec(`
      CREATE TABLE IF NOT EXISTS issue_previous_assignees (
        key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        PRIMARY KEY (key, account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_prev_assignee_account ON issue_previous_assignees(account_id);
    `);
    const columns = database.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === "changelog_synced")) {
      database.exec("ALTER TABLE issues ADD COLUMN changelog_synced INTEGER NOT NULL DEFAULT 0");
    }
  }

  if (currentVersion < 7) {
    // Version 6→7: Add issue_changelog table
    database.exec(`
      CREATE TABLE IF NOT EXISTS issue_changelog (
        key TEXT NOT NULL,
        created INTEGER NOT NULL,
        field TEXT NOT NULL,
        from_string TEXT,
        to_string TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_key_created ON issue_changelog(key, created);
    `);
  }

  if (currentVersion < 8) {
    // Version 7→8: Add granular timeline phase columns
    const columns = database.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has("review_at")) database.exec("ALTER TABLE issues ADD COLUMN review_at TEXT");
    if (!colNames.has("merge_ready_at")) database.exec("ALTER TABLE issues ADD COLUMN merge_ready_at TEXT");
    if (!colNames.has("release_ready_at")) database.exec("ALTER TABLE issues ADD COLUMN release_ready_at TEXT");
  }

  if (currentVersion < 9) {
    // Version 8→9: Add embedding columns for semantic search
    const columns = database.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has("embedding")) database.exec("ALTER TABLE issues ADD COLUMN embedding BLOB");
    if (!colNames.has("embedding_hash")) database.exec("ALTER TABLE issues ADD COLUMN embedding_hash TEXT");
  }

  if (currentVersion < 10) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS flow_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_key TEXT NOT NULL,
        branch_name TEXT,
        repo TEXT,
        worktree_name TEXT,
        worktree_path TEXT,
        jira_summary TEXT,
        jira_status TEXT,
        pr_number INTEGER,
        pr_title TEXT,
        pr_url TEXT,
        pr_state TEXT,
        pr_is_draft INTEGER,
        pr_review_decision TEXT,
        pr_checks_status TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(ticket_key, branch_name)
      );
      CREATE INDEX IF NOT EXISTS idx_flow_state_ticket ON flow_state(ticket_key);
      CREATE INDEX IF NOT EXISTS idx_flow_state_branch ON flow_state(branch_name);
    `);
  }

  if (currentVersion < 11) {
    const table = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='flow_state'").get();
    if (table) {
      const columns = database.query("PRAGMA table_info(flow_state)").all() as Array<{ name: string; pk: number }>;
      const ticketKeyColumn = columns.find(col => col.name === "ticket_key");
      if (ticketKeyColumn?.pk) {
        database.exec(`
          DROP INDEX IF EXISTS idx_flow_state_ticket;
          DROP INDEX IF EXISTS idx_flow_state_branch;

          CREATE TABLE flow_state_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_key TEXT NOT NULL,
            branch_name TEXT,
            repo TEXT,
            worktree_name TEXT,
            worktree_path TEXT,
            jira_summary TEXT,
            jira_status TEXT,
            pr_number INTEGER,
            pr_title TEXT,
            pr_url TEXT,
            pr_state TEXT,
            pr_is_draft INTEGER,
            pr_review_decision TEXT,
            pr_checks_status TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(ticket_key, branch_name)
          );

          INSERT INTO flow_state_new (
            ticket_key, branch_name, repo, worktree_name, worktree_path,
            jira_summary, jira_status,
            pr_number, pr_title, pr_url, pr_state, pr_is_draft, pr_review_decision, pr_checks_status,
            updated_at
          )
          SELECT
            ticket_key, branch_name, repo, worktree_name, worktree_path,
            jira_summary, jira_status,
            pr_number, pr_title, pr_url, pr_state, pr_is_draft, pr_review_decision, pr_checks_status,
            updated_at
          FROM flow_state;

          DROP TABLE flow_state;
          ALTER TABLE flow_state_new RENAME TO flow_state;
        `);
      }
    } else {
      database.exec(`
        CREATE TABLE flow_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_key TEXT NOT NULL,
          branch_name TEXT,
          repo TEXT,
          worktree_name TEXT,
          worktree_path TEXT,
          jira_summary TEXT,
          jira_status TEXT,
          pr_number INTEGER,
          pr_title TEXT,
          pr_url TEXT,
          pr_state TEXT,
          pr_is_draft INTEGER,
          pr_review_decision TEXT,
          pr_checks_status TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(ticket_key, branch_name)
        );
      `);
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_flow_state_ticket ON flow_state(ticket_key);
      CREATE INDEX IF NOT EXISTS idx_flow_state_branch ON flow_state(branch_name);
    `);
  }

  if (currentVersion < 12) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        space_key TEXT,
        title TEXT NOT NULL,
        body TEXT,
        version INTEGER NOT NULL,
        parent_id TEXT,
        updated TEXT,
        cached_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_page_space ON pages(space_key);
      CREATE INDEX IF NOT EXISTS idx_page_updated ON pages(updated);

      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        id,
        title,
        body,
        content='pages',
        content_rowid='rowid',
        tokenize='porter ascii'
      );

      CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
        INSERT INTO pages_fts(rowid, id, title, body) VALUES (NEW.rowid, NEW.id, NEW.title, NEW.body);
      END;

      CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, id, title, body) VALUES ('delete', OLD.rowid, OLD.id, OLD.title, OLD.body);
      END;

      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, id, title, body) VALUES ('delete', OLD.rowid, OLD.id, OLD.title, OLD.body);
        INSERT INTO pages_fts(rowid, id, title, body) VALUES (NEW.rowid, NEW.id, NEW.title, NEW.body);
      END;
    `);
  }

  if (currentVersion < 13) {
    const columns = database.query("PRAGMA table_info(issue_changelog)").all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === "author")) {
      database.exec("ALTER TABLE issue_changelog ADD COLUMN author TEXT");
    }
  }

  if (currentVersion < SCHEMA_VERSION) {
    database.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION.toString()]);
  }
}

export async function initDb(): Promise<Database> {
  return getDb();
}

function issueToRow(raw: unknown): Record<string, unknown> | null {
  const parsed = parseIssue(raw);
  if (!parsed.key) return null;
  const project = parsed.key.split("-")[0];
  if (!project) return null;
  return {
    $key: parsed.key,
    $project: project,
    $summary: parsed.summary,
    $description: parsed.description,
    $acceptance_criteria: parsed.acceptanceCriteria,
    $testing_instructions: parsed.testingInstructions,
    $status: parsed.status,
    $status_category: parsed.statusCategory,
    $assignee: parsed.assignee,
    $assignee_id: parsed.assigneeId,
    $priority: parsed.priority,
    $priority_id: parsed.priorityId,
    $issue_type: parsed.issueType,
    $story_points: parsed.storyPoints,
    $epic_key: parsed.epicKey,
    $epic_name: parsed.epicName,
    $parent_key: parsed.parentKey,
    $created: parsed.created,
    $updated: parsed.updated,
    $labels: JSON.stringify(parsed.labels),
    $raw: JSON.stringify(raw),
    $cached_at: new Date().toISOString(),
  };
}

export async function cacheIssues(rawIssues: unknown[]): Promise<void> {
  const database = getDb();

  const stmt = database.prepare(`
    INSERT INTO issues (
      key, project, summary, description, acceptance_criteria, testing_instructions,
      status, status_category, assignee, assignee_id, priority, priority_id,
      issue_type, story_points, epic_key, epic_name, parent_key, created, updated, labels, raw, cached_at
    ) VALUES (
      $key, $project, $summary, $description, $acceptance_criteria, $testing_instructions,
      $status, $status_category, $assignee, $assignee_id, $priority, $priority_id,
      $issue_type, $story_points, $epic_key, $epic_name, $parent_key, $created, $updated, $labels, $raw, $cached_at
    )
    ON CONFLICT(key) DO UPDATE SET
      project = excluded.project,
      summary = excluded.summary,
      description = excluded.description,
      acceptance_criteria = excluded.acceptance_criteria,
      testing_instructions = excluded.testing_instructions,
      status = excluded.status,
      status_category = excluded.status_category,
      assignee = excluded.assignee,
      assignee_id = excluded.assignee_id,
      priority = excluded.priority,
      priority_id = excluded.priority_id,
      issue_type = excluded.issue_type,
      story_points = excluded.story_points,
      epic_key = excluded.epic_key,
      epic_name = excluded.epic_name,
      parent_key = excluded.parent_key,
      created = excluded.created,
      updated = excluded.updated,
      labels = excluded.labels,
      raw = excluded.raw,
      cached_at = excluded.cached_at,
      changelog_synced = 0
  `);

  const insertMany = database.transaction((issues: unknown[]) => {
    for (const raw of issues) {
      const row = issueToRow(raw);
      if (row) {
        stmt.run(row as Record<string, string | number | null>);
      }
    }
  });

  insertMany(rawIssues);
}

export type FieldChange = {
  field: string;
  oldValue?: string;
  newValue?: string;
  isText?: boolean;
};

export type SyncChange = {
  key: string;
  summary: string;
  issueType: string;
  assignee?: string;
  teamId?: string;
  changeType: "new" | "changed";
  fields: FieldChange[];
};

export async function diffAndCacheIssues(rawIssues: unknown[]): Promise<SyncChange[]> {
  const database = getDb();
  const changes: SyncChange[] = [];

  const parsed = rawIssues
    .map(raw => parseIssue(raw))
    .filter(issue => issue.key);

  if (parsed.length === 0) {
    await cacheIssues(rawIssues);
    return changes;
  }

  const keys = parsed.map(p => p.key);
  const placeholders = keys.map(() => "?").join(", ");
  const existingRows = database.query(
    `SELECT key, summary, status, assignee, priority, issue_type,
            story_points, epic_key, labels, description, acceptance_criteria, testing_instructions
     FROM issues WHERE key IN (${placeholders})`
  ).all(...keys) as Array<{
    key: string; summary: string; status: string; assignee: string | null;
    priority: string | null; issue_type: string | null;
    story_points: number | null; epic_key: string | null; labels: string | null;
    description: string | null; acceptance_criteria: string | null; testing_instructions: string | null;
  }>;
  const existingMap = new Map(existingRows.map(r => [r.key, r]));

  for (const issue of parsed) {
    const existing = existingMap.get(issue.key);
    if (!existing) {
      changes.push({ key: issue.key, summary: issue.summary, issueType: issue.issueType, assignee: issue.assignee ?? undefined, teamId: issue.teamId ?? undefined, changeType: "new", fields: [{ field: "status", newValue: issue.status }] });
      continue;
    }

    const fields: FieldChange[] = [];
    if (existing.summary !== issue.summary) {
      fields.push({ field: "summary", oldValue: existing.summary, newValue: issue.summary });
    }
    if (existing.status !== issue.status) {
      fields.push({ field: "status", oldValue: existing.status, newValue: issue.status });
    }
    if (existing.assignee !== issue.assignee) {
      fields.push({ field: "assignee", oldValue: existing.assignee ?? undefined, newValue: issue.assignee ?? undefined });
    }
    if ((existing.priority ?? "") !== (issue.priority ?? "")) {
      fields.push({ field: "priority", oldValue: existing.priority ?? undefined, newValue: issue.priority ?? undefined });
    }
    if ((existing.issue_type ?? "") !== (issue.issueType ?? "")) {
      fields.push({ field: "type", oldValue: existing.issue_type ?? undefined, newValue: issue.issueType ?? undefined });
    }
    const oldPoints = existing.story_points != null ? String(existing.story_points) : undefined;
    const newPoints = issue.storyPoints != null ? String(issue.storyPoints) : undefined;
    if (oldPoints !== newPoints) {
      fields.push({ field: "points", oldValue: oldPoints, newValue: newPoints });
    }
    if ((existing.epic_key ?? "") !== (issue.epicKey ?? "")) {
      fields.push({ field: "epic", oldValue: existing.epic_key ?? undefined, newValue: issue.epicKey ?? undefined });
    }
    const oldLabels = existing.labels ?? "[]";
    const newLabels = JSON.stringify(issue.labels ?? []);
    if (oldLabels !== newLabels) {
      fields.push({ field: "labels", oldValue: oldLabels, newValue: newLabels });
    }
    // Text fields
    if ((existing.description ?? "") !== (issue.description ?? "")) {
      fields.push({ field: "description", oldValue: existing.description ?? undefined, newValue: issue.description ?? undefined, isText: true });
    }
    if ((existing.acceptance_criteria ?? "") !== (issue.acceptanceCriteria ?? "")) {
      fields.push({ field: "ac", oldValue: existing.acceptance_criteria ?? undefined, newValue: issue.acceptanceCriteria ?? undefined, isText: true });
    }
    if ((existing.testing_instructions ?? "") !== (issue.testingInstructions ?? "")) {
      fields.push({ field: "ti", oldValue: existing.testing_instructions ?? undefined, newValue: issue.testingInstructions ?? undefined, isText: true });
    }

    if (fields.length > 0) {
      changes.push({ key: issue.key, summary: issue.summary, issueType: issue.issueType, assignee: issue.assignee ?? undefined, teamId: issue.teamId ?? undefined, changeType: "changed", fields });
    }
  }

  await cacheIssues(rawIssues);
  return changes;
}

export async function cacheSingleIssue(raw: unknown): Promise<void> {
  await cacheIssues([raw]);
}

export async function cacheUserMapping(email: string, accountId: string): Promise<void> {
  const database = getDb();
  database.run(
    "INSERT OR REPLACE INTO user_mapping (email, account_id) VALUES (?, ?)",
    [email, accountId]
  );
}

export async function getUserAccountId(email: string): Promise<string | null> {
  const database = getDb();
  const row = database.query("SELECT account_id FROM user_mapping WHERE email = ?").get(email) as { account_id: string } | null;
  return row?.account_id ?? null;
}

async function searchCacheInternal(opts: CacheSearchOpts, retried = false): Promise<SearchCacheResult> {
  const database = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Fuzzy search mode: fetch candidates and rescore in JS
  const useFuzzy = opts.fuzzy && opts.text;
  const fuzzyQuery = opts.text || "";

  // FTS5 text search with BM25 ranking (non-fuzzy mode)
  let useFtsRanking = false;
  let ftsQuery = "";
  if (opts.text && !useFuzzy) {
    ftsQuery = opts.text
      .split(/\s+/)
      .filter(Boolean)
      .map(term => `"${term.replace(/"/g, '""')}"*`)
      .join(" ");
    useFtsRanking = true;
  }

  // Project filter
  if (opts.project && opts.project.length > 0) {
    const placeholders = opts.project.map(() => "?").join(", ");
    conditions.push(`i.project IN (${placeholders})`);
    params.push(...opts.project);
  }

  // Status filter
  if (opts.status && opts.status.length > 0) {
    const placeholders = opts.status.map(() => "?").join(", ");
    conditions.push(`i.status IN (${placeholders})`);
    params.push(...opts.status);
  }

  // Assignee filter
  if (opts.assignee) {
    if (opts.assignee === "none") {
      conditions.push("i.assignee_id IS NULL");
    } else if (opts.assignee === "me" && opts.currentUserEmail) {
      const accountId = await getUserAccountId(opts.currentUserEmail);
      if (accountId) {
        conditions.push("i.assignee_id = ?");
        params.push(accountId);
      }
    } else if (opts.assignee !== "me") {
      conditions.push("i.assignee_id = ?");
      params.push(opts.assignee);
    }
  }

  // Issue type filter
  if (opts.issueType && opts.issueType.length > 0) {
    const placeholders = opts.issueType.map(() => "?").join(", ");
    conditions.push(`i.issue_type IN (${placeholders})`);
    params.push(...opts.issueType);
  }

  // Priority filter
  if (opts.priority && opts.priority.length > 0) {
    const placeholders = opts.priority.map(() => "?").join(", ");
    conditions.push(`i.priority IN (${placeholders})`);
    params.push(...opts.priority);
  }

  // Story points filter
  if (opts.storyPoints) {
    if (opts.storyPoints === "none") {
      conditions.push("i.story_points IS NULL");
    } else if (opts.storyPoints === "any") {
      conditions.push("i.story_points IS NOT NULL");
    } else {
      const { op, value } = opts.storyPoints;
      conditions.push(`i.story_points ${op} ?`);
      params.push(value);
    }
  }

  // Epic filter
  if (opts.epicKey) {
    conditions.push("i.epic_key = ?");
    params.push(opts.epicKey);
  }

  // Labels filter
  if (opts.labels && opts.labels.length > 0) {
    const labelConditions = opts.labels.map(() => "i.labels LIKE ?");
    conditions.push(`(${labelConditions.join(" OR ")})`);
    for (const label of opts.labels) {
      params.push(`%"${label}"%`);
    }
  }

  // Date filters
  if (opts.updatedAfter) {
    conditions.push("i.updated >= ?");
    params.push(opts.updatedAfter);
  }
  if (opts.updatedBefore) {
    conditions.push("i.updated <= ?");
    params.push(opts.updatedBefore);
  }

  // Build query
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Ordering - use BM25 ranking for text search, otherwise use specified order
  const orderMap: Record<string, string> = {
    updated: "i.updated",
    created: "i.created",
    key: "i.key",
    priority: "i.priority_id",
  };

  const requestedLimit = opts.limit || 100;

  type Row = {
    key: string;
    summary: string;
    description?: string | null;
    status: string;
    project: string;
    updated: string;
    raw: string;
    rank?: number;
  };

  let rows: Row[];
  let scoreMap: Map<string, number> | undefined;

  if (useFuzzy) {
    // MiniSearch-based search with BM25+ ranking
    const index = getSearchIndex();

    // If structured filters exist, get matching keys from SQL first
    let filterKeySet: Set<string> | null = null;
    if (conditions.length > 0) {
      const filterSql = `SELECT i.key FROM issues i ${whereClause}`;
      const filterRows = database.query(filterSql).all(...(params as (string | number | null)[])) as Array<{ key: string }>;
      filterKeySet = new Set(filterRows.map(r => r.key));
    }

    const searchResults = index.search(fuzzyQuery, {
      filter: filterKeySet ? (result) => filterKeySet!.has(result.id as string) : undefined,
    });

    // Apply relative threshold: --min-score is % of top result's score
    const minScorePct = opts.minScore ?? 50;
    const topScore = searchResults.length > 0 ? searchResults[0].score : 0;
    const scoreThreshold = topScore * (minScorePct / 100);
    const minResults = 1;

    const aboveThreshold = searchResults.filter(r => r.score >= scoreThreshold);
    const filteredResults = aboveThreshold.length >= minResults ? aboveThreshold : searchResults.slice(0, Math.min(minResults, searchResults.length));
    const resultKeys = filteredResults.slice(0, requestedLimit).map(r => r.id as string);

    // Build score map for callers that need it
    scoreMap = new Map(filteredResults.map(r => [r.id as string, r.score]));

    if (resultKeys.length === 0) {
      rows = [];
    } else {
      const placeholders = resultKeys.map(() => "?").join(", ");
      const fetchSql = `SELECT key, summary, status, project, updated, raw FROM issues WHERE key IN (${placeholders})`;
      const fetchedRows = database.query(fetchSql).all(...(resultKeys as (string | number | null)[])) as Row[];

      // Preserve MiniSearch rank order
      const rowMap = new Map(fetchedRows.map(r => [r.key, r]));
      rows = resultKeys.map(k => rowMap.get(k)).filter((r): r is Row => r !== undefined);
    }
  } else {
    let sql: string;

    if (useFtsRanking) {
      // BM25 weights: key=10, summary=5, description=1, ac=1, ti=1
      // Lower BM25 score = better match, so we sort ASC
      const ftsCondition = "i.rowid IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)";
      const ftsWhere = whereClause ? `${whereClause} AND ${ftsCondition}` : `WHERE ${ftsCondition}`;
      params.push(ftsQuery);

      const limitClause = `LIMIT ${requestedLimit}`;
      sql = `SELECT i.key, i.summary, i.status, i.project, i.updated, i.raw,
        (SELECT bm25(issues_fts, 10.0, 5.0, 1.0, 1.0, 1.0) FROM issues_fts WHERE issues_fts.rowid = i.rowid) AS rank
        FROM issues i ${ftsWhere} ORDER BY rank ${limitClause}`;
    } else {
      const orderField = orderMap[opts.orderBy || "updated"] || "i.updated";
      const orderDir = opts.orderDir === "asc" ? "ASC" : "DESC";
      const orderClause = `ORDER BY ${orderField} ${orderDir}`;
      const limitClause = `LIMIT ${requestedLimit}`;
      sql = `SELECT i.key, i.summary, i.status, i.project, i.updated, i.raw FROM issues i ${whereClause} ${orderClause} ${limitClause}`;
    }

    try {
      rows = database.query(sql).all(...(params as (string | number | null)[])) as Row[];
    } catch (err) {
      if (!retried && err instanceof Error && err.message.includes("fts5: missing row")) {
        await rebuildFtsIndex();
        return searchCacheInternal(opts, true);
      }
      throw err;
    }
  }

  const results = rows.map(row => ({
    key: row.key,
    summary: row.summary,
    status: row.status,
    project: row.project,
    updated: row.updated,
    raw: JSON.parse(row.raw),
  }));
  return { results, scoreMap };
}

export type SearchCacheResult = {
  results: CachedIssue[];
  scoreMap?: Map<string, number>;
};

export async function searchCache(opts: CacheSearchOpts, retried = false): Promise<CachedIssue[]> {
  const { results } = await searchCacheInternal(opts, retried);
  return results;
}

export async function searchCacheWithScores(opts: CacheSearchOpts): Promise<SearchCacheResult> {
  return searchCacheInternal(opts);
}

export async function getCachedIssue(key: string): Promise<CachedIssue | null> {
  const database = getDb();
  const row = database.query(
    "SELECT key, summary, status, project, updated, raw FROM issues WHERE key = ?"
  ).get(key) as { key: string; summary: string; status: string; project: string; updated: string; raw: string } | null;

  if (!row) return null;

  return {
    key: row.key,
    summary: row.summary,
    status: row.status,
    project: row.project,
    updated: row.updated,
    raw: JSON.parse(row.raw),
  };
}

export function getCachedIssuesRaw(keys: string[]): Map<string, unknown> {
  if (keys.length === 0) return new Map();
  const database = getDb();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = database.query(
    `SELECT key, raw FROM issues WHERE key IN (${placeholders})`
  ).all(...keys) as Array<{ key: string; raw: string }>;
  const result = new Map<string, unknown>();
  for (const row of rows) {
    result.set(row.key, JSON.parse(row.raw));
  }
  return result;
}

export function getChildrenRaw(parentOrEpicKeys: string[]): Map<string, unknown> {
  if (parentOrEpicKeys.length === 0) return new Map();
  const database = getDb();
  const placeholders = parentOrEpicKeys.map(() => "?").join(", ");
  const rows = database.query(
    `SELECT key, raw FROM issues WHERE parent_key IN (${placeholders}) OR epic_key IN (${placeholders})`
  ).all(...parentOrEpicKeys, ...parentOrEpicKeys) as Array<{ key: string; raw: string }>;
  const result = new Map<string, unknown>();
  for (const row of rows) {
    result.set(row.key, JSON.parse(row.raw));
  }
  return result;
}

export async function getCachedKeys(): Promise<string[]> {
  const database = getDb();
  const rows = database.query("SELECT key FROM issues").all() as Array<{ key: string }>;
  return rows.map(r => r.key);
}

export function getIdKeyMap(keys: string[]): Map<string, string> {
  const database = getDb();
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = database.query(
    `SELECT key, raw FROM issues WHERE key IN (${placeholders})`
  ).all(...keys) as Array<{ key: string; raw: string }>;
  const map = new Map<string, string>();
  for (const r of rows) {
    try {
      const raw = JSON.parse(r.raw);
      if (raw.id) map.set(String(raw.id), r.key);
    } catch {}
  }
  return map;
}

export async function clearCache(): Promise<void> {
  const database = getDb();
  database.exec("DELETE FROM issues");
  database.exec("DELETE FROM issues_fts");
  database.exec("DELETE FROM issue_previous_assignees");
  database.exec("DELETE FROM user_mapping");
  database.exec("DELETE FROM sync_meta");
}

export async function rebuildFtsIndex(): Promise<void> {
  const database = getDb();
  database.exec("INSERT INTO issues_fts(issues_fts) VALUES('rebuild')");
}

export async function getLastSyncTime(): Promise<string | null> {
  const database = getDb();
  const row = database.query("SELECT value FROM sync_meta WHERE key = 'last_sync'").get() as { value: string } | null;
  return row?.value ?? null;
}

export type FlowState = {
  ticketKey: string;
  branchName: string | null;
  repo: string | null;
  worktreeName: string | null;
  worktreePath: string | null;
  jiraSummary: string | null;
  jiraStatus: string | null;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  prState: string | null;
  prIsDraft: boolean;
  prReviewDecision: string | null;
  prChecksStatus: string | null;
  updatedAt: string;
};

type FlowStateRow = {
  ticket_key: string;
  branch_name: string | null;
  repo: string | null;
  worktree_name: string | null;
  worktree_path: string | null;
  jira_summary: string | null;
  jira_status: string | null;
  pr_number: number | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_is_draft: number | null;
  pr_review_decision: string | null;
  pr_checks_status: string | null;
  updated_at: string;
};

function flowStateFromRow(row: FlowStateRow | null): FlowState | null {
  if (!row) return null;
  return {
    ticketKey: row.ticket_key,
    branchName: row.branch_name,
    repo: row.repo,
    worktreeName: row.worktree_name,
    worktreePath: row.worktree_path,
    jiraSummary: row.jira_summary,
    jiraStatus: row.jira_status,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    prUrl: row.pr_url,
    prState: row.pr_state,
    prIsDraft: row.pr_is_draft === 1,
    prReviewDecision: row.pr_review_decision,
    prChecksStatus: row.pr_checks_status,
    updatedAt: row.updated_at,
  };
}

function selectFlowStateFields(): string {
  return `
    SELECT
      ticket_key, branch_name, repo, worktree_name, worktree_path,
      jira_summary, jira_status,
      pr_number, pr_title, pr_url, pr_state, pr_is_draft, pr_review_decision, pr_checks_status,
      updated_at
    FROM flow_state
  `;
}

export async function getFlowState(ticketKey: string): Promise<FlowState | null> {
  const database = getDb();
  const row = database.query(`
    ${selectFlowStateFields()}
    WHERE ticket_key = ?
    ORDER BY branch_name IS NOT NULL, updated_at DESC
    LIMIT 1
  `).get(ticketKey) as FlowStateRow | null;

  return flowStateFromRow(row);
}

export async function getFlowStateForBranch(ticketKey: string, branchName: string): Promise<FlowState | null> {
  const database = getDb();
  const row = database.query(`
    ${selectFlowStateFields()}
    WHERE ticket_key = ? AND branch_name = ?
    LIMIT 1
  `).get(ticketKey, branchName) as FlowStateRow | null;

  return flowStateFromRow(row);
}

async function getBranchlessFlowState(ticketKey: string): Promise<FlowState | null> {
  const database = getDb();
  const row = database.query(`
    ${selectFlowStateFields()}
    WHERE ticket_key = ? AND branch_name IS NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(ticketKey) as FlowStateRow | null;

  return flowStateFromRow(row);
}

export async function upsertFlowState(state: {
  ticketKey: string;
  branchName?: string | null;
  repo?: string | null;
  worktreeName?: string | null;
  worktreePath?: string | null;
  jiraSummary?: string | null;
  jiraStatus?: string | null;
  prNumber?: number | null;
  prTitle?: string | null;
  prUrl?: string | null;
  prState?: string | null;
  prIsDraft?: boolean;
  prReviewDecision?: string | null;
  prChecksStatus?: string | null;
}): Promise<void> {
  const database = getDb();
  const existing = state.branchName
    ? await getFlowStateForBranch(state.ticketKey, state.branchName)
    : await getBranchlessFlowState(state.ticketKey);
  const has = (key: keyof typeof state) => Object.prototype.hasOwnProperty.call(state, key);
  const merged = {
    branchName: has("branchName") ? state.branchName ?? null : existing?.branchName ?? null,
    repo: has("repo") ? state.repo ?? null : existing?.repo ?? null,
    worktreeName: has("worktreeName") ? state.worktreeName ?? null : existing?.worktreeName ?? null,
    worktreePath: has("worktreePath") ? state.worktreePath ?? null : existing?.worktreePath ?? null,
    jiraSummary: has("jiraSummary") ? state.jiraSummary ?? null : existing?.jiraSummary ?? null,
    jiraStatus: has("jiraStatus") ? state.jiraStatus ?? null : existing?.jiraStatus ?? null,
    prNumber: has("prNumber") ? state.prNumber ?? null : existing?.prNumber ?? null,
    prTitle: has("prTitle") ? state.prTitle ?? null : existing?.prTitle ?? null,
    prUrl: has("prUrl") ? state.prUrl ?? null : existing?.prUrl ?? null,
    prState: has("prState") ? state.prState ?? null : existing?.prState ?? null,
    prIsDraft: has("prIsDraft") ? !!state.prIsDraft : existing?.prIsDraft ?? false,
    prReviewDecision: has("prReviewDecision") ? state.prReviewDecision ?? null : existing?.prReviewDecision ?? null,
    prChecksStatus: has("prChecksStatus") ? state.prChecksStatus ?? null : existing?.prChecksStatus ?? null,
  };

  const values = [
    state.ticketKey,
    merged.branchName,
    merged.repo,
    merged.worktreeName,
    merged.worktreePath,
    merged.jiraSummary,
    merged.jiraStatus,
    merged.prNumber,
    merged.prTitle,
    merged.prUrl,
    merged.prState,
    merged.prIsDraft ? 1 : 0,
    merged.prReviewDecision,
    merged.prChecksStatus,
    new Date().toISOString(),
  ];

  if (merged.branchName) {
    database.run(`
      INSERT INTO flow_state (
        ticket_key, branch_name, repo, worktree_name, worktree_path,
        jira_summary, jira_status,
        pr_number, pr_title, pr_url, pr_state, pr_is_draft, pr_review_decision, pr_checks_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_key, branch_name) DO UPDATE SET
        repo = excluded.repo,
        worktree_name = excluded.worktree_name,
        worktree_path = excluded.worktree_path,
        jira_summary = excluded.jira_summary,
        jira_status = excluded.jira_status,
        pr_number = excluded.pr_number,
        pr_title = excluded.pr_title,
        pr_url = excluded.pr_url,
        pr_state = excluded.pr_state,
        pr_is_draft = excluded.pr_is_draft,
        pr_review_decision = excluded.pr_review_decision,
        pr_checks_status = excluded.pr_checks_status,
        updated_at = excluded.updated_at
    `, values);
    return;
  }

  if (existing) {
    database.run(`
      UPDATE flow_state SET
        repo = ?,
        worktree_name = ?,
        worktree_path = ?,
        jira_summary = ?,
        jira_status = ?,
        pr_number = ?,
        pr_title = ?,
        pr_url = ?,
        pr_state = ?,
        pr_is_draft = ?,
        pr_review_decision = ?,
        pr_checks_status = ?,
        updated_at = ?
      WHERE ticket_key = ? AND branch_name IS NULL
    `, [
      merged.repo,
      merged.worktreeName,
      merged.worktreePath,
      merged.jiraSummary,
      merged.jiraStatus,
      merged.prNumber,
      merged.prTitle,
      merged.prUrl,
      merged.prState,
      merged.prIsDraft ? 1 : 0,
      merged.prReviewDecision,
      merged.prChecksStatus,
      new Date().toISOString(),
      state.ticketKey,
    ]);
    return;
  }

  database.run(`
    INSERT INTO flow_state (
      ticket_key, branch_name, repo, worktree_name, worktree_path,
      jira_summary, jira_status,
      pr_number, pr_title, pr_url, pr_state, pr_is_draft, pr_review_decision, pr_checks_status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, values);
}

export async function setLastSyncTime(timestamp: string): Promise<void> {
  const database = getDb();
  database.run(
    "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync', ?)",
    [timestamp]
  );
}

export type CacheStats = {
  totalIssues: number;
  lastSync: string | null;
  byProject: Record<string, number>;
};

export async function getCacheStats(): Promise<CacheStats> {
  const database = getDb();
  const totalRow = database.query("SELECT COUNT(*) as count FROM issues").get() as { count: number };
  const projectRows = database.query("SELECT project, COUNT(*) as count FROM issues GROUP BY project").all() as Array<{ project: string; count: number }>;
  const byProject: Record<string, number> = {};
  for (const row of projectRows) {
    byProject[row.project] = row.count;
  }
  return {
    totalIssues: totalRow.count,
    lastSync: await getLastSyncTime(),
    byProject,
  };
}

export function isValidKey(key: string): boolean {
  const match = key.match(KEY_PATTERN);
  if (!match) return false;
  return KNOWN_PROJECTS.includes(match[1]);
}

export function parsePartialKey(partial: string): { number: string; project?: string } | null {
  // Just a number: "123"
  const numMatch = partial.match(/^(\d+)$/);
  if (numMatch) {
    return { number: numMatch[1] };
  }

  // Project prefix with optional dash: "FE-123", "fe123", "PROJ-123", "proj123"
  const projNumMatch = partial.match(/^([A-Za-z]+)-?(\d+)$/);
  if (projNumMatch) {
    const resolvedProject = resolveProjectAlias(projNumMatch[1]);
    if (resolvedProject) {
      return { project: resolvedProject, number: projNumMatch[2] };
    }
    // Even if alias not found, still try with raw input
    return { project: projNumMatch[1].toUpperCase(), number: projNumMatch[2] };
  }

  return null;
}

export type MatchedKey = {
  key: string;
  summary: string;
  updated: string;
};

export async function findMatchingKeys(partial: string): Promise<MatchedKey[]> {
  const database = getDb();

  const parsed = parsePartialKey(partial);
  if (!parsed) return [];

  // Query issues with summary and updated for sorting
  const rows = database.query(
    "SELECT key, summary, updated FROM issues ORDER BY updated DESC"
  ).all() as Array<{ key: string; summary: string; updated: string }>;

  const exactMatches: Array<{ key: string; summary: string; updated: string }> = [];
  const prefixMatches: Array<{ key: string; summary: string; updated: string }> = [];

  for (const row of rows) {
    const [project, number] = row.key.split("-");

    if (parsed.project) {
      // Exact project match (alias already resolved in parsePartialKey)
      if (project === parsed.project) {
        if (number === parsed.number) {
          exactMatches.push(row);
        } else if (number.startsWith(parsed.number)) {
          prefixMatches.push(row);
        }
      }
    } else {
      // No project specified - match any project
      if (number === parsed.number) {
        exactMatches.push(row);
      } else if (number.startsWith(parsed.number)) {
        prefixMatches.push(row);
      }
    }
  }

  const matches = exactMatches.length > 0 ? exactMatches : prefixMatches;

  // Sort: default project first, then by recency (already sorted by updated DESC)
  return matches
    .sort((a, b) => {
      const aProj = a.key.split("-")[0];
      const bProj = b.key.split("-")[0];
      const aIsDefault = aProj === DEFAULT_PROJECT ? 0 : 1;
      const bIsDefault = bProj === DEFAULT_PROJECT ? 0 : 1;
      if (aIsDefault !== bIsDefault) return aIsDefault - bIsDefault;
      // Already sorted by updated DESC from query
      return 0;
    })
    .map(({ key, summary, updated }) => ({ key, summary, updated }));
}

export type KeyResolveResult =
  | { type: "valid"; key: string }
  | { type: "resolved"; key: string; original: string }
  | { type: "multiple"; matches: MatchedKey[]; original: string }
  | { type: "invalid"; original: string };

const TWO_MONTHS_MS = 2 * 30 * 24 * 60 * 60 * 1000;

export async function resolveKey(input: string): Promise<KeyResolveResult> {
  const upper = input.toUpperCase();

  if (isValidKey(upper)) {
    return { type: "valid", key: upper };
  }

  const matches = await findMatchingKeys(input);

  if (matches.length === 1) {
    return { type: "resolved", key: matches[0].key, original: input };
  }

  if (matches.length > 1) {
    // Sort by updated DESC to find the newest
    const byRecency = [...matches].sort(
      (a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime()
    );
    const newest = new Date(byRecency[0].updated).getTime();
    const secondNewest = new Date(byRecency[1].updated).getTime();

    // Auto-pick if the newest is >2 months ahead of the next
    if (newest - secondNewest > TWO_MONTHS_MS) {
      return { type: "resolved", key: byRecency[0].key, original: input };
    }

    return { type: "multiple", matches, original: input };
  }

  return { type: "invalid", original: input };
}

const DONE_STATUSES = localConfig.statuses.done;

export function getLocalMineIssues(accountId: string, qaAccountIds?: Set<string>): unknown[] {
  const database = getDb();
  const placeholders = DONE_STATUSES.map(() => "?").join(", ");

  // Base: tickets currently assigned to me
  const baseRows = database.query(
    `SELECT raw FROM issues WHERE assignee_id = ? AND status NOT IN (${placeholders}) ORDER BY updated DESC`
  ).all(accountId, ...DONE_STATUSES) as Array<{ raw: string }>;
  const seenKeys = new Set<string>();
  const results: unknown[] = [];
  for (const r of baseRows) {
    const raw = JSON.parse(r.raw);
    const key = (raw as Record<string, string>)?.key;
    if (key) seenKeys.add(key);
    results.push(raw);
  }

  // "Was mine" tickets: previously assigned to me, now assigned to QA
  if (qaAccountIds && qaAccountIds.size > 0) {
    const qaIds = [...qaAccountIds];
    const qaPlaceholders = qaIds.map(() => "?").join(", ");
    const wasMineRows = database.query(
      `SELECT i.raw FROM issues i
       JOIN issue_previous_assignees pa ON i.key = pa.key
       WHERE pa.account_id = ? AND i.assignee_id IN (${qaPlaceholders})
         AND i.status NOT IN (${placeholders})
       ORDER BY i.updated DESC`
    ).all(accountId, ...qaIds, ...DONE_STATUSES) as Array<{ raw: string }>;
    for (const r of wasMineRows) {
      const raw = JSON.parse(r.raw);
      const key = (raw as Record<string, string>)?.key;
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        results.push(raw);
      }
    }
  }

  return results;
}

export function getLocalSprintData(boardId?: number): { sprint: unknown; rawIssues: unknown[] } | null {
  const database = getDb();
  const rows = database.query(
    "SELECT raw FROM issues ORDER BY updated DESC"
  ).all() as Array<{ raw: string }>;

  // Find the active sprint from issue sprint fields
  let activeSprint: Record<string, unknown> | null = null;

  for (const row of rows) {
    const raw = JSON.parse(row.raw) as Record<string, unknown>;
    const fields = raw?.fields as Record<string, unknown> | undefined;
    const sprints = fields?.[customFields.sprint];
    if (!Array.isArray(sprints)) continue;
    for (const s of sprints) {
      if (s?.state === "active" && (!boardId || s?.boardId === boardId)) {
        activeSprint = s;
        break;
      }
    }
    if (activeSprint) break;
  }

  if (!activeSprint) return null;

  const sprintId = activeSprint.id;
  const sprintIssues: unknown[] = [];

  for (const row of rows) {
    const raw = JSON.parse(row.raw) as Record<string, unknown>;
    const fields = raw?.fields as Record<string, unknown> | undefined;
    const sprints = fields?.[customFields.sprint];
    if (!Array.isArray(sprints)) continue;
    if (sprints.some((s: Record<string, unknown>) => s?.id === sprintId)) {
      sprintIssues.push(raw);
    }
  }

  return { sprint: activeSprint, rawIssues: sprintIssues };
}

export type CachedTimelineDate = {
  key: string;
  startedAt: string | null;
  testingAt: string | null;
  completedAt: string | null;
  doneAt: string | null;
  statusCategory: string | null;
  status: string | null;
};

export function getTimelineDates(keys: string[]): CachedTimelineDate[] {
  if (keys.length === 0) return [];
  const database = getDb();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = database.query(
    `SELECT key, started_at, done_at, review_at, merge_ready_at, status_category, status FROM issues WHERE key IN (${placeholders})`
  ).all(...keys) as Array<{ key: string; started_at: string | null; done_at: string | null; review_at: string | null; merge_ready_at: string | null; status_category: string | null; status: string | null }>;
  return rows.map(r => ({
    key: r.key,
    startedAt: r.started_at,
    testingAt: r.review_at,
    completedAt: r.merge_ready_at,
    doneAt: r.done_at,
    statusCategory: r.status_category,
    status: r.status,
  }));
}

export function cacheTimelineDates(dates: Array<{ key: string; startedAt: string | null; testingAt: string | null; completedAt: string | null; doneAt: string | null }>): void {
  if (dates.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(
    "UPDATE issues SET started_at = ?, review_at = ?, merge_ready_at = ?, done_at = ? WHERE key = ?"
  );
  const updateMany = database.transaction((items: typeof dates) => {
    for (const d of items) {
      stmt.run(d.startedAt, d.testingAt, d.completedAt, d.doneAt, d.key);
    }
  });
  updateMany(dates);
}

// --- User functions ---

export type UserRecord = {
  accountId: string;
  displayName: string;
  email: string | null;
  active: boolean;
  isMainAccount: boolean;
  role: string | null;
  team: string | null;
  notes: string | null;
};

type UserRow = {
  account_id: string;
  display_name: string;
  email: string | null;
  active: number;
  is_main_account: number;
  role: string | null;
  team: string | null;
  notes: string | null;
};

function rowToUser(row: UserRow): UserRecord {
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    email: row.email,
    active: row.active === 1,
    isMainAccount: row.is_main_account === 1,
    role: row.role,
    team: row.team,
    notes: row.notes,
  };
}

export function getAllUsers(): UserRecord[] {
  const database = getDb();
  const rows = database.query("SELECT * FROM users ORDER BY display_name").all() as UserRow[];
  return rows.map(rowToUser);
}

export function getUser(accountId: string): UserRecord | null {
  const database = getDb();
  const row = database.query("SELECT * FROM users WHERE account_id = ?").get(accountId) as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function getMainUser(): UserRecord | null {
  const database = getDb();
  const row = database.query("SELECT * FROM users WHERE is_main_account = 1").get() as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function getUsersByRole(role: string): UserRecord[] {
  const database = getDb();
  const rows = database.query("SELECT * FROM users WHERE role = ? ORDER BY display_name").all(role) as UserRow[];
  return rows.map(rowToUser);
}

export function upsertUser(user: UserRecord): void {
  const database = getDb();
  database.run(`
    INSERT INTO users (account_id, display_name, email, active, is_main_account, role, team, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = excluded.display_name,
      email = excluded.email,
      active = excluded.active,
      is_main_account = excluded.is_main_account,
      role = excluded.role,
      team = excluded.team,
      notes = excluded.notes
  `, [
    user.accountId,
    user.displayName,
    user.email,
    user.active ? 1 : 0,
    user.isMainAccount ? 1 : 0,
    user.role,
    user.team,
    user.notes,
  ]);
}

export function upsertUsersFromSync(users: Array<{ accountId: string; displayName: string; email?: string | null; active?: boolean }>): void {
  if (users.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO users (account_id, display_name, email, active)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = excluded.display_name,
      email = COALESCE(excluded.email, users.email),
      active = excluded.active
  `);
  const insertMany = database.transaction((items: typeof users) => {
    for (const u of items) {
      stmt.run(u.accountId, u.displayName, u.email ?? null, u.active !== false ? 1 : 0);
    }
  });
  insertMany(users);
}

export function updateUserFields(accountId: string, fields: Partial<Pick<UserRecord, "role" | "team" | "notes" | "isMainAccount">>): void {
  const database = getDb();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if ("isMainAccount" in fields) {
    if (fields.isMainAccount) {
      database.run("UPDATE users SET is_main_account = 0 WHERE is_main_account = 1");
    }
    sets.push("is_main_account = ?");
    params.push(fields.isMainAccount ? 1 : 0);
  }
  if ("role" in fields) {
    sets.push("role = ?");
    params.push(fields.role ?? null);
  }
  if ("team" in fields) {
    sets.push("team = ?");
    params.push(fields.team ?? null);
  }
  if ("notes" in fields) {
    sets.push("notes = ?");
    params.push(fields.notes ?? null);
  }

  if (sets.length === 0) return;
  params.push(accountId);
  database.run(`UPDATE users SET ${sets.join(", ")} WHERE account_id = ?`, params);
}

export function findUserByNameOrId(query: string): UserRecord[] {
  const database = getDb();
  const lower = query.toLowerCase();
  const rows = database.query("SELECT * FROM users ORDER BY display_name").all() as UserRow[];
  return rows
    .filter(r => r.account_id === query || r.display_name.toLowerCase().includes(lower))
    .map(rowToUser);
}

// --- Previous assignee / "was mine" functions ---

export function cachePreviousAssignees(data: Array<{ key: string; accountIds: string[] }>): void {
  if (data.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(
    "INSERT OR IGNORE INTO issue_previous_assignees (key, account_id) VALUES (?, ?)"
  );
  const insertMany = database.transaction((items: typeof data) => {
    for (const { key, accountIds } of items) {
      for (const accountId of accountIds) {
        stmt.run(key, accountId);
      }
    }
  });
  insertMany(data);
}

export function cacheChangelog(entries: Array<{ key: string; created: number; field: string; fromString: string | null; toString: string | null; author: string | null }>): void {
  const database = getDb();
  const keys = [...new Set(entries.map(e => e.key))];
  const tx = database.transaction(() => {
    if (keys.length > 0) {
      const placeholders = keys.map(() => "?").join(", ");
      database.run(`DELETE FROM issue_changelog WHERE key IN (${placeholders})`, keys);
    }
    const insert = database.prepare(
      "INSERT INTO issue_changelog (key, created, field, from_string, to_string, author) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const e of entries) {
      const from = typeof e.fromString === "string" ? e.fromString : null;
      const to = typeof e.toString === "string" ? e.toString : null;
      const field = typeof e.field === "string" ? e.field : String(e.field ?? "");
      const created = typeof e.created === "number" ? e.created : Number(e.created) || 0;
      const author = typeof e.author === "string" ? e.author : null;
      insert.run(e.key, created, field, from, to, author);
    }
  });
  tx();
}

export function getChangelogEntries(keys: string[], sinceMs: number): Array<{ key: string; created: number; field: string; fromString: string | null; toString: string | null; author: string | null }> {
  const database = getDb();
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => "?").join(", ");
  return database.query(
    `SELECT key, created, field, from_string as fromString, to_string as toString, author
     FROM issue_changelog
     WHERE key IN (${placeholders}) AND created >= ?
     ORDER BY created DESC`
  ).all(...keys, sinceMs) as Array<{ key: string; created: number; field: string; fromString: string | null; toString: string | null; author: string | null }>;
}

export function markChangelogSynced(keys: string[]): void {
  if (keys.length === 0) return;
  const database = getDb();
  const placeholders = keys.map(() => "?").join(", ");
  database.run(
    `UPDATE issues SET changelog_synced = 1 WHERE key IN (${placeholders})`,
    keys
  );
}

export function resetChangelogSynced(): void {
  const database = getDb();
  database.run("UPDATE issues SET changelog_synced = 0");
}

export function getKeysNeedingChangelogSync(keys: string[]): string[] {
  if (keys.length === 0) return [];
  const database = getDb();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = database.query(
    `SELECT key FROM issues WHERE key IN (${placeholders}) AND changelog_synced = 0`
  ).all(...keys) as Array<{ key: string }>;
  return rows.map(r => r.key);
}

export function getBackfillKeys(monthsBack = 4): string[] {
  const database = getDb();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const cutoffStr = cutoff.toISOString();
  const rows = database.query(
    `SELECT key FROM issues WHERE changelog_synced = 0 AND (updated >= ? OR created >= ?) ORDER BY updated DESC`
  ).all(cutoffStr, cutoffStr) as Array<{ key: string }>;
  return rows.map(r => r.key);
}

export function getRecentCachedKeys(monthsBack = 4): string[] {
  const database = getDb();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const cutoffStr = cutoff.toISOString();
  const rows = database.query(
    `SELECT key FROM issues WHERE updated >= ? OR created >= ? ORDER BY updated DESC`
  ).all(cutoffStr, cutoffStr) as Array<{ key: string }>;
  return rows.map(r => r.key);
}

export function getWasMineKeys(accountId: string, keys?: string[]): Set<string> {
  const database = getDb();
  if (keys && keys.length > 0) {
    const placeholders = keys.map(() => "?").join(", ");
    const rows = database.query(
      `SELECT DISTINCT key FROM issue_previous_assignees WHERE account_id = ? AND key IN (${placeholders})`
    ).all(accountId, ...keys) as Array<{ key: string }>;
    return new Set(rows.map(r => r.key));
  }
  const rows = database.query(
    "SELECT DISTINCT key FROM issue_previous_assignees WHERE account_id = ?"
  ).all(accountId) as Array<{ key: string }>;
  return new Set(rows.map(r => r.key));
}

// --- Embedding functions ---

type EmbeddingIssue = {
  key: string;
  summary: string;
  description: string | null;
  acceptance_criteria: string | null;
  testing_instructions: string | null;
};

export function getIssuesNeedingEmbedding(limit?: number): EmbeddingIssue[] {
  const database = getDb();
  const rows = database.query(
    `SELECT key, summary, description, acceptance_criteria, testing_instructions, embedding_hash
     FROM issues${limit ? ` LIMIT ${limit}` : ""}`
  ).all() as Array<EmbeddingIssue & { embedding_hash: string | null }>;

  return rows.filter((row) => {
    const currentHash = computeContentHash({
      summary: row.summary,
      description: row.description,
      acceptanceCriteria: row.acceptance_criteria,
      testingInstructions: row.testing_instructions,
    });
    return row.embedding_hash !== currentHash;
  });
}

export function cacheEmbeddings(data: Array<{ key: string; embedding: Float32Array; hash: string }>): void {
  if (data.length === 0) return;
  const database = getDb();
  const stmt = database.prepare("UPDATE issues SET embedding = ?, embedding_hash = ? WHERE key = ?");
  const updateMany = database.transaction((items: typeof data) => {
    for (const d of items) {
      const buf = Buffer.from(d.embedding.buffer, d.embedding.byteOffset, d.embedding.byteLength);
      stmt.run(buf, d.hash, d.key);
    }
  });
  updateMany(data);
}

let embeddingCache: Map<string, Float32Array> | null = null;

export function getAllEmbeddings(): Map<string, Float32Array> {
  if (embeddingCache) return embeddingCache;
  const database = getDb();
  const rows = database.query(
    "SELECT key, embedding FROM issues WHERE embedding IS NOT NULL"
  ).all() as Array<{ key: string; embedding: Buffer }>;

  const map = new Map<string, Float32Array>();
  for (const row of rows) {
    if (row.embedding && row.embedding.byteLength === DIMENSIONS * 4) {
      map.set(row.key, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIMENSIONS));
    }
  }
  embeddingCache = map;
  return map;
}

export function invalidateEmbeddingCache(): void {
  embeddingCache = null;
}

export function getEmbeddingStats(): { total: number; embedded: number; pending: number } {
  const database = getDb();
  const totalRow = database.query("SELECT COUNT(*) as count FROM issues").get() as { count: number };
  const embeddedRow = database.query("SELECT COUNT(*) as count FROM issues WHERE embedding IS NOT NULL").get() as { count: number };
  return {
    total: totalRow.count,
    embedded: embeddedRow.count,
    pending: totalRow.count - embeddedRow.count,
  };
}

export interface CachedPage {
  id: string;
  spaceId: string;
  spaceKey: string | null;
  title: string;
  body: string | null;
  version: number;
  parentId: string | null;
  updated: string | null;
}

export function cachePages(pages: CachedPage[]): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO pages (id, space_id, space_key, title, body, version, parent_id, updated)
    VALUES ($id, $spaceId, $spaceKey, $title, $body, $version, $parentId, $updated)
    ON CONFLICT(id) DO UPDATE SET
      space_id = excluded.space_id,
      space_key = COALESCE(excluded.space_key, space_key),
      title = excluded.title,
      body = COALESCE(excluded.body, body),
      version = excluded.version,
      parent_id = COALESCE(excluded.parent_id, parent_id),
      updated = excluded.updated,
      cached_at = CURRENT_TIMESTAMP
  `);

  const insertMany = database.transaction((items: CachedPage[]) => {
    for (const item of items) {
      stmt.run({
        $id: item.id,
        $spaceId: item.spaceId,
        $spaceKey: item.spaceKey,
        $title: item.title,
        $body: item.body,
        $version: item.version,
        $parentId: item.parentId,
        $updated: item.updated,
      });
    }
  });

  insertMany(pages);
}

export function getPageFromCache(id: string): CachedPage | null {
  const database = getDb();
  const row = database.query("SELECT * FROM pages WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    spaceId: row.space_id,
    spaceKey: row.space_key,
    title: row.title,
    body: row.body,
    version: row.version,
    parentId: row.parent_id,
    updated: row.updated,
  };
}

export function searchPagesInCache(query: string): CachedPage[] {
  const database = getDb();
  const rows = database.query(`
    SELECT p.* FROM pages p
    JOIN pages_fts f ON p.id = f.id
    WHERE pages_fts MATCH ?
    ORDER BY rank
  `).all(query) as any[];

  return rows.map(row => ({
    id: row.id,
    spaceId: row.space_id,
    spaceKey: row.space_key,
    title: row.title,
    body: row.body,
    version: row.version,
    parentId: row.parent_id,
    updated: row.updated,
  }));
}

// ─── PR Cache ────────────────────────────────────────────────────────

const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type CachedPR = {
  cacheKey: string;
  repo: string;
  number: number;
  state: string;
  data: unknown;
  cachedAt: string;
};

export function cachePRs(prs: Array<{ repo: string; number: number; state: string; data: unknown }>): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO pr_cache (cache_key, repo, number, state, data, cached_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = database.transaction(() => {
    for (const pr of prs) {
      const cacheKey = `${pr.repo}#${pr.number}`;
      stmt.run(cacheKey, pr.repo, pr.number, pr.state, JSON.stringify(pr.data));
    }
  });
  tx();
}

/** Get all cached PRs, optionally filtered by repo/state. Returns null if cache is stale. */
export function getCachedPRs(opts?: {
  repos?: string[];
  state?: string;
  maxAgeMs?: number;
}): { prs: CachedPR[]; isStale: boolean } | null {
  const database = getDb();
  const maxAge = opts?.maxAgeMs ?? PR_CACHE_TTL_MS;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Check freshness: find the newest cached_at across all matching rows
  if (opts?.repos && opts.repos.length > 0) {
    const placeholders = opts.repos.map(() => "?").join(",");
    conditions.push(`repo IN (${placeholders})`);
    params.push(...opts.repos);
  }
  if (opts?.state) {
    conditions.push("state = ?");
    params.push(opts.state);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get the most recent cache time across matching rows
  const timeRow = database.query(`
    SELECT MAX(cached_at) as latest FROM pr_cache ${where}
  `).get(...params) as { latest: string | null } | undefined;

  if (!timeRow?.latest) return null; // No cached data

  const latestMs = new Date(timeRow.latest + "Z").getTime();
  const nowMs = Date.now();
  const isStale = (nowMs - latestMs) > maxAge;

  // Fetch all matching rows
  const rows = database.query(`
    SELECT cache_key, repo, number, state, data, cached_at
    FROM pr_cache ${where}
    ORDER BY cached_at DESC
  `).all(...params) as Array<{
    cache_key: string;
    repo: string;
    number: number;
    state: string;
    data: string;
    cached_at: string;
  }>;

  const prs: CachedPR[] = rows.map(row => ({
    cacheKey: row.cache_key,
    repo: row.repo,
    number: row.number,
    state: row.state,
    data: JSON.parse(row.data),
    cachedAt: row.cached_at,
  }));

  return { prs, isStale };
}

export function clearPRCache(): void {
  const database = getDb();
  database.run("DELETE FROM pr_cache");
}
