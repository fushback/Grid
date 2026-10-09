import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express, { Request, Response } from 'express';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { Duplex } from 'node:stream';
import pg from 'pg';

const { Pool } = pg;

const browserDistFolder = join(import.meta.dirname, '../browser');
const CLOUD_STORE_FILE = '/tmp/gridpulse-cloud-state-v3.json';
const PERSISTENT_WORKSPACE_FILE = join(process.cwd(), '.gridpulse-workspace-state.json');

function readConnectionStringFromEnv(): string {
  const fromEnv = (
    process.env['SUPABASE_POSTGRES_CONNECTION_STRING'] ||
    process.env['DATABASE_URL'] ||
    ''
  ).trim();
  if (fromEnv && !fromEnv.includes('YOUR_SUPABASE_PASSWORD')) {
    return fromEnv;
  }
  try {
    const envPath = join(process.cwd(), '.env');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (
          (key === 'SUPABASE_POSTGRES_CONNECTION_STRING' || key === 'DATABASE_URL') &&
          val &&
          !val.includes('YOUR_SUPABASE_PASSWORD')
        ) {
          return val;
        }
      }
    }
  } catch {
    // Ignore .env read errors
  }
  return '';
}

let cachedPgPool: pg.Pool | null = null;
let cachedPgConnStr = '';

function getPgPool(): pg.Pool | null {
  let raw = readConnectionStringFromEnv();
  if (!raw) return null;
  const m = raw.match(/^(postgresql:\/\/[^:]+:)(.+)(@[^@]+)$/);
  if (m && m[2].includes('@')) {
    raw = m[1] + encodeURIComponent(m[2]) + m[3];
  }
  if (cachedPgPool && cachedPgConnStr === raw) {
    return cachedPgPool;
  }
  try {
    cachedPgConnStr = raw;
    cachedPgPool = new Pool({
      connectionString: raw,
      ssl: { rejectUnauthorized: false },
      max: 4,
      connectionTimeoutMillis: 6000,
    });
    return cachedPgPool;
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Registry of internal route handlers so WebSocket RPC (ExecuteCrudCommand) and /api/realtime/crud
// can invoke any workspace/sidebar/grid CRUD handler in-memory with zero HTTP loopback overhead.
type InternalRouteHandler = (req: Request, res: Response) => unknown;
const registeredRouteHandlers = new Map<string, InternalRouteHandler>();

const origAppGet = app.get.bind(app);
const origAppPost = app.post.bind(app);

(app as unknown as { get: (...args: unknown[]) => unknown }).get = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && typeof args[args.length - 1] === 'function') {
    registeredRouteHandlers.set(`GET:${args[0]}`, args[args.length - 1] as InternalRouteHandler);
  }
  return (origAppGet as (...a: unknown[]) => unknown)(...args);
};

(app as unknown as { post: (...args: unknown[]) => unknown }).post = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && typeof args[args.length - 1] === 'function') {
    registeredRouteHandlers.set(`POST:${args[0]}`, args[args.length - 1] as InternalRouteHandler);
  }
  return (origAppPost as (...a: unknown[]) => unknown)(...args);
};

const angularApp = new AngularNodeAppEngine();

interface ServerColumn {
  id: string;
  name: string;
  colType:
    | 'text'
    | 'varchar_max'
    | 'number'
    | 'date'
    | 'dropdown'
    | 'lookup'
    | 'checkbox'
    | 'formula';
  orderIndex: number;
  width: number;
  required: boolean;
  isNullable?: boolean;
  isPrimaryKey?: boolean;
  isIdentity?: boolean;
  identitySeed?: number;
  identityIncrement?: number;
  defaultValue?: string;
  formula: string;
  optionsCsv: string;
  lookupTableName?: string;
}

interface ServerRow {
  id: string;
  orderIndex: number;
  cells: Record<string, string | number | boolean>;
  updatedBy: string;
  updatedAt: string;
}

interface ServerTable {
  tableName: string;
  columns: ServerColumn[];
  rows: ServerRow[];
  allowEmptyColumns?: boolean;
  identitySeed: number;
  identityIncrement: number;
  nextIdentityValue: number;
  createdAt: string;
  updatedAt: string;
}

interface ServerDatabase {
  databaseName: string;
  activeTableName: string;
  tables: ServerTable[];
  createdAt: string;
  updatedAt: string;
}

interface DbTableSummary {
  tableName: string;
  rowCount: number;
  columnCount: number;
  columns: ServerColumn[];
  rows?: ServerRow[];
  identitySeed: number;
  identityIncrement: number;
  nextIdentityValue: number;
  createdAt: string;
  updatedAt: string;
}

interface DbDatabaseSummary {
  databaseName: string;
  activeTableName: string;
  tables: DbTableSummary[];
  createdAt: string;
  updatedAt: string;
}

interface ServerPresence {
  userId: string;
  displayName: string;
  color: string;
  isAnonymous: boolean;
  activeRowId: string;
  activeColId: string;
  updatedAt: string;
}

interface ServerActivity {
  id: string;
  userName: string;
  userColor: string;
  action: string;
  detail: string;
  timestamp: string;
}

interface ServerUser {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: string;
  color: string;
  createdAt: string;
}

interface ServerVersionCommit {
  id: string;
  versionTag: string;
  title: string;
  message: string;
  authorName: string;
  authorColor: string;
  createdAt: string;
  rowCount: number;
  columnCount: number;
  columnsSnapshot: ServerColumn[];
  rowsSnapshot: ServerRow[];
}

interface ServerSortRule {
  columnId: string;
  direction: 'asc' | 'desc';
}

interface ServerColumnFilterRule {
  columnId: string;
  condition:
    | 'none'
    | 'contains'
    | 'not_contains'
    | 'equals'
    | 'not_equals'
    | 'gt'
    | 'lt'
    | 'between'
    | 'empty'
    | 'not_empty';
  queryValue: string;
  queryValueEnd: string;
  excludedValues: string[];
}

interface CloudWorkspaceState {
  workspaceId: string;
  workspaceName: string;
  activeDatabaseName: string;
  databases: ServerDatabase[];
  activeTableName: string;
  tables: ServerTable[];
  updatedAt: string;
  columns: ServerColumn[];
  rows: ServerRow[];
  presence: Record<string, ServerPresence>;
  activities: ServerActivity[];
  users?: ServerUser[];
  sessions?: Record<string, string>;
  versions?: ServerVersionCommit[];
}

function buildDefaultColumns(): ServerColumn[] {
  return [
    {
      id: 'ID',
      name: 'ID',
      colType: 'number',
      orderIndex: 0,
      width: 90,
      required: true,
      isNullable: false,
      isPrimaryKey: true,
      isIdentity: true,
      identitySeed: 1,
      identityIncrement: 1,
      defaultValue: '',
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Record ID',
      name: 'Record ID',
      colType: 'text',
      orderIndex: 1,
      width: 125,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Initiative & Deliverable',
      name: 'Initiative & Deliverable',
      colType: 'text',
      orderIndex: 2,
      width: 245,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Department',
      name: 'Department',
      colType: 'dropdown',
      orderIndex: 3,
      width: 155,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: 'Engineering, Product, Finance, Operations, Growth, Security',
    },
    {
      id: 'Stage',
      name: 'Stage',
      colType: 'dropdown',
      orderIndex: 4,
      width: 145,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: 'Active, In Review, Planned, Completed, At Risk',
    },
    {
      id: 'Lead Owner',
      name: 'Lead Owner',
      colType: 'text',
      orderIndex: 5,
      width: 155,
      required: false,
      isNullable: true,
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Units',
      name: 'Units',
      colType: 'number',
      orderIndex: 6,
      width: 110,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Unit Cost',
      name: 'Unit Cost',
      colType: 'number',
      orderIndex: 7,
      width: 125,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Total Budget',
      name: 'Total Budget',
      colType: 'formula',
      orderIndex: 8,
      width: 145,
      required: false,
      isNullable: true,
      formula: '=[Units] * [Unit Cost]',
      optionsCsv: '',
    },
    {
      id: 'Est. Value (1.25x)',
      name: 'Est. Value (1.25x)',
      colType: 'formula',
      orderIndex: 9,
      width: 155,
      required: false,
      isNullable: true,
      formula: '=ROUND([Total Budget] * 1.25, 2)',
      optionsCsv: '',
    },
    {
      id: 'Target Date',
      name: 'Target Date',
      colType: 'date',
      orderIndex: 10,
      width: 140,
      required: true,
      isNullable: false,
      formula: '',
      optionsCsv: '',
    },
    {
      id: 'Approved',
      name: 'Approved',
      colType: 'checkbox',
      orderIndex: 11,
      width: 110,
      required: false,
      isNullable: true,
      formula: '',
      optionsCsv: '',
    },
  ];
}

const INITIATIVES = [
  'Cloud Data Warehouse Migration',
  'Zero-Trust IAM Policy Rollout',
  'Q4 Enterprise Billing Pipeline',
  'Real-Time Analytics Stream Engine',
  'APAC Regional Edge Deployment',
  'Automated Reconciliation Ledger',
  'Customer Portal SSO Upgrade',
  'Distributed Cache Optimization',
  'SOC2 Type II Compliance Audit',
  'Multi-Region Failover Drills',
  'Self-Serve Onboarding Funnel',
  'Mobile Offline Sync Protocol',
  'Partner Webhook Gateway v2',
  'Executive Revenue Forecasting',
  'Kubernetes Cluster Right-Sizing',
];

const DEPARTMENTS = ['Engineering', 'Product', 'Finance', 'Operations', 'Growth', 'Security'];
const STAGES = ['Active', 'In Review', 'Planned', 'Completed', 'At Risk'];
const OWNERS = [
  'Elena Rostova',
  'Marcus Vance',
  'Priya Nair',
  'Devon Brooks',
  'Hannah Abbott',
  'Liam Chen',
  'Sofia Alverez',
  'Noah Takahashi',
];

function generateSampleRows(count: number, startOffset = 0): ServerRow[] {
  const rows: ServerRow[] = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < count; i++) {
    const idx = startOffset + i + 1;
    const code = `GP-${String(1000 + idx)}`;
    const title = `${INITIATIVES[idx % INITIATIVES.length]} — Batch ${(idx % 9) + 1}`;
    const dept = DEPARTMENTS[idx % DEPARTMENTS.length];
    const stage = STAGES[(idx * 3) % STAGES.length];
    const owner = OWNERS[(idx * 2) % OWNERS.length];
    const units = 10 + ((idx * 17) % 240);
    const unitCost = 25 + ((idx * 43) % 475);
    const month = String(((idx % 12) + 1)).padStart(2, '0');
    const day = String(((idx * 5) % 28) + 1).padStart(2, '0');
    const due = `2026-${month}-${day}`;
    const approved = idx % 3 !== 0;

    rows.push({
      id: `row_${idx}_${Date.now().toString(36)}`,
      orderIndex: idx * 10,
      cells: {
        ID: idx,
        'Record ID': code,
        'Initiative & Deliverable': title,
        Department: dept,
        Stage: stage,
        'Lead Owner': owner,
        Units: units,
        'Unit Cost': unitCost,
        'Target Date': due,
        Approved: approved,
      },
      updatedBy: owner,
      updatedAt: nowIso,
    });
  }
  return rows;
}

function ensurePrimaryKeyIdentityColumn(columns: ServerColumn[]): ServerColumn[] {
  const existingPk = columns.find(
    (c) => c.isPrimaryKey || c.isIdentity || c.id.toLowerCase() === 'id' || c.name.toLowerCase() === 'id'
  );
  const pkCol: ServerColumn = {
    id: 'ID',
    name: 'ID',
    colType: 'number',
    orderIndex: 0,
    width: existingPk?.width || 90,
    required: true,
    isNullable: false,
    isPrimaryKey: true,
    isIdentity: true,
    identitySeed: existingPk?.identitySeed ?? 1,
    identityIncrement: existingPk?.identityIncrement ?? 1,
    defaultValue: '',
    formula: '',
    optionsCsv: '',
  };
  const nonPkCols = columns.filter(
    (c) =>
      c !== existingPk &&
      !c.isPrimaryKey &&
      !c.isIdentity &&
      c.id.toLowerCase() !== 'id' &&
      c.name.toLowerCase() !== 'id'
  );
  return [
    pkCol,
    ...nonPkCols.map((c, idx) => ({
      ...c,
      orderIndex: idx + 1,
      isNullable: c.isNullable ?? !c.required,
      required: Boolean(c.required || c.isNullable === false),
    })),
  ];
}

function resolveServerColumnDefaultValue(col: ServerColumn): string | number | boolean {
  const trimmed = String(col.defaultValue ?? '').trim();
  if (col.colType === 'checkbox') {
    const lower = trimmed.toLowerCase();
    return (
      lower === 'true' ||
      lower === '1' ||
      lower === 'yes' ||
      lower === 'y' ||
      lower === 'checked' ||
      lower === 'on'
    );
  }
  if (col.colType === 'number') {
    const cleaned = trimmed.replace(/[$,%\s()]/g, '');
    const parsed = Number(cleaned);
    return cleaned.length > 0 && Number.isFinite(parsed) ? parsed : 0;
  }
  if (col.colType === 'date') {
    return trimmed || new Date().toISOString().slice(0, 10);
  }
  if (col.colType === 'dropdown') {
    const opts = (col.optionsCsv || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const matched = opts.find((o) => o.toLowerCase() === trimmed.toLowerCase());
    return matched || trimmed || opts[0] || '';
  }
  if (col.colType === 'lookup') {
    const rawOpts = (col.optionsCsv || '').trim();
    if (rawOpts.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawOpts);
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (trimmed) {
            const lowerTrimmed = trimmed.toLowerCase();
            const matchedObj = parsed.find((entry) => {
              if (!entry || typeof entry !== 'object') return false;
              const obj = entry as Record<string, unknown>;
              if (JSON.stringify(obj).toLowerCase() === lowerTrimmed) return true;
              for (const v of Object.values(obj)) {
                if (String(v ?? '').toLowerCase() === lowerTrimmed) return true;
              }
              return false;
            });
            if (matchedObj) {
              return JSON.stringify(matchedObj);
            }
          }
          if (col.required || col.isNullable === false || trimmed) {
            return JSON.stringify(parsed[0]);
          }
          return '';
        }
      } catch {
        // Fallback below
      }
    }
    if (trimmed) return trimmed;
    const objMatch = /\{([^{}]+)\}/.exec(rawOpts);
    return objMatch ? `{${objMatch[1].trim()}}` : '';
  }
  return trimmed.slice(0, 2000) || (col.required || col.isNullable === false ? 'TBD' : '');
}

function sanitizeRowsAgainstSchema(columns: ServerColumn[], rows: ServerRow[]): ServerRow[] {
  const pkCol = columns.find((c) => c.isPrimaryKey || c.isIdentity);
  const usedIds = new Set<number>();
  let maxId = 0;

  if (pkCol) {
    for (const r of rows) {
      const rawPk = r.cells?.[pkCol.name] ?? r.cells?.[pkCol.id];
      const numPk = Number(rawPk);
      if (Number.isInteger(numPk) && numPk >= 1 && !usedIds.has(numPk)) {
        usedIds.add(numPk);
        if (numPk > maxId) maxId = numPk;
      }
    }
  }

  const assignedPkByRowId = new Map<string, number>();
  if (pkCol) {
    const seenInPass = new Set<number>();
    for (const r of rows) {
      const rawPk = r.cells?.[pkCol.name] ?? r.cells?.[pkCol.id];
      const numPk = Number(rawPk);
      if (Number.isInteger(numPk) && numPk >= 1 && !seenInPass.has(numPk)) {
        seenInPass.add(numPk);
        assignedPkByRowId.set(r.id, numPk);
      } else {
        maxId += 1;
        seenInPass.add(maxId);
        assignedPkByRowId.set(r.id, maxId);
      }
    }
  }

  return rows.map((row) => {
    const rawCells: Record<string, string | number | boolean> = { ...(row.cells || {}) };
    const nextCells: Record<string, string | number | boolean> = {};

    for (const col of columns) {
      if (col.isPrimaryKey || col.isIdentity) {
        const pkVal = assignedPkByRowId.get(row.id) ?? 1;
        nextCells[col.name] = pkVal;
        nextCells[col.id] = pkVal;
        continue;
      }

      if (col.colType === 'formula') {
        continue;
      }

      const rawVal = rawCells[col.name] !== undefined ? rawCells[col.name] : rawCells[col.id];
      const hasDefault =
        col.defaultValue !== undefined && String(col.defaultValue).trim().length > 0;
      const val =
        (rawVal === undefined || rawVal === null || rawVal === '') && hasDefault
          ? resolveServerColumnDefaultValue(col)
          : rawVal;
      let normalized: string | number | boolean = val ?? '';

      if (col.colType === 'number') {
        if (typeof val === 'boolean') {
          normalized = val ? 1 : 0;
        } else if (typeof val === 'string') {
          const lower = val.trim().toLowerCase();
          if (lower === 'false' || lower === 'true') {
            normalized = lower === 'true' ? 1 : 0;
          } else {
            const num = Number(val.replace(/[$,%\s()]/g, ''));
            normalized = Number.isFinite(num) && val.trim() !== '' ? num : 0;
          }
        } else if (typeof val === 'number') {
          normalized = Number.isFinite(val) ? val : 0;
        } else {
          normalized = 0;
        }
      } else if (col.colType === 'checkbox') {
        if (typeof val === 'boolean') {
          normalized = val;
        } else {
          const lower = String(val ?? '').trim().toLowerCase();
          normalized =
            lower === 'true' ||
            lower === '1' ||
            lower === 'yes' ||
            lower === 'y' ||
            lower === 'checked' ||
            lower === 'on';
        }
      } else {
        normalized = val === undefined || val === null ? '' : String(val).slice(0, 2000);
      }

      // Store keyed by Column Name (database field name) AND column id
      nextCells[col.name] = normalized;
      nextCells[col.id] = normalized;
    }

    return {
      ...row,
      cells: nextCells,
    };
  });
}

function buildDefaultUsers(): ServerUser[] {
  const nowIso = new Date().toISOString();
  return [
    {
      id: 'usr_pg_1',
      email: 'alex.rivera@gridpulse.io',
      passwordHash: 'GridPulse@2026',
      displayName: 'Alex Rivera',
      role: 'Workspace Admin',
      color: '#ca8a04',
      createdAt: nowIso,
    },
    {
      id: 'usr_pg_2',
      email: 'elena.rostova@gridpulse.io',
      passwordHash: 'GridPulse@2026',
      displayName: 'Elena Rostova',
      role: 'Operations Lead',
      color: '#059669',
      createdAt: nowIso,
    },
  ];
}

function evaluateServerFormula(
  formula: string,
  row: ServerRow,
  columns: ServerColumn[],
  depth = 0
): string | number | boolean {
  if (!formula || depth > 4) return '';
  let expr = formula.trim();
  if (expr.startsWith('=')) {
    expr = expr.slice(1).trim();
  }
  if (!expr) return '';

  const resolveColRef = (refName: string): string | number | boolean => {
    const cleanRef = refName.trim().replace(/^\[|\]$/g, '').trim().toLowerCase();
    const targetCol = columns.find(
      (c) => c.id.toLowerCase() === cleanRef || c.name.toLowerCase() === cleanRef
    );
    if (!targetCol) return 0;
    if (targetCol.colType === 'formula' && targetCol.formula) {
      return evaluateServerFormula(targetCol.formula, row, columns, depth + 1);
    }
    const byName = row.cells[targetCol.name];
    const byId = row.cells[targetCol.id];
    const raw = byName !== undefined && byName !== null ? byName : byId;
    return raw !== undefined && raw !== null ? raw : 0;
  };

  const upperMatch = /^UPPER\(\s*(?:\[([^\]]+)\]|([^)]+))\s*\)$/i.exec(expr);
  if (upperMatch) {
    return String(resolveColRef(upperMatch[1] || upperMatch[2] || '')).toUpperCase();
  }

  const ifMatch =
    /^IF\(\s*(?:\[([^\]]+)\]|([^,]+))\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)$/i.exec(expr);
  if (ifMatch) {
    const condVal = resolveColRef(ifMatch[1] || ifMatch[2] || '');
    const truthy =
      condVal === true ||
      condVal === 'true' ||
      (typeof condVal === 'number' && condVal > 0) ||
      (typeof condVal === 'string' && condVal.length > 0 && condVal !== 'false' && condVal !== '0');
    return truthy ? ifMatch[3] : ifMatch[4];
  }

  let roundDecimals: number | null = null;
  const roundMatch = /^ROUND\(\s*(.+)\s*,\s*(\d+)\s*\)$/i.exec(expr);
  if (roundMatch) {
    expr = roundMatch[1].trim();
    roundDecimals = Number(roundMatch[2]);
  }

  const sumMatch = /^(SUM|AVG|MIN|MAX)\((.+)\)$/i.exec(expr);
  if (sumMatch) {
    const fn = sumMatch[1].toUpperCase();
    const args = sumMatch[2].split(',').map((part) => {
      const m = /\[([^\]]+)\]/.exec(part);
      if (m) {
        const val = Number(resolveColRef(m[1]));
        return Number.isFinite(val) ? val : 0;
      }
      const trimmedPart = part.trim();
      const matchedCol = columns.find(
        (c) =>
          c.name.toLowerCase() === trimmedPart.toLowerCase() ||
          c.id.toLowerCase() === trimmedPart.toLowerCase()
      );
      const val = matchedCol ? Number(resolveColRef(matchedCol.name)) : Number(trimmedPart);
      return Number.isFinite(val) ? val : 0;
    });
    if (args.length === 0) return 0;
    let res = 0;
    if (fn === 'SUM') res = args.reduce((a, b) => a + b, 0);
    if (fn === 'AVG') res = args.reduce((a, b) => a + b, 0) / args.length;
    if (fn === 'MIN') res = Math.min(...args);
    if (fn === 'MAX') res = Math.max(...args);
    if (roundDecimals !== null) {
      const factor = Math.pow(10, roundDecimals);
      return Math.round(res * factor) / factor;
    }
    return Math.round(res * 100) / 100;
  }

  let substituted = expr.replace(/\[([^\]]+)\]/g, (_, colRef: string) => {
    const val = Number(resolveColRef(colRef));
    return Number.isFinite(val) ? String(val) : '0';
  });

  const colsByLength = [...columns].sort((a, b) => b.name.length - a.name.length);
  for (const col of colsByLength) {
    const escapedName = col.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedName) continue;
    const bareRegex = new RegExp(`(?<![a-zA-Z0-9_])(${escapedName})(?![a-zA-Z0-9_])`, 'gi');
    substituted = substituted.replace(bareRegex, () => {
      const val = Number(resolveColRef(col.name));
      return Number.isFinite(val) ? String(val) : '0';
    });
  }

  if (!/^[0-9+\-*/().\s]+$/.test(substituted)) {
    return 0;
  }

  try {
    const tokens: string[] = [];
    let current = '';
    for (const ch of substituted) {
      if (ch === ' ') continue;
      if ('+-*/()'.includes(ch)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        tokens.push(ch);
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);

    let pos = 0;
    const parseExpression = (): number => {
      let val = parseTerm();
      while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
        const op = tokens[pos++];
        const right = parseTerm();
        val = op === '+' ? val + right : val - right;
      }
      return val;
    };
    const parseTerm = (): number => {
      let val = parseFactor();
      while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
        const op = tokens[pos++];
        const right = parseFactor();
        val = op === '*' ? val * right : right === 0 ? 0 : val / right;
      }
      return val;
    };
    const parseFactor = (): number => {
      if (tokens[pos] === '(') {
        pos++;
        const val = parseExpression();
        if (tokens[pos] === ')') pos++;
        return val;
      }
      if (tokens[pos] === '-') {
        pos++;
        return -parseFactor();
      }
      if (tokens[pos] === '+') {
        pos++;
        return parseFactor();
      }
      const num = Number(tokens[pos++] || '0');
      return Number.isFinite(num) ? num : 0;
    };

    const result = parseExpression();
    if (!Number.isFinite(result)) return 0;
    if (roundDecimals !== null) {
      const factor = Math.pow(10, roundDecimals);
      return Math.round(result * factor) / factor;
    }
    return Math.round(result * 100) / 100;
  } catch {
    return 0;
  }
}

function getServerDisplayValue(
  row: ServerRow,
  col: ServerColumn,
  columns: ServerColumn[]
): string | number | boolean {
  if (col.colType === 'formula') {
    return evaluateServerFormula(col.formula, row, columns);
  }
  const byName = row.cells[col.name];
  const byId = row.cells[col.id];
  const val = byName !== undefined && byName !== null ? byName : byId;
  if (val === undefined || val === null) {
    return col.colType === 'checkbox' ? false : '';
  }
  return val;
}

function executeDatabaseQuery(
  columns: ServerColumn[],
  allRows: ServerRow[],
  params: {
    offset?: number;
    limit?: number;
    selectAll?: boolean;
    globalSearchQuery?: string;
    searchScopeColId?: string;
    columnHeaderSearches?: Record<string, string>;
    filterRules?: Record<string, ServerColumnFilterRule>;
    sortRules?: ServerSortRule[];
  }
): {
  rows: ServerRow[];
  allMatchedRowIds: string[];
  totalRows: number;
  filteredTotalRows: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  uniqueValuesByColumn: Record<string, { label: string; count: number }[]>;
} {
  const sortedCols = [...columns].sort((a, b) => a.orderIndex - b.orderIndex);
  const search = (params.globalSearchQuery || '').trim().toLowerCase();
  const scope = params.searchScopeColId || 'all';
  const headerSearches = params.columnHeaderSearches || {};
  const filters = params.filterRules || {};
  const sorts = params.sortRules || [];

  // Compute unique value counts per column across the database rows for Excel Filter checklists
  const uniqueValuesByColumn: Record<string, { label: string; count: number }[]> = {};
  for (const col of sortedCols) {
    const counts = new Map<string, number>();
    for (const row of allRows) {
      const raw = getServerDisplayValue(row, col, sortedCols);
      const str = raw === null || raw === undefined || String(raw) === '' ? '(Blank)' : String(raw);
      counts.set(str, (counts.get(str) || 0) + 1);
    }
    uniqueValuesByColumn[col.id] = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      .slice(0, 150);
  }

  // Step 1: Database Filter & Search
  const matched = allRows.filter((row) => {
    if (search.length > 0) {
      if (scope !== 'all') {
        const col = sortedCols.find((c) => c.id === scope);
        const val = col ? getServerDisplayValue(row, col, sortedCols) : '';
        if (!String(val).toLowerCase().includes(search)) return false;
      } else {
        const anyMatch = sortedCols.some((col) => {
          const val = getServerDisplayValue(row, col, sortedCols);
          return String(val).toLowerCase().includes(search);
        });
        if (!anyMatch) return false;
      }
    }

    for (const col of sortedCols) {
      const rawVal = getServerDisplayValue(row, col, sortedCols);
      const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal);
      const lowerVal = strVal.toLowerCase();

      const colHeaderQuery = (headerSearches[col.id] || '').trim().toLowerCase();
      if (colHeaderQuery.length > 0 && !lowerVal.includes(colHeaderQuery)) {
        return false;
      }

      const rule = filters[col.id];
      if (!rule) continue;

      if (Array.isArray(rule.excludedValues) && rule.excludedValues.length > 0) {
        const displayKey = strVal === '' ? '(Blank)' : strVal;
        if (rule.excludedValues.includes(displayKey)) {
          return false;
        }
      }

      if (rule.condition && rule.condition !== 'none') {
        const q = (rule.queryValue || '').trim().toLowerCase();
        const qNum = Number(rule.queryValue);
        const vNum = Number(rawVal);

        switch (rule.condition) {
          case 'empty':
            if (strVal.trim().length > 0) return false;
            break;
          case 'not_empty':
            if (strVal.trim().length === 0) return false;
            break;
          case 'contains':
            if (q.length > 0 && !lowerVal.includes(q)) return false;
            break;
          case 'not_contains':
            if (q.length > 0 && lowerVal.includes(q)) return false;
            break;
          case 'equals':
            if (q.length > 0 && lowerVal !== q) return false;
            break;
          case 'not_equals':
            if (q.length > 0 && lowerVal === q) return false;
            break;
          case 'gt':
            if ((rule.queryValue || '').trim().length > 0) {
              if (!Number.isNaN(qNum) && !Number.isNaN(vNum)) {
                if (!(vNum > qNum)) return false;
              } else if (!(lowerVal > q)) {
                return false;
              }
            }
            break;
          case 'lt':
            if ((rule.queryValue || '').trim().length > 0) {
              if (!Number.isNaN(qNum) && !Number.isNaN(vNum)) {
                if (!(vNum < qNum)) return false;
              } else if (!(lowerVal < q)) {
                return false;
              }
            }
            break;
          case 'between': {
            const qEndNum = Number(rule.queryValueEnd);
            if (
              (rule.queryValue || '').trim().length > 0 &&
              (rule.queryValueEnd || '').trim().length > 0 &&
              !Number.isNaN(qNum) &&
              !Number.isNaN(qEndNum) &&
              !Number.isNaN(vNum)
            ) {
              if (vNum < Math.min(qNum, qEndNum) || vNum > Math.max(qNum, qEndNum)) {
                return false;
              }
            }
            break;
          }
        }
      }
    }
    return true;
  });

  // Step 2: Database Multi-Column Sort
  let sorted: ServerRow[];
  if (sorts.length === 0) {
    sorted = [...matched].sort((a, b) => a.orderIndex - b.orderIndex);
  } else {
    const colMap = new Map<string, ServerColumn>(sortedCols.map((c) => [c.id, c]));
    sorted = [...matched].sort((rowA, rowB) => {
      for (const rule of sorts) {
        const col = colMap.get(rule.columnId);
        if (!col) continue;
        const valA = getServerDisplayValue(rowA, col, sortedCols);
        const valB = getServerDisplayValue(rowB, col, sortedCols);

        let cmp = 0;
        if (col.colType === 'number' || col.colType === 'formula') {
          const numA = Number(valA);
          const numB = Number(valB);
          if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
            cmp = numA - numB;
          } else {
            cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true });
          }
        } else if (col.colType === 'checkbox') {
          cmp = (valA === true ? 1 : 0) - (valB === true ? 1 : 0);
        } else {
          cmp = String(valA).localeCompare(String(valB), undefined, {
            numeric: true,
            sensitivity: 'base',
          });
        }
        if (cmp !== 0) {
          return rule.direction === 'asc' ? cmp : -cmp;
        }
      }
      return rowA.orderIndex - rowB.orderIndex;
    });
  }

  const offset = params.selectAll ? 0 : Math.max(0, Number(params.offset ?? 0));
  const limit = params.selectAll
    ? Math.max(1, sorted.length)
    : Math.max(1, Math.min(10000, Number(params.limit ?? 10)));
  const slice = params.selectAll ? sorted : sorted.slice(offset, offset + limit);

  return {
    rows: slice,
    allMatchedRowIds: sorted.map((r) => r.id),
    totalRows: allRows.length,
    filteredTotalRows: sorted.length,
    offset,
    limit,
    hasMore: !params.selectAll && offset + limit < sorted.length,
    uniqueValuesByColumn,
  };
}

function computeNextIdentityValue(columns: ServerColumn[], rows: ServerRow[]): number {
  const pkCol = columns.find((c) => c.isPrimaryKey || c.isIdentity);
  if (!pkCol) return rows.length + 1;
  let maxId = 0;
  for (const r of rows) {
    const raw = r.cells?.[pkCol.name] ?? r.cells?.[pkCol.id];
    const num = Number(raw);
    if (Number.isInteger(num) && num > maxId) {
      maxId = num;
    }
  }
  return maxId + 1;
}

function quoteSqlIdent(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(val: string): string {
  return `'${String(val).replace(/'/g, "''")}'`;
}

function mapColTypeToSqlType(col: ServerColumn): string {
  if (col.isPrimaryKey || col.isIdentity) {
    return 'INTEGER GENERATED BY DEFAULT AS IDENTITY (START WITH 1 INCREMENT BY 1) PRIMARY KEY';
  }
  const notNullClause = col.isNullable === false || col.required ? ' NOT NULL' : ' NULL';
  const defVal = resolveServerColumnDefaultValue(col);
  switch (col.colType) {
    case 'number':
      return `NUMERIC DEFAULT ${Number.isFinite(Number(defVal)) ? Number(defVal) : 0}${notNullClause}`;
    case 'checkbox':
      return `BOOLEAN DEFAULT ${defVal === true ? 'TRUE' : 'FALSE'}${notNullClause}`;
    case 'varchar_max':
      return `VARCHAR(2000) DEFAULT ${quoteSqlLiteral(String(defVal))}${notNullClause}`;
    default:
      return `TEXT DEFAULT ${quoteSqlLiteral(String(defVal))}${notNullClause}`;
  }
}

interface WriteBehindDdlTask {
  type: 'create_database' | 'rename_database' | 'drop_database' | 'drop_table';
  databaseName: string;
  newDatabaseName?: string;
  tableName?: string;
  timestampMs: number;
}

const writeBehindDdlQueue: WriteBehindDdlTask[] = [];
let writeBehindMetadataDirty = false;

// Write-Behind Buffer tracking dirty rows & dirty tables awaiting PostgreSQL bulk flush
const writeBehindDirtyRows = new Map<
  string,
  { databaseName: string; tableName: string; rowId: string; timestampMs: number }
>();
const writeBehindDirtyTables = new Map<
  string,
  { databaseName: string; tableName: string; firstDirtyAtMs: number }
>();

const writeBehindMetrics = {
  totalCoalescedEdits: 0,
  totalPostgresBulkFlushes: 0,
  lastFlushedAt: null as string | null,
  flushIntervalSeconds: 120,
  bufferThresholdRows: 100,
  isFlushing: false,
};

async function execCreateDatabaseInPostgres(databaseName: string): Promise<void> {
  const pool = getPgPool();
  if (!pool || !databaseName) return;
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteSqlIdent(databaseName)}`);
  } catch {
    // Ignore schema creation errors
  }
}

async function execRenameDatabaseInPostgres(
  oldDatabaseName: string,
  newDatabaseName: string
): Promise<void> {
  const pool = getPgPool();
  if (!pool || !oldDatabaseName || !newDatabaseName) return;
  const cleanOld = stripDboPrefix(oldDatabaseName);
  const cleanNew = stripDboPrefix(newDatabaseName);
  if (!cleanOld || !cleanNew || cleanOld.toLowerCase() === cleanNew.toLowerCase()) return;
  try {
    await pool.query(
      `ALTER SCHEMA ${quoteSqlIdent(cleanOld)} RENAME TO ${quoteSqlIdent(cleanNew)}`
    );
  } catch {
    await execCreateDatabaseInPostgres(cleanNew);
  }
}

async function execDropDatabaseFromPostgres(databaseName: string): Promise<void> {
  const pool = getPgPool();
  if (!pool || !databaseName) return;
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteSqlIdent(databaseName)} CASCADE`);
  } catch {
    // Ignore schema drop errors
  }
}

function stripDboPrefix(name: string): string {
  return String(name || '').replace(/^dbo\./i, '').trim();
}

async function execSyncTableToPostgres(table: ServerTable, databaseName?: string): Promise<void> {
  const pool = getPgPool();
  if (!pool) return;
  table.tableName = stripDboPrefix(table.tableName) || table.tableName;
  const cleanDbName = databaseName ? stripDboPrefix(databaseName) : undefined;
  const sortedCols = [...table.columns].sort((a, b) => a.orderIndex - b.orderIndex);
  if (sortedCols.length === 0) return;

  const client = await pool.connect().catch(() => null);
  if (!client) return;

  try {
    await client.query('BEGIN');
    const quotedTable = quoteSqlIdent(table.tableName);
    if (cleanDbName) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteSqlIdent(cleanDbName)}`);
    }
    const schemaQualifiedTable = cleanDbName
      ? `${quoteSqlIdent(cleanDbName)}.${quotedTable}`
      : quotedTable;

    // Build exact SQL table definition matching table.tableName and table.columns
    const colDefs = sortedCols
      .map((col) => `${quoteSqlIdent(col.name)} ${mapColTypeToSqlType(col)}`)
      .join(', ');

    await client.query(`DROP TABLE IF EXISTS ${schemaQualifiedTable}`);
    await client.query(`CREATE TABLE ${schemaQualifiedTable} (${colDefs})`);

    if (table.rows.length > 0) {
      const colNamesSql = sortedCols.map((c) => quoteSqlIdent(c.name)).join(', ');
      const batchSize = 100;

      for (let offset = 0; offset < table.rows.length; offset += batchSize) {
        const chunk = table.rows.slice(offset, offset + batchSize);
        const valuesPlaceholders: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        for (const row of chunk) {
          const rowPlaceholders: string[] = [];
          for (const col of sortedCols) {
            rowPlaceholders.push(`$${paramIdx++}`);
            const rawVal = getServerDisplayValue(row, col, sortedCols);
            if (col.isPrimaryKey || col.isIdentity) {
              const pkNum = Number(rawVal);
              params.push(Number.isInteger(pkNum) && pkNum >= 1 ? pkNum : 1);
            } else if (col.colType === 'number') {
              const numVal = Number(rawVal);
              params.push(Number.isFinite(numVal) ? numVal : 0);
            } else if (col.colType === 'checkbox') {
              params.push(Boolean(rawVal === true || rawVal === 'true' || rawVal === 1));
            } else {
              params.push(rawVal === undefined || rawVal === null ? '' : String(rawVal));
            }
          }
          valuesPlaceholders.push(`(${rowPlaceholders.join(', ')})`);
        }

        await client.query(
          `INSERT INTO ${schemaQualifiedTable} (${colNamesSql}) VALUES ${valuesPlaceholders.join(', ')}`,
          params
        );
      }
    }

    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => null);
  } finally {
    client.release();
  }
}

async function execDropTableFromPostgres(tableName: string, databaseName?: string): Promise<void> {
  const pool = getPgPool();
  if (!pool) return;
  const cleanTable = stripDboPrefix(tableName) || tableName;
  const cleanDb = databaseName ? stripDboPrefix(databaseName) : undefined;
  try {
    if (cleanDb) {
      await pool.query(
        `DROP TABLE IF EXISTS ${quoteSqlIdent(cleanDb)}.${quoteSqlIdent(cleanTable)}`
      );
    }
    await pool.query(`DROP TABLE IF EXISTS ${quoteSqlIdent(cleanTable)}`);
  } catch {
    // Ignore drop errors
  }
}

/**
 * Write-Behind Buffer wrappers for Database, Table, Field, and Row CRUD operations:
 * Mutates in-memory state immediately and queues DDL / Table sync for the Background Flush Worker.
 */
async function createDatabaseInRealBackend(
  databaseName: string,
  immediatePg = false
): Promise<void> {
  if (!databaseName) return;
  if (immediatePg) {
    await execCreateDatabaseInPostgres(databaseName);
    return;
  }
  const cleanDb = stripDboPrefix(databaseName);
  writeBehindDdlQueue.push({
    type: 'create_database',
    databaseName: cleanDb,
    timestampMs: Date.now(),
  });
  writeBehindMetrics.totalCoalescedEdits++;
}

async function renameDatabaseInRealBackend(
  oldDatabaseName: string,
  newDatabaseName: string,
  immediatePg = false
): Promise<void> {
  if (!oldDatabaseName || !newDatabaseName) return;
  if (immediatePg) {
    await execRenameDatabaseInPostgres(oldDatabaseName, newDatabaseName);
    return;
  }
  const cleanOld = stripDboPrefix(oldDatabaseName);
  const cleanNew = stripDboPrefix(newDatabaseName);
  writeBehindDdlQueue.push({
    type: 'rename_database',
    databaseName: cleanOld,
    newDatabaseName: cleanNew,
    timestampMs: Date.now(),
  });
  writeBehindMetrics.totalCoalescedEdits++;
}

async function dropDatabaseFromRealBackend(
  databaseName: string,
  immediatePg = false
): Promise<void> {
  if (!databaseName) return;
  if (immediatePg) {
    await execDropDatabaseFromPostgres(databaseName);
    return;
  }
  const cleanDb = stripDboPrefix(databaseName);
  const lowerDbPrefix = `${cleanDb.toLowerCase()}|`;
  for (const key of Array.from(writeBehindDirtyTables.keys())) {
    if (key.startsWith(lowerDbPrefix)) {
      writeBehindDirtyTables.delete(key);
    }
  }
  for (const key of Array.from(writeBehindDirtyRows.keys())) {
    if (key.startsWith(lowerDbPrefix)) {
      writeBehindDirtyRows.delete(key);
    }
  }
  writeBehindDdlQueue.push({
    type: 'drop_database',
    databaseName: cleanDb,
    timestampMs: Date.now(),
  });
  writeBehindMetrics.totalCoalescedEdits++;
}

async function syncTableToRealDatabase(
  table: ServerTable,
  databaseName?: string,
  immediatePg = false
): Promise<void> {
  table.tableName = stripDboPrefix(table.tableName) || table.tableName;
  const cleanDb = stripDboPrefix(databaseName || cloudState.activeDatabaseName || 'GridPulse_DB');
  if (immediatePg) {
    await execSyncTableToPostgres(table, cleanDb);
    return;
  }
  const nowMs = Date.now();
  const tableKey = `${cleanDb.toLowerCase()}|${table.tableName.toLowerCase()}`;
  if (!writeBehindDirtyTables.has(tableKey)) {
    writeBehindDirtyTables.set(tableKey, {
      databaseName: cleanDb,
      tableName: table.tableName,
      firstDirtyAtMs: nowMs,
    });
  }
  const structuralRowKey = `${tableKey}|__schema_or_rows__`;
  writeBehindDirtyRows.set(structuralRowKey, {
    databaseName: cleanDb,
    tableName: table.tableName,
    rowId: '__schema_or_rows__',
    timestampMs: nowMs,
  });
  writeBehindMetrics.totalCoalescedEdits++;
}

async function dropTableFromRealDatabase(
  tableName: string,
  databaseName?: string,
  immediatePg = false
): Promise<void> {
  const cleanTable = stripDboPrefix(tableName) || tableName;
  const cleanDb = stripDboPrefix(databaseName || cloudState.activeDatabaseName || 'GridPulse_DB');
  if (immediatePg) {
    await execDropTableFromPostgres(cleanTable, cleanDb);
    return;
  }
  const tableKey = `${cleanDb.toLowerCase()}|${cleanTable.toLowerCase()}`;
  writeBehindDirtyTables.delete(tableKey);
  for (const key of Array.from(writeBehindDirtyRows.keys())) {
    if (key.startsWith(`${tableKey}|`)) {
      writeBehindDirtyRows.delete(key);
    }
  }
  writeBehindDdlQueue.push({
    type: 'drop_table',
    databaseName: cleanDb,
    tableName: cleanTable,
    timestampMs: Date.now(),
  });
  writeBehindMetrics.totalCoalescedEdits++;
}

function summarizeTable(t: ServerTable): DbTableSummary {
  const sortedCols = [...(t.columns || [])].sort((a, b) => a.orderIndex - b.orderIndex);
  const sortedRows = [...(t.rows || [])]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .slice(0, 250);
  return {
    tableName: t.tableName,
    rowCount: (t.rows || []).length,
    columnCount: sortedCols.length,
    columns: sortedCols,
    rows: sortedRows,
    identitySeed: t.identitySeed || 1,
    identityIncrement: t.identityIncrement || 1,
    nextIdentityValue: computeNextIdentityValue(sortedCols, t.rows || []),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function getTableSummaries(state: CloudWorkspaceState, targetDb?: ServerDatabase): DbTableSummary[] {
  const db = targetDb || getTargetDatabase(state);
  return (db.tables || []).map(summarizeTable);
}

function getDatabaseSummaries(state: CloudWorkspaceState): DbDatabaseSummary[] {
  ensureDatabasesHierarchy(state);
  return (state.databases || []).map((db) => ({
    databaseName: db.databaseName,
    activeTableName: db.activeTableName || (db.tables[0]?.tableName ?? ''),
    tables: (db.tables || []).map(summarizeTable),
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
  }));
}

function extractLookupTemplateTokens(rawTemplate?: string): string[] {
  const str = String(rawTemplate || '').trim();
  if (!str) return [];
  const bracketMatches = Array.from(str.matchAll(/\[([^\]]+)\]/g))
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (bracketMatches.length > 0) {
    return bracketMatches;
  }
  const inner = str.replace(/^\{|\}$/g, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^\[|\]$/g, '').trim())
    .filter(Boolean);
}

function formatLookupTemplateFromFieldNames(fieldNames: string[], pkName = 'ID'): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const cleanPk = (pkName || 'ID').trim();
  seen.add(cleanPk.toLowerCase());
  ordered.push(`[${cleanPk}]`);

  for (const raw of fieldNames) {
    const clean = String(raw || '').trim().replace(/^\[|\]$/g, '').trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    ordered.push(`[${clean}]`);
  }
  return `{${ordered.join(', ')}}`;
}

function resolveLookupTemplateAndColumns(
  rawTemplate: string | undefined,
  sourceColumns: ServerColumn[],
  mutations?: {
    renamedColumns?: { oldName: string; newName: string }[];
    addedColumnNames?: string[];
    deletedColumnNames?: string[];
  }
): { selectedColumns: ServerColumn[]; normalizedTemplate: string } {
  const sortedSource = [...(sourceColumns || [])].sort((a, b) => a.orderIndex - b.orderIndex);
  const nonLookupCols = sortedSource.filter((c) => c.colType !== 'lookup');
  const effectiveCols = nonLookupCols.length > 0 ? nonLookupCols : sortedSource;
  const pkCol =
    effectiveCols.find(
      (c) =>
        c.isPrimaryKey ||
        c.isIdentity ||
        c.name.toLowerCase() === 'id' ||
        c.id.toLowerCase() === 'id'
    ) || effectiveCols[0];
  const pkName = pkCol?.name || 'ID';

  let tokens = extractLookupTemplateTokens(rawTemplate);

  if (mutations) {
    if (Array.isArray(mutations.renamedColumns) && mutations.renamedColumns.length > 0) {
      const renameMap = new Map<string, string>();
      for (const pair of mutations.renamedColumns) {
        if (pair.oldName && pair.newName) {
          renameMap.set(pair.oldName.trim().toLowerCase(), pair.newName.trim());
        }
      }
      tokens = tokens.map((t) => renameMap.get(t.toLowerCase()) || t);
    }
    if (Array.isArray(mutations.deletedColumnNames) && mutations.deletedColumnNames.length > 0) {
      const delSet = new Set(mutations.deletedColumnNames.map((n) => n.trim().toLowerCase()));
      tokens = tokens.filter((t) => !delSet.has(t.toLowerCase()));
    }
    if (Array.isArray(mutations.addedColumnNames) && mutations.addedColumnNames.length > 0) {
      for (const added of mutations.addedColumnNames) {
        const cleanAdded = added.trim();
        if (
          cleanAdded &&
          !tokens.some((t) => t.toLowerCase() === cleanAdded.toLowerCase())
        ) {
          tokens.push(cleanAdded);
        }
      }
    }
  }

  const colByLower = new Map<string, ServerColumn>();
  for (const col of effectiveCols) {
    colByLower.set(col.name.trim().toLowerCase(), col);
    colByLower.set(col.id.trim().toLowerCase(), col);
  }

  const selectedColumns: ServerColumn[] = [];
  const selectedLower = new Set<string>();

  if (pkCol) {
    selectedColumns.push(pkCol);
    selectedLower.add(pkCol.name.trim().toLowerCase());
  }

  for (const tok of tokens) {
    const lower = tok.trim().toLowerCase();
    if (selectedLower.has(lower)) continue;
    const matched = colByLower.get(lower);
    if (matched && !selectedLower.has(matched.name.trim().toLowerCase())) {
      selectedColumns.push(matched);
      selectedLower.add(matched.name.trim().toLowerCase());
    }
  }

  const hasExplicitSingleIdOnly =
    tokens.length === 1 && tokens[0].toLowerCase() === pkName.toLowerCase();
  if (selectedColumns.length <= 1 && !hasExplicitSingleIdOnly) {
    for (const col of effectiveCols) {
      const lower = col.name.trim().toLowerCase();
      if (!selectedLower.has(lower)) {
        selectedColumns.push(col);
        selectedLower.add(lower);
      }
    }
  }

  const normalizedTemplate = formatLookupTemplateFromFieldNames(
    selectedColumns.map((c) => c.name),
    pkName
  );
  return { selectedColumns, normalizedTemplate };
}

function buildLinkedLookupRecordsFromTable(
  sourceTable: ServerTable,
  selectedColumnsOverride?: ServerColumn[]
): {
  id: string | number;
  obj: Record<string, string | number | boolean>;
  json: string;
}[] {
  const sortedCols = [...(sourceTable.columns || [])].sort(
    (a, b) => a.orderIndex - b.orderIndex
  );
  const colsToInclude =
    selectedColumnsOverride && selectedColumnsOverride.length > 0
      ? selectedColumnsOverride
      : sortedCols.filter((c) => c.colType !== 'lookup');
  const effectiveCols = colsToInclude.length > 0 ? colsToInclude : sortedCols;

  const sortedRows = [...(sourceTable.rows || [])].sort(
    (a, b) => a.orderIndex - b.orderIndex
  );
  const pkCol =
    sortedCols.find(
      (c) =>
        c.isPrimaryKey ||
        c.isIdentity ||
        c.name.toLowerCase() === 'id' ||
        c.id.toLowerCase() === 'id'
    ) || effectiveCols[0];

  const records: {
    id: string | number;
    obj: Record<string, string | number | boolean>;
    json: string;
  }[] = [];

  for (let i = 0; i < sortedRows.length; i++) {
    const row = sortedRows[i];
    const obj: Record<string, string | number | boolean> = {};
    if (pkCol) {
      obj[pkCol.name] = getServerDisplayValue(row, pkCol, sortedCols);
    }
    for (const col of effectiveCols) {
      if (pkCol && col.name.toLowerCase() === pkCol.name.toLowerCase()) continue;
      obj[col.name] = getServerDisplayValue(row, col, sortedCols);
    }
    const rawId = pkCol ? obj[pkCol.name] : obj['ID'] ?? obj['id'] ?? i + 1;
    const numId = Number(rawId);
    const id: string | number =
      Number.isFinite(numId) && String(rawId).trim() !== ''
        ? numId
        : String(rawId ?? i + 1);
    records.push({
      id,
      obj,
      json: JSON.stringify(obj),
    });
  }

  if (records.length === 0 && effectiveCols.length > 0) {
    const sampleObj: Record<string, string | number | boolean> = {};
    const pkName = pkCol ? pkCol.name : 'ID';
    sampleObj[pkName] = 1;
    for (const col of effectiveCols) {
      if (col.name.toLowerCase() === pkName.toLowerCase()) continue;
      const def = resolveServerColumnDefaultValue(col);
      sampleObj[col.name] =
        def !== '' && def !== undefined
          ? def
          : col.colType === 'number'
          ? 0
          : col.colType === 'checkbox'
          ? false
          : col.colType === 'date'
          ? new Date().toISOString().slice(0, 10)
          : `Sample ${col.name}`;
    }
    records.push({
      id: 1,
      obj: sampleObj,
      json: JSON.stringify(sampleObj),
    });
  }

  return records;
}

function extractForeignKeyIdOrMatchValue(rawCellVal: unknown): {
  fkId?: string | number;
  rawStr: string;
} {
  const rawStr = rawCellVal === null || rawCellVal === undefined ? '' : String(rawCellVal).trim();
  if (!rawStr) return { rawStr: '' };

  if (rawStr.startsWith('{') || rawStr.startsWith('[')) {
    try {
      const parsed = JSON.parse(rawStr);
      const target = Array.isArray(parsed) ? parsed[0] : parsed;
      if (target && typeof target === 'object') {
        const obj = target as Record<string, unknown>;
        const idVal = obj['ID'] ?? obj['id'] ?? obj['key'];
        if (idVal !== undefined && idVal !== null && String(idVal).trim() !== '') {
          const num = Number(idVal);
          return {
            fkId: Number.isFinite(num) ? num : String(idVal).trim(),
            rawStr,
          };
        }
      }
    } catch {
      const idMatch = /(?:["']?(?:id|ID|key)["']?\s*:\s*)(['"]?[^,}'"\s]+['"]?)/.exec(rawStr);
      if (idMatch) {
        const cleaned = idMatch[1].replace(/^['"]|['"]$/g, '').trim();
        const num = Number(cleaned);
        return {
          fkId: Number.isFinite(num) && cleaned !== '' ? num : cleaned,
          rawStr,
        };
      }
    }
  }

  return { rawStr };
}

interface LookupSchemaMutationSyncInfo {
  databaseName: string;
  oldTableName?: string;
  newTableName?: string;
  mutatedTableName?: string;
  renamedColumns?: { oldName: string; newName: string }[];
  addedColumnNames?: string[];
  deletedColumnNames?: string[];
}

/**
 * Synchronizes all `lookup` columns across all tables in the workspace with their
 * linked foreign-key tables (`lookupTableName` — which can be another table OR the same table).
 * Whenever a linked table (or the same table) has a field renamed, added, or deleted, or its table name or row data changes:
 * 1. Updates `col.formula` template `{[ID], [Field1], [Field2]}` to reflect renamed, added, or deleted fields.
 * 2. Rebuilds `col.optionsCsv` as a JSON array of the linked table's current schema & rows for those selected fields.
 * 3. Updates `col.defaultValue` if it references a record in the linked table.
 * 4. Updates every row's cell value in the lookup column so the stored JSON automatically reflects
 *    any renamed, added, or deleted fields and updated row values from the linked/same table.
 */
function syncAllLinkedLookupColumnsInState(
  state: CloudWorkspaceState,
  mutationInfo?: LookupSchemaMutationSyncInfo
): void {
  if (!Array.isArray(state.databases)) return;

  for (const db of state.databases) {
    if (!Array.isArray(db.tables) || db.tables.length === 0) continue;

    // 1. Update lookupTableName if a linked table in this database was renamed
    if (
      mutationInfo &&
      mutationInfo.oldTableName &&
      mutationInfo.newTableName &&
      db.databaseName.toLowerCase() === mutationInfo.databaseName.toLowerCase() &&
      mutationInfo.oldTableName.toLowerCase() !== mutationInfo.newTableName.toLowerCase()
    ) {
      for (const tbl of db.tables) {
        for (const col of tbl.columns || []) {
          if (
            col.colType === 'lookup' &&
            col.lookupTableName &&
            col.lookupTableName.toLowerCase() === mutationInfo.oldTableName.toLowerCase()
          ) {
            col.lookupTableName = mutationInfo.newTableName;
          }
        }
      }
    }

    // 2. Auto-detect any columns hydrated from PostgreSQL as 'text' whose cell values store Lookup JSON objects ({"ID":...})
    for (const tbl of db.tables) {
      for (const col of tbl.columns || []) {
        if (col.isPrimaryKey || col.isIdentity) continue;
        if (col.colType === 'text' && Array.isArray(tbl.rows) && tbl.rows.length > 0) {
          let sampleParsed: Record<string, unknown> | null = null;
          let jsonCellCount = 0;
          let nonEmptyCount = 0;
          for (const r of tbl.rows.slice(0, 25)) {
            const rawVal = r.cells?.[col.name] ?? r.cells?.[col.id];
            const strVal = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
            if (!strVal) continue;
            nonEmptyCount++;
            if (strVal.startsWith('{') && strVal.endsWith('}')) {
              try {
                const parsed = JSON.parse(strVal);
                if (
                  parsed &&
                  typeof parsed === 'object' &&
                  !Array.isArray(parsed) &&
                  ('ID' in parsed || 'id' in parsed)
                ) {
                  jsonCellCount++;
                  if (!sampleParsed) {
                    sampleParsed = parsed as Record<string, unknown>;
                  }
                }
              } catch {
                // Not valid JSON
              }
            }
          }
          if (nonEmptyCount > 0 && jsonCellCount === nonEmptyCount && sampleParsed) {
            const jsonKeys = Object.keys(sampleParsed);
            const nonIdKeys = jsonKeys.filter((k) => k.toLowerCase() !== 'id');
            const baseColName = col.name.replace(/id$/i, '').trim().toLowerCase();
            // Match source table either by non-ID column names in the JSON or by column name
            const bySchemaMatch =
              nonIdKeys.length > 0
                ? db.tables.find((candidateTbl) => {
                    const candColsLower = new Set(
                      (candidateTbl.columns || []).map((c) => c.name.trim().toLowerCase())
                    );
                    return nonIdKeys.every((k) => candColsLower.has(k.trim().toLowerCase()));
                  })
                : undefined;
            const byNameMatch = db.tables.find(
              (candidateTbl) =>
                candidateTbl.tableName.toLowerCase() === col.name.trim().toLowerCase() ||
                (baseColName.length > 0 &&
                  candidateTbl.tableName.toLowerCase() === baseColName)
            );
            const inferredTable =
              (nonIdKeys.length >= 2 ? bySchemaMatch || byNameMatch : byNameMatch || bySchemaMatch) ||
              db.tables[0];
            if (inferredTable) {
              col.colType = 'lookup';
              col.lookupTableName = inferredTable.tableName;
              col.formula = formatLookupTemplateFromFieldNames(jsonKeys);
            }
          }
        }
      }
    }

    // 3. Resolve and synchronize all lookup columns in this database
    for (const tbl of db.tables) {
      for (const col of tbl.columns || []) {
        if (col.colType !== 'lookup') continue;

        let linkedTblName = (col.lookupTableName || '').trim();
        const rawOpts = (col.optionsCsv || '').trim();

        // Support optionsCsv that directly names a table or uses FK:TableName
        if (!linkedTblName && rawOpts && !rawOpts.startsWith('[') && !rawOpts.startsWith('{')) {
          const fkCandidate = rawOpts.replace(/^fk:/i, '').trim();
          const matchedTbl = db.tables.find(
            (t) => t.tableName.toLowerCase() === fkCandidate.toLowerCase()
          );
          if (matchedTbl) {
            linkedTblName = matchedTbl.tableName;
          }
        }

        // Auto-link to another table or the same table when lookupTableName is not yet set
        if (!linkedTblName) {
          const otherTbl =
            db.tables.find(
              (t) => t.tableName.toLowerCase() !== tbl.tableName.toLowerCase()
            ) || tbl || db.tables[0];
          if (otherTbl) {
            linkedTblName = otherTbl.tableName;
          }
        }

        if (!linkedTblName) continue;

        const sourceTable =
          db.tables.find(
            (t) => t.tableName.toLowerCase() === linkedTblName.toLowerCase()
          ) || tbl;
        if (!sourceTable) continue;

        col.lookupTableName = sourceTable.tableName;

        const targetMutatedName = (
          mutationInfo?.mutatedTableName ||
          mutationInfo?.newTableName ||
          ''
        ).trim();
        const isSourceMutated =
          Boolean(mutationInfo) &&
          db.databaseName.toLowerCase() === (mutationInfo?.databaseName || '').toLowerCase() &&
          targetMutatedName.toLowerCase() === sourceTable.tableName.toLowerCase();

        const { selectedColumns, normalizedTemplate } = resolveLookupTemplateAndColumns(
          col.formula,
          sourceTable.columns || [],
          isSourceMutated ? mutationInfo : undefined
        );

        col.formula = normalizedTemplate;
        const linkedRecords = buildLinkedLookupRecordsFromTable(sourceTable, selectedColumns);
        col.optionsCsv = JSON.stringify(linkedRecords.map((r) => r.obj));

        const recordById = new Map<
          string,
          { id: string | number; obj: Record<string, string | number | boolean>; json: string }
        >();
        for (const rec of linkedRecords) {
          recordById.set(String(rec.id).toLowerCase(), rec);
        }

        const resolveRecordJson = (rawVal: unknown, fallbackRowId?: unknown): string | null => {
          const { fkId, rawStr } = extractForeignKeyIdOrMatchValue(rawVal);
          if (fkId !== undefined) {
            const byId = recordById.get(String(fkId).toLowerCase());
            if (byId) return byId.json;
          }
          if (rawStr) {
            const lower = rawStr.toLowerCase();
            const byDirectId = recordById.get(lower);
            if (byDirectId) return byDirectId.json;

            for (const rec of linkedRecords) {
              if (rec.json.toLowerCase() === lower) return rec.json;
              for (const v of Object.values(rec.obj)) {
                if (String(v ?? '').toLowerCase() === lower) {
                  return rec.json;
                }
              }
            }
          }
          if (fallbackRowId !== undefined && fallbackRowId !== null) {
            const byRowId = recordById.get(String(fallbackRowId).toLowerCase());
            if (byRowId) return byRowId.json;
          }
          return null;
        };

        // Update defaultValue if present so it also stays in sync with linked table schema changes
        if (col.defaultValue && String(col.defaultValue).trim().length > 0) {
          const updatedDef = resolveRecordJson(col.defaultValue);
          if (updatedDef) {
            col.defaultValue = updatedDef;
          } else if (linkedRecords.length > 0) {
            col.defaultValue = linkedRecords[0].json;
          }
        }

        const isSelfLookup =
          sourceTable.tableName.toLowerCase() === tbl.tableName.toLowerCase();

        // Update all rows in this table so their lookup cell JSON reflects added, renamed, or deleted fields in sourceTable
        for (const row of tbl.rows || []) {
          if (!row.cells) continue;
          const currentCellVal =
            row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
          const rowPkVal = row.cells['ID'] ?? row.cells['id'];

          if (
            currentCellVal === undefined ||
            currentCellVal === null ||
            String(currentCellVal).trim() === ''
          ) {
            if (isSelfLookup && rowPkVal !== undefined) {
              const selfRec = recordById.get(String(rowPkVal).toLowerCase());
              if (selfRec) {
                row.cells[col.name] = selfRec.json;
                row.cells[col.id] = selfRec.json;
                continue;
              }
            }
            if (
              (col.required || col.isNullable === false) &&
              linkedRecords.length > 0
            ) {
              row.cells[col.name] = linkedRecords[0].json;
              row.cells[col.id] = linkedRecords[0].json;
            }
            continue;
          }
          const syncedJson = resolveRecordJson(
            currentCellVal,
            isSelfLookup ? rowPkVal : undefined
          );
          if (syncedJson) {
            row.cells[col.name] = syncedJson;
            row.cells[col.id] = syncedJson;
          } else if (linkedRecords.length > 0) {
            row.cells[col.name] = linkedRecords[0].json;
            row.cells[col.id] = linkedRecords[0].json;
          }
        }
      }
    }
  }
}

function normalizeServerTable(t: ServerTable): ServerTable {
  t.tableName = stripDboPrefix(t.tableName) || t.tableName;
  if (t.allowEmptyColumns && (!Array.isArray(t.columns) || t.columns.length === 0)) {
    t.columns = [];
    t.rows = [];
    t.nextIdentityValue = 1;
    return t;
  }
  t.columns = ensurePrimaryKeyIdentityColumn(t.columns || []);
  t.rows = sanitizeRowsAgainstSchema(t.columns, t.rows || []);
  t.nextIdentityValue = computeNextIdentityValue(t.columns, t.rows);
  return t;
}

function ensureDatabasesHierarchy(state: CloudWorkspaceState): void {
  const nowIso = new Date().toISOString();
  if (!Array.isArray(state.databases) || state.databases.length === 0) {
    const existingTables =
      Array.isArray(state.tables) && state.tables.length > 0
        ? state.tables.map(normalizeServerTable)
        : [
            normalizeServerTable({
              tableName: 'Initiatives',
              columns: state.columns || buildDefaultColumns(),
              rows: state.rows || generateSampleRows(500, 0),
              identitySeed: 1,
              identityIncrement: 1,
              nextIdentityValue: 501,
              createdAt: state.updatedAt || nowIso,
              updatedAt: state.updatedAt || nowIso,
            }),
          ];
    const defaultDbName = state.activeDatabaseName || 'GridPulse_DB';
    state.databases = [
      {
        databaseName: defaultDbName,
        activeTableName: state.activeTableName || existingTables[0]?.tableName || '',
        tables: existingTables,
        createdAt: state.updatedAt || nowIso,
        updatedAt: state.updatedAt || nowIso,
      },
    ];
    state.activeDatabaseName = defaultDbName;
  } else {
    for (const db of state.databases) {
      if (!Array.isArray(db.tables)) {
        db.tables = [];
      }
      for (const tbl of db.tables) {
        normalizeServerTable(tbl);
      }
    }
    if (!state.activeDatabaseName) {
      state.activeDatabaseName = state.databases[0].databaseName;
    }
  }
  syncAllLinkedLookupColumnsInState(state);
}

function findDatabase(state: CloudWorkspaceState, requestedDbName?: string): ServerDatabase {
  ensureDatabasesHierarchy(state);
  const trimmedDb = (requestedDbName || '').trim();
  const foundDb = trimmedDb
    ? state.databases.find((d) => d.databaseName.toLowerCase() === trimmedDb.toLowerCase())
    : state.databases.find(
        (d) => d.databaseName.toLowerCase() === (state.activeDatabaseName || '').toLowerCase()
      );
  return foundDb || state.databases[0];
}

function findTable(db: ServerDatabase, requestedTableName?: string): ServerTable | null {
  if (!Array.isArray(db.tables) || db.tables.length === 0) {
    db.activeTableName = '';
    return null;
  }
  const trimmed = (requestedTableName || '').trim();
  const found = trimmed
    ? db.tables.find((t) => t.tableName.toLowerCase() === trimmed.toLowerCase())
    : db.tables.find(
        (t) => t.tableName.toLowerCase() === (db.activeTableName || '').toLowerCase()
      );
  const target = found || db.tables[0];
  normalizeServerTable(target);
  return target;
}

function getTargetDatabase(state: CloudWorkspaceState, requestedDbName?: string): ServerDatabase {
  const targetDb = findDatabase(state, requestedDbName);
  state.activeDatabaseName = targetDb.databaseName;
  state.tables = targetDb.tables;
  return targetDb;
}

function getTargetTable(
  state: CloudWorkspaceState,
  requestedTableName?: string,
  requestedDbName?: string
): ServerTable | null {
  const targetDb = getTargetDatabase(state, requestedDbName);

  if (!Array.isArray(targetDb.tables) || targetDb.tables.length === 0) {
    targetDb.activeTableName = '';
    state.activeTableName = '';
    state.workspaceName = targetDb.databaseName;
    state.columns = [];
    state.rows = [];
    return null;
  }

  const target = findTable(targetDb, requestedTableName);
  if (!target) {
    targetDb.activeTableName = '';
    state.activeTableName = '';
    state.workspaceName = targetDb.databaseName;
    state.columns = [];
    state.rows = [];
    return null;
  }

  targetDb.activeTableName = target.tableName;
  state.activeTableName = target.tableName;
  state.workspaceName = target.tableName;
  state.columns = target.columns;
  state.rows = target.rows;
  return target;
}

function parseAndHydrateWorkspaceState(raw: string): CloudWorkspaceState | null {
  try {
    const parsed = JSON.parse(raw) as CloudWorkspaceState;
    if (
      parsed &&
      (Array.isArray(parsed.databases) ||
        Array.isArray(parsed.tables) ||
        Array.isArray(parsed.columns))
    ) {
      ensureDatabasesHierarchy(parsed);
      getTargetTable(parsed, parsed.activeTableName, parsed.activeDatabaseName);

      if (!Array.isArray(parsed.users) || parsed.users.length === 0) {
        parsed.users = buildDefaultUsers();
      }
      if (!parsed.sessions) {
        parsed.sessions = {};
      }
      if (!Array.isArray(parsed.versions) || parsed.versions.length === 0) {
        parsed.versions = [
          {
            id: 'ver_v1_0',
            versionTag: 'v1.0',
            title: 'Initial Baseline Schema & Seed Data',
            message: 'Baseline workspace snapshot with 12 columns and 500 records',
            authorName: 'Alex Rivera',
            authorColor: '#ca8a04',
            createdAt: parsed.updatedAt || new Date().toISOString(),
            rowCount: parsed.rows.length,
            columnCount: parsed.columns.length,
            columnsSnapshot: parsed.columns.map((c) => ({ ...c })),
            rowsSnapshot: parsed.rows.slice(0, 500).map((r) => ({ ...r, cells: { ...r.cells } })),
          },
        ];
      }
      return parsed;
    }
  } catch {
    // Ignore parse error
  }
  return null;
}

function loadOrCreateState(): CloudWorkspaceState {
  // 1. Prefer persistent project workspace state file first (survives /tmp clears and restarts)
  const candidateFiles = [PERSISTENT_WORKSPACE_FILE, CLOUD_STORE_FILE];
  let bestState: CloudWorkspaceState | null = null;

  for (const filePath of candidateFiles) {
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        const hydrated = parseAndHydrateWorkspaceState(raw);
        if (hydrated) {
          if (
            !bestState ||
            Date.parse(hydrated.updatedAt || '') > Date.parse(bestState.updatedAt || '')
          ) {
            bestState = hydrated;
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  if (bestState) {
    // Keep both files in sync immediately
    try {
      const serialized = JSON.stringify(bestState);
      writeFileSync(PERSISTENT_WORKSPACE_FILE, serialized, 'utf-8');
      writeFileSync(CLOUD_STORE_FILE, serialized, 'utf-8');
    } catch {
      // Ignore write errors
    }
    return bestState;
  }

  const defaultCols = ensurePrimaryKeyIdentityColumn(buildDefaultColumns());
  const defaultRows = sanitizeRowsAgainstSchema(defaultCols, generateSampleRows(500, 0));
  const nowIso = new Date().toISOString();

  const defaultTable: ServerTable = {
    tableName: 'Initiatives',
    columns: defaultCols,
    rows: defaultRows,
    identitySeed: 1,
    identityIncrement: 1,
    nextIdentityValue: computeNextIdentityValue(defaultCols, defaultRows),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const defaultDb: ServerDatabase = {
    databaseName: 'GridPulse_DB',
    activeTableName: 'Initiatives',
    tables: [defaultTable],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const initial: CloudWorkspaceState = {
    workspaceId: 'ws_gridpulse_main',
    workspaceName: 'Initiatives',
    activeDatabaseName: 'GridPulse_DB',
    databases: [defaultDb],
    activeTableName: 'Initiatives',
    tables: defaultDb.tables,
    updatedAt: nowIso,
    columns: defaultCols,
    rows: defaultRows,
    presence: {},
    users: buildDefaultUsers(),
    sessions: {},
    versions: [
      {
        id: 'ver_v1_0',
        versionTag: 'v1.0',
        title: 'Initial Baseline Schema & Seed Data',
        message: 'Baseline workspace snapshot with IDENTITY(1,1) PK and 500 records',
        authorName: 'Alex Rivera',
        authorColor: '#ca8a04',
        createdAt: nowIso,
        rowCount: defaultRows.length,
        columnCount: defaultCols.length,
        columnsSnapshot: defaultCols.map((c) => ({ ...c })),
        rowsSnapshot: defaultRows.map((r) => ({ ...r, cells: { ...r.cells } })),
      },
    ],
    activities: [
      {
        id: 'act_init',
        userName: 'Alex Rivera',
        userColor: '#ca8a04',
        action: 'Database Initialized',
        detail: 'Initialized database "GridPulse_DB" with table "Initiatives" (IDENTITY(1,1) PK, 500 records)',
        timestamp: nowIso,
      },
    ],
  };
  // Do NOT call saveStateToDisk(initial) here! If disk files were missing on container boot,
  // calling saveStateToDisk(initial) before ensurePostgresHydrated() would overwrite PostgreSQL's
  // __gridpulse_workspace_state with the default Initiatives-only state!
  return initial;
}

async function saveStateToPostgresMetadata(state: CloudWorkspaceState): Promise<void> {
  const pool = getPgPool();
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "public"."__gridpulse_workspace_state" (
        "workspace_id" TEXT PRIMARY KEY,
        "state_json" TEXT NOT NULL,
        "updated_at" TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(
      `
      INSERT INTO "public"."__gridpulse_workspace_state" ("workspace_id", "state_json", "updated_at")
      VALUES ($1, $2, NOW())
      ON CONFLICT ("workspace_id")
      DO UPDATE SET "state_json" = EXCLUDED."state_json", "updated_at" = NOW()
      `,
      ['ws_gridpulse_main', JSON.stringify(state)]
    );
  } catch {
    // Ignore metadata table persistence errors
  }
}

function writeStateFilesToDiskOnly(state: CloudWorkspaceState): void {
  const serialized = JSON.stringify(state);
  try {
    writeFileSync(PERSISTENT_WORKSPACE_FILE, serialized, 'utf-8');
  } catch {
    // Ignore disk write issues in read-only environments
  }
  try {
    writeFileSync(CLOUD_STORE_FILE, serialized, 'utf-8');
  } catch {
    // Ignore disk write issues in read-only environments
  }
}

function saveStateToDisk(state: CloudWorkspaceState): void {
  writeStateFilesToDiskOnly(state);
  writeBehindMetadataDirty = true;
}

async function persistWorkspaceState(
  state: CloudWorkspaceState,
  immediatePg = false
): Promise<void> {
  writeStateFilesToDiskOnly(state);
  if (immediatePg) {
    await saveStateToPostgresMetadata(state);
    return;
  }
  writeBehindMetadataDirty = true;
}

const cloudState: CloudWorkspaceState = loadOrCreateState();

let pgHydrationPromise: Promise<void> | null = null;
let pgHasHydrated = false;

async function ensurePostgresHydrated(): Promise<void> {
  if (pgHasHydrated) return;
  if (pgHydrationPromise) return pgHydrationPromise;

  pgHydrationPromise = (async () => {
    const pool = getPgPool();
    if (!pool) {
      pgHasHydrated = true;
      return;
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "public"."__gridpulse_workspace_state" (
          "workspace_id" TEXT PRIMARY KEY,
          "state_json" TEXT NOT NULL,
          "updated_at" TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      const metaRes = await pool
        .query<{ state_json: string }>(
          `SELECT "state_json" FROM "public"."__gridpulse_workspace_state" WHERE "workspace_id" = $1 LIMIT 1`,
          ['ws_gridpulse_main']
        )
        .catch(() => ({ rows: [] as { state_json: string }[] }));

      const isDiskFreshInit =
        cloudState.activities?.length === 1 && cloudState.activities[0]?.id === 'act_init';

      if (metaRes.rows.length > 0 && metaRes.rows[0].state_json) {
        const pgState = parseAndHydrateWorkspaceState(metaRes.rows[0].state_json);
        if (pgState) {
          const pgTime = Date.parse(pgState.updatedAt || '') || 0;
          const localTime = Date.parse(cloudState.updatedAt || '') || 0;

          if (isDiskFreshInit || pgTime >= localTime) {
            Object.assign(cloudState, pgState);
            ensureDatabasesHierarchy(cloudState);
            getTargetTable(
              cloudState,
              cloudState.activeTableName,
              cloudState.activeDatabaseName
            );
            writeStateFilesToDiskOnly(cloudState);
          }
        }
      }

      // Single fast query to introspect all user schemas, tables, and columns in PostgreSQL
      const allColsRes = await pool
        .query<{
          table_schema: string;
          table_name: string;
          column_name: string;
          data_type: string;
          is_nullable: string;
          ordinal_position: number;
        }>(`
          SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
          FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public', 'auth', 'storage', 'extensions', 'realtime', 'graphql', 'graphql_public', 'vault', 'pgbouncer', 'supabase_functions', 'supabase_migrations', '_realtime', 'net', 'pgsodium', 'pgsodium_masks')
            AND table_schema NOT LIKE 'pg_%'
            AND table_name NOT LIKE '__gridpulse%'
          ORDER BY table_schema ASC, table_name ASC, ordinal_position ASC
        `)
        .catch(() => null);

      const pgExistingTablesSet = new Set<string>();

      if (allColsRes && allColsRes.rows.length > 0) {
        const grouped = new Map<
          string,
          Map<
            string,
            {
              column_name: string;
              data_type: string;
              is_nullable: string;
              ordinal_position: number;
            }[]
          >
        >();

        for (const r of allColsRes.rows) {
          if (!r.table_schema || !r.table_name) continue;
          pgExistingTablesSet.add(
            `${r.table_schema.toLowerCase()}::${r.table_name.toLowerCase()}`
          );
          let tblMap = grouped.get(r.table_schema);
          if (!tblMap) {
            tblMap = new Map();
            grouped.set(r.table_schema, tblMap);
          }
          let colList = tblMap.get(r.table_name);
          if (!colList) {
            colList = [];
            tblMap.set(r.table_name, colList);
          }
          colList.push(r);
        }

        for (const [schemaName, tblMap] of grouped.entries()) {
          let dbEntry = cloudState.databases.find(
            (d) => d.databaseName.toLowerCase() === schemaName.toLowerCase()
          );
          if (!dbEntry) {
            const nowIso = new Date().toISOString();
            dbEntry = {
              databaseName: schemaName,
              activeTableName: '',
              tables: [],
              createdAt: nowIso,
              updatedAt: nowIso,
            };
            cloudState.databases.push(dbEntry);
          }

          for (const [tblName, colRows] of tblMap.entries()) {
            const existingTbl = dbEntry.tables.find(
              (t) => t.tableName.toLowerCase() === tblName.toLowerCase()
            );

            // Hydrate if table is not in cloudState OR if existingTbl only had a 1-column stub while PostgreSQL has more columns
            if (!existingTbl || colRows.length > existingTbl.columns.length) {
              const nowIso = new Date().toISOString();
              const builtCols: ServerColumn[] = colRows.map((c, idx) => {
                const prevCol = existingTbl?.columns.find(
                  (ec) => ec.name.toLowerCase() === c.column_name.toLowerCase()
                );
                if (prevCol) {
                  return { ...prevCol, orderIndex: idx };
                }
                const isPk = c.column_name.toLowerCase() === 'id' || idx === 0;
                const dt = (c.data_type || '').toLowerCase();
                let colType: ServerColumn['colType'] = 'text';
                if (
                  dt.includes('int') ||
                  dt.includes('numeric') ||
                  dt.includes('decimal') ||
                  dt.includes('real') ||
                  dt.includes('double')
                ) {
                  colType = 'number';
                } else if (dt.includes('bool')) {
                  colType = 'checkbox';
                } else if (dt.includes('char')) {
                  colType = 'varchar_max';
                }
                return {
                  id: c.column_name,
                  name: c.column_name,
                  colType,
                  orderIndex: idx,
                  width: isPk ? 95 : 160,
                  required: c.is_nullable === 'NO',
                  isNullable: c.is_nullable !== 'NO',
                  isPrimaryKey: isPk,
                  isIdentity: isPk,
                  identitySeed: 1,
                  identityIncrement: 1,
                  defaultValue: '',
                  formula: '',
                  optionsCsv: '',
                };
              });

              const quotedSchemaTbl = `${quoteSqlIdent(schemaName)}.${quoteSqlIdent(tblName)}`;
              const liveDataRes = await pool
                .query<Record<string, unknown>>(`SELECT * FROM ${quotedSchemaTbl} ORDER BY 1 ASC LIMIT 5000`)
                .catch(() => null);
              const liveRows: ServerRow[] = (liveDataRes?.rows || []).map((r, rIdx) => {
                const cells: Record<string, string | number | boolean> = {};
                for (const col of builtCols) {
                  const rawVal = r[col.name] ?? r[col.id];
                  const norm: string | number | boolean =
                    rawVal === null || rawVal === undefined
                      ? col.colType === 'checkbox'
                        ? false
                        : ''
                      : col.colType === 'number'
                      ? Number(rawVal)
                      : col.colType === 'checkbox'
                      ? Boolean(rawVal)
                      : String(rawVal);
                  cells[col.name] = norm;
                  cells[col.id] = norm;
                }
                const pkVal = cells['ID'] ?? cells['id'] ?? rIdx + 1;
                return {
                  id: `row_pg_${pkVal}_${rIdx}`,
                  orderIndex: (rIdx + 1) * 10,
                  cells,
                  updatedBy: 'PostgreSQL',
                  updatedAt: nowIso,
                };
              });

              if (!existingTbl) {
                const hydratedTbl = normalizeServerTable({
                  tableName: tblName,
                  columns: builtCols,
                  rows: liveRows,
                  identitySeed: 1,
                  identityIncrement: 1,
                  nextIdentityValue: computeNextIdentityValue(builtCols, liveRows),
                  createdAt: nowIso,
                  updatedAt: nowIso,
                });
                dbEntry.tables.push(hydratedTbl);
                if (!dbEntry.activeTableName) {
                  dbEntry.activeTableName = hydratedTbl.tableName;
                }
              } else {
                existingTbl.columns = builtCols;
                if (liveRows.length > 0 && existingTbl.rows.length === 0) {
                  existingTbl.rows = sanitizeRowsAgainstSchema(builtCols, liveRows);
                }
                existingTbl.nextIdentityValue = computeNextIdentityValue(
                  existingTbl.columns,
                  existingTbl.rows
                );
              }
            }
          }
        }
      }

      ensureDatabasesHierarchy(cloudState);
      getTargetTable(cloudState, cloudState.activeTableName, cloudState.activeDatabaseName);
      await persistWorkspaceState(cloudState, true);

      // Sync any tables in cloudState that do not yet exist in PostgreSQL in the background
      void (async () => {
        for (const db of cloudState.databases) {
          await createDatabaseInRealBackend(db.databaseName, true);
          for (const tbl of db.tables) {
            const key = `${db.databaseName.toLowerCase()}::${tbl.tableName.toLowerCase()}`;
            if (!pgExistingTablesSet.has(key)) {
              await syncTableToRealDatabase(tbl, db.databaseName, true);
            }
          }
        }
      })();
    } catch {
      // Ignore PostgreSQL hydration errors when offline
    } finally {
      pgHasHydrated = true;
    }
  })();

  return pgHydrationPromise;
}

void ensurePostgresHydrated();

// Connected SSE clients for real-time collaboration
const sseClients = new Set<Response>();

function broadcastEvent(eventType: string, payload: unknown): void {
  const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
  if (eventType === 'workspace_sync' && payload && typeof payload === 'object') {
    const wbStatus = getWriteBehindBufferStatus();
    const wbData = `event: write_behind_status\ndata: ${JSON.stringify(wbStatus)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(wbData);
      } catch {
        sseClients.delete(client);
      }
    }
    broadcastWsFrameToAll({
      type: 'ReceiveWorkspaceSync',
      payload: payload as Record<string, unknown>,
      status: wbStatus,
    });
  }
}

function recordActivity(userName: string, userColor: string, action: string, detail: string): void {
  const entry: ServerActivity = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userName: userName || 'Collaborator',
    userColor: userColor || '#2563eb',
    action,
    detail,
    timestamp: new Date().toISOString(),
  };
  cloudState.activities = [entry, ...cloudState.activities.slice(0, 49)];
}

/**
 * SSE endpoint for real-time multi-user collaboration
 */
app.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);

  // Send initial connected state summary
  res.write(
    `event: connected\ndata: ${JSON.stringify({
      workspaceId: cloudState.workspaceId,
      activeDatabaseName: cloudState.activeDatabaseName,
      databases: getDatabaseSummaries(cloudState),
      activeTableName: cloudState.activeTableName,
      tables: getTableSummaries(cloudState),
      presence: Object.values(cloudState.presence),
      updatedAt: cloudState.updatedAt,
    })}\n\n`
  );

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/**
 * GET /api/workspace — returns workspace metadata, databases tree, tables list, active table columns, versions summary, and initial 10 lazy-loaded rows from database
 */
app.get('/api/workspace', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const requestedDb =
    typeof req.query['databaseName'] === 'string' ? req.query['databaseName'] : undefined;
  const requestedTable =
    typeof req.query['tableName'] === 'string' ? req.query['tableName'] : undefined;
  const prevDbName = cloudState.activeDatabaseName;
  const prevTableName = cloudState.activeTableName;
  const targetDb = getTargetDatabase(cloudState, requestedDb);
  const targetTable = getTargetTable(cloudState, requestedTable, targetDb.databaseName);
  if (
    (requestedDb || requestedTable) &&
    (cloudState.activeDatabaseName !== prevDbName || cloudState.activeTableName !== prevTableName)
  ) {
    // Read-only active view switch: update local cache file ONLY, never mark PostgreSQL write-behind buffer dirty
    writeStateFilesToDiskOnly(cloudState);
  }
  const sortedCols = targetTable
    ? [...targetTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];

  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [uid, pres] of Object.entries(cloudState.presence)) {
    if (Date.parse(pres.updatedAt) < cutoff) {
      delete cloudState.presence[uid];
    }
  }

  const limit = Math.max(1, Math.min(500, Number(req.query['limit'] || 10)));
  const queryResult = executeDatabaseQuery(sortedCols, targetTable ? targetTable.rows : [], {
    offset: 0,
    limit,
  });

  const versionsSummary = (cloudState.versions || []).map((v) => ({
    id: v.id,
    versionTag: v.versionTag,
    title: v.title,
    message: v.message,
    authorName: v.authorName,
    authorColor: v.authorColor,
    createdAt: v.createdAt,
    rowCount: v.rowCount,
    columnCount: v.columnCount,
  }));

  res.json({
    workspaceId: cloudState.workspaceId,
    workspaceName: targetTable ? targetTable.tableName : targetDb.databaseName,
    activeDatabaseName: targetDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: targetTable ? targetTable.tableName : '',
    tables: getTableSummaries(cloudState, targetDb),
    updatedAt: cloudState.updatedAt,
    totalRows: queryResult.totalRows,
    filteredTotalRows: queryResult.filteredTotalRows,
    hasMore: queryResult.hasMore,
    columns: sortedCols,
    rows: queryResult.rows,
    uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
    presence: Object.values(cloudState.presence),
    activities: cloudState.activities,
    versions: versionsSummary,
  });
});

/**
 * GET /api/workspace/tree — normal REST API endpoint for Sidebar Object Explorer tree
 * (Fetches database list, table list, field list, and nodes without using Redis or realtime streams)
 */
app.get('/api/workspace/tree', async (_req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const targetDb = findDatabase(cloudState, cloudState.activeDatabaseName);
  res.status(200).json({
    ok: true,
    activeDatabaseName: targetDb.databaseName,
    activeTableName: cloudState.activeTableName || targetDb.activeTableName || '',
    databases: getDatabaseSummaries(cloudState),
    tables: getTableSummaries(cloudState, targetDb),
  });
});

/**
 * POST /api/workspace/databases — creates a new database in the backend
 * (can be empty so its node in Manage Object Explorer is empty until tables are created, or optionally seeded with a starter table)
 */
app.post('/api/workspace/databases', async (req: Request, res: Response) => {
  try {
    await ensurePostgresHydrated();
    const body = (req.body || {}) as {
      databaseName?: string;
      createStarterTable?: boolean;
      starterTableName?: string;
      userName?: string;
      userColor?: string;
    };

    const cleanDbName = stripDboPrefix(body.databaseName || '').slice(0, 80);
    if (!cleanDbName) {
      res.status(200).json({ ok: false, error: 'Database name is required.' });
      return;
    }

    ensureDatabasesHierarchy(cloudState);
    if (
      cloudState.databases.some(
        (d) => d.databaseName.toLowerCase() === cleanDbName.toLowerCase()
      )
    ) {
      res.status(200).json({
        ok: false,
        error: `A database named "${cleanDbName}" already exists on the server.`,
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const author = body.userName || 'Collaborator';
    const tables: ServerTable[] = [];
    let activeTableName = '';

    if (body.createStarterTable) {
      const tblName = stripDboPrefix(body.starterTableName || 'Table_1').slice(0, 80) || 'Table_1';
      const pkCol: ServerColumn = {
        id: 'ID',
        name: 'ID',
        colType: 'number',
        orderIndex: 0,
        width: 95,
        required: true,
        isNullable: false,
        isPrimaryKey: true,
        isIdentity: true,
        identitySeed: 1,
        identityIncrement: 1,
        defaultValue: '',
        formula: '',
        optionsCsv: '',
      };
      tables.push({
        tableName: tblName,
        columns: [pkCol],
        rows: [],
        identitySeed: 1,
        identityIncrement: 1,
        nextIdentityValue: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      activeTableName = tblName;
    }

    const newDb: ServerDatabase = {
      databaseName: cleanDbName,
      activeTableName,
      tables,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    cloudState.databases.push(newDb);
    const targetTable = getTargetTable(cloudState, activeTableName, cleanDbName);
    cloudState.updatedAt = nowIso;

    recordActivity(
      author,
      body.userColor || '#ca8a04',
      'Database Created',
      `Created database "${cleanDbName}" in backend${activeTableName ? ` with starter table "${activeTableName}"` : ' (0 tables)'}`
    );
    await createDatabaseInRealBackend(cleanDbName, true);
    if (targetTable) {
      await syncTableToRealDatabase(targetTable, cleanDbName, true);
    }
    await persistWorkspaceState(cloudState, true);

    const sortedCols = targetTable
      ? [...targetTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
      : [];
    const queryResult = executeDatabaseQuery(sortedCols, targetTable ? targetTable.rows : [], {
      offset: 0,
      limit: 10,
    });

    broadcastEvent('workspace_sync', {
      workspaceName: targetTable ? targetTable.tableName : cleanDbName,
      activeDatabaseName: cleanDbName,
      databases: getDatabaseSummaries(cloudState),
      activeTableName: targetTable ? targetTable.tableName : '',
      tables: getTableSummaries(cloudState, newDb),
      updatedAt: cloudState.updatedAt,
      columns: sortedCols,
      totalRows: queryResult.totalRows,
      activities: cloudState.activities,
    });

    res.status(200).json({
      ok: true,
      activeDatabaseName: cleanDbName,
      databases: getDatabaseSummaries(cloudState),
      activeTableName: targetTable ? targetTable.tableName : '',
      tables: getTableSummaries(cloudState, newDb),
      columns: sortedCols,
      rows: queryResult.rows,
      totalRows: queryResult.totalRows,
      filteredTotalRows: queryResult.filteredTotalRows,
      hasMore: queryResult.hasMore,
      uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
      activities: cloudState.activities,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to create database.',
    });
  }
});

/**
 * POST /api/workspace/databases/delete — drops a database from the backend
 */
app.post('/api/workspace/databases/delete', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const {
    databaseName = '',
    userName = 'Collaborator',
    userColor = '#ca8a04',
  } = (req.body || {}) as {
    databaseName?: string;
    userName?: string;
    userColor?: string;
  };

  ensureDatabasesHierarchy(cloudState);
  if (cloudState.databases.length <= 1) {
    res.status(200).json({
      ok: false,
      error: 'At least one database must remain on the server.',
    });
    return;
  }

  const clean = databaseName.trim();
  const idx = cloudState.databases.findIndex(
    (d) => d.databaseName.toLowerCase() === clean.toLowerCase()
  );
  if (idx === -1) {
    res.status(200).json({ ok: false, error: `Database "${clean}" not found.` });
    return;
  }

  const removed = cloudState.databases.splice(idx, 1)[0];
  await dropDatabaseFromRealBackend(removed.databaseName, true);
  for (const tbl of removed.tables) {
    await dropTableFromRealDatabase(tbl.tableName, removed.databaseName, true);
  }

  const nextDb = cloudState.databases[Math.max(0, idx - 1)] || cloudState.databases[0];
  const targetTable = getTargetTable(
    cloudState,
    nextDb.activeTableName || nextDb.tables[0]?.tableName,
    nextDb.databaseName
  );
  cloudState.updatedAt = new Date().toISOString();

  recordActivity(
    userName,
    userColor,
    'Database Dropped',
    `Dropped database "${removed.databaseName}" from backend`
  );
  await persistWorkspaceState(cloudState, true);

  const sortedCols = targetTable
    ? [...targetTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const queryResult = executeDatabaseQuery(sortedCols, targetTable ? targetTable.rows : [], {
    offset: 0,
    limit: 10,
  });

  broadcastEvent('workspace_sync', {
    workspaceName: targetTable ? targetTable.tableName : nextDb.databaseName,
    activeDatabaseName: nextDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: targetTable ? targetTable.tableName : '',
    tables: getTableSummaries(cloudState, nextDb),
    updatedAt: cloudState.updatedAt,
    columns: sortedCols,
    totalRows: queryResult.totalRows,
    activities: cloudState.activities,
  });

  res.status(200).json({
    ok: true,
    activeDatabaseName: nextDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: targetTable ? targetTable.tableName : '',
    tables: getTableSummaries(cloudState, nextDb),
    columns: sortedCols,
    rows: queryResult.rows,
    totalRows: queryResult.totalRows,
    filteredTotalRows: queryResult.filteredTotalRows,
    hasMore: queryResult.hasMore,
    uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
    activities: cloudState.activities,
  });
});

/**
 * POST /api/workspace/databases/rename — renames an existing database in the backend
 */
app.post('/api/workspace/databases/rename', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const {
    oldDatabaseName = '',
    newDatabaseName = '',
    userName = 'Collaborator',
    userColor = '#4285F4',
  } = (req.body || {}) as {
    oldDatabaseName?: string;
    newDatabaseName?: string;
    userName?: string;
    userColor?: string;
  };

  ensureDatabasesHierarchy(cloudState);
  const cleanOld = stripDboPrefix(oldDatabaseName).trim();
  const cleanNew = stripDboPrefix(newDatabaseName).trim().slice(0, 80);

  if (!cleanOld || !cleanNew) {
    res.status(200).json({ ok: false, error: 'Database name is required.' });
    return;
  }

  const targetDb = cloudState.databases.find(
    (d) => d.databaseName.toLowerCase() === cleanOld.toLowerCase()
  );
  if (!targetDb) {
    res.status(200).json({ ok: false, error: `Database "${cleanOld}" not found.` });
    return;
  }

  if (
    cleanNew.toLowerCase() !== cleanOld.toLowerCase() &&
    cloudState.databases.some((d) => d.databaseName.toLowerCase() === cleanNew.toLowerCase())
  ) {
    res.status(200).json({
      ok: false,
      error: `A database named "${cleanNew}" already exists.`,
    });
    return;
  }

  const wasActive =
    (cloudState.activeDatabaseName || '').toLowerCase() === targetDb.databaseName.toLowerCase();
  const nowIso = new Date().toISOString();
  targetDb.databaseName = cleanNew;
  targetDb.updatedAt = nowIso;
  if (wasActive) {
    cloudState.activeDatabaseName = cleanNew;
  }
  cloudState.updatedAt = nowIso;

  await renameDatabaseInRealBackend(cleanOld, cleanNew, true);
  for (const tbl of targetDb.tables) {
    await syncTableToRealDatabase(tbl, cleanNew, true);
  }
  recordActivity(
    userName,
    userColor,
    'Database Renamed',
    `Renamed database "${cleanOld}" to "${cleanNew}"`
  );
  await persistWorkspaceState(cloudState, true);

  const activeDb = getTargetDatabase(cloudState, cloudState.activeDatabaseName);
  const activeTable = getTargetTable(cloudState, activeDb.activeTableName, activeDb.databaseName);
  const sortedCols = activeTable
    ? [...activeTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const queryResult = executeDatabaseQuery(sortedCols, activeTable ? activeTable.rows : [], {
    offset: 0,
    limit: 10,
  });

  broadcastEvent('workspace_sync', {
    workspaceName: activeTable ? activeTable.tableName : activeDb.databaseName,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTable ? activeTable.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    updatedAt: cloudState.updatedAt,
    columns: sortedCols,
    totalRows: queryResult.totalRows,
    activities: cloudState.activities,
  });

  res.status(200).json({
    ok: true,
    renamedDatabaseName: cleanNew,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTable ? activeTable.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    activities: cloudState.activities,
  });
});

/**
 * POST /api/workspace/query — executes search, filter, and multi-column sort on the active database table and returns paginated rows (10 at a time)
 */
app.post('/api/workspace/query', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const body = (req.body || {}) as {
    databaseName?: string;
    tableName?: string;
    offset?: number;
    limit?: number;
    selectAll?: boolean;
    globalSearchQuery?: string;
    searchScopeColId?: string;
    columnHeaderSearches?: Record<string, string>;
    filterRules?: Record<string, ServerColumnFilterRule>;
    sortRules?: ServerSortRule[];
  };

  const targetDb = getTargetDatabase(cloudState, body.databaseName);
  const targetTable = getTargetTable(cloudState, body.tableName, targetDb.databaseName);
  const sortedCols = targetTable
    ? [...targetTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];

  const result = executeDatabaseQuery(sortedCols, targetTable ? targetTable.rows : [], {
    offset: body.offset ?? 0,
    limit: body.limit ?? 10,
    selectAll: Boolean(body.selectAll),
    globalSearchQuery: body.globalSearchQuery,
    searchScopeColId: body.searchScopeColId,
    columnHeaderSearches: body.columnHeaderSearches,
    filterRules: body.filterRules,
    sortRules: body.sortRules,
  });

  res.json({
    ok: true,
    activeDatabaseName: targetDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: targetTable ? targetTable.tableName : '',
    tables: getTableSummaries(cloudState, targetDb),
    columns: sortedCols,
    ...result,
  });
});

/**
 * POST /api/workspace/tables — creates a new database table (and corresponding Excel-style sheet tab)
 * inside the target database with Primary Key IDENTITY(1,1) column (unless explicitly created empty),
 * user-defined columns (name, value, datatype, NULL/NOT NULL, formula), and mirrors the table directly to the database.
 */
app.post('/api/workspace/tables', async (req: Request, res: Response) => {
  try {
    await ensurePostgresHydrated();
    const body = (req.body || {}) as {
      databaseName?: string;
      tableName?: string;
      pkColumnName?: string;
      includeDefaultPk?: boolean;
      columns?: {
        name?: string;
        colType?: ServerColumn['colType'];
        isNullable?: boolean;
        columnValue?: string;
        formula?: string;
        optionsCsv?: string;
      }[];
      initialRowCount?: number;
      userName?: string;
      userColor?: string;
    };

    ensureDatabasesHierarchy(cloudState);
    const requestedDbName = stripDboPrefix(body.databaseName || '').trim();
    const targetDb =
      (requestedDbName
        ? cloudState.databases.find(
            (d) => d.databaseName.toLowerCase() === requestedDbName.toLowerCase()
          )
        : undefined) ||
      cloudState.databases.find(
        (d) => d.databaseName.toLowerCase() === (cloudState.activeDatabaseName || '').toLowerCase()
      ) ||
      cloudState.databases[0];

    const cleanTableName = stripDboPrefix(body.tableName || '').slice(0, 80);
    if (!cleanTableName) {
      res.status(200).json({ ok: false, error: 'Table name is required.' });
      return;
    }

    if (
      targetDb.tables.some(
        (t) => t.tableName.toLowerCase() === cleanTableName.toLowerCase()
      )
    ) {
      res.status(200).json({
        ok: false,
        error: `A table named "${cleanTableName}" already exists in database "${targetDb.databaseName}".`,
      });
      return;
    }

    // Always set primary key internally as ID with IDENTITY(1,1) and create 0 rows
    const pkName = 'ID';
    const builtColumns: ServerColumn[] = [
      {
        id: pkName,
        name: pkName,
        colType: 'number',
        orderIndex: 0,
        width: 95,
        required: true,
        isNullable: false,
        isPrimaryKey: true,
        isIdentity: true,
        identitySeed: 1,
        identityIncrement: 1,
        defaultValue: '',
        formula: '',
        optionsCsv: '',
      },
    ];

    const seenColNames = new Set<string>([pkName.toLowerCase()]);
    const allowedColTypes = new Set<ServerColumn['colType']>([
      'text',
      'varchar_max',
      'number',
      'date',
      'dropdown',
      'lookup',
      'checkbox',
      'formula',
    ]);

    if (Array.isArray(body.columns)) {
      for (const rawCol of body.columns) {
        const cleanColName = String(rawCol?.name || '').trim().slice(0, 80);
        if (!cleanColName) continue;
        const lowerColName = cleanColName.toLowerCase();
        if (seenColNames.has(lowerColName)) {
          res.status(200).json({
            ok: false,
            error: `Duplicate field name "${cleanColName}" in table "${cleanTableName}".`,
          });
          return;
        }
        seenColNames.add(lowerColName);

        const colType: ServerColumn['colType'] =
          rawCol?.colType && allowedColTypes.has(rawCol.colType) ? rawCol.colType : 'text';
        const isFormula = colType === 'formula';
        const isNullable = isFormula
          ? true
          : rawCol?.isNullable !== undefined
          ? Boolean(rawCol.isNullable)
          : true;
        const rawDefault = String(
          (rawCol as { defaultValue?: string; columnValue?: string })?.defaultValue ??
            rawCol?.columnValue ??
            ''
        ).trim();
        const rawFormula = String(rawCol?.formula || '').trim();
        const normalizedFormula = isFormula
          ? rawFormula.startsWith('=')
            ? rawFormula
            : `=${rawFormula}`
          : colType === 'lookup'
          ? rawFormula
          : '';
        const rawOptions =
          colType === 'dropdown' || colType === 'lookup'
            ? String(rawCol?.optionsCsv || '').trim()
            : '';
        const rawLookupTableName =
          colType === 'lookup'
            ? String(
                (rawCol as { lookupTableName?: string })?.lookupTableName || cleanTableName
              ).trim()
            : '';

        builtColumns.push({
          id: cleanColName,
          name: cleanColName,
          colType,
          orderIndex: builtColumns.length,
          width: colType === 'varchar_max' ? 220 : colType === 'formula' || colType === 'lookup' ? 210 : 150,
          required: isFormula ? false : !isNullable,
          isNullable,
          defaultValue: isFormula ? '' : rawDefault,
          formula: normalizedFormula,
          optionsCsv: rawOptions,
          lookupTableName: rawLookupTableName || undefined,
        });
      }
    }

    const nowIso = new Date().toISOString();
    const author = body.userName || 'Collaborator';
    const newTable: ServerTable = {
      tableName: cleanTableName,
      columns: builtColumns,
      rows: [],
      allowEmptyColumns: false,
      identitySeed: 1,
      identityIncrement: 1,
      nextIdentityValue: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    targetDb.tables.push(newTable);
    targetDb.activeTableName = cleanTableName;
    targetDb.updatedAt = nowIso;

    syncAllLinkedLookupColumnsInState(cloudState);

    const currentActiveDbName = cloudState.activeDatabaseName || targetDb.databaseName;
    const isTargetActiveDb =
      targetDb.databaseName.toLowerCase() === currentActiveDbName.toLowerCase();

    if (isTargetActiveDb) {
      getTargetTable(cloudState, cleanTableName, targetDb.databaseName);
    }
    cloudState.updatedAt = nowIso;

    recordActivity(
      author,
      body.userColor || '#ca8a04',
      'Table Created',
      `Created table "${cleanTableName}" in database "${targetDb.databaseName}"`
    );
    await syncTableToRealDatabase(newTable, targetDb.databaseName, true);
    await persistWorkspaceState(cloudState, true);

    const activeDbObj =
      cloudState.databases.find(
        (d) => d.databaseName.toLowerCase() === currentActiveDbName.toLowerCase()
      ) || targetDb;
    const activeTableObj = isTargetActiveDb
      ? newTable
      : activeDbObj.tables.find(
          (t) => t.tableName.toLowerCase() === (activeDbObj.activeTableName || '').toLowerCase()
        ) || activeDbObj.tables[0] || null;
    const responseCols = activeTableObj
      ? [...activeTableObj.columns].sort((a, b) => a.orderIndex - b.orderIndex)
      : [];
    const responseRows = activeTableObj ? activeTableObj.rows : [];

    const queryResult = executeDatabaseQuery(responseCols, responseRows, {
      offset: 0,
      limit: 10,
    });

    broadcastEvent('workspace_sync', {
      workspaceName: activeTableObj ? activeTableObj.tableName : activeDbObj.databaseName,
      activeDatabaseName: activeDbObj.databaseName,
      databases: getDatabaseSummaries(cloudState),
      activeTableName: activeTableObj ? activeTableObj.tableName : '',
      tables: getTableSummaries(cloudState, activeDbObj),
      updatedAt: cloudState.updatedAt,
      columns: responseCols,
      totalRows: responseRows.length,
      activities: cloudState.activities,
    });

    res.status(200).json({
      ok: true,
      createdInDatabaseName: targetDb.databaseName,
      createdTableName: cleanTableName,
      activeDatabaseName: activeDbObj.databaseName,
      databases: getDatabaseSummaries(cloudState),
      activeTableName: activeTableObj ? activeTableObj.tableName : '',
      tables: getTableSummaries(cloudState, activeDbObj),
      columns: responseCols,
      rows: queryResult.rows,
      totalRows: queryResult.totalRows,
      filteredTotalRows: queryResult.filteredTotalRows,
      hasMore: queryResult.hasMore,
      uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
      activities: cloudState.activities,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to create table in database.',
    });
  }
});

/**
 * POST /api/workspace/tables/delete — deletes a database table and its sheet tab without changing activeDatabaseName if deleted from a non-active database
 */
app.post('/api/workspace/tables/delete', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const {
    databaseName,
    tableName = '',
    userName = 'Collaborator',
    userColor = '#ca8a04',
  } = (req.body || {}) as {
    databaseName?: string;
    tableName?: string;
    userName?: string;
    userColor?: string;
  };

  ensureDatabasesHierarchy(cloudState);
  const prevActiveDbName = cloudState.activeDatabaseName || cloudState.databases[0].databaseName;
  const targetDb = findDatabase(cloudState, databaseName);
  const clean = tableName.trim();
  const idx = targetDb.tables.findIndex(
    (t) => t.tableName.toLowerCase() === clean.toLowerCase()
  );
  if (idx === -1) {
    res.status(200).json({ ok: false, error: `Table "${clean}" not found in "${targetDb.databaseName}".` });
    return;
  }

  const removed = targetDb.tables.splice(idx, 1)[0];
  await dropTableFromRealDatabase(removed.tableName, targetDb.databaseName, true);

  const nextActiveInTargetDb = targetDb.tables[Math.max(0, idx - 1)] || targetDb.tables[0] || null;
  targetDb.activeTableName = nextActiveInTargetDb ? nextActiveInTargetDb.tableName : '';
  cloudState.updatedAt = new Date().toISOString();
  targetDb.updatedAt = cloudState.updatedAt;

  const isTargetActiveDb =
    targetDb.databaseName.toLowerCase() === prevActiveDbName.toLowerCase();

  // Keep the true active database unchanged
  const activeDb = findDatabase(cloudState, prevActiveDbName);
  const activeTable = isTargetActiveDb
    ? getTargetTable(cloudState, targetDb.activeTableName, activeDb.databaseName)
    : getTargetTable(cloudState, activeDb.activeTableName, activeDb.databaseName);

  recordActivity(
    userName,
    userColor,
    'Table Deleted',
    `Dropped table "${removed.tableName}" from database "${targetDb.databaseName}"`
  );
  await persistWorkspaceState(cloudState, true);

  const sortedCols = activeTable
    ? [...activeTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const queryResult = executeDatabaseQuery(sortedCols, activeTable ? activeTable.rows : [], {
    offset: 0,
    limit: 10,
  });

  broadcastEvent('workspace_sync', {
    workspaceName: activeTable ? activeTable.tableName : activeDb.databaseName,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTable ? activeTable.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    updatedAt: cloudState.updatedAt,
    columns: sortedCols,
    totalRows: queryResult.totalRows,
    activities: cloudState.activities,
  });

  res.status(200).json({
    ok: true,
    deletedFromDatabaseName: targetDb.databaseName,
    deletedTableName: removed.tableName,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTable ? activeTable.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    columns: sortedCols,
    rows: queryResult.rows,
    totalRows: queryResult.totalRows,
    filteredTotalRows: queryResult.filteredTotalRows,
    hasMore: queryResult.hasMore,
    uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
    activities: cloudState.activities,
  });
});

/**
 * POST /api/workspace/tables/rename — renames an existing database table and/or updates its tabular columns schema
 */
app.post('/api/workspace/tables/rename', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const {
    databaseName,
    oldTableName = '',
    newTableName = '',
    columns,
    userName = 'Collaborator',
    userColor = '#4285F4',
  } = (req.body || {}) as {
    databaseName?: string;
    oldTableName?: string;
    newTableName?: string;
    columns?: {
      originalName?: string;
      name?: string;
      colType?: ServerColumn['colType'];
      isNullable?: boolean;
      defaultValue?: string;
      columnValue?: string;
      formula?: string;
      optionsCsv?: string;
    }[];
    userName?: string;
    userColor?: string;
  };

  ensureDatabasesHierarchy(cloudState);
  const prevActiveDbName = cloudState.activeDatabaseName || cloudState.databases[0].databaseName;
  const targetDb = findDatabase(cloudState, databaseName);
  const cleanOld = stripDboPrefix(oldTableName).trim();
  const cleanNew = stripDboPrefix(newTableName).trim().slice(0, 80);

  if (!cleanOld || !cleanNew) {
    res.status(200).json({ ok: false, error: 'Table name is required.' });
    return;
  }

  const targetTable = targetDb.tables.find(
    (t) => t.tableName.toLowerCase() === cleanOld.toLowerCase()
  );
  if (!targetTable) {
    res.status(200).json({
      ok: false,
      error: `Table "${cleanOld}" not found in database "${targetDb.databaseName}".`,
    });
    return;
  }

  if (
    cleanNew.toLowerCase() !== cleanOld.toLowerCase() &&
    targetDb.tables.some((t) => t.tableName.toLowerCase() === cleanNew.toLowerCase())
  ) {
    res.status(200).json({
      ok: false,
      error: `A table named "${cleanNew}" already exists in database "${targetDb.databaseName}".`,
    });
    return;
  }

  let tableRenamedColsList: { oldName: string; newName: string }[] = [];
  let tableAddedColNames: string[] = [];
  let tableDeletedColNames: string[] = [];

  // If tabular columns were submitted from Edit Table popup, validate and apply schema changes
  if (Array.isArray(columns)) {
    const pkName = 'ID';
    const existingPk = targetTable.columns.find((c) => c.isPrimaryKey || c.isIdentity);
    const builtColumns: ServerColumn[] = [
      existingPk
        ? { ...existingPk, orderIndex: 0 }
        : {
            id: pkName,
            name: pkName,
            colType: 'number',
            orderIndex: 0,
            width: 95,
            required: true,
            isNullable: false,
            isPrimaryKey: true,
            isIdentity: true,
            identitySeed: 1,
            identityIncrement: 1,
            defaultValue: '',
            formula: '',
            optionsCsv: '',
          },
    ];

    const seenColNames = new Set<string>([builtColumns[0].name.toLowerCase()]);
    const allowedColTypes = new Set<ServerColumn['colType']>([
      'text',
      'varchar_max',
      'number',
      'date',
      'dropdown',
      'lookup',
      'checkbox',
      'formula',
    ]);
    const renameMap = new Map<string, string>();
    const existingColMap = new Map<string, ServerColumn>(
      targetTable.columns.map((c) => [c.name.toLowerCase(), c])
    );

    for (const rawCol of columns) {
      const cleanColName = String(rawCol?.name || '').trim().slice(0, 80);
      if (!cleanColName) continue;
      const lowerColName = cleanColName.toLowerCase();
      if (seenColNames.has(lowerColName)) {
        res.status(200).json({
          ok: false,
          error: `Duplicate field name "${cleanColName}" in table "${cleanNew}".`,
        });
        return;
      }
      seenColNames.add(lowerColName);

      const origName = String(rawCol?.originalName || '').trim();
      if (origName && origName !== cleanColName) {
        renameMap.set(origName, cleanColName);
      }

      const prevCol = origName ? existingColMap.get(origName.toLowerCase()) : undefined;
      const colType: ServerColumn['colType'] =
        rawCol?.colType && allowedColTypes.has(rawCol.colType) ? rawCol.colType : 'text';
      const isFormula = colType === 'formula';
      const isNullable = isFormula
        ? true
        : rawCol?.isNullable !== undefined
        ? Boolean(rawCol.isNullable)
        : true;
      const rawDefault = String(rawCol?.defaultValue ?? rawCol?.columnValue ?? '').trim();
      const rawFormula = String(rawCol?.formula || prevCol?.formula || '').trim();
      const normalizedFormula = isFormula
        ? rawFormula.startsWith('=')
          ? rawFormula
          : `=${rawFormula}`
        : colType === 'lookup'
        ? rawFormula
        : '';
      const rawOptions =
        colType === 'dropdown' || colType === 'lookup'
          ? String(rawCol?.optionsCsv || '').trim()
          : '';
      const rawLookupTableName =
        colType === 'lookup'
          ? String(
              (rawCol as { lookupTableName?: string })?.lookupTableName ||
                prevCol?.lookupTableName ||
                cleanNew
            ).trim()
          : '';

      builtColumns.push({
        id: cleanColName,
        name: cleanColName,
        colType,
        orderIndex: builtColumns.length,
        width:
          prevCol?.width ||
          (colType === 'varchar_max'
            ? 220
            : colType === 'formula' || colType === 'lookup'
            ? 210
            : 150),
        required: isFormula ? false : !isNullable,
        isNullable,
        defaultValue: isFormula ? '' : rawDefault,
        formula: normalizedFormula,
        optionsCsv: rawOptions,
        lookupTableName: rawLookupTableName || undefined,
      });
    }

    tableRenamedColsList = Array.from(renameMap.entries()).map(([oldName, newName]) => ({
      oldName,
      newName,
    }));
    const oldNamesLower = new Set(targetTable.columns.map((c) => c.name.toLowerCase()));
    const renamedNewLower = new Set(
      Array.from(renameMap.values()).map((n) => n.toLowerCase())
    );
    const renamedOldLower = new Set(
      Array.from(renameMap.keys()).map((n) => n.toLowerCase())
    );
    tableAddedColNames = builtColumns
      .filter(
        (c) =>
          c.colType !== 'lookup' &&
          !oldNamesLower.has(c.name.toLowerCase()) &&
          !renamedNewLower.has(c.name.toLowerCase())
      )
      .map((c) => c.name);
    const newNamesLower = new Set(builtColumns.map((c) => c.name.toLowerCase()));
    tableDeletedColNames = targetTable.columns
      .filter(
        (c) =>
          !newNamesLower.has(c.name.toLowerCase()) &&
          !renamedOldLower.has(c.name.toLowerCase())
      )
      .map((c) => c.name);

    if (renameMap.size > 0) {
      for (const row of targetTable.rows) {
        if (!row.cells) continue;
        for (const [oldCol, newCol] of renameMap.entries()) {
          if (row.cells[oldCol] !== undefined) {
            row.cells[newCol] = row.cells[oldCol];
            delete row.cells[oldCol];
          }
        }
      }
    }

    targetTable.columns = builtColumns;
    targetTable.rows = sanitizeRowsAgainstSchema(builtColumns, targetTable.rows);
  }

  const nowIso = new Date().toISOString();
  if (cleanNew.toLowerCase() !== cleanOld.toLowerCase()) {
    await dropTableFromRealDatabase(targetTable.tableName, targetDb.databaseName, true);
  }
  targetTable.tableName = cleanNew;
  targetTable.updatedAt = nowIso;
  targetDb.updatedAt = nowIso;

  syncAllLinkedLookupColumnsInState(cloudState, {
    databaseName: targetDb.databaseName,
    oldTableName: cleanOld,
    newTableName: cleanNew,
    mutatedTableName: cleanNew,
    renamedColumns: tableRenamedColsList,
    addedColumnNames: tableAddedColNames,
    deletedColumnNames: tableDeletedColNames,
  });

  if ((targetDb.activeTableName || '').toLowerCase() === cleanOld.toLowerCase()) {
    targetDb.activeTableName = cleanNew;
  }
  if (
    prevActiveDbName.toLowerCase() === targetDb.databaseName.toLowerCase() &&
    (cloudState.activeTableName || '').toLowerCase() === cleanOld.toLowerCase()
  ) {
    cloudState.activeTableName = cleanNew;
    cloudState.workspaceName = cleanNew;
  }
  cloudState.updatedAt = nowIso;

  await syncTableToRealDatabase(targetTable, targetDb.databaseName, true);
  for (const otherTbl of targetDb.tables) {
    if (
      otherTbl !== targetTable &&
      otherTbl.columns.some(
        (c) =>
          c.colType === 'lookup' &&
          (c.lookupTableName || '').toLowerCase() === targetTable.tableName.toLowerCase()
      )
    ) {
      await syncTableToRealDatabase(otherTbl, targetDb.databaseName, true);
    }
  }
  recordActivity(
    userName,
    userColor,
    cleanNew !== cleanOld ? 'Table Renamed & Updated' : 'Table Schema Updated',
    cleanNew !== cleanOld
      ? `Renamed table "${cleanOld}" to "${cleanNew}" (${targetTable.columns.length} fields) in database "${targetDb.databaseName}"`
      : `Updated schema for table "${cleanNew}" (${targetTable.columns.length} fields) in database "${targetDb.databaseName}"`
  );
  await persistWorkspaceState(cloudState, true);

  const activeDb = getTargetDatabase(cloudState, prevActiveDbName);
  const activeTbl = getTargetTable(cloudState, activeDb.activeTableName, activeDb.databaseName);
  const sortedCols = activeTbl
    ? [...activeTbl.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const queryResult = executeDatabaseQuery(sortedCols, activeTbl ? activeTbl.rows : [], {
    offset: 0,
    limit: 10,
  });

  broadcastEvent('workspace_sync', {
    workspaceName: activeTbl ? activeTbl.tableName : activeDb.databaseName,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTbl ? activeTbl.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    updatedAt: cloudState.updatedAt,
    columns: sortedCols,
    totalRows: activeTbl ? activeTbl.rows.length : 0,
    activities: cloudState.activities,
  });

  res.status(200).json({
    ok: true,
    renamedDatabaseName: targetDb.databaseName,
    renamedTableName: cleanNew,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTbl ? activeTbl.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    columns: sortedCols,
    rows: queryResult.rows,
    totalRows: queryResult.totalRows,
    filteredTotalRows: queryResult.filteredTotalRows,
    hasMore: queryResult.hasMore,
    uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
    activities: cloudState.activities,
  });
});

/**
 * GET /api/workspace/lazy-rows — paginated chunk endpoint for lazy loading
 */
app.get('/api/workspace/lazy-rows', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const requestedDb =
    typeof req.query['databaseName'] === 'string' ? req.query['databaseName'] : undefined;
  const requestedTable =
    typeof req.query['tableName'] === 'string' ? req.query['tableName'] : undefined;
  const targetDb = getTargetDatabase(cloudState, requestedDb);
  const targetTable = getTargetTable(cloudState, requestedTable, targetDb.databaseName);
  const offset = Math.max(0, Number(req.query['offset'] || 0));
  const limit = Math.max(1, Math.min(500, Number(req.query['limit'] || 10)));
  const sortedCols = targetTable
    ? [...targetTable.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];
  const result = executeDatabaseQuery(sortedCols, targetTable ? targetTable.rows : [], {
    offset,
    limit,
  });

  res.json({
    activeDatabaseName: targetDb.databaseName,
    activeTableName: targetTable ? targetTable.tableName : '',
    offset,
    limit,
    totalRows: result.totalRows,
    filteredTotalRows: result.filteredTotalRows,
    rows: result.rows,
    hasMore: result.hasMore,
  });
});

/**
 * POST /api/auth/login — authenticates user from PostgreSQL users store
 */
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email = '', password = '' } = (req.body || {}) as {
    email?: string;
    password?: string;
  };
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) {
    res.status(200).json({ ok: false, error: 'Email and password are required.' });
    return;
  }

  if (!Array.isArray(cloudState.users)) {
    cloudState.users = buildDefaultUsers();
  }
  const user = cloudState.users.find((u) => u.email.toLowerCase() === cleanEmail);
  if (!user || user.passwordHash !== password) {
    res.status(200).json({
      ok: false,
      error: 'Invalid user email or password.',
    });
    return;
  }

  const token = `pg_sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  if (!cloudState.sessions) cloudState.sessions = {};
  cloudState.sessions[token] = user.id;

  recordActivity(
    user.displayName,
    user.color,
    'User Login',
    `Authenticated user ${user.email} (${user.role})`
  );
  saveStateToDisk(cloudState);

  res.status(200).json({
    ok: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      color: user.color,
    },
  });
});

/**
 * POST /api/auth/register — creates a new user account
 */
app.post('/api/auth/register', (req: Request, res: Response) => {
  const {
    email = '',
    password = '',
    displayName = '',
    color = '#ca8a04',
  } = (req.body || {}) as {
    email?: string;
    password?: string;
    displayName?: string;
    color?: string;
  };

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = displayName.trim() || cleanEmail.split('@')[0] || 'Collaborator';
  if (!cleanEmail || !cleanEmail.includes('@') || password.length < 4) {
    res.status(200).json({
      ok: false,
      error: 'Please enter a valid email address and a password of at least 4 characters.',
    });
    return;
  }

  if (!Array.isArray(cloudState.users)) {
    cloudState.users = buildDefaultUsers();
  }
  if (cloudState.users.some((u) => u.email.toLowerCase() === cleanEmail)) {
    res.status(200).json({
      ok: false,
      error: `An account with email "${cleanEmail}" already exists.`,
    });
    return;
  }

  const newUser: ServerUser = {
    id: `usr_pg_${Date.now().toString(36)}`,
    email: cleanEmail,
    passwordHash: password,
    displayName: cleanName.slice(0, 60),
    role: 'Editor',
    color: color || '#ca8a04',
    createdAt: new Date().toISOString(),
  };

  cloudState.users.push(newUser);
  const token = `pg_sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  if (!cloudState.sessions) cloudState.sessions = {};
  cloudState.sessions[token] = newUser.id;

  recordActivity(
    newUser.displayName,
    newUser.color,
    'User Registered',
    `Created account ${newUser.email}`
  );
  saveStateToDisk(cloudState);

  res.status(200).json({
    ok: true,
    token,
    user: {
      id: newUser.id,
      email: newUser.email,
      displayName: newUser.displayName,
      role: newUser.role,
      color: newUser.color,
    },
  });
});

/**
 * GET /api/auth/me — verifies PostgreSQL session token
 */
app.get('/api/auth/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || !cloudState.sessions || !cloudState.sessions[token]) {
    res.status(200).json({ ok: false, user: null });
    return;
  }
  const userId = cloudState.sessions[token];
  const user = (cloudState.users || []).find((u) => u.id === userId);
  if (!user) {
    res.status(200).json({ ok: false, user: null });
    return;
  }
  res.status(200).json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      color: user.color,
    },
  });
});

/**
 * POST /api/auth/logout — logs out of PostgreSQL session
 */
app.post('/api/auth/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token && cloudState.sessions) {
    delete cloudState.sessions[token];
    saveStateToDisk(cloudState);
  }
  res.status(200).json({ ok: true });
});

/**
 * GET /api/workspace/versions — returns version control commit history
 */
app.get('/api/workspace/versions', (_req: Request, res: Response) => {
  const list = (cloudState.versions || []).map((v) => ({
    id: v.id,
    versionTag: v.versionTag,
    title: v.title,
    message: v.message,
    authorName: v.authorName,
    authorColor: v.authorColor,
    createdAt: v.createdAt,
    rowCount: v.rowCount,
    columnCount: v.columnCount,
  }));
  res.status(200).json({ ok: true, versions: list });
});

/**
 * POST /api/workspace/versions — commits a new version checkpoint of the database
 */
app.post('/api/workspace/versions', (req: Request, res: Response) => {
  const {
    title = '',
    message = '',
    authorName = 'Alex Rivera',
    authorColor = '#ca8a04',
  } = (req.body || {}) as {
    title?: string;
    message?: string;
    authorName?: string;
    authorColor?: string;
  };

  if (!Array.isArray(cloudState.versions)) {
    cloudState.versions = [];
  }

  const nextMinor = cloudState.versions.length;
  const versionTag = `v1.${nextMinor}`;
  const cleanTitle = title.trim() || `Checkpoint ${versionTag}`;
  const cleanMessage =
    message.trim() ||
    `Saved snapshot with ${cloudState.rows.length} rows and ${cloudState.columns.length} columns`;

  const commit: ServerVersionCommit = {
    id: `ver_${Date.now().toString(36)}`,
    versionTag,
    title: cleanTitle.slice(0, 100),
    message: cleanMessage.slice(0, 240),
    authorName: authorName || 'Collaborator',
    authorColor: authorColor || '#ca8a04',
    createdAt: new Date().toISOString(),
    rowCount: cloudState.rows.length,
    columnCount: cloudState.columns.length,
    columnsSnapshot: cloudState.columns.map((c) => ({ ...c })),
    rowsSnapshot: cloudState.rows.map((r) => ({ ...r, cells: { ...r.cells } })),
  };

  cloudState.versions = [commit, ...cloudState.versions.slice(0, 29)];
  recordActivity(
    commit.authorName,
    commit.authorColor,
    `Version ${commit.versionTag} Committed`,
    `${commit.title} (${commit.rowCount} rows, ${commit.columnCount} cols)`
  );
  saveStateToDisk(cloudState);

  const list = cloudState.versions.map((v) => ({
    id: v.id,
    versionTag: v.versionTag,
    title: v.title,
    message: v.message,
    authorName: v.authorName,
    authorColor: v.authorColor,
    createdAt: v.createdAt,
    rowCount: v.rowCount,
    columnCount: v.columnCount,
  }));

  res.status(200).json({
    ok: true,
    committed: list[0],
    versions: list,
    activities: cloudState.activities,
  });
});

/**
 * POST /api/workspace/versions/restore — restores the database to a committed version snapshot
 */
app.post('/api/workspace/versions/restore', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const {
    versionId = '',
    userName = 'Alex Rivera',
    userColor = '#ca8a04',
  } = (req.body || {}) as {
    versionId?: string;
    userName?: string;
    userColor?: string;
  };

  const target = (cloudState.versions || []).find((v) => v.id === versionId);
  if (!target) {
    res.status(200).json({ ok: false, error: 'Version snapshot not found.' });
    return;
  }

  const restoredCols = ensurePrimaryKeyIdentityColumn(
    target.columnsSnapshot.map((c) => ({ ...c }))
  );
  const restoredRows = sanitizeRowsAgainstSchema(
    restoredCols,
    target.rowsSnapshot.map((r) => ({ ...r, cells: { ...r.cells } }))
  );
  const nowIso = new Date().toISOString();

  const activeDb = getTargetDatabase(cloudState, cloudState.activeDatabaseName);
  const activeTbl = getTargetTable(cloudState, activeDb.activeTableName, activeDb.databaseName);
  if (activeTbl) {
    activeTbl.columns = restoredCols;
    activeTbl.rows = restoredRows;
    activeTbl.nextIdentityValue = computeNextIdentityValue(restoredCols, restoredRows);
    activeTbl.updatedAt = nowIso;
    activeDb.updatedAt = nowIso;
    await syncTableToRealDatabase(activeTbl, activeDb.databaseName);
  }

  cloudState.columns = restoredCols;
  cloudState.rows = restoredRows;
  cloudState.updatedAt = nowIso;

  recordActivity(
    userName,
    userColor,
    `Restored ${target.versionTag}`,
    `Rolled back database to "${target.title}" (${cloudState.rows.length} rows)`
  );
  await persistWorkspaceState(cloudState);

  const queryResult = executeDatabaseQuery(cloudState.columns, cloudState.rows, {
    offset: 0,
    limit: 10,
  });

  broadcastEvent('workspace_sync', {
    workspaceName: cloudState.workspaceName,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTbl ? activeTbl.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    updatedAt: cloudState.updatedAt,
    columns: cloudState.columns,
    rows: queryResult.rows,
    totalRows: queryResult.totalRows,
    filteredTotalRows: queryResult.filteredTotalRows,
    activities: cloudState.activities,
  });

  res.status(200).json({
    ok: true,
    restoredVersion: target.versionTag,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: activeTbl ? activeTbl.tableName : '',
    tables: getTableSummaries(cloudState, activeDb),
    columns: cloudState.columns,
    rows: queryResult.rows,
    totalRows: queryResult.totalRows,
    filteredTotalRows: queryResult.filteredTotalRows,
    hasMore: queryResult.hasMore,
    uniqueValuesByColumn: queryResult.uniqueValuesByColumn,
    activities: cloudState.activities,
  });
});

/**
 * GET /api/download-project — downloads the complete project source code (Angular 21 + .NET Core 8 Web API + EF Core PostgreSQL)
 */
app.get('/api/download-project', (_req: Request, res: Response) => {
  try {
    const rootDir = process.cwd();
    const archiveBuffer = execFileSync(
      'tar',
      [
        '-czf',
        '-',
        '--exclude=node_modules',
        '--exclude=.angular',
        '--exclude=dist',
        '--exclude=.git',
        '.',
      ],
      { cwd: rootDir, maxBuffer: 50 * 1024 * 1024 }
    );
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="gridpulse-complete-project.tar.gz"'
    );
    res.send(archiveBuffer);
  } catch {
    res.status(500).json({ error: 'Failed to create project archive.' });
  }
});

// GitHub CLI public OAuth App Client ID (always has OAuth Device Flow enabled)
const GITHUB_DEVICE_FLOW_CLIENT_ID = '178c6fc778ccc68e1d6a';
const DEFAULT_GITHUB_WEB_CLIENT_ID =
  process.env['GITHUB_CLIENT_ID'] || GITHUB_DEVICE_FLOW_CLIENT_ID;

function collectProjectFiles(
  baseDir: string,
  relDir = ''
): { path: string; content: string }[] {
  const excludedDirs = new Set([
    'node_modules',
    '.angular',
    'dist',
    '.git',
    '.aistudio',
  ]);
  const excludedFiles = new Set([
    'bun.lock',
    'package-lock.json',
    '.github-auth-cache.json',
  ]);
  const results: { path: string; content: string }[] = [];

  const currentDir = relDir ? join(baseDir, relDir) : baseDir;
  const entries = readdirSync(currentDir);

  for (const name of entries) {
    if (excludedDirs.has(name) || excludedFiles.has(name)) continue;
    const relPath = relDir ? `${relDir}/${name}` : name;
    const fullPath = join(baseDir, relPath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      results.push(...collectProjectFiles(baseDir, relPath));
    } else if (stat.isFile() && stat.size < 512 * 1024) {
      try {
        let content = readFileSync(fullPath, 'utf-8');
        if (!content.includes('\u0000')) {
          if (relPath === 'vercel.json') {
            try {
              const parsedVercel = JSON.parse(content) as Record<string, unknown>;
              delete parsedVercel['public'];
              delete parsedVercel['name'];
              content = `${JSON.stringify(parsedVercel, null, 2)}\n`;
            } catch {
              // Keep raw content if JSON parse fails
            }
          }
          results.push({ path: relPath, content });
        }
      } catch {
        // Skip binary or unreadable files
      }
    }
  }
  return results;
}

/**
 * GET /api/auth/github/url — returns GitHub OAuth authorization URL for popup flow
 */
app.get('/api/auth/github/url', (req: Request, res: Response) => {
  const appUrl = (process.env['APP_URL'] || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const redirectUri = `${appUrl}/auth/callback`;
  const params = new URLSearchParams({
    client_id: DEFAULT_GITHUB_WEB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'repo',
  });
  res.json({
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
    redirectUri,
    hasClientSecret: Boolean(process.env['GITHUB_CLIENT_SECRET']),
  });
});

/**
 * GET /auth/callback — OAuth callback handler that exchanges code for token and posts message to opener
 */
app.get(['/auth/callback', '/auth/callback/'], async (req: Request, res: Response) => {
  const code = String(req.query['code'] || '');
  const clientSecret = process.env['GITHUB_CLIENT_SECRET'] || '';

  if (!code || !clientSecret) {
    res.send(`
      <html>
        <body style="font-family: system-ui, sans-serif; padding: 24px;">
          <p>GitHub OAuth callback received. Please use the Device Activation flow or configure GITHUB_CLIENT_SECRET.</p>
          <script>
            if (window.opener) {
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
        </body>
      </html>
    `);
    return;
  }

  try {
    const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: DEFAULT_GITHUB_WEB_CLIENT_ID,
        client_secret: clientSecret,
        code,
      }),
    });
    const tokenData = (await tokenResp.json()) as { access_token?: string };
    const accessToken = tokenData.access_token || '';
    let username = 'fushback';

    if (accessToken) {
      const userResp = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Gridario-App',
        },
      });
      const userJson = (await userResp.json()) as { login?: string };
      if (userJson.login) username = userJson.login;
      cachedGitHubToken = accessToken;
      cachedGitHubUsername = username;
      saveCachedGitHubAuth(cachedGitHubToken, cachedGitHubUsername);
    }

    res.send(`
      <html>
        <body style="font-family: system-ui, sans-serif; padding: 24px;">
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: 'OAUTH_AUTH_SUCCESS',
                accessToken: ${JSON.stringify(accessToken)},
                username: ${JSON.stringify(username)}
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>GitHub authentication successful. This window will close automatically.</p>
        </body>
      </html>
    `);
  } catch {
    res.status(500).send('OAuth callback failed.');
  }
});

/**
 * POST /api/github/device-code — initiates GitHub OAuth Device Flow so the user can authorize GitHub in browser
 */
app.post('/api/github/device-code', async (_req: Request, res: Response) => {
  try {
    const resp = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'GridPulse-App',
      },
      body: JSON.stringify({
        client_id: GITHUB_DEVICE_FLOW_CLIENT_ID,
        scope: 'repo',
      }),
    });
    const rawText = await resp.text();
    let data: {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    } = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      const params = new URLSearchParams(rawText);
      data = {
        device_code: params.get('device_code') || undefined,
        user_code: params.get('user_code') || undefined,
        verification_uri: params.get('verification_uri') || undefined,
        interval: Number(params.get('interval') || 5),
        error: params.get('error') || undefined,
        error_description: params.get('error_description') || undefined,
      };
    }

    if (!resp.ok || !data.device_code) {
      res.status(200).json({
        error: data.error_description || data.error || 'Could not start GitHub Device Flow.',
      });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({
      error: err instanceof Error ? err.message : 'Failed to contact GitHub OAuth server.',
    });
  }
});

const GITHUB_AUTH_CACHE_FILE = join(process.cwd(), '.github-auth-cache.json');

function loadCachedGitHubAuth(): { token: string; username: string } {
  if (process.env['GITHUB_TOKEN']) {
    return { token: process.env['GITHUB_TOKEN'], username: '' };
  }
  try {
    if (existsSync(GITHUB_AUTH_CACHE_FILE)) {
      const parsed = JSON.parse(readFileSync(GITHUB_AUTH_CACHE_FILE, 'utf-8')) as {
        token?: string;
        username?: string;
      };
      return {
        token: parsed.token || '',
        username: parsed.username || '',
      };
    }
  } catch {
    // Ignore read error
  }
  return { token: '', username: '' };
}

function saveCachedGitHubAuth(token: string, username: string): void {
  try {
    writeFileSync(GITHUB_AUTH_CACHE_FILE, JSON.stringify({ token, username }, null, 2), 'utf-8');
  } catch {
    // Ignore write error
  }
}

const initialGhAuth = loadCachedGitHubAuth();
let cachedGitHubToken = initialGhAuth.token;
let cachedGitHubUsername = initialGhAuth.username;

/**
 * Helper to parse a repo input such as:
 * - "https://github.com/fushback/Grid.git"
 * - "https://github.com/fushback/Grid"
 * - "fushback/Grid"
 * - "Grid"
 */
function parseGitHubRepoInput(
  rawInput: string,
  fallbackOwner: string
): { owner: string; repo: string } {
  const trimmed = (rawInput || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { owner: fallbackOwner || 'fushback', repo: 'Grid' };
  }

  // Match full URL: https://github.com/owner/repo(.git)
  const urlMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1].trim(),
      repo: urlMatch[2].trim(),
    };
  }

  // Match owner/repo(.git)
  const slashMatch = trimmed.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (slashMatch) {
    return {
      owner: slashMatch[1].trim(),
      repo: slashMatch[2].trim(),
    };
  }

  // Plain repo name
  const cleanName =
    trimmed
      .replace(/\.git$/i, '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-') || 'Grid';
  return { owner: fallbackOwner || 'fushback', repo: cleanName };
}

/**
 * GET /api/github/status — returns cached GitHub authorization status if already connected
 */
app.get('/api/github/status', (_req: Request, res: Response) => {
  res.status(200).json({
    authorized: Boolean(cachedGitHubToken),
    username: cachedGitHubUsername || (cachedGitHubToken ? 'fushback' : ''),
    accessToken: cachedGitHubToken || '',
    defaultRepoUrl: 'https://github.com/fushback/Grid.git',
  });
});

/**
 * POST /api/github/device-poll — polls GitHub OAuth Device Flow for access_token after user authorizes
 */
app.post('/api/github/device-poll', async (req: Request, res: Response) => {
  try {
    const { deviceCode } = (req.body || {}) as { deviceCode?: string };
    if (!deviceCode) {
      res.status(200).json({ status: 'error', message: 'deviceCode is required' });
      return;
    }

    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Gridario-App',
      },
      body: JSON.stringify({
        client_id: GITHUB_DEVICE_FLOW_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const rawText = await resp.text();
    let data: {
      access_token?: string;
      error?: string;
      error_description?: string;
    } = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      const params = new URLSearchParams(rawText);
      data = {
        access_token: params.get('access_token') || undefined,
        error: params.get('error') || undefined,
        error_description: params.get('error_description') || undefined,
      };
    }

    if (data.access_token) {
      let loginName = 'fushback';
      try {
        const userResp = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${data.access_token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Gridario-App',
          },
        });
        const userJson = (await userResp.json()) as { login?: string };
        if (userJson?.login) {
          loginName = userJson.login;
        }
      } catch {
        // Fallback to default username if profile lookup fails
      }
      cachedGitHubToken = data.access_token;
      cachedGitHubUsername = loginName;
      saveCachedGitHubAuth(cachedGitHubToken, cachedGitHubUsername);
      res.status(200).json({
        status: 'authorized',
        accessToken: data.access_token,
        username: loginName,
      });
      return;
    }

    res.status(200).json({
      status: data.error || 'authorization_pending',
      message: data.error_description || 'Waiting for authorization on GitHub...',
    });
  } catch (err) {
    res.status(200).json({
      status: 'authorization_pending',
      message: err instanceof Error ? err.message : 'Waiting for GitHub response...',
    });
  }
});

/**
 * POST /api/github/create-and-push — commits & pushes all project files to an existing GitHub repository (such as https://github.com/fushback/Grid.git) or creates it if it doesn't exist
 */
app.post('/api/github/create-and-push', async (req: Request, res: Response) => {
  try {
    const {
      accessToken,
      repoName = 'https://github.com/fushback/Grid.git',
      description = 'Gridario Cloud Spreadsheet - Full-Stack Angular 21 + Serverless API (Vercel Ready)',
      commitMessage = 'Commit Gridario full-stack application',
      isPrivate = false,
    } = req.body as {
      accessToken?: string;
      repoName?: string;
      description?: string;
      commitMessage?: string;
      isPrivate?: boolean;
    };

    const effectiveToken = (accessToken || cachedGitHubToken || '').trim();
    if (!effectiveToken) {
      res.status(400).json({ error: 'Please authorize GitHub first to obtain an access token.' });
      return;
    }

    const ghHeaders = {
      Authorization: `Bearer ${effectiveToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Gridario-App',
    };

    // 1. Verify authenticated GitHub user
    const userResp = await fetch('https://api.github.com/user', { headers: ghHeaders });
    if (!userResp.ok) {
      res.status(401).json({ error: 'GitHub token is invalid or expired. Please re-authorize.' });
      return;
    }
    const userData = (await userResp.json()) as { login: string };
    const authUser = userData.login;
    cachedGitHubToken = effectiveToken;
    cachedGitHubUsername = authUser;
    saveCachedGitHubAuth(cachedGitHubToken, cachedGitHubUsername);

    const parsedRepo = parseGitHubRepoInput(repoName, authUser);
    let owner = parsedRepo.owner || authUser;
    const cleanRepoName = parsedRepo.repo;

    let defaultBranch = 'main';
    let repoHtmlUrl = `https://github.com/${owner}/${cleanRepoName}`;

    // 2. Check if the repository already exists first (e.g. https://github.com/fushback/Grid.git)
    const existingResp = await fetch(
      `https://api.github.com/repos/${owner}/${cleanRepoName}`,
      { headers: ghHeaders }
    );

    if (existingResp.ok) {
      const existingRepo = (await existingResp.json()) as {
        default_branch?: string;
        html_url?: string;
        owner?: { login?: string };
      };
      defaultBranch = existingRepo.default_branch || 'main';
      repoHtmlUrl = existingRepo.html_url || repoHtmlUrl;
      if (existingRepo.owner?.login) {
        owner = existingRepo.owner.login;
      }
    } else {
      // Repository does not exist yet — create it under the authenticated user
      owner = authUser;
      repoHtmlUrl = `https://github.com/${owner}/${cleanRepoName}`;
      const createResp = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          name: cleanRepoName,
          description,
          private: Boolean(isPrivate),
          auto_init: true,
        }),
      });

      if (!createResp.ok) {
        const errBody = (await createResp.json()) as { message?: string };
        res.status(400).json({
          error: errBody.message || `Could not access or create repository "${owner}/${cleanRepoName}".`,
        });
        return;
      }
      const createdRepo = (await createResp.json()) as {
        default_branch?: string;
        html_url?: string;
      };
      defaultBranch = createdRepo.default_branch || 'main';
      repoHtmlUrl = createdRepo.html_url || repoHtmlUrl;
    }

    // 3. Get latest commit SHA on defaultBranch (or initialize if the existing repository is completely empty, i.e., HTTP 409)
    let refResp = await fetch(
      `https://api.github.com/repos/${owner}/${cleanRepoName}/git/ref/heads/${defaultBranch}`,
      { headers: ghHeaders }
    );

    if (!refResp.ok) {
      // Existing repository is empty (0 commits) — bootstrap initial commit via Contents API so Git Data API works
      const initReadmeContent = Buffer.from(
        `# ${cleanRepoName}\n\n${description}\n`,
        'utf-8'
      ).toString('base64');

      const initResp = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/contents/README.md`,
        {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify({
            message: 'Initial repository bootstrap',
            content: initReadmeContent,
            branch: defaultBranch,
          }),
        }
      );

      if (!initResp.ok) {
        const initErr = (await initResp.json().catch(() => ({}))) as { message?: string };
        res.status(500).json({
          error:
            initErr.message ||
            `Could not initialize empty repository ${owner}/${cleanRepoName}.`,
        });
        return;
      }

      // Re-fetch branch reference now that the empty repo has an initial commit
      refResp = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/git/ref/heads/${defaultBranch}`,
        { headers: ghHeaders }
      );
      if (!refResp.ok) {
        res.status(500).json({
          error: 'Could not read repository branch reference after initializing empty repository.',
        });
        return;
      }
    }

    const refData = (await refResp.json()) as { object: { sha: string } };
    const baseCommitSha = refData.object.sha;

    // 4. Collect project files and build Git tree
    const files = collectProjectFiles(process.cwd());
    const treeItems = files.map((f) => ({
      path: f.path,
      mode: '100644',
      type: 'blob',
      content: f.content,
    }));

    const treeResp = await fetch(
      `https://api.github.com/repos/${owner}/${cleanRepoName}/git/trees`,
      {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          base_tree: baseCommitSha,
          tree: treeItems,
        }),
      }
    );

    if (!treeResp.ok) {
      const treeErr = (await treeResp.json()) as { message?: string };
      res.status(500).json({
        error: treeErr.message || 'Failed to upload project files to GitHub tree.',
      });
      return;
    }
    const treeData = (await treeResp.json()) as { sha: string };

    // 5. Create commit
    const finalCommitMsg =
      (commitMessage || '').trim() || 'Commit Gridario full-stack application';
    const commitResp = await fetch(
      `https://api.github.com/repos/${owner}/${cleanRepoName}/git/commits`,
      {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          message: finalCommitMsg,
          tree: treeData.sha,
          parents: [baseCommitSha],
        }),
      }
    );
    if (!commitResp.ok) {
      res.status(500).json({ error: 'Failed to create commit on GitHub.' });
      return;
    }
    const commitData = (await commitResp.json()) as { sha: string };

    // 6. Update branch ref
    const updateRefResp = await fetch(
      `https://api.github.com/repos/${owner}/${cleanRepoName}/git/refs/heads/${defaultBranch}`,
      {
        method: 'PATCH',
        headers: ghHeaders,
        body: JSON.stringify({
          sha: commitData.sha,
          force: true,
        }),
      }
    );
    if (!updateRefResp.ok) {
      res.status(500).json({ error: 'Failed to update branch reference on GitHub.' });
      return;
    }

    recordActivity(
      owner,
      '#ca8a04',
      'Committed to GitHub',
      `${finalCommitMsg} → ${owner}/${cleanRepoName} (${commitData.sha.slice(0, 7)})`
    );
    saveStateToDisk(cloudState);

    res.json({
      ok: true,
      owner,
      repoName: cleanRepoName,
      repoUrl: repoHtmlUrl,
      commitSha: commitData.sha,
      commitUrl: `${repoHtmlUrl}/commit/${commitData.sha}`,
      vercelCloneUrl: `https://vercel.com/new/clone?repository-url=${encodeURIComponent(repoHtmlUrl)}&project-name=${encodeURIComponent(cleanRepoName.toLowerCase())}`,
      filesUploaded: files.length,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unexpected error pushing to GitHub.',
    });
  }
});

/**
 * POST /api/vercel/deploy — deploys the full-stack Angular 21 + Serverless API directly to Vercel
 * (No separate .NET API URL required — Vercel hosts both the Angular UI and /api/* endpoints)
 */
app.post('/api/vercel/deploy', async (req: Request, res: Response) => {
  try {
    const {
      vercelToken,
      projectName = 'gridpulse-cloud-app',
    } = req.body as {
      vercelToken?: string;
      projectName?: string;
    };

    const token = (vercelToken || process.env['VERCEL_TOKEN'] || '').trim();
    if (!token) {
      res.status(400).json({
        error:
          'Please enter a Vercel Access Token (from https://vercel.com/account/tokens) or push to GitHub first and click "1-Click Import to Vercel".',
      });
      return;
    }

    const cleanProjectName =
      projectName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'gridpulse-cloud-app';

    // Collect project files (excluding dotnet-backend so Vercel builds the self-contained Angular + Serverless API bundle)
    const allFiles = collectProjectFiles(process.cwd()).filter(
      (f) => !f.path.startsWith('dotnet-backend/')
    );

    const vercelFiles = allFiles.map((f) => ({
      file: f.path,
      data: f.content,
    }));

    const deployResp = await fetch('https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanProjectName,
        files: vercelFiles,
        projectSettings: {
          framework: null,
          installCommand: 'npm install',
          buildCommand: 'npm run build',
          outputDirectory: 'dist/app/browser',
        },
        target: 'production',
      }),
    });

    const deployData = (await deployResp.json()) as {
      id?: string;
      url?: string;
      inspectorUrl?: string;
      error?: { message?: string };
    };

    if (!deployResp.ok || !deployData.url) {
      res.status(400).json({
        error:
          deployData.error?.message ||
          'Failed to create deployment on Vercel. Please verify your Vercel token.',
      });
      return;
    }

    const liveUrl = deployData.url.startsWith('http')
      ? deployData.url
      : `https://${deployData.url}`;

    res.json({
      ok: true,
      deploymentId: deployData.id,
      deploymentUrl: liveUrl,
      inspectorUrl: deployData.inspectorUrl || liveUrl,
      filesDeployed: vercelFiles.length,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unexpected error deploying to Vercel.',
    });
  }
});


/**
 * POST /api/workspace/presence — updates real-time collaborator cursor & active cell focus
 */
app.post('/api/workspace/presence', (req: Request, res: Response) => {
  const body = req.body as Partial<ServerPresence>;
  if (!body || !body.userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  const presenceItem: ServerPresence = {
    userId: String(body.userId).slice(0, 128),
    displayName: String(body.displayName || 'Collaborator').slice(0, 80),
    color: String(body.color || '#2563eb').slice(0, 16),
    isAnonymous: Boolean(body.isAnonymous),
    activeRowId: String(body.activeRowId || '').slice(0, 128),
    activeColId: String(body.activeColId || '').slice(0, 128),
    updatedAt: new Date().toISOString(),
  };

  cloudState.presence[presenceItem.userId] = presenceItem;
  broadcastEvent('presence', {
    presence: Object.values(cloudState.presence),
  });

  res.json({ ok: true, presence: Object.values(cloudState.presence) });
});

/**
 * POST /api/workspace/sync — applies authoritative workspace mutations and broadcasts to all collaborators
 */
app.post('/api/workspace/sync', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const {
    clientId,
    userName = 'Collaborator',
    userColor = '#ca8a04',
    actionType,
    actionDetail = '',
    databaseName,
    tableName,
    preserveActiveContext = false,
    workspaceName,
    columns,
    rows,
    deletedRowIds,
    defaultUpdatedColIds,
    applyDefaultToAllRowsForColId,
    renamedColumns,
    replaceAllRows = false,
    appendSampleCount,
  } = req.body as {
    clientId?: string;
    userName?: string;
    userColor?: string;
    actionType: string;
    actionDetail?: string;
    databaseName?: string;
    tableName?: string;
    preserveActiveContext?: boolean;
    workspaceName?: string;
    columns?: ServerColumn[];
    rows?: ServerRow[];
    deletedRowIds?: string[];
    defaultUpdatedColIds?: string[];
    applyDefaultToAllRowsForColId?: string;
    renamedColumns?: { oldName: string; newName: string }[];
    replaceAllRows?: boolean;
    appendSampleCount?: number;
  };

  const nowIso = new Date().toISOString();
  cloudState.updatedAt = nowIso;
  ensureDatabasesHierarchy(cloudState);
  const prevActiveDbName = cloudState.activeDatabaseName || cloudState.databases[0].databaseName;
  const prevActiveTableName = cloudState.activeTableName || '';

  const targetDb = preserveActiveContext
    ? findDatabase(cloudState, databaseName)
    : getTargetDatabase(cloudState, databaseName);
  targetDb.updatedAt = nowIso;
  const targetTable = preserveActiveContext
    ? findTable(targetDb, tableName)
    : getTargetTable(cloudState, tableName, targetDb.databaseName);

  if (!targetTable) {
    if (preserveActiveContext) {
      getTargetDatabase(cloudState, prevActiveDbName);
      getTargetTable(cloudState, prevActiveTableName, prevActiveDbName);
    }
    saveStateToDisk(cloudState);
    res.json({
      ok: true,
      activeDatabaseName: cloudState.activeDatabaseName,
      databases: getDatabaseSummaries(cloudState),
      activeTableName: cloudState.activeTableName,
      tables: getTableSummaries(cloudState),
      updatedAt: cloudState.updatedAt,
      totalRows: 0,
      activities: cloudState.activities,
    });
    return;
  }

  targetTable.updatedAt = nowIso;

  let syncAddedColumnNames: string[] = [];
  let syncDeletedColumnNames: string[] = [];
  let syncRenamedCols: { oldName: string; newName: string }[] = [];

  if (actionType === 'generate_bulk_rows' && typeof appendSampleCount === 'number') {
    const countToAdd = Math.max(1, Math.min(2000, appendSampleCount));
    if (targetTable.columns.length === 0) {
      targetTable.allowEmptyColumns = false;
      targetTable.columns = ensurePrimaryKeyIdentityColumn([]);
    }
    const generated = generateSampleRows(countToAdd, targetTable.rows.length);
    for (const r of generated) {
      for (const col of targetTable.columns) {
        if (!(col.name in r.cells) && !(col.id in r.cells) && col.colType !== 'formula') {
          const defVal = resolveServerColumnDefaultValue(col);
          r.cells[col.name] = defVal;
          r.cells[col.id] = defVal;
        }
      }
    }
    targetTable.rows = sanitizeRowsAgainstSchema(targetTable.columns, [
      ...targetTable.rows,
      ...generated,
    ]);
    recordActivity(
      userName,
      userColor,
      'Bulk Dataset Generated',
      `Appended ${countToAdd} rows to "${targetDb.databaseName}.${targetTable.tableName}" (${targetTable.rows.length} total)`
    );
  } else if (actionType === 'reset_workspace') {
    targetTable.allowEmptyColumns = false;
    targetTable.columns = ensurePrimaryKeyIdentityColumn(buildDefaultColumns());
    targetTable.rows = sanitizeRowsAgainstSchema(targetTable.columns, generateSampleRows(150, 0));
    recordActivity(
      userName,
      userColor,
      'Table Reset',
      `Restored default template in "${targetDb.databaseName}.${targetTable.tableName}" with 150 rows`
    );
  } else {
    if (typeof workspaceName === 'string' && workspaceName.trim().length > 0 && !preserveActiveContext) {
      const nextTableName = workspaceName.trim().slice(0, 80);
      if (
        nextTableName.toLowerCase() !== targetTable.tableName.toLowerCase() &&
        !targetDb.tables.some(
          (t) => t !== targetTable && t.tableName.toLowerCase() === nextTableName.toLowerCase()
        )
      ) {
        await dropTableFromRealDatabase(targetTable.tableName, targetDb.databaseName);
        targetTable.tableName = nextTableName;
        targetDb.activeTableName = nextTableName;
        cloudState.activeTableName = nextTableName;
      }
      cloudState.workspaceName = targetTable.tableName;
    }

    const prevColumnsSnapshot = [...targetTable.columns];
    const prevColsById = new Map<string, ServerColumn>();
    for (const oldCol of targetTable.columns) {
      prevColsById.set(oldCol.id.toLowerCase(), oldCol);
      prevColsById.set(oldCol.name.toLowerCase(), oldCol);
    }

    syncRenamedCols = Array.isArray(renamedColumns)
      ? renamedColumns
          .map((p) => ({
            oldName: String(p?.oldName || '').trim(),
            newName: String(p?.newName || '').trim(),
          }))
          .filter((p) => p.oldName && p.newName && p.oldName !== p.newName)
      : [];

    const colsRequiringFullTableDefaultUpdate = new Set<string>(
      (defaultUpdatedColIds || []).map((id) => id.toLowerCase())
    );
    if (
      typeof applyDefaultToAllRowsForColId === 'string' &&
      applyDefaultToAllRowsForColId.trim().length > 0
    ) {
      colsRequiringFullTableDefaultUpdate.add(applyDefaultToAllRowsForColId.trim().toLowerCase());
    }

    if (syncRenamedCols.length > 0) {
      for (const row of targetTable.rows) {
        if (!row.cells) continue;
        for (const pair of syncRenamedCols) {
          const oldKey = pair.oldName;
          const newKey = pair.newName;
          if (row.cells[oldKey] !== undefined) {
            row.cells[newKey] = row.cells[oldKey];
            delete row.cells[oldKey];
          }
        }
      }
    }

    if (Array.isArray(columns)) {
      targetTable.allowEmptyColumns = false;
      targetTable.columns = ensurePrimaryKeyIdentityColumn(columns);

      const oldColNamesLower = new Set(
        prevColumnsSnapshot.map((c) => c.name.toLowerCase())
      );
      const renamedNewLower = new Set(
        syncRenamedCols.map((r) => r.newName.toLowerCase())
      );
      const renamedOldLower = new Set(
        syncRenamedCols.map((r) => r.oldName.toLowerCase())
      );
      syncAddedColumnNames = targetTable.columns
        .filter(
          (c) =>
            c.colType !== 'lookup' &&
            !oldColNamesLower.has(c.name.toLowerCase()) &&
            !renamedNewLower.has(c.name.toLowerCase())
        )
        .map((c) => c.name);
      const newColNamesLower = new Set(
        targetTable.columns.map((c) => c.name.toLowerCase())
      );
      syncDeletedColumnNames = prevColumnsSnapshot
        .filter(
          (c) =>
            !newColNamesLower.has(c.name.toLowerCase()) &&
            !renamedOldLower.has(c.name.toLowerCase())
        )
        .map((c) => c.name);

      // Only apply default across all rows automatically for newly created columns
      // (existing columns only overwrite all rows when applyDefaultToAllRowsForColId / defaultUpdatedColIds is explicitly sent)
      for (const col of targetTable.columns) {
        if (col.isPrimaryKey || col.isIdentity || col.colType === 'formula') continue;
        const prevCol =
          prevColsById.get(col.id.toLowerCase()) || prevColsById.get(col.name.toLowerCase());
        const nextDef = String(col.defaultValue ?? '').trim();
        if (!prevCol && nextDef.length > 0) {
          colsRequiringFullTableDefaultUpdate.add(col.id.toLowerCase());
          colsRequiringFullTableDefaultUpdate.add(col.name.toLowerCase());
        }
      }
    }

    if (Array.isArray(deletedRowIds) && deletedRowIds.length > 0) {
      const delSet = new Set(deletedRowIds);
      targetTable.rows = targetTable.rows.filter((r) => !delSet.has(r.id));
    }

    if (targetTable.columns.length > 0) {
      if (Array.isArray(rows)) {
        if (replaceAllRows) {
          targetTable.rows = sanitizeRowsAgainstSchema(targetTable.columns, rows);
        } else {
          const byId = new Map<string, ServerRow>(targetTable.rows.map((r) => [r.id, r]));
          for (const incoming of rows) {
            byId.set(incoming.id, incoming);
          }
          targetTable.rows = sanitizeRowsAgainstSchema(
            targetTable.columns,
            Array.from(byId.values()).sort((a, b) => a.orderIndex - b.orderIndex)
          );
        }
      } else {
        targetTable.rows = sanitizeRowsAgainstSchema(targetTable.columns, targetTable.rows);
      }

      // Apply created or updated column default value across ALL rows in the database table (UPDATE table SET col = default)
      if (colsRequiringFullTableDefaultUpdate.size > 0 && targetTable.rows.length > 0) {
        for (const col of targetTable.columns) {
          if (col.isPrimaryKey || col.isIdentity || col.colType === 'formula') continue;
          if (
            colsRequiringFullTableDefaultUpdate.has(col.id.toLowerCase()) ||
            colsRequiringFullTableDefaultUpdate.has(col.name.toLowerCase())
          ) {
            const resolvedDef = resolveServerColumnDefaultValue(col);
            for (const dbRow of targetTable.rows) {
              dbRow.cells[col.name] = resolvedDef;
              dbRow.cells[col.id] = resolvedDef;
              dbRow.updatedAt = nowIso;
            }
          }
        }
        targetTable.rows = sanitizeRowsAgainstSchema(targetTable.columns, targetTable.rows);
      }
    }

    if (actionType) {
      recordActivity(userName, userColor, actionType, actionDetail);
    }
  }

  targetTable.nextIdentityValue = computeNextIdentityValue(targetTable.columns, targetTable.rows);
  syncAllLinkedLookupColumnsInState(cloudState, {
    databaseName: targetDb.databaseName,
    mutatedTableName: targetTable.tableName,
    renamedColumns: syncRenamedCols,
    addedColumnNames: syncAddedColumnNames,
    deletedColumnNames: syncDeletedColumnNames,
  });
  await syncTableToRealDatabase(targetTable, targetDb.databaseName);
  for (const otherTbl of targetDb.tables) {
    if (
      otherTbl !== targetTable &&
      otherTbl.columns.some(
        (c) =>
          c.colType === 'lookup' &&
          (c.lookupTableName || '').toLowerCase() === targetTable.tableName.toLowerCase()
      )
    ) {
      await syncTableToRealDatabase(otherTbl, targetDb.databaseName);
    }
  }

  if (preserveActiveContext) {
    getTargetDatabase(cloudState, prevActiveDbName);
    getTargetTable(cloudState, prevActiveTableName, prevActiveDbName);
  } else {
    cloudState.columns = targetTable.columns;
    cloudState.rows = targetTable.rows;
  }

  await persistWorkspaceState(cloudState);
  const currentActiveDb = getTargetDatabase(cloudState, cloudState.activeDatabaseName);
  const currentActiveTbl = getTargetTable(
    cloudState,
    cloudState.activeTableName,
    currentActiveDb.databaseName
  );
  const activeSortedCols = currentActiveTbl
    ? [...currentActiveTbl.columns].sort((a, b) => a.orderIndex - b.orderIndex)
    : [];

  broadcastEvent('workspace_sync', {
    clientId,
    workspaceName: currentActiveTbl ? currentActiveTbl.tableName : currentActiveDb.databaseName,
    activeDatabaseName: currentActiveDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: currentActiveTbl ? currentActiveTbl.tableName : '',
    tables: getTableSummaries(cloudState, currentActiveDb),
    updatedAt: cloudState.updatedAt,
    columns: activeSortedCols,
    totalRows: currentActiveTbl ? currentActiveTbl.rows.length : 0,
    activities: cloudState.activities,
  });

  const returnRowLimit = Math.max(50, Array.isArray(rows) ? rows.length : 50);
  res.json({
    ok: true,
    activeDatabaseName: currentActiveDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    activeTableName: currentActiveTbl ? currentActiveTbl.tableName : '',
    tables: getTableSummaries(cloudState, currentActiveDb),
    columns: activeSortedCols,
    rows: currentActiveTbl ? currentActiveTbl.rows.slice(0, returnRowLimit) : [],
    updatedAt: cloudState.updatedAt,
    totalRows: currentActiveTbl ? currentActiveTbl.rows.length : 0,
    activities: cloudState.activities,
  });
});

/**
 * ============================================================================
 * COMPONENT A & B: REAL-TIME WEBSOCKET HUB + IN-MEMORY REDIS WRITE-BEHIND BUFFER
 * & ASYNCHRONOUS BACKGROUND POSTGRESQL BULK FLUSH WORKER
 * ============================================================================
 */
interface RealtimeCellDelta {
  mutationId: string;
  databaseName: string;
  tableName: string;
  rowId: string;
  columnId: string;
  rawValue: string | null;
  userId: string;
  userName: string;
  userColor: string;
  clientTimestampMs: number;
}

interface RealtimeCellAck {
  mutationId: string;
  accepted: boolean;
  databaseName: string;
  tableName: string;
  rowId: string;
  columnId: string;
  authoritativeValue: string | null;
  authoritativeTimestampMs: number;
  updatedBy: string;
}

interface WriteBehindBufferStatus {
  dirtyRowCount: number;
  pendingDdlCount: number;
  totalCoalescedEdits: number;
  totalPostgresBulkFlushes: number;
  oldestDirtyTimestampMs: number | null;
  lastFlushedAt: string | null;
  flushIntervalSeconds: number;
  bufferThresholdRows: number;
}

// Atomic Last-Write-Wins (LWW) cell timestamp ledger ("dbLower|tableLower|rowId|colIdLower" -> timestampMs)
const cellLwwTimestamps = new Map<string, number>();

function getWriteBehindBufferStatus(): WriteBehindBufferStatus {
  let oldest: number | null = null;
  for (const entry of writeBehindDirtyRows.values()) {
    if (oldest === null || entry.timestampMs < oldest) {
      oldest = entry.timestampMs;
    }
  }
  for (const ddl of writeBehindDdlQueue) {
    if (oldest === null || ddl.timestampMs < oldest) {
      oldest = ddl.timestampMs;
    }
  }
  return {
    dirtyRowCount: writeBehindDirtyRows.size + writeBehindDdlQueue.length,
    pendingDdlCount: writeBehindDdlQueue.length,
    totalCoalescedEdits: writeBehindMetrics.totalCoalescedEdits,
    totalPostgresBulkFlushes: writeBehindMetrics.totalPostgresBulkFlushes,
    oldestDirtyTimestampMs: oldest,
    lastFlushedAt: writeBehindMetrics.lastFlushedAt,
    flushIntervalSeconds: writeBehindMetrics.flushIntervalSeconds,
    bufferThresholdRows: writeBehindMetrics.bufferThresholdRows,
  };
}

function coerceSingleCellValueForColumn(
  col: ServerColumn,
  rawInput: string | null | undefined,
  allCols: ServerColumn[],
  row: ServerRow
): string | number | boolean {
  const rawStr = rawInput === null || rawInput === undefined ? '' : String(rawInput);
  if (col.colType === 'checkbox') {
    const low = rawStr.trim().toLowerCase();
    return low === 'true' || low === '1' || low === 'yes';
  }
  if (col.colType === 'number') {
    const trimmed = rawStr.trim();
    if (!trimmed) return col.isNullable !== false ? '' : 0;
    const num = Number(trimmed.replace(/[$,%\s()]/g, ''));
    return Number.isFinite(num) ? num : 0;
  }
  if (col.colType === 'lookup') {
    const trimmed = rawStr.trim();
    if (!trimmed) return '';
    const rawOpts = (col.optionsCsv || '').trim();
    if (rawOpts.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawOpts);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const lowerTrimmed = trimmed.toLowerCase();
          const matchedObj = parsed.find((entry) => {
            if (!entry || typeof entry !== 'object') return false;
            const obj = entry as Record<string, unknown>;
            if (JSON.stringify(obj).toLowerCase() === lowerTrimmed) return true;
            for (const v of Object.values(obj)) {
              if (String(v ?? '').toLowerCase() === lowerTrimmed) return true;
            }
            return false;
          });
          if (matchedObj) {
            return JSON.stringify(matchedObj);
          }
        }
      } catch {
        // Fallback to raw trimmed string
      }
    }
    return trimmed;
  }
  if (col.colType === 'formula') {
    return evaluateServerFormula(col.formula, row, allCols);
  }
  return rawStr;
}

/**
 * Atomically applies a batch of cell deltas into the in-memory cache with LWW concurrency control,
 * queues dirty rows into the write-behind buffer, and broadcasts accepted deltas to connected peers.
 */
function processRealtimeCellDeltaBatch(deltas: RealtimeCellDelta[]): {
  acks: RealtimeCellAck[];
  acceptedDeltas: RealtimeCellDelta[];
  status: WriteBehindBufferStatus;
} {
  ensureDatabasesHierarchy(cloudState);
  const acks: RealtimeCellAck[] = [];
  const acceptedDeltas: RealtimeCellDelta[] = [];
  const mutatedTables = new Map<string, { db: ServerDatabase; table: ServerTable }>();

  for (const rawDelta of deltas) {
    if (!rawDelta || !rawDelta.rowId || !rawDelta.columnId) continue;

    const clientTs =
      typeof rawDelta.clientTimestampMs === 'number' && Number.isFinite(rawDelta.clientTimestampMs)
        ? rawDelta.clientTimestampMs
        : Date.now();

    const targetDb = findDatabase(cloudState, rawDelta.databaseName);
    const targetTable = findTable(targetDb, rawDelta.tableName);
    if (!targetTable) {
      acks.push({
        mutationId: rawDelta.mutationId || '',
        accepted: false,
        databaseName: targetDb.databaseName,
        tableName: rawDelta.tableName || '',
        rowId: rawDelta.rowId,
        columnId: rawDelta.columnId,
        authoritativeValue: null,
        authoritativeTimestampMs: Date.now(),
        updatedBy: 'Server',
      });
      continue;
    }

    const targetCol = targetTable.columns.find(
      (c) =>
        c.id.toLowerCase() === rawDelta.columnId.toLowerCase() ||
        c.name.toLowerCase() === rawDelta.columnId.toLowerCase()
    );
    const targetRow = targetTable.rows.find((r) => r.id === rawDelta.rowId);

    if (!targetCol || !targetRow || targetCol.isPrimaryKey || targetCol.isIdentity) {
      const existingVal =
        targetRow && targetCol
          ? (targetRow.cells[targetCol.name] ?? targetRow.cells[targetCol.id] ?? '')
          : '';
      acks.push({
        mutationId: rawDelta.mutationId || '',
        accepted: false,
        databaseName: targetDb.databaseName,
        tableName: targetTable.tableName,
        rowId: rawDelta.rowId,
        columnId: rawDelta.columnId,
        authoritativeValue: String(existingVal),
        authoritativeTimestampMs: Date.now(),
        updatedBy: targetRow?.updatedBy || 'Server',
      });
      continue;
    }

    const cellLwwKey = `${targetDb.databaseName.toLowerCase()}|${targetTable.tableName.toLowerCase()}|${targetRow.id}|${targetCol.id.toLowerCase()}`;
    const existingLwwTs = cellLwwTimestamps.get(cellLwwKey) ?? 0;

    // Atomic LWW Concurrency Check: reject out-of-order / stale writes
    if (clientTs < existingLwwTs) {
      const authoritativeVal =
        targetRow.cells[targetCol.name] !== undefined
          ? targetRow.cells[targetCol.name]
          : targetRow.cells[targetCol.id];
      acks.push({
        mutationId: rawDelta.mutationId || '',
        accepted: false,
        databaseName: targetDb.databaseName,
        tableName: targetTable.tableName,
        rowId: targetRow.id,
        columnId: targetCol.id,
        authoritativeValue: authoritativeVal !== undefined ? String(authoritativeVal) : '',
        authoritativeTimestampMs: existingLwwTs,
        updatedBy: targetRow.updatedBy || 'Collaborator',
      });
      continue;
    }

    // Apply winning cell mutation in-memory ONLY if the value actually changed (dirty check)
    const normalizedVal = coerceSingleCellValueForColumn(
      targetCol,
      rawDelta.rawValue,
      targetTable.columns,
      targetRow
    );
    const prevCellVal =
      targetRow.cells[targetCol.name] !== undefined
        ? targetRow.cells[targetCol.name]
        : targetRow.cells[targetCol.id];

    if (String(prevCellVal ?? '') === String(normalizedVal ?? '')) {
      // No-op edit: value is identical to current cached state; acknowledge without marking dirty
      acks.push({
        mutationId: rawDelta.mutationId || '',
        accepted: true,
        databaseName: targetDb.databaseName,
        tableName: targetTable.tableName,
        rowId: targetRow.id,
        columnId: targetCol.id,
        authoritativeValue: String(normalizedVal),
        authoritativeTimestampMs: existingLwwTs || clientTs,
        updatedBy: targetRow.updatedBy || rawDelta.userName || 'Collaborator',
      });
      continue;
    }

    targetRow.cells[targetCol.name] = normalizedVal;
    targetRow.cells[targetCol.id] = normalizedVal;

    // Re-evaluate any formula columns on this row in memory
    for (const fCol of targetTable.columns) {
      if (fCol.colType === 'formula') {
        const fVal = evaluateServerFormula(fCol.formula, targetRow, targetTable.columns);
        targetRow.cells[fCol.name] = fVal;
        targetRow.cells[fCol.id] = fVal;
      }
    }

    const updatedIso = new Date(clientTs).toISOString();
    targetRow.updatedBy = rawDelta.userName || 'Collaborator';
    targetRow.updatedAt = updatedIso;
    targetTable.updatedAt = updatedIso;
    targetDb.updatedAt = updatedIso;
    cloudState.updatedAt = updatedIso;

    cellLwwTimestamps.set(cellLwwKey, clientTs);
    writeBehindMetrics.totalCoalescedEdits++;

    const tableKey = `${targetDb.databaseName.toLowerCase()}|${targetTable.tableName.toLowerCase()}`;
    const rowDirtyKey = `${tableKey}|${targetRow.id}`;
    writeBehindDirtyRows.set(rowDirtyKey, {
      databaseName: targetDb.databaseName,
      tableName: targetTable.tableName,
      rowId: targetRow.id,
      timestampMs: clientTs,
    });
    if (!writeBehindDirtyTables.has(tableKey)) {
      writeBehindDirtyTables.set(tableKey, {
        databaseName: targetDb.databaseName,
        tableName: targetTable.tableName,
        firstDirtyAtMs: clientTs,
      });
    }
    mutatedTables.set(tableKey, { db: targetDb, table: targetTable });

    const normalizedDelta: RealtimeCellDelta = {
      ...rawDelta,
      databaseName: targetDb.databaseName,
      tableName: targetTable.tableName,
      rowId: targetRow.id,
      columnId: targetCol.id,
      rawValue: String(normalizedVal),
      clientTimestampMs: clientTs,
    };
    acceptedDeltas.push(normalizedDelta);

    acks.push({
      mutationId: rawDelta.mutationId || '',
      accepted: true,
      databaseName: targetDb.databaseName,
      tableName: targetTable.tableName,
      rowId: targetRow.id,
      columnId: targetCol.id,
      authoritativeValue: String(normalizedVal),
      authoritativeTimestampMs: clientTs,
      updatedBy: targetRow.updatedBy,
    });
  }

  // Keep linked lookup columns in memory synchronized when a main table cell changes
  for (const { db, table } of mutatedTables.values()) {
    syncAllLinkedLookupColumnsInState(cloudState, {
      databaseName: db.databaseName,
      mutatedTableName: table.tableName,
    });
  }

  if (acceptedDeltas.length > 0) {
    // Fast local file checkpoint (no PostgreSQL network round-trip on keystroke)
    writeStateFilesToDiskOnly(cloudState);
  }

  const status = getWriteBehindBufferStatus();

  // Broadcast accepted deltas to WebSocket and SSE clients
  if (acceptedDeltas.length === 1) {
    broadcastEvent('cell_delta', acceptedDeltas[0]);
    broadcastWsFrameToGroup(
      acceptedDeltas[0].databaseName,
      acceptedDeltas[0].tableName,
      {
        type: 'ReceiveCellDelta',
        delta: acceptedDeltas[0],
        status,
      }
    );
  } else if (acceptedDeltas.length > 1) {
    broadcastEvent('cell_delta_batch', { deltas: acceptedDeltas });
    const first = acceptedDeltas[0];
    broadcastWsFrameToGroup(first.databaseName, first.tableName, {
      type: 'ReceiveCellDeltaBatch',
      deltas: acceptedDeltas,
      status,
    });
  }

  broadcastEvent('write_behind_status', status);

  // If write-behind buffer threshold is met, trigger asynchronous bulk flush to PostgreSQL immediately
  if (writeBehindDirtyRows.size >= writeBehindMetrics.bufferThresholdRows) {
    void flushWriteBehindBufferToPostgres('threshold');
  }

  return { acks, acceptedDeltas, status };
}

/**
 * Asynchronous Background Worker: Atomically drains queued DDL operations, dirty tables, and dirty rows
 * from the in-memory write-behind buffer and bulk-flushes them to PostgreSQL with exponential-backoff retry resiliency.
 */
async function flushWriteBehindBufferToPostgres(
  reason: 'periodic' | 'threshold' | 'manual' | 'shutdown' = 'periodic'
): Promise<WriteBehindBufferStatus> {
  if (
    writeBehindMetrics.isFlushing ||
    (writeBehindDirtyTables.size === 0 &&
      writeBehindDdlQueue.length === 0 &&
      !writeBehindMetadataDirty)
  ) {
    return getWriteBehindBufferStatus();
  }

  writeBehindMetrics.isFlushing = true;

  // Atomically claim current dirty batch so incoming edits during flush accumulate into a fresh batch
  const claimedDdls = writeBehindDdlQueue.splice(0, writeBehindDdlQueue.length);
  const claimedTables = Array.from(writeBehindDirtyTables.entries());
  const claimedRows = Array.from(writeBehindDirtyRows.entries());
  writeBehindDirtyTables.clear();
  writeBehindDirtyRows.clear();
  writeBehindMetadataDirty = false;

  try {
    await ensurePostgresHydrated();

    const maxAttempts = 3;
    let attempt = 0;
    let flushedSuccess = false;

    while (attempt < maxAttempts && !flushedSuccess) {
      attempt++;
      try {
        // 1. Execute queued Sidebar Tree / Schema DDL tasks in chronological order
        for (const ddl of claimedDdls) {
          if (ddl.type === 'create_database') {
            await execCreateDatabaseInPostgres(ddl.databaseName);
          } else if (ddl.type === 'rename_database' && ddl.newDatabaseName) {
            await execRenameDatabaseInPostgres(ddl.databaseName, ddl.newDatabaseName);
          } else if (ddl.type === 'drop_database') {
            await execDropDatabaseFromPostgres(ddl.databaseName);
          } else if (ddl.type === 'drop_table' && ddl.tableName) {
            await execDropTableFromPostgres(ddl.tableName, ddl.databaseName);
          }
        }

        // 2. Bulk-flush dirty tables and rows to PostgreSQL
        for (const [, item] of claimedTables) {
          const db = findDatabase(cloudState, item.databaseName);
          const tbl = findTable(db, item.tableName);
          if (tbl) {
            await execSyncTableToPostgres(tbl, db.databaseName);
            // Also flush any lookup-dependent tables in the same database
            for (const otherTbl of db.tables) {
              if (
                otherTbl !== tbl &&
                otherTbl.columns.some(
                  (c) =>
                    c.colType === 'lookup' &&
                    (c.lookupTableName || '').toLowerCase() === tbl.tableName.toLowerCase()
                )
              ) {
                await execSyncTableToPostgres(otherTbl, db.databaseName);
              }
            }
          }
        }

        // 3. Persist authoritative workspace metadata snapshot to PostgreSQL
        await persistWorkspaceState(cloudState, true);
        flushedSuccess = true;
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
        }
      }
    }

    if (flushedSuccess) {
      writeBehindMetrics.totalPostgresBulkFlushes++;
      writeBehindMetrics.lastFlushedAt = new Date().toISOString();
      recordActivity(
        'Write-Behind Worker',
        '#0d9488',
        'PostgreSQL Bulk Flush',
        `Flushed ${claimedRows.length} dirty row(s), ${claimedTables.length} table(s), and ${claimedDdls.length} DDL op(s) to PostgreSQL (${reason} trigger)`
      );
    } else {
      // Dead-letter recovery: re-queue claimed records if PostgreSQL was unreachable after retries
      writeBehindDdlQueue.unshift(...claimedDdls);
      for (const [k, v] of claimedTables) {
        if (!writeBehindDirtyTables.has(k)) {
          writeBehindDirtyTables.set(k, v);
        }
      }
      for (const [k, v] of claimedRows) {
        if (!writeBehindDirtyRows.has(k)) {
          writeBehindDirtyRows.set(k, v);
        }
      }
      writeBehindMetadataDirty = true;
    }
  } finally {
    writeBehindMetrics.isFlushing = false;
  }

  const updatedStatus = getWriteBehindBufferStatus();
  broadcastEvent('write_behind_status', updatedStatus);
  broadcastWsFrameToAll({
    type: 'WriteBehindStatus',
    status: updatedStatus,
  });
  return updatedStatus;
}

// Start periodic background write-behind flush timer (every 2 minutes)
const writeBehindIntervalId = setInterval(() => {
  if (
    writeBehindDirtyTables.size > 0 ||
    writeBehindDdlQueue.length > 0 ||
    writeBehindMetadataDirty
  ) {
    void flushWriteBehindBufferToPostgres('periodic');
  }
}, writeBehindMetrics.flushIntervalSeconds * 1000);
writeBehindIntervalId.unref?.();

/**
 * Unified Real-Time CRUD Command Executor for Sidebar Tree (Databases, Tables, Fields) & Grid Operations.
 * Executes against the in-memory Redis-grade cache and queues PostgreSQL persistence into the Write-Behind Buffer.
 */
async function executeRealtimeCrudCommand(
  crudAction: string,
  payload: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const routeKeyMap: Record<string, { method: 'GET' | 'POST'; path: string }> = {
    get_workspace: { method: 'GET', path: '/api/workspace' },
    get_tree: { method: 'GET', path: '/api/workspace/tree' },
    query_rows: { method: 'POST', path: '/api/workspace/query' },
    create_database: { method: 'POST', path: '/api/workspace/databases' },
    delete_database: { method: 'POST', path: '/api/workspace/databases/delete' },
    rename_database: { method: 'POST', path: '/api/workspace/databases/rename' },
    create_table: { method: 'POST', path: '/api/workspace/tables' },
    delete_table: { method: 'POST', path: '/api/workspace/tables/delete' },
    rename_or_edit_table: { method: 'POST', path: '/api/workspace/tables/rename' },
    workspace_sync: { method: 'POST', path: '/api/workspace/sync' },
    restore_version: { method: 'POST', path: '/api/workspace/versions/restore' },
    presence: { method: 'POST', path: '/api/workspace/presence' },
  };

  const routeInfo = routeKeyMap[crudAction];
  if (!routeInfo) {
    return { ok: false, error: `Unsupported CRUD action: ${crudAction}` };
  }

  const handler = registeredRouteHandlers.get(`${routeInfo.method}:${routeInfo.path}`);
  if (!handler) {
    return { ok: false, error: `Handler not registered for ${routeInfo.method}:${routeInfo.path}` };
  }

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const syntheticReq = {
      method: routeInfo.method,
      path: routeInfo.path,
      query: routeInfo.method === 'GET' ? payload : {},
      body: routeInfo.method === 'POST' ? payload : {},
      headers: {},
    } as unknown as Request;

    const syntheticResObj = {
      statusCode: 200,
      status(code: number) {
        syntheticResObj.statusCode = code;
        return syntheticResObj;
      },
      json(data: unknown) {
        resolve((data && typeof data === 'object' ? data : { ok: true, data }) as Record<string, unknown>);
        return syntheticResObj;
      },
      send(data: unknown) {
        resolve((data && typeof data === 'object' ? data : { ok: true, data }) as Record<string, unknown>);
        return syntheticResObj;
      },
    };
    const syntheticRes = syntheticResObj as unknown as Response;

    Promise.resolve(handler(syntheticReq, syntheticRes)).catch(reject);
  });

  const status = getWriteBehindBufferStatus();
  const isMutating =
    crudAction !== 'get_workspace' &&
    crudAction !== 'get_tree' &&
    crudAction !== 'query_rows' &&
    crudAction !== 'presence';

  if (isMutating) {
    broadcastEvent('write_behind_status', status);
    broadcastWsFrameToAll({
      type: 'WriteBehindStatus',
      status,
    });
    if (status.dirtyRowCount >= writeBehindMetrics.bufferThresholdRows) {
      void flushWriteBehindBufferToPostgres('threshold');
    }
  }

  return {
    ...result,
    writeBehindStatus: status,
  };
}

/**
 * POST /api/realtime/crud — Multiplexed Real-Time CRUD endpoint for Sidebar Tree & Grid operations
 */
app.post('/api/realtime/crud', async (req: Request, res: Response) => {
  try {
    const { crudAction = '', payload = {} } = (req.body || {}) as {
      crudAction?: string;
      payload?: Record<string, unknown>;
    };
    const result = await executeRealtimeCrudCommand(crudAction, payload);
    res.json({
      ok: result['ok'] !== false,
      result,
      status: getWriteBehindBufferStatus(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Realtime CRUD execution failed.',
      status: getWriteBehindBufferStatus(),
    });
  }
});

/**
 * POST /api/realtime/delta — Multiplexed delta stream endpoint for single or batched cell mutations
 */
app.post('/api/realtime/delta', async (req: Request, res: Response) => {
  await ensurePostgresHydrated();
  const body = (req.body || {}) as {
    delta?: RealtimeCellDelta;
    deltas?: RealtimeCellDelta[];
  };
  const list: RealtimeCellDelta[] = Array.isArray(body.deltas)
    ? body.deltas
    : body.delta
    ? [body.delta]
    : [];

  const result = processRealtimeCellDeltaBatch(list);
  res.json({
    ok: true,
    acks: result.acks,
    status: result.status,
  });
});

/**
 * POST /api/realtime/flush — Immediately triggers the background write-behind worker to flush dirty rows to PostgreSQL
 */
app.post('/api/realtime/flush', async (_req: Request, res: Response) => {
  const status = await flushWriteBehindBufferToPostgres('manual');
  res.json({
    ok: true,
    status,
  });
});

/**
 * GET /api/realtime/status — Returns current Redis write-behind buffer metrics and flush status
 */
app.get('/api/realtime/status', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    status: getWriteBehindBufferStatus(),
  });
});

// ============================================================================
// NATIVE RFC 6455 WEBSOCKET UPGRADE HUB (/api/realtime-ws)
// ============================================================================
interface ConnectedWsClient {
  socket: Duplex;
  groupKey: string;
}

const wsClients = new Set<ConnectedWsClient>();

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendWsJson(client: ConnectedWsClient, data: unknown): void {
  try {
    const frame = encodeWsTextFrame(JSON.stringify(data));
    client.socket.write(frame);
  } catch {
    wsClients.delete(client);
  }
}

function broadcastWsFrameToGroup(
  databaseName: string,
  tableName: string,
  data: unknown,
  excludeClient?: ConnectedWsClient
): void {
  const targetGroup = `${(databaseName || '').toLowerCase()}|${(tableName || '').toLowerCase()}`;
  for (const client of wsClients) {
    if (client === excludeClient) continue;
    if (!client.groupKey || client.groupKey === targetGroup) {
      sendWsJson(client, data);
    }
  }
}

function broadcastWsFrameToAll(data: unknown): void {
  for (const client of wsClients) {
    sendWsJson(client, data);
  }
}

function handleIncomingWsMessage(client: ConnectedWsClient, rawText: string): void {
  try {
    const msg = JSON.parse(rawText) as {
      type?: string;
      invocationId?: string;
      databaseName?: string;
      tableName?: string;
      crudAction?: string;
      payload?: Record<string, unknown>;
      delta?: RealtimeCellDelta;
      deltas?: RealtimeCellDelta[];
    };
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'JoinTableGroup') {
      client.groupKey = `${(msg.databaseName || '').toLowerCase()}|${(msg.tableName || '').toLowerCase()}`;
      sendWsJson(client, {
        type: 'WriteBehindStatus',
        status: getWriteBehindBufferStatus(),
      });
      return;
    }

    if (msg.type === 'LeaveTableGroup') {
      client.groupKey = '';
      return;
    }

    if (msg.type === 'ExecuteCrudCommand' && msg.crudAction) {
      void executeRealtimeCrudCommand(msg.crudAction, msg.payload || {}).then((result) => {
        sendWsJson(client, {
          type: 'CrudCommandAck',
          invocationId: msg.invocationId,
          result,
          status: getWriteBehindBufferStatus(),
        });
      });
      return;
    }

    if (msg.type === 'StreamCellDelta' && msg.delta) {
      const result = processRealtimeCellDeltaBatch([msg.delta]);
      sendWsJson(client, {
        type: 'CellAck',
        invocationId: msg.invocationId,
        ack: result.acks[0],
        acks: result.acks,
        status: result.status,
      });
      return;
    }

    if (msg.type === 'StreamCellDeltaBatch' && Array.isArray(msg.deltas)) {
      const result = processRealtimeCellDeltaBatch(msg.deltas);
      sendWsJson(client, {
        type: 'CellBatchAck',
        invocationId: msg.invocationId,
        acks: result.acks,
        status: result.status,
      });
    }
  } catch {
    // Ignore malformed WebSocket frame
  }
}

function upgradeToRealtimeWebSocket(req: IncomingMessage, socket: Duplex): void {
  const key = req.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
    socket.destroy();
    return;
  }

  const acceptKey = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n',
  ];
  socket.write(responseHeaders.join('\r\n'));

  const client: ConnectedWsClient = {
    socket,
    groupKey: '',
  };
  wsClients.add(client);

  // Send initial write-behind buffer status
  sendWsJson(client, {
    type: 'WriteBehindStatus',
    status: getWriteBehindBufferStatus(),
  });

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLength = isMasked ? 4 : 0;
      const totalFrameLen = offset + maskLength + payloadLen;
      if (buffer.length < totalFrameLen) return;

      if (opcode === 0x08) {
        // Close frame
        wsClients.delete(client);
        socket.end();
        return;
      }

      if (opcode === 0x09) {
        // Ping -> Pong
        const pong = Buffer.from([0x8a, 0x00]);
        socket.write(pong);
      } else if (opcode === 0x01) {
        // Text frame
        const mask = isMasked ? buffer.subarray(offset, offset + 4) : null;
        const payloadOffset = offset + maskLength;
        const dataBuf = Buffer.from(
          buffer.subarray(payloadOffset, payloadOffset + payloadLen)
        );
        if (mask) {
          for (let i = 0; i < dataBuf.length; i++) {
            dataBuf[i] ^= mask[i % 4];
          }
        }
        handleIncomingWsMessage(client, dataBuf.toString('utf8'));
      }

      buffer = buffer.subarray(totalFrameLen);
    }
  });

  socket.on('close', () => {
    wsClients.delete(client);
  });

  socket.on('error', () => {
    wsClients.delete(client);
  });
}

// Intercept WebSocket upgrade requests on /api/realtime-ws before Angular SSR catch-all
app.use('/api', (req, _res, next) => {
  if (
    req.path === '/realtime-ws' &&
    req.headers.upgrade &&
    req.headers.upgrade.toLowerCase() === 'websocket'
  ) {
    upgradeToRealtimeWebSocket(req, req.socket);
    return;
  }
  next();
});

/**
 * GET /api/workspace/tree — returns authoritative databases, tables, and columns schema directly from the backend database without changing activeDatabaseName
 */
app.get('/api/workspace/tree', async (_req: Request, res: Response) => {
  await ensurePostgresHydrated();
  ensureDatabasesHierarchy(cloudState);
  const activeDb = findDatabase(cloudState, cloudState.activeDatabaseName);
  res.json({
    ok: true,
    activeDatabaseName: activeDb.databaseName,
    databases: getDatabaseSummaries(cloudState),
    tables: getTableSummaries(cloudState, activeDb),
    updatedAt: cloudState.updatedAt,
  });
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  })
);

/**
 * Ensure unmatched /api/* routes always return JSON instead of falling through to Angular SSR HTML
 */
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'API route not found' });
});

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

const server = createServer(app);
server.on('upgrade', (req, socket) => {
  if (req.url && req.url.startsWith('/api/realtime-ws')) {
    upgradeToRealtimeWebSocket(req, socket);
  }
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  server.listen(port, () => {
    console.log(`Node Express + Realtime WS server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);

