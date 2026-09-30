import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ConfigUser = {
  accountId: string;
  displayName: string;
  email: string | null;
  active: boolean;
  isMainAccount?: boolean;
  role: string | null;
  team: string | null;
  notes: string | null;
};

export type CustomFieldName =
  | "team"
  | "sprint"
  | "storyPoints"
  | "epicLink"
  | "acceptanceCriteria"
  | "testingInstructions";

export type StatusConfig = {
  inProgress: string[];
  review: string[];
  ready: string[];
  /** Sprint "to do" subgroups in display order: label -> statuses. */
  todo: Record<string, string[]>;
  done: string[];
  /** Status shown when `tik review` moves a ticket. */
  reviewName: string;
  timeline: {
    started: string[];
    testing: string[];
    completed: string[];
  };
};

type StatusOverrides = Partial<Omit<StatusConfig, "timeline">> & {
  timeline?: Partial<StatusConfig["timeline"]>;
};

export type LocalConfig = {
  jiraBase: string;
  myTeamId: string;
  myBoardId: number;
  inProgressTransitionId: string;
  reviewTransitionId: string;
  defaultProject: string;
  syncProjects: string[];
  teamName: string;
  teamBoardMap: Record<string, number>;
  teamIdNames: Record<string, string>;
  githubRepos: Record<string, string>;
  prBaseBranches?: Record<string, string>;
  projectAliases: Record<string, string[]>;
  /** Workflow status names by role; unset keys fall back to the Jira default workflow. */
  statuses: StatusConfig;
  /** Jira custom field IDs (e.g. "customfield_10020") by role; they differ per Jira instance. */
  customFields: Partial<Record<CustomFieldName, string>>;
  /** Project whose tickets are listed first within a timeline group. */
  timelineFirstProject?: string;
  /** Display names treated as bots by --no-bots and by export collapsing (substring match). */
  botAuthors?: string[];
  myEmail?: string;
  users?: ConfigUser[];
  confluence?: {
    defaultSpace?: string;
    syncSpaces?: string[];
  };
};

export const CONFIG_PATH = join(homedir(), ".config", "tik", "config.local.json");

const CORE_SETTINGS = ["jiraBase", "defaultProject", "syncProjects"] as const;

function isConfigOptionalCommand(): boolean {
  return ["--version", "-v", "version", "--help"].some((flag) => process.argv.includes(flag));
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "" || value === 0 ||
    (Array.isArray(value) && value.length === 0);
}

const DEFAULT_STATUSES: StatusConfig = {
  inProgress: ["In Progress"],
  review: ["In Review"],
  ready: [],
  todo: { "To Do": ["To Do", "Open"], Backlog: ["Backlog"] },
  done: ["Done", "Closed", "Resolved"],
  reviewName: "In Review",
  timeline: { started: ["In Progress"], testing: ["In Review"], completed: [] },
};

function emptyConfig(): LocalConfig {
  return {
    jiraBase: "",
    myTeamId: "",
    myBoardId: 0,
    inProgressTransitionId: "",
    reviewTransitionId: "",
    defaultProject: "",
    syncProjects: [],
    teamName: "",
    teamBoardMap: {},
    teamIdNames: {},
    githubRepos: {},
    projectAliases: {},
    statuses: DEFAULT_STATUSES,
    customFields: {},
    users: [],
    confluence: {
      defaultSpace: "",
      syncSpaces: [],
    },
  };
}

function loadConfig(): LocalConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    if (isConfigOptionalCommand()) return emptyConfig();
    fail(
      `Missing config file: ${CONFIG_PATH}\n` +
      `Create it from config.example.json:\n` +
      `  mkdir -p ~/.config/tik && cp config.example.json ${CONFIG_PATH}`
    );
  }

  let parsed: Partial<Omit<LocalConfig, "statuses">> & { statuses?: StatusOverrides };
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (isConfigOptionalCommand()) return emptyConfig();
    fail(`Invalid JSON in ${CONFIG_PATH}: ${(error as Error).message}`);
  }

  const config: LocalConfig = {
    ...emptyConfig(),
    ...parsed,
    statuses: {
      ...DEFAULT_STATUSES,
      ...parsed.statuses,
      timeline: { ...DEFAULT_STATUSES.timeline, ...parsed.statuses?.timeline },
    },
  };
  const missing = CORE_SETTINGS.filter((key) => isUnset(config[key]));
  if (missing.length > 0 && !isConfigOptionalCommand()) {
    fail(`Missing required setting(s) in ${CONFIG_PATH}: ${missing.join(", ")}\nSee config.example.json.`);
  }

  config.jiraBase = config.jiraBase.replace(/\/$/, "");
  return config;
}

export const localConfig = loadConfig();

/** For settings only some commands need (team, board, transitions): exits with a clear message when unset. */
export function requireSetting<K extends keyof LocalConfig>(key: K): NonNullable<LocalConfig[K]> {
  const value = localConfig[key];
  if (isUnset(value)) {
    fail(`This command needs "${key}" in ${CONFIG_PATH}. See config.example.json.`);
  }
  return value as NonNullable<LocalConfig[K]>;
}

const customFieldNames: CustomFieldName[] = [
  "team",
  "sprint",
  "storyPoints",
  "epicLink",
  "acceptanceCriteria",
  "testingInstructions",
];

/** Configured custom field IDs; "" when unset, so reads of an unset field find nothing. */
export const customFields = Object.fromEntries(
  customFieldNames.map((name) => [name, localConfig.customFields[name] ?? ""])
) as Record<CustomFieldName, string>;

export function requireCustomField(name: CustomFieldName): string {
  if (!customFields[name]) {
    fail(`This command needs "customFields.${name}" in ${CONFIG_PATH}. See config.example.json.`);
  }
  return customFields[name];
}
