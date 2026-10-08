import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import {
  ColumnType,
  LookupItem,
  GridColumn,
  GridRow,
  DbTableSummary,
  DbDatabaseSummary,
  NewTableColumnDraft,
  SortRule,
  FilterConditionType,
  ColumnFilterRule,
  ClipboardBuffer,
  CollaboratorPresence,
  ActivityLogItem,
  CellPrimitive,
  getDropdownOptions,
  getLookupOptions,
  matchLookupItemFromRaw,
  validateCellValue,
  evaluateFormula,
  extractLookupTemplateTokens,
  formatLookupTemplateFromFieldNames,
  resolveLookupTemplateAndColumns,
} from './grid-models';
import { OperationLoader } from './operation-loader';

export interface PostgresAuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  color: string;
  avatarUrl?: string;
}

export interface VersionCommitItem {
  id: string;
  versionTag: string;
  title: string;
  message: string;
  authorName: string;
  authorColor: string;
  createdAt: string;
  rowCount: number;
  columnCount: number;
}

type ActiveModalType =
  | 'none'
  | 'multi_sort'
  | 'column_filter'
  | 'column_schema'
  | 'new_row'
  | 'create_database'
  | 'create_table'
  | 'rename_sidebar_item'
  | 'collaborator_profile'
  | 'activity_drawer'
  | 'excel_paste'
  | 'github_push'
  | 'postgres_auth'
  | 'version_control';

export type PasteTargetScope =
  | 'cell'
  | 'row'
  | 'column'
  | 'table'
  | 'overlay'
  | 'append_rows'
  | 'replace_all';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetType: 'cell' | 'column' | 'row' | 'table' | 'new_row';
  rowId: string | null;
  rowNumber: number | null;
  colId: string | null;
  colName: string | null;
}

export interface SidebarContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetType: 'databases_folder' | 'database' | 'table' | 'field';
  databaseName: string;
  tableName: string;
  column: GridColumn | null;
}

export interface DatabaseWorkspaceTab {
  tabId: string;
  databaseName: string;
  activeTableName: string;
}

export type GridarioTheme = 'classic-light' | 'classic-dark';

export interface ConfirmationDialogState {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'primary' | 'danger';
  onConfirm: (() => void) | null;
}

export interface HistorySnapshot {
  label: string;
  workspaceName: string;
  columns: GridColumn[];
  rows: GridRow[];
  cellValidationErrors: Record<string, string>;
  pendingUnsavedRowIds: string[];
  pendingUnsavedColIds: string[];
  activeCell: { rowId: string; colId: string } | null;
  timestamp: string;
}

const COLLABORATOR_COLORS = [
  '#2563eb',
  '#0d9488',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#16a34a',
];

const ANON_NAMES = [
  'Alex Rivera',
  'Jordan Vance',
  'Taylor Kim',
  'Morgan Patel',
  'Casey Lin',
  'Riley Mercer',
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [ReactiveFormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(window:keydown)': 'onGlobalKeydown($event)',
    '(window:paste)': 'onGlobalPaste($event)',
    '(window:scroll)': 'onWindowScroll()',
    '(document:click)': 'closeAllMenus()',
    '(mousedown)': 'clearActionTooltip()',
    '(mouseover)': 'onGlobalMouseOver($event)',
    '(mousemove)': 'onGlobalMouseMove($event)',
    '(mouseout)': 'onGlobalMouseOut($event)',
  },
})
export class App implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  readonly loader = inject(OperationLoader);

  // Workspace, Multi-Database (SQL Server Database Tabs), Multi-Table (Excel Sheet Tabs inside Database Tab) & Cloud Sync State
  readonly workspaceId = signal<string>('ws_gridpulse_main');
  readonly activeDatabaseName = signal<string>('');
  readonly activeTableName = signal<string>('');
  readonly workspaceName = signal<string>('');
  readonly databases = signal<DbDatabaseSummary[]>([]);
  readonly tables = signal<DbTableSummary[]>([]);
  readonly tableLastUsedOrderByDb = signal<Record<string, string[]>>({});
  readonly openTableTabsByDb = signal<Record<string, string[]>>({});
  private readonly tableLastUsedStorageKey = 'gridario_table_last_used_order';
  private readonly openTableTabsStorageKey = 'gridario_open_table_tabs_by_db';
  public hasInitializedWorkspace = false;

  readonly sortedTablesByLastUsed = computed<DbTableSummary[]>(() => {
    const rawTables = this.tables();
    if (rawTables.length <= 1) return rawTables;
    const activeDb = (this.activeDatabaseName() || '').trim().toLowerCase();
    const activeTbl = (this.activeTableName() || '').trim().toLowerCase();
    const orderMap = this.tableLastUsedOrderByDb();

    let dbHistory: string[] = [];
    for (const [k, list] of Object.entries(orderMap)) {
      if (k.trim().toLowerCase() === activeDb && Array.isArray(list)) {
        dbHistory = list;
        break;
      }
    }

    const rankMap = new Map<string, number>();
    let rank = 0;
    if (activeTbl) {
      rankMap.set(activeTbl, rank++);
    }
    for (const tblName of dbHistory) {
      const lower = (tblName || '').trim().toLowerCase();
      if (lower && !rankMap.has(lower)) {
        rankMap.set(lower, rank++);
      }
    }

    return [...rawTables].sort((a, b) => {
      const aLower = a.tableName.trim().toLowerCase();
      const bLower = b.tableName.trim().toLowerCase();
      const aRank = rankMap.get(aLower);
      const bRank = rankMap.get(bLower);

      if (aRank !== undefined && bRank !== undefined) {
        return aRank - bRank;
      }
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;

      if (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt) {
        return b.updatedAt.localeCompare(a.updatedAt);
      }
      return 0;
    });
  });

  // Only tables that have been opened from the sidebar for the active database and not yet closed
  readonly openTablesForActiveDatabase = computed<DbTableSummary[]>(() => {
    const rawTables = this.tables();
    const activeDb = (this.activeDatabaseName() || '').trim();
    if (!activeDb || rawTables.length === 0) return [];
    const openNames = this.getOpenTableNamesForDb(activeDb);
    if (openNames.length === 0) return [];

    const tableByLower = new Map<string, DbTableSummary>();
    for (const t of rawTables) {
      tableByLower.set(t.tableName.trim().toLowerCase(), t);
    }

    const result: DbTableSummary[] = [];
    const seen = new Set<string>();
    for (const openName of openNames) {
      const lower = (openName || '').trim().toLowerCase();
      if (!lower || seen.has(lower)) continue;
      const match = tableByLower.get(lower);
      if (match) {
        seen.add(lower);
        result.push(match);
      }
    }
    return result;
  });

  // SQL Server Management Studio (SSMS) / Browser-Style Database Connection Tabs
  // Each tab represents an active Database connection page, and inside each Database Tab
  // the footer hosts the Excel-style Table Sheet Tabs for that specific database.
  readonly databaseTabs = signal<DatabaseWorkspaceTab[]>([]);
  readonly activeDatabaseTabId = signal<string>('');
  readonly activeDatabaseTab = computed<DatabaseWorkspaceTab | null>(() => {
    const id = this.activeDatabaseTabId();
    const list = this.databaseTabs();
    return list.find((t) => t.tabId === id) || list[0] || null;
  });
  readonly hasActiveConnection = computed<boolean>(() => {
    return this.databaseTabs().length > 0;
  });
  readonly isCurrentTabAwaitingDbSelection = computed<boolean>(() => {
    const tab = this.activeDatabaseTab();
    return Boolean(tab && !tab.databaseName);
  });

  readonly isEditingWorkspaceName = signal<boolean>(false);
  readonly workspaceNameControl = this.fb.nonNullable.control(
    '',
    [Validators.required, Validators.maxLength(80)]
  );

  // 2-Theme UI Preference State (Classic Light & Classic Dark)
  readonly activeTheme = signal<GridarioTheme>('classic-light');
  readonly isDarkMode = computed<boolean>(() => this.activeTheme() === 'classic-dark');
  readonly themeOptions: {
    id: GridarioTheme;
    label: string;
    shortLabel: string;
    icon: string;
  }[] = [
    {
      id: 'classic-light',
      label: 'Classic Light',
      shortLabel: 'Light',
      icon: 'light_mode',
    },
    {
      id: 'classic-dark',
      label: 'Classic Dark',
      shortLabel: 'Dark',
      icon: 'dark_mode',
    },
  ];

  // Smart Overflow Hover Tooltip State (for truncated cells and sidebar items)
  readonly overflowTooltip = signal<{
    visible: boolean;
    text: string;
    x: number;
    y: number;
  }>({
    visible: false,
    text: '',
    x: 0,
    y: 0,
  });

  // 1-Second Hover Action & Functionality Explanation Tooltip State
  readonly actionTooltip = signal<{
    visible: boolean;
    text: string;
    x: number;
    y: number;
  }>({
    visible: false,
    text: '',
    x: 0,
    y: 0,
  });
  private actionHoverTimerId: ReturnType<typeof setTimeout> | null = null;
  private hoveredInteractiveEl: HTMLElement | null = null;
  private lastMouseX = 0;
  private lastMouseY = 0;

  // Excel-Style Column Resize State
  readonly resizingColId = signal<string | null>(null);

  // "Manage" Object Explorer Sidebar State + Split-Screen / Expand-Contract State
  readonly isManageSidebarOpen = signal<boolean>(true);
  readonly sidebarWidthPx = signal<number>(316);
  readonly sidebarTreeHeightPx = signal<number>(520);
  readonly isDraggingSidebarWidth = signal<boolean>(false);
  readonly isDraggingSidebarHeight = signal<boolean>(false);
  readonly isSidebarExpanded = computed<boolean>(
    () => this.sidebarWidthPx() >= 420 || this.sidebarTreeHeightPx() >= 680
  );

  // Table View Split-Screen & Expand / Contract State (See More or Fewer Rows)
  readonly tableViewHeightPx = signal<number>(380);
  readonly isDraggingTableHeight = signal<boolean>(false);
  readonly isTableViewExpanded = computed<boolean>(() => this.tableViewHeightPx() >= 580);
  readonly estimatedVisibleRowCapacity = computed<number>(() =>
    Math.max(4, Math.floor((this.tableViewHeightPx() - 62) / 38))
  );

  readonly manageTreeSearchQuery = signal<string>('');
  readonly manageTreeSearchControl = this.fb.nonNullable.control('');
  readonly isServerNodeExpanded = signal<boolean>(false);
  readonly isDatabasesFolderExpanded = signal<boolean>(false);
  readonly expandedDatabaseNodes = signal<Set<string>>(new Set<string>());
  readonly expandedTableNodes = signal<Set<string>>(new Set<string>());
  private readonly sidebarTreeStorageKey = 'gridario_sidebar_tree_state';

  // Create New Database Modal State
  readonly isCreatingDatabase = signal<boolean>(false);
  readonly createDatabaseErrorMessage = signal<string>('');
  readonly newDatabaseForm = this.fb.nonNullable.group({
    databaseName: ['', [Validators.required, Validators.maxLength(80)]],
    createStarterTable: [false],
    starterTableName: ['Table_1', [Validators.maxLength(80)]],
  });

  // Create / Edit Table & Tabular Field Designer Modal State
  readonly isCreatingTable = signal<boolean>(false);
  readonly editingTableOriginalName = signal<string>('');
  readonly createTableErrorMessage = signal<string>('');
  readonly newTableForm = this.fb.nonNullable.group({
    databaseName: ['GridPulse_DB', [Validators.required, Validators.maxLength(80)]],
    tableName: ['', [Validators.required, Validators.maxLength(80)]],
    pkColumnName: ['ID', [Validators.required, Validators.maxLength(60)]],
    includeDefaultPk: [true],
    initialRowCount: [3, [Validators.required, Validators.min(0), Validators.max(200)]],
  });
  readonly newTableTopDraft = signal<NewTableColumnDraft>({
    id: '__top_draft__',
    name: '',
    colType: 'text',
    isNullable: true,
    columnValue: '',
    formula: '',
    optionsCsv: '',
    isPrimaryKey: false,
    isIdentity: false,
  });
  readonly newTableColumns = signal<NewTableColumnDraft[]>([]);

  readonly columns = signal<GridColumn[]>([]);
  readonly rows = signal<GridRow[]>([]);
  readonly activities = signal<ActivityLogItem[]>([]);

  readonly cloudSyncStatus = signal<'synced' | 'syncing' | 'offline'>('synced');
  readonly lastSyncedTime = signal<string>('Just now');
  readonly firestoreDocCount = signal<number>(0);

  // Auth (PostgreSQL Users Table) & Collaborator Presence
  readonly firebaseUser = signal<PostgresAuthUser | null>({
    id: 'usr_pg_alex',
    email: 'alex.rivera@gridpulse.io',
    displayName: 'Alex Rivera',
    role: 'Admin',
    color: '#4285F4',
  });
  readonly authMode = signal<'login' | 'register'>('login');
  readonly authErrorMessage = signal<string>('');
  readonly authForm = this.fb.nonNullable.group({
    email: ['alex.rivera@gridpulse.io', [Validators.required]],
    password: ['GridPulse@2026', [Validators.required]],
    displayName: ['Alex Rivera'],
    color: ['#4285F4'],
  });
  readonly currentClientId = signal<string>('client_init');
  readonly currentUserName = signal<string>('Alex Rivera');
  readonly currentUserColor = signal<string>('#4285F4');
  readonly currentUserAvatarUrl = computed<string>(() => {
    const user = this.firebaseUser();
    if (user?.avatarUrl) {
      return user.avatarUrl;
    }
    const name = (user?.displayName || this.currentUserName() || 'User').trim();
    const color = (user?.color || this.currentUserColor() || '#4285F4').trim();
    return this.buildUserAvatarDataUri(name, color);
  });
  readonly collaborators = signal<CollaboratorPresence[]>([]);
  readonly isCoEditorSimActive = signal<boolean>(false);

  // Version Control State (PostgreSQL Workspace Snapshots)
  readonly versions = signal<VersionCommitItem[]>([]);
  readonly isCommittingVersion = signal<boolean>(false);
  readonly versionForm = this.fb.nonNullable.group({
    title: ['Q4 Budget Checkpoint', [Validators.required, Validators.maxLength(100)]],
    message: ['Snapshot of current columns, formulas, and verified rows'],
  });

  // Active Navigation Section / Modal State
  readonly activeNavTab = signal<'grid' | 'sort' | 'filter' | 'schema' | 'activity'>('grid');
  readonly activeModal = signal<ActiveModalType>('none');
  readonly isSettingsDropdownOpen = signal<boolean>(false);

  // Unified Right-Click & Mobile Long-Press Context Menu State (Grid)
  readonly contextMenu = signal<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetType: 'cell',
    rowId: null,
    rowNumber: null,
    colId: null,
    colName: null,
  });

  // Object Explorer Sidebar Right-Click & Mobile Long-Press Context Menu State
  readonly sidebarContextMenu = signal<SidebarContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetType: 'database',
    databaseName: '',
    tableName: '',
    column: null,
  });

  // Rename / Edit Sidebar Item Modal State (Database, Table, or Field)
  readonly renameSidebarTargetType = signal<'database' | 'table' | 'field'>('database');
  readonly renameSidebarDbName = signal<string>('');
  readonly renameSidebarDatabaseName = this.renameSidebarDbName;
  readonly renameSidebarTableName = signal<string>('');
  readonly renameSidebarColumn = signal<GridColumn | null>(null);
  readonly renameSidebarErrorMessage = signal<string>('');
  readonly isRenamingSidebarItem = signal<boolean>(false);
  readonly renameSidebarControl = this.fb.nonNullable.control('', [
    Validators.required,
    Validators.maxLength(80),
  ]);
  readonly renameSidebarForm = this.fb.nonNullable.group({
    newName: this.renameSidebarControl,
  });

  // SQL Server-Style Always-Empty First Row ("Add Row" Row) State
  readonly newRowSentinelId = '__new_row__';
  readonly newRowDraftCells = signal<Record<string, CellPrimitive>>({});
  readonly newRowValidationErrors = signal<Record<string, string>>({});
  readonly editingNewRowColId = signal<string | null>(null);
  readonly newRowCellEditControl = this.fb.nonNullable.control('');
  readonly isAddingRowsOneByOne = signal<boolean>(false);

  // Confirmation Dialog State (before adding, duplicating, or deleting/removing)
  readonly confirmDialog = signal<ConfirmationDialogState>({
    visible: false,
    title: '',
    message: '',
    confirmLabel: 'Confirm',
    variant: 'primary',
    onConfirm: null,
  });

  // Search, Multi-Sort (1..N columns), and Excel Multi-Column Filter State
  readonly globalSearchQuery = signal<string>('');
  readonly searchScopeColId = signal<string>('all');
  readonly searchInputControl = this.fb.nonNullable.control('');
  readonly searchScopeControl = this.fb.nonNullable.control('all');

  readonly sortRules = signal<SortRule[]>([]);

  readonly filterRules = signal<Record<string, ColumnFilterRule>>({});
  readonly draftFilterRules = signal<Record<string, ColumnFilterRule>>({});
  readonly columnHeaderSearches = signal<Record<string, string>>({});
  readonly draftColumnHeaderSearches = signal<Record<string, string>>({});
  readonly activeFilterColId = signal<string | null>(null);
  readonly filterChecklistSearch = signal<string>('');
  readonly filterChecklistSearchControl = this.fb.nonNullable.control('');
  readonly filterConditionControl = this.fb.nonNullable.control<FilterConditionType>('none');
  readonly filterValueControl = this.fb.nonNullable.control('');
  readonly filterValueEndControl = this.fb.nonNullable.control('');

  // Selection & Active Cell / Formula Bar State
  readonly selectedRowIds = signal<Set<string>>(new Set<string>());
  readonly selectedColumnId = signal<string | null>(null);
  readonly activeCell = signal<{ rowId: string; colId: string } | null>(null);
  readonly editingCell = signal<{ rowId: string; colId: string } | null>(null);
  readonly cellEditControl = this.fb.nonNullable.control('');
  readonly formulaBarControl = this.fb.nonNullable.control('');

  // Validation & Notification Banner + Multi-Cell / Multi-Row Error Tracking
  readonly validationBanner = signal<{
    type: 'error' | 'info' | 'success';
    message: string;
  } | null>(null);
  readonly invalidCellKey = signal<string | null>(null);
  // Key format: `${rowId}:${colId}` -> errorMessage
  readonly cellValidationErrors = signal<Record<string, string>>({});
  readonly pendingUnsavedRowIds = signal<Set<string>>(new Set<string>());
  readonly pendingUnsavedColIds = signal<Set<string>>(new Set<string>());
  private lastValidRowSnapshots = new Map<string, GridRow>();

  // Clipboard State (Rows or Column Copy / Cut / Paste + Excel System Clipboard)
  readonly clipboard = signal<ClipboardBuffer | null>(null);
  private lastInternalClipboardText = '';
  readonly excelPasteTextControl = this.fb.nonNullable.control('');
  readonly excelPasteRawSignal = signal<string>('');
  readonly excelPasteMode = signal<PasteTargetScope>('overlay');

  // Undo & Redo History Stacks (Up to 20 Steps each)
  readonly maxHistorySteps = 20;
  readonly undoStack = signal<HistorySnapshot[]>([]);
  readonly redoStack = signal<HistorySnapshot[]>([]);
  readonly canUndo = computed<boolean>(() => this.undoStack().length > 0);
  readonly canRedo = computed<boolean>(() => this.redoStack().length > 0);

  // Lazy Loading & Server-Side Database Query State (10 rows at a time)
  readonly lazyBatchSize = 10;
  readonly visibleRowLimit = signal<number>(10);
  readonly isLazyLoadingMore = signal<boolean>(false);
  readonly dbTotalRows = signal<number>(500);
  readonly dbFilteredTotalRows = signal<number>(500);
  readonly dbHasMoreRows = signal<boolean>(true);
  readonly dbUniqueValuesByColumn = signal<Record<string, { label: string; count: number }[]>>({});

  // Reactive Form: Dynamic Column Creator / Schema Editor
  readonly editingSchemaColId = signal<string | null>(null);
  readonly schemaModalColType = signal<ColumnType>('text');
  readonly targetColumnSchemaDbName = signal<string>('');
  readonly targetColumnSchemaTableName = signal<string>('');
  readonly targetColumnSchemaColumns = computed<GridColumn[]>(() => {
    const dbName = (this.targetColumnSchemaDbName() || this.activeDatabaseName()).trim();
    const tblName = (this.targetColumnSchemaTableName() || this.activeTableName()).trim();
    if (
      dbName.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
      tblName.toLowerCase() === this.activeTableName().toLowerCase()
    ) {
      return this.sortedColumns();
    }
    const dbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === dbName.toLowerCase()
    );
    const tblObj = dbObj?.tables?.find(
      (t) => t.tableName.toLowerCase() === tblName.toLowerCase()
    );
    return tblObj?.columns
      ? [...tblObj.columns].sort((a, b) => a.orderIndex - b.orderIndex)
      : this.sortedColumns();
  });
  readonly columnSchemaForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    colType: ['text' as ColumnType, [Validators.required]],
    width: [150, [Validators.required, Validators.min(70), Validators.max(800)]],
    required: [false],
    isNullable: [true],
    lookupTableName: [''],
    optionsCsv: ['Option A, Option B, Option C'],
    formula: ['=[Units] * [Unit Cost]'],
    defaultValue: [''],
  });

  // Reactive Form: Collaborator Profile
  readonly profileForm = this.fb.nonNullable.group({
    displayName: ['Alex Rivera', [Validators.required, Validators.maxLength(60)]],
    color: ['#4285F4', [Validators.required]],
  });

  // Reactive Form: Create New Row Modal
  readonly newRowValues = signal<Record<string, string | boolean>>({});

  // GitHub OAuth Device Flow, Repository Creation & Vercel Hosting State
  readonly githubAuthStatus = signal<
    'idle' | 'awaiting_device' | 'authorized' | 'pushing' | 'pushed' | 'error'
  >('idle');
  readonly githubUserCode = signal<string>('');
  readonly githubVerificationUri = signal<string>('https://github.com/login/device');
  readonly githubAuthorizedUser = signal<string>('');
  readonly githubAccessToken = signal<string>('');
  readonly githubPushedRepoUrl = signal<string>('https://github.com/fushback/Grid');
  readonly vercelCloneUrl = signal<string>(
    'https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffushback%2FGrid&project-name=gridario'
  );
  readonly vercelDeploymentUrl = signal<string>('');
  readonly vercelDeployStatus = signal<'idle' | 'deploying' | 'deployed' | 'error'>('idle');
  readonly githubStatusMessage = signal<string>('');
  readonly githubForm = this.fb.nonNullable.group({
    repoName: [
      'https://github.com/fushback/Grid.git',
      [Validators.required, Validators.maxLength(200)],
    ],
    description: [
      'Gridario Cloud Spreadsheet - Full-Stack Angular 21 + Serverless API (Vercel Ready)',
    ],
    commitMessage: [
      'Commit Gridario application updates (10-row lazy load, gold/light-black theme, version control)',
      [Validators.required, Validators.maxLength(200)],
    ],
    isPrivate: [false],
    manualToken: [''],
    vercelToken: [''],
  });

  private eventSource: EventSource | null = null;
  private coEditorInterval: ReturnType<typeof setInterval> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private bannerTimeout: ReturnType<typeof setTimeout> | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private githubPollTimer: ReturnType<typeof setInterval> | null = null;

  // =========================================================================
  // COMPUTED SIGNALS: FILTERING, MULTI-COLUMN SORTING & LAZY LOADING
  // =========================================================================

  readonly sortedColumns = computed<GridColumn[]>(() => {
    return [...this.columns()].sort((a, b) => a.orderIndex - b.orderIndex);
  });

  readonly activeFilterCount = computed<number>(() => {
    const cols = this.sortedColumns();
    const rules = this.filterRules();
    const headerSearches = this.columnHeaderSearches();
    let count = 0;

    for (const col of cols) {
      const r = rules[col.id];
      const hasRule =
        r &&
        ((r.condition !== 'none' &&
          (r.condition === 'empty' ||
            r.condition === 'not_empty' ||
            r.queryValue.trim().length > 0)) ||
          r.excludedValues.length > 0);
      const hasHeaderSearch = (headerSearches[col.id] || '').trim().length > 0;
      if (hasRule || hasHeaderSearch) {
        count++;
      }
    }
    return count;
  });

  readonly filteredAndSortedRows = computed<GridRow[]>(() => {
    const allRows = this.rows();
    const cols = this.sortedColumns();
    const search = this.globalSearchQuery().trim().toLowerCase();
    const scope = this.searchScopeColId();
    const filters = this.filterRules();
    const headerSearches = this.columnHeaderSearches();
    const sorts = this.sortRules();

    // Step 1: Filter rows (Per-column header searches + 1..N Excel column filters)
    const matched = allRows.filter((row) => {
      if (search.length > 0) {
        if (scope !== 'all') {
          const col = cols.find((c) => c.id === scope);
          const val = col ? this.getDisplayCellValue(row, col) : '';
          if (!String(val).toLowerCase().includes(search)) return false;
        } else {
          const anyMatch = cols.some((col) => {
            const val = this.getDisplayCellValue(row, col);
            return String(val).toLowerCase().includes(search);
          });
          if (!anyMatch) return false;
        }
      }

      for (const col of cols) {
        const rawVal = this.getDisplayCellValue(row, col);
        const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal);
        const lowerVal = strVal.toLowerCase();

        const colHeaderQuery = (headerSearches[col.id] || '').trim().toLowerCase();
        if (colHeaderQuery.length > 0 && !lowerVal.includes(colHeaderQuery)) {
          return false;
        }

        const rule = filters[col.id];
        if (!rule) continue;

        if (rule.excludedValues.length > 0) {
          const displayKey = strVal === '' ? '(Blank)' : strVal;
          if (rule.excludedValues.includes(displayKey)) {
            return false;
          }
        }

        if (rule.condition !== 'none') {
          const q = rule.queryValue.trim().toLowerCase();
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
              if (rule.queryValue.trim().length > 0) {
                if (!Number.isNaN(qNum) && !Number.isNaN(vNum)) {
                  if (!(vNum > qNum)) return false;
                } else if (!(lowerVal > q)) {
                  return false;
                }
              }
              break;
            case 'lt':
              if (rule.queryValue.trim().length > 0) {
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
                rule.queryValue.trim().length > 0 &&
                rule.queryValueEnd.trim().length > 0 &&
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

    // Step 2: Multi-Column Cascading Sort (1, 2, 3, or N columns)
    if (sorts.length === 0) {
      return [...matched].sort((a, b) => a.orderIndex - b.orderIndex);
    }

    const colMap = new Map<string, GridColumn>(cols.map((c) => [c.id, c]));

    return [...matched].sort((rowA, rowB) => {
      for (const rule of sorts) {
        const col = colMap.get(rule.columnId);
        if (!col) continue;

        const valA = this.getDisplayCellValue(rowA, col);
        const valB = this.getDisplayCellValue(rowB, col);

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
  });

  readonly visibleRows = computed<GridRow[]>(() => {
    const limit = this.visibleRowLimit();
    return this.filteredAndSortedRows().slice(0, limit);
  });

  readonly hasMoreLazyRows = computed<boolean>(() => {
    return (
      this.dbHasMoreRows() ||
      this.visibleRowLimit() < this.filteredAndSortedRows().length
    );
  });

  readonly invalidRowIds = computed<Set<string>>(() => {
    const errors = this.cellValidationErrors();
    const rowIds = new Set<string>();
    for (const key of Object.keys(errors)) {
      const sepIdx = key.indexOf(':');
      if (sepIdx > 0) {
        rowIds.add(key.slice(0, sepIdx));
      }
    }
    return rowIds;
  });

  readonly totalValidationErrorCount = computed<number>(() => {
    return Object.keys(this.cellValidationErrors()).length;
  });

  readonly excelPastePreviewStats = computed<{ rows: number; cols: number }>(() => {
    const raw = this.excelPasteRawSignal().trim();
    if (!raw) return { rows: 0, cols: 0 };
    const matrix = this.parseExcelClipboardMatrix(raw);
    const rCount = matrix.length;
    const cCount = matrix.reduce((max, r) => Math.max(max, r.length), 0);
    return { rows: rCount, cols: cCount };
  });

  readonly isAllFilteredSelected = computed<boolean>(() => {
    const visible = this.visibleRows();
    const selected = this.selectedRowIds();
    if (visible.length === 0) return false;
    return visible.every((r) => selected.has(r.id));
  });

  readonly isSomeSelected = computed<boolean>(() => {
    const selected = this.selectedRowIds();
    return selected.size > 0 && !this.isAllFilteredSelected();
  });

  readonly activeFilterColumn = computed<GridColumn | null>(() => {
    const colId = this.activeFilterColId();
    if (!colId) return null;
    return this.sortedColumns().find((c) => c.id === colId) || null;
  });

  readonly uniqueValuesForActiveFilterCol = computed<
    { label: string; count: number; checked: boolean }[]
  >(() => {
    const col = this.activeFilterColumn();
    if (!col) return [];
    const rulesSource =
      this.activeModal() === 'column_filter' ? this.draftFilterRules() : this.filterRules();
    const rule = rulesSource[col.id];
    const excluded = new Set(rule?.excludedValues || []);
    const search = this.filterChecklistSearch().trim().toLowerCase();

    const dbList = this.dbUniqueValuesByColumn()[col.id];
    let items: { label: string; count: number; checked: boolean }[];

    if (Array.isArray(dbList) && dbList.length > 0) {
      items = dbList.map((u) => ({
        label: u.label,
        count: u.count,
        checked: !excluded.has(u.label),
      }));
    } else {
      const counts = new Map<string, number>();
      for (const row of this.rows()) {
        const val = this.getDisplayCellValue(row, col);
        const key =
          val === null || val === undefined || String(val) === '' ? '(Blank)' : String(val);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      items = Array.from(counts.entries())
        .map(([label, count]) => ({
          label,
          count,
          checked: !excluded.has(label),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    }

    if (search.length > 0) {
      return items.filter((item) => item.label.toLowerCase().includes(search));
    }
    return items;
  });

  readonly activeCellInfo = computed<{
    rowNumber: number;
    colName: string;
    colType: ColumnType;
    rawValue: string;
    displayValue: string;
    isFormula: boolean;
    formulaText: string;
  } | null>(() => {
    const active = this.activeCell();
    if (!active) return null;
    const rowIdx = this.filteredAndSortedRows().findIndex((r) => r.id === active.rowId);
    const row = this.rows().find((r) => r.id === active.rowId);
    const col = this.sortedColumns().find((c) => c.id === active.colId);
    if (!row || !col) return null;

    const displayVal = String(this.getDisplayCellValue(row, col));
    const rawVal =
      col.colType === 'formula'
        ? col.formula
        : String(row.cells[col.id] !== undefined ? row.cells[col.id] : '');

    return {
      rowNumber: rowIdx >= 0 ? rowIdx + 1 : 1,
      colName: col.name,
      colType: col.colType,
      rawValue: rawVal,
      displayValue: displayVal,
      isFormula: col.colType === 'formula',
      formulaText: col.formula || '',
    };
  });

  readonly columnTotals = computed<Record<string, string>>(() => {
    const filtered = this.filteredAndSortedRows();
    const cols = this.sortedColumns();
    const totals: Record<string, string> = {};

    for (const col of cols) {
      if (col.colType === 'number' || col.colType === 'formula') {
        let sum = 0;
        let validCount = 0;
        for (const r of filtered) {
          const val = Number(this.getDisplayCellValue(r, col));
          if (!Number.isNaN(val) && Number.isFinite(val)) {
            sum += val;
            validCount++;
          }
        }
        if (validCount > 0) {
          const isCurrency =
            col.name.toLowerCase().includes('cost') ||
            col.name.toLowerCase().includes('budget') ||
            col.name.toLowerCase().includes('value') ||
            col.name.toLowerCase().includes('price') ||
            col.name.toLowerCase().includes('revenue');
          const formatted = sum.toLocaleString('en-US', {
            minimumFractionDigits: isCurrency ? 2 : 0,
            maximumFractionDigits: 2,
          });
          totals[col.id] = isCurrency ? `$${formatted}` : formatted;
        } else {
          totals[col.id] = '—';
        }
      } else if (col.colType === 'checkbox') {
        const checkedCount = filtered.filter((r) => r.cells[col.id] === true).length;
        totals[col.id] = `${checkedCount}/${filtered.length} true`;
      } else {
        totals[col.id] = `${filtered.length} rows`;
      }
    }
    return totals;
  });

  // =========================================================================
  // LIFECYCLE & INITIALIZATION
  // =========================================================================

  ngOnInit(): void {
    if (this.isBrowser) {
      const savedTheme = localStorage.getItem('gridario_ui_theme');
      if (savedTheme === 'classic-dark' || savedTheme === 'neumorphic-dark') {
        this.applyTheme('classic-dark');
      } else {
        this.applyTheme('classic-light');
      }

      this.restoreSidebarTreeStateFromStorage();
      this.restoreTableLastUsedOrderFromStorage();

      const storedId = sessionStorage.getItem('gridpulse_client_id');
      const clientId =
        storedId || `collab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      sessionStorage.setItem('gridpulse_client_id', clientId);
      this.currentClientId.set(clientId);

      const randomIdx = Math.abs(this.hashCode(clientId)) % ANON_NAMES.length;
      const storedName =
        localStorage.getItem('gridpulse_user_name') || ANON_NAMES[randomIdx];
      const storedColor =
        localStorage.getItem('gridpulse_user_color') ||
        COLLABORATOR_COLORS[randomIdx % COLLABORATOR_COLORS.length];

      this.currentUserName.set(storedName);
      this.currentUserColor.set(storedColor);
      this.profileForm.patchValue({ displayName: storedName, color: storedColor });

      // Restore PostgreSQL authenticated session if token exists
      const pgToken = localStorage.getItem('gridpulse_pg_token');
      if (pgToken) {
        this.http
          .get<{ ok: boolean; user: PostgresAuthUser | null }>('/api/auth/me', {
            headers: { Authorization: `Bearer ${pgToken}` },
          })
          .subscribe({
            next: (res) => {
              if (res?.ok && res.user) {
                this.firebaseUser.set(res.user);
                this.currentUserName.set(res.user.displayName);
                this.currentUserColor.set(res.user.color || '#f59e0b');
                this.profileForm.patchValue({
                  displayName: res.user.displayName,
                  color: res.user.color || '#f59e0b',
                });
                this.broadcastPresence();
              } else {
                localStorage.removeItem('gridpulse_pg_token');
              }
            },
            error: () => {
              // Ignore session check error
            },
          });
      }

      // Restore saved GitHub token if previously authorized
      const savedGhToken = localStorage.getItem('gridario_gh_token') || '';
      const savedGhUser = localStorage.getItem('gridario_gh_user') || '';
      if (savedGhToken) {
        this.githubAccessToken.set(savedGhToken);
        this.githubAuthorizedUser.set(savedGhUser || 'GitHub User');
        this.githubAuthStatus.set('authorized');
      } else {
        this.http
          .get<{ authorized?: boolean; username?: string; accessToken?: string }>(
            '/api/github/status'
          )
          .subscribe({
            next: (ghStatus) => {
              if (ghStatus?.authorized && ghStatus.accessToken) {
                this.githubAccessToken.set(ghStatus.accessToken);
                this.githubAuthorizedUser.set(ghStatus.username || 'GitHub User');
                this.githubAuthStatus.set('authorized');
              }
            },
            error: () => {
              // Ignore
            },
          });
      }

      this.fetchWorkspaceFromServer();
      this.connectRealTimeStream();

      window.addEventListener('message', (event: MessageEvent) => {
        const origin = event.origin || '';
        if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
          return;
        }
        const data = event.data as {
          type?: string;
          accessToken?: string;
          username?: string;
        } | null;
        if (data?.type === 'OAUTH_AUTH_SUCCESS' && data.accessToken) {
          this.githubAccessToken.set(data.accessToken);
          this.githubAuthorizedUser.set(data.username || 'GitHub User');
          this.githubAuthStatus.set('authorized');
          localStorage.setItem('gridario_gh_token', data.accessToken);
          localStorage.setItem('gridario_gh_user', data.username || 'GitHub User');
          this.githubStatusMessage.set(
            `Authorized as @${data.username || 'user'}. Ready to commit and push to GitHub!`
          );
        }
      });

      this.presenceTimer = setInterval(() => {
        this.broadcastPresence();
      }, 20000);
    }
  }

  ngOnDestroy(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.coEditorInterval) {
      clearInterval(this.coEditorInterval);
    }
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
    }
    if (this.bannerTimeout) {
      clearTimeout(this.bannerTimeout);
    }
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
    }
    if (this.githubPollTimer) {
      clearInterval(this.githubPollTimer);
    }
    this.clearActionTooltip();
  }

  private seedInitialClientData(): void {
    const cols: GridColumn[] = [
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
    this.columns.set(cols);
    this.tables.set([
      {
        tableName: 'Initiatives',
        rowCount: 500,
        columnCount: cols.length,
        columns: cols,
        identitySeed: 1,
        identityIncrement: 1,
        nextIdentityValue: 501,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    this.databases.set([
      {
        databaseName: 'GridPulse_DB',
        activeTableName: 'Initiatives',
        tables: this.tables(),
        createdAt: '',
        updatedAt: '',
      },
    ]);
    this.openTableTabsByDb.set({ GridPulse_DB: ['Initiatives'] });

    const sampleRows: GridRow[] = [];
    const depts = ['Engineering', 'Product', 'Finance', 'Operations', 'Growth', 'Security'];
    const stages = ['Active', 'In Review', 'Planned', 'Completed', 'At Risk'];
    const owners = ['Elena Rostova', 'Marcus Vance', 'Priya Nair', 'Devon Brooks', 'Liam Chen'];
    const titles = [
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
    ];

    for (let i = 1; i <= 10; i++) {
      sampleRows.push({
        id: `row_seed_${i}`,
        orderIndex: i * 10,
        cells: {
          ID: i,
          'Record ID': `GP-${1000 + i}`,
          'Initiative & Deliverable': `${titles[i % titles.length]} — Phase ${(i % 4) + 1}`,
          Department: depts[i % depts.length],
          Stage: stages[(i * 2) % stages.length],
          'Lead Owner': owners[i % owners.length],
          Units: 15 + ((i * 19) % 180),
          'Unit Cost': 40 + ((i * 35) % 360),
          'Target Date': `2026-${String((i % 12) + 1).padStart(2, '0')}-${String(((i * 3) % 27) + 1).padStart(2, '0')}`,
          Approved: i % 3 !== 0,
        },
        updatedBy: owners[i % owners.length],
        updatedAt: '2026-10-05T15:00:00Z',
      });
    }
    this.rows.set(sampleRows);
    this.snapshotValidRows(sampleRows);
    this.activeCell.set({ rowId: sampleRows[0].id, colId: 'Initiative & Deliverable' });
    this.formulaBarControl.setValue(String(sampleRows[0].cells['Initiative & Deliverable']));
  }

  public computeNextClientIdentityValue(
    rowsList: GridRow[] = this.rows(),
    colsList: GridColumn[] = this.columns()
  ): number {
    const pkCol = colsList.find((c) => c.isPrimaryKey || c.isIdentity);
    if (!pkCol) return rowsList.length + 1;
    let maxId = 0;
    for (const r of rowsList) {
      const raw = r.cells?.[pkCol.name] ?? r.cells?.[pkCol.id];
      const num = Number(raw);
      if (Number.isInteger(num) && num > maxId) {
        maxId = num;
      }
    }
    const tableSummary = this.tables().find(
      (t) => t.tableName.toLowerCase() === this.activeTableName().toLowerCase()
    );
    if (tableSummary && tableSummary.nextIdentityValue > maxId + 1) {
      return tableSummary.nextIdentityValue;
    }
    return maxId + 1;
  }

  private sanitizeClientRowsAgainstColumns(
    cols: GridColumn[],
    rowsList: GridRow[]
  ): GridRow[] {
    if (cols.length === 0) return [];
    let maxIdentity = 0;
    const pkCol = cols.find((c) => c.isPrimaryKey || c.isIdentity);
    if (pkCol) {
      for (const r of rowsList) {
        const rawPk = r.cells?.[pkCol.name] ?? r.cells?.[pkCol.id];
        const numPk = Number(rawPk);
        if (Number.isInteger(numPk) && numPk > maxIdentity) {
          maxIdentity = numPk;
        }
      }
    }

    return rowsList.map((r) => {
      const nextCells: Record<string, CellPrimitive> = { ...(r.cells || {}) };
      for (const col of cols) {
        const val = nextCells[col.name] !== undefined ? nextCells[col.name] : nextCells[col.id];
        if (col.isPrimaryKey || col.isIdentity) {
          const numPk = Number(val);
          const resolvedPk =
            Number.isInteger(numPk) && numPk >= 1 ? numPk : ++maxIdentity;
          nextCells[col.name] = resolvedPk;
          nextCells[col.id] = resolvedPk;
          continue;
        }
        if (col.colType === 'formula') {
          if (
            typeof val === 'boolean' ||
            typeof val === 'number' ||
            val === 'false' ||
            val === 'true' ||
            val === ''
          ) {
            delete nextCells[col.id];
            delete nextCells[col.name];
          }
        } else if (col.colType === 'number') {
          let numNormalized: CellPrimitive = val ?? 0;
          if (typeof val === 'boolean') {
            numNormalized = val ? 1 : 0;
          } else if (typeof val === 'string') {
            const lower = val.trim().toLowerCase();
            if (lower === 'false' || lower === 'true') {
              numNormalized = lower === 'true' ? 1 : 0;
            }
          }
          nextCells[col.name] = numNormalized;
          nextCells[col.id] = numNormalized;
        } else if (col.colType === 'checkbox') {
          let boolNormalized: CellPrimitive = val ?? false;
          if (typeof val !== 'boolean') {
            const lower = String(val ?? '').trim().toLowerCase();
            if (
              lower === 'true' ||
              lower === '1' ||
              lower === 'yes' ||
              lower === 'y' ||
              lower === 'checked' ||
              lower === 'on'
            ) {
              boolNormalized = true;
            } else if (
              lower === 'false' ||
              lower === '0' ||
              lower === 'no' ||
              lower === 'n' ||
              lower === 'unchecked' ||
              lower === 'off' ||
              lower === ''
            ) {
              boolNormalized = false;
            }
          }
          nextCells[col.name] = boolNormalized;
          nextCells[col.id] = boolNormalized;
        } else {
          const strVal = val ?? '';
          nextCells[col.name] = strVal;
          nextCells[col.id] = strVal;
        }
      }
      return {
        ...r,
        cells: nextCells,
      };
    });
  }

  private snapshotValidRows(rowsList: GridRow[]): void {
    const invalidRows = this.invalidRowIds();
    for (const r of rowsList) {
      if (!invalidRows.has(r.id)) {
        this.lastValidRowSnapshots.set(r.id, { ...r, cells: { ...r.cells } });
      }
    }
  }

  // =========================================================================
  // "MANAGE" SIDEBAR (MS SQL SERVER MANAGEMENT STUDIO OBJECT EXPLORER TREE)
  // =========================================================================

  public toggleManageSidebar(event?: Event): void {
    event?.stopPropagation();
    this.isManageSidebarOpen.update((v) => !v);
  }

  public onManageTreeSearchInput(): void {
    this.manageTreeSearchQuery.set(this.manageTreeSearchControl.value);
  }

  public clearManageTreeSearch(): void {
    this.manageTreeSearchControl.setValue('');
    this.manageTreeSearchQuery.set('');
  }

  public readonly filteredManageDatabases = computed<DbDatabaseSummary[]>(() => {
    const q = this.manageTreeSearchQuery().trim().toLowerCase();
    const allDbs = this.databases();
    if (!q) return allDbs;

    return allDbs.filter((db) => {
      if (db.databaseName.toLowerCase().includes(q)) return true;
      return (db.tables || []).some((tbl) => {
        if (tbl.tableName.toLowerCase().includes(q)) return true;
        const cols = this.getColumnsForManageTable(db.databaseName, tbl);
        return cols.some((c) => c.name.toLowerCase().includes(q));
      });
    });
  });

  public refreshObjectExplorerTreeFromDb(): void {
    if (!this.isBrowser) return;
    this.http
      .get<{
        ok: boolean;
        activeDatabaseName?: string;
        activeTableName?: string;
        databases?: DbDatabaseSummary[];
        tables?: DbTableSummary[];
      }>('/api/workspace/tree')
      .subscribe({
        next: (res) => {
          if (res?.ok && Array.isArray(res.databases)) {
            this.databases.set(res.databases);
            this.syncTablesSignalForActiveDatabase(res.databases);
          }
        },
        error: () => {
          // Ignore background tree refresh errors
        },
      });
  }

  public syncTablesSignalForActiveDatabase(
    dbs: DbDatabaseSummary[] = this.databases(),
    overrideActiveDbName?: string
  ): void {
    const activeDb = (overrideActiveDbName ?? this.activeDatabaseName()).trim();
    if (!activeDb) {
      this.tables.set([]);
      return;
    }
    const foundDb = dbs.find((d) => d.databaseName.toLowerCase() === activeDb.toLowerCase());
    if (foundDb) {
      if (this.activeDatabaseName() !== foundDb.databaseName) {
        this.activeDatabaseName.set(foundDb.databaseName);
      }
      this.tables.set(Array.isArray(foundDb.tables) ? foundDb.tables : []);
    }
  }

  private restoreSidebarTreeStateFromStorage(): void {
    if (!this.isBrowser) return;
    try {
      const raw = localStorage.getItem(this.sidebarTreeStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        serverExpanded?: boolean;
        databasesFolderExpanded?: boolean;
        expandedDatabases?: string[];
        expandedTables?: string[];
      };
      if (typeof parsed.serverExpanded === 'boolean') {
        this.isServerNodeExpanded.set(parsed.serverExpanded);
      }
      if (typeof parsed.databasesFolderExpanded === 'boolean') {
        this.isDatabasesFolderExpanded.set(parsed.databasesFolderExpanded);
      }
      if (Array.isArray(parsed.expandedDatabases)) {
        this.expandedDatabaseNodes.set(new Set(parsed.expandedDatabases));
      }
      if (Array.isArray(parsed.expandedTables)) {
        this.expandedTableNodes.set(new Set(parsed.expandedTables));
      }
    } catch {
      // Ignore malformed storage
    }
  }

  private saveSidebarTreeStateToStorage(): void {
    if (!this.isBrowser) return;
    try {
      const payload = {
        serverExpanded: this.isServerNodeExpanded(),
        databasesFolderExpanded: this.isDatabasesFolderExpanded(),
        expandedDatabases: Array.from(this.expandedDatabaseNodes()),
        expandedTables: Array.from(this.expandedTableNodes()),
      };
      localStorage.setItem(this.sidebarTreeStorageKey, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors
    }
  }

  private restoreTableLastUsedOrderFromStorage(): void {
    if (!this.isBrowser) return;
    try {
      const raw = localStorage.getItem(this.tableLastUsedStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      if (parsed && typeof parsed === 'object') {
        this.tableLastUsedOrderByDb.set(parsed);
      }
    } catch {
      // Ignore malformed storage
    }
  }

  private saveTableLastUsedOrderToStorage(): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(
        this.tableLastUsedStorageKey,
        JSON.stringify(this.tableLastUsedOrderByDb())
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  public recordTableUsed(databaseName: string, tableName: string): void {
    const cleanDb = (databaseName || '').trim();
    const cleanTbl = (tableName || '').trim();
    if (!cleanDb || !cleanTbl) return;

    this.tableLastUsedOrderByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      let matchedKey = cleanDb;
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === cleanDb.toLowerCase()) {
          matchedKey = k;
          break;
        }
      }
      const existing = Array.isArray(next[matchedKey]) ? next[matchedKey] : [];
      const filtered = existing.filter(
        (t) => (t || '').trim().toLowerCase() !== cleanTbl.toLowerCase()
      );
      next[matchedKey] = [cleanTbl, ...filtered];
      return next;
    });
    this.saveTableLastUsedOrderToStorage();
  }

  public getOpenTableNamesForDb(databaseName: string): string[] {
    const cleanDb = (databaseName || '').trim().toLowerCase();
    if (!cleanDb) return [];
    const map = this.openTableTabsByDb();
    for (const [k, list] of Object.entries(map)) {
      if (k.trim().toLowerCase() === cleanDb && Array.isArray(list)) {
        return list;
      }
    }
    return [];
  }

  public openTableTab(databaseName: string, tableName: string): void {
    const cleanDb = (databaseName || '').trim();
    const cleanTbl = (tableName || '').trim();
    if (!cleanDb || !cleanTbl) return;

    this.openTableTabsByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      let matchedKey = cleanDb;
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === cleanDb.toLowerCase()) {
          matchedKey = k;
          break;
        }
      }
      const existing = Array.isArray(next[matchedKey]) ? [...next[matchedKey]] : [];
      if (!existing.some((t) => (t || '').trim().toLowerCase() === cleanTbl.toLowerCase())) {
        existing.push(cleanTbl);
      }
      next[matchedKey] = existing;
      return next;
    });
  }

  public closeTableTab(tableName: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const cleanTbl = (tableName || '').trim();
    const currentDb = (this.activeDatabaseName() || '').trim();
    if (!cleanTbl || !currentDb) return;

    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.flushAllDirtyRowsAutoSave();

    this.openTableTabsByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === currentDb.toLowerCase()) {
          next[k] = (next[k] || []).filter(
            (t) => (t || '').trim().toLowerCase() !== cleanTbl.toLowerCase()
          );
        }
      }
      return next;
    });

    const isClosingActive =
      this.activeTableName().trim().toLowerCase() === cleanTbl.toLowerCase();
    if (!isClosingActive) {
      return;
    }

    const remainingOpen = this.openTablesForActiveDatabase();
    if (remainingOpen.length > 0) {
      const nextTbl = remainingOpen[remainingOpen.length - 1].tableName;
      this.switchTable(nextTbl);
    } else {
      this.activeTableName.set('');
      this.workspaceName.set(currentDb);
      this.workspaceNameControl.setValue(currentDb);
      const activeTabId = this.activeDatabaseTabId();
      this.databaseTabs.update((tabs) =>
        tabs.map((t) =>
          t.tabId === activeTabId || t.databaseName.toLowerCase() === currentDb.toLowerCase()
            ? { ...t, activeTableName: '' }
            : t
        )
      );
      this.columns.set([]);
      this.rows.set([]);
      this.dbTotalRows.set(0);
      this.dbFilteredTotalRows.set(0);
      this.dbHasMoreRows.set(false);
      this.selectedRowIds.set(new Set());
      this.selectedColumnId.set(null);
      this.activeCell.set(null);
      this.editingCell.set(null);
      this.cellValidationErrors.set({});
      this.pendingUnsavedRowIds.set(new Set());
      this.pendingUnsavedColIds.set(new Set());
    }
  }

  public renameTableInLastUsedOrder(
    databaseName: string,
    oldTableName: string,
    newTableName: string
  ): void {
    const cleanDb = (databaseName || '').trim();
    const cleanOld = (oldTableName || '').trim();
    const cleanNew = (newTableName || '').trim();
    if (!cleanDb || !cleanOld || !cleanNew) return;

    this.tableLastUsedOrderByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === cleanDb.toLowerCase()) {
          const list = Array.isArray(next[k]) ? next[k] : [];
          const replaced = list.map((t) =>
            (t || '').trim().toLowerCase() === cleanOld.toLowerCase() ? cleanNew : t
          );
          if (!replaced.some((t) => t.trim().toLowerCase() === cleanNew.toLowerCase())) {
            replaced.unshift(cleanNew);
          }
          next[k] = replaced;
        }
      }
      return next;
    });
    this.openTableTabsByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === cleanDb.toLowerCase()) {
          const list = Array.isArray(next[k]) ? next[k] : [];
          next[k] = list.map((t) =>
            (t || '').trim().toLowerCase() === cleanOld.toLowerCase() ? cleanNew : t
          );
        }
      }
      return next;
    });
    this.saveTableLastUsedOrderToStorage();
  }

  public removeTableFromLastUsedOrder(databaseName: string, tableName: string): void {
    const cleanDb = (databaseName || '').trim();
    const cleanTbl = (tableName || '').trim();
    if (!cleanDb || !cleanTbl) return;

    this.tableLastUsedOrderByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === cleanDb.toLowerCase()) {
          next[k] = (next[k] || []).filter(
            (t) => (t || '').trim().toLowerCase() !== cleanTbl.toLowerCase()
          );
        }
      }
      return next;
    });
    this.openTableTabsByDb.update((prev) => {
      const next: Record<string, string[]> = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.trim().toLowerCase() === cleanDb.toLowerCase()) {
          next[k] = (next[k] || []).filter(
            (t) => (t || '').trim().toLowerCase() !== cleanTbl.toLowerCase()
          );
        }
      }
      return next;
    });
    this.saveTableLastUsedOrderToStorage();
  }

  public getLastUsedTableForDatabase(databaseName: string): string {
    const cleanDb = (databaseName || '').trim();
    if (!cleanDb) return '';
    const dbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === cleanDb.toLowerCase()
    );
    const availableTables = dbObj?.tables || [];
    const openNames = this.getOpenTableNamesForDb(cleanDb);
    if (openNames.length === 0) return '';

    const orderMap = this.tableLastUsedOrderByDb();
    for (const [k, list] of Object.entries(orderMap)) {
      if (k.trim().toLowerCase() === cleanDb.toLowerCase() && Array.isArray(list)) {
        for (const candidate of list) {
          const candLower = (candidate || '').trim().toLowerCase();
          const isOpen = openNames.some((o) => (o || '').trim().toLowerCase() === candLower);
          if (!isOpen) continue;
          const matched = availableTables.find(
            (t) => t.tableName.toLowerCase() === candLower
          );
          if (matched) return matched.tableName;
        }
      }
    }
    const lastOpen = openNames[openNames.length - 1];
    const matchedOpen = availableTables.find(
      (t) => t.tableName.toLowerCase() === (lastOpen || '').trim().toLowerCase()
    );
    return matchedOpen ? matchedOpen.tableName : lastOpen || '';
  }

  /**
   * Returns the display label for a top Database Tab:
   * Displays the active Database Name e.g. [DatabaseName].
   */
  public getDatabaseTabDisplayTableName(dbTab: DatabaseWorkspaceTab): string {
    const dbName = (
      dbTab.databaseName ||
      (dbTab.tabId === this.activeDatabaseTabId() ? this.activeDatabaseName() : '')
    ).trim();
    return dbName || 'No Active Connection';
  }

  public isServerRootNodeExpanded(): boolean {
    if (this.manageTreeSearchQuery().trim().length > 0) return true;
    return this.isServerNodeExpanded();
  }

  public toggleServerNode(event?: Event): void {
    event?.stopPropagation();
    const nextVal = !this.isServerNodeExpanded();
    this.isServerNodeExpanded.set(nextVal);
    this.saveSidebarTreeStateToStorage();
    if (nextVal) {
      this.refreshObjectExplorerTreeFromDb();
    }
  }

  public isDatabasesFolderNodeExpanded(): boolean {
    if (this.manageTreeSearchQuery().trim().length > 0) return true;
    return this.isDatabasesFolderExpanded();
  }

  public toggleDatabasesFolderNode(event?: Event): void {
    event?.stopPropagation();
    const nextVal = !this.isDatabasesFolderExpanded();
    this.isDatabasesFolderExpanded.set(nextVal);
    this.saveSidebarTreeStateToStorage();
    if (nextVal) {
      this.refreshObjectExplorerTreeFromDb();
    }
  }

  public isDatabaseNodeExpanded(dbName: string): boolean {
    if (this.manageTreeSearchQuery().trim().length > 0) return true;
    return this.expandedDatabaseNodes().has(dbName);
  }

  public toggleDatabaseNode(dbName: string, event?: Event): void {
    event?.stopPropagation();
    let willExpand = false;
    this.expandedDatabaseNodes.update((prev) => {
      const next = new Set(prev);
      if (next.has(dbName)) {
        next.delete(dbName);
      } else {
        next.add(dbName);
        willExpand = true;
      }
      return next;
    });
    this.saveSidebarTreeStateToStorage();
    if (willExpand) {
      this.refreshObjectExplorerTreeFromDb();
    }
  }

  public isTableNodeExpanded(dbName: string, tableName: string): boolean {
    if (this.manageTreeSearchQuery().trim().length > 0) return true;
    return this.expandedTableNodes().has(`${dbName}::${tableName}`);
  }

  public toggleTableNode(dbName: string, tableName: string, event?: Event): void {
    event?.stopPropagation();
    const key = `${dbName}::${tableName}`;
    let willExpand = false;
    this.expandedTableNodes.update((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        willExpand = true;
      }
      return next;
    });
    this.saveSidebarTreeStateToStorage();
    if (willExpand) {
      this.refreshObjectExplorerTreeFromDb();
    }
  }

  public expandAllManageTree(event?: Event): void {
    event?.stopPropagation();
    this.refreshObjectExplorerTreeFromDb();
    const dbSet = new Set<string>();
    const tblSet = new Set<string>();
    for (const db of this.databases()) {
      dbSet.add(db.databaseName);
      for (const t of db.tables || []) {
        tblSet.add(`${db.databaseName}::${t.tableName}`);
      }
    }
    this.isServerNodeExpanded.set(true);
    this.isDatabasesFolderExpanded.set(true);
    this.expandedDatabaseNodes.set(dbSet);
    this.expandedTableNodes.set(tblSet);
    this.saveSidebarTreeStateToStorage();
  }

  public collapseAllManageTree(event?: Event): void {
    event?.stopPropagation();
    this.isServerNodeExpanded.set(false);
    this.isDatabasesFolderExpanded.set(false);
    this.expandedDatabaseNodes.set(new Set());
    this.expandedTableNodes.set(new Set());
    this.saveSidebarTreeStateToStorage();
  }

  public getColumnsForManageTable(dbName: string, tbl: DbTableSummary): GridColumn[] {
    if (
      dbName.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
      tbl.tableName.toLowerCase() === this.activeTableName().toLowerCase()
    ) {
      return this.sortedColumns();
    }
    return [...(tbl.columns || [])].sort((a, b) => a.orderIndex - b.orderIndex);
  }

  public getSqlDatatypeName(col: GridColumn): string {
    if (col.isPrimaryKey || col.isIdentity) return 'int';
    switch (col.colType) {
      case 'number':
        return 'int';
      case 'text':
        return 'varchar';
      case 'varchar_max':
        return 'varchar(max)';
      case 'lookup':
        return 'lookup';
      case 'date':
        return 'date';
      case 'checkbox':
        return 'bit';
      case 'dropdown':
        return 'varchar';
      case 'formula':
        return 'formula';
      default:
        return 'varchar';
    }
  }

  /**
   * Formats a column node in the Manage sidebar tree like MS SQL Server Object Explorer:
   * e.g., "price (int, not null)" or "ID (PK, int, not null)"
   */
  public formatColumnManageTreeMeta(col: GridColumn): string {
    const sqlType = this.getSqlDatatypeName(col);
    const nullLabel =
      col.isPrimaryKey || col.isIdentity || col.isNullable === false || col.required
        ? 'not null'
        : 'null';
    if (col.isPrimaryKey || col.isIdentity) {
      return `(PK, ${sqlType}, ${nullLabel})`;
    }
    if (col.colType === 'lookup' && col.lookupTableName) {
      return `(FK -> ${col.lookupTableName}, json, ${nullLabel})`;
    }
    return `(${sqlType}, ${nullLabel})`;
  }

  public selectDatabaseFromTree(dbName: string, event?: Event): void {
    event?.stopPropagation();
    // Database selection only happens from the DB dropdown inside the sidebar;
    // clicking a database node in the tree only expands/collapses its tables node.
    this.toggleDatabaseNode(dbName, event);
  }

  public selectTableFromTree(dbName: string, tableName: string, event?: Event): void {
    event?.stopPropagation();
    // Clicking or double-clicking a table in Object Explorer only toggles its column tree;
    // opening the table onto the screen is done via right-click -> "Select".
    this.toggleTableNode(dbName, tableName, event);
  }

  /**
   * Right-click context menu action ("Select") on a table in Object Explorer:
   * Opens the table tab in the bottom bar and displays the selected table onto the screen.
   */
  public selectTableFromContextMenu(dbName: string, tableName: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const cleanDb = (dbName || '').trim();
    const cleanTbl = (tableName || '').trim();
    if (!cleanDb || !cleanTbl) return;

    this.openTableTab(cleanDb, cleanTbl);

    if (
      !this.hasActiveConnection() ||
      cleanDb.toLowerCase() !== this.activeDatabaseName().toLowerCase()
    ) {
      this.switchDatabase(cleanDb, cleanTbl, event, true);
      return;
    }

    if (cleanTbl.toLowerCase() !== this.activeTableName().toLowerCase()) {
      this.switchTable(cleanTbl, event);
    } else {
      this.fetchWorkspaceFromServer(false, cleanTbl, cleanDb);
    }
  }

  public selectColumnFromTree(
    dbName: string,
    tableName: string,
    col: GridColumn,
    event?: Event
  ): void {
    event?.stopPropagation();
    if (
      dbName.toLowerCase() !== this.activeDatabaseName().toLowerCase() ||
      tableName.toLowerCase() !== this.activeTableName().toLowerCase()
    ) {
      return;
    }
    this.selectedColumnId.set(col.id);
    const firstRow = this.visibleRows()[0];
    if (firstRow) {
      this.selectCell(firstRow.id, col.id);
    }
  }

  public openCreateTableForDatabaseFromTree(dbName: string, event?: Event): void {
    event?.stopPropagation();
    this.openCreateTableModal(event, dbName);
  }

  public openAddColumnForTableFromTree(
    dbName: string,
    tableName: string,
    event?: Event
  ): void {
    event?.stopPropagation();
    this.openAddColumnModal(dbName, tableName);
  }

  public isProtectedIdColumn(col?: GridColumn | null): boolean {
    if (!col) return false;
    return Boolean(
      col.isPrimaryKey ||
        col.isIdentity ||
        col.id.trim().toLowerCase() === 'id' ||
        col.name.trim().toLowerCase() === 'id'
    );
  }

  public isIdPrimaryKeyColumn(col?: GridColumn | null): boolean {
    return this.isProtectedIdColumn(col);
  }

  public isColumnIdProtected(colId?: string | null): boolean {
    if (!colId) return false;
    if (colId.trim().toLowerCase() === 'id') return true;
    const col = this.columns().find(
      (c) => c.id === colId || c.name.toLowerCase() === colId.trim().toLowerCase()
    );
    return this.isProtectedIdColumn(col);
  }

  public isColumnIdPrimaryKey(colId?: string | null): boolean {
    return this.isColumnIdProtected(colId);
  }

  public onSidebarContextMenu(
    event: MouseEvent,
    targetType: 'databases_folder' | 'database' | 'table' | 'field',
    databaseName = '',
    tableName = '',
    column: GridColumn | null = null
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.openSidebarContextMenuAt(
      event.clientX,
      event.clientY,
      targetType,
      databaseName,
      tableName,
      column
    );
  }

  public onSidebarTouchStart(
    event: TouchEvent,
    targetType: 'databases_folder' | 'database' | 'table' | 'field',
    databaseName = '',
    tableName = '',
    column: GridColumn | null = null
  ): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
    }
    const touch = event.touches[0];
    if (!touch) return;
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    this.longPressTimer = setTimeout(() => {
      this.openSidebarContextMenuAt(
        clientX,
        clientY,
        targetType,
        databaseName,
        tableName,
        column
      );
    }, 480);
  }

  public onSidebarTouchEndOrMove(): void {
    this.onTouchEndOrMove();
  }

  public openRenameSidebarModal(
    targetType: 'database' | 'table' | 'field',
    dbName: string,
    tableName = '',
    col: GridColumn | null = null,
    event?: Event
  ): void {
    this.openRenameSidebarItemModal(targetType, dbName, tableName, col, event);
  }

  public submitRenameSidebarModal(): void {
    this.submitRenameSidebarItemModal();
  }

  public openSidebarContextMenuAt(
    clientX: number,
    clientY: number,
    targetType: 'databases_folder' | 'database' | 'table' | 'field',
    databaseName: string,
    tableName: string,
    column: GridColumn | null
  ): void {
    if (this.contextMenu().visible) {
      this.contextMenu.update((m) => ({ ...m, visible: false }));
    }
    if (this.isSettingsDropdownOpen()) {
      this.isSettingsDropdownOpen.set(false);
    }

    const vw = this.isBrowser ? window.innerWidth : 1280;
    const vh = this.isBrowser ? window.innerHeight : 800;
    const menuWidth = Math.min(260, Math.max(190, vw - 24));
    const menuHeight = Math.min(320, Math.max(140, vh - 24));

    const clampedX = Math.max(10, Math.min(clientX, vw - menuWidth - 10));
    const clampedY = Math.max(10, Math.min(clientY, vh - menuHeight - 10));

    this.sidebarContextMenu.set({
      visible: true,
      x: clampedX,
      y: clampedY,
      targetType,
      databaseName,
      tableName,
      column,
    });
  }

  public openRenameSidebarItemModal(
    targetType: 'database' | 'table' | 'field',
    dbName: string,
    tableName = '',
    col: GridColumn | null = null,
    event?: Event
  ): void {
    event?.stopPropagation();
    this.closeAllMenus();

    if (targetType === 'table') {
      this.openEditTableModal(dbName, tableName, event);
      return;
    }

    if (targetType === 'field' && this.isProtectedIdColumn(col)) {
      this.showBanner(
        'info',
        `The "${col?.name || 'ID'}" primary key field cannot be edited or renamed until the table "${tableName}" itself is deleted.`
      );
      return;
    }

    this.renameSidebarTargetType.set(targetType);
    this.renameSidebarDbName.set(dbName);
    this.renameSidebarTableName.set(tableName);
    this.renameSidebarColumn.set(col);
    this.renameSidebarErrorMessage.set('');
    this.isRenamingSidebarItem.set(false);

    const initialName = targetType === 'database' ? dbName : col?.name || '';
    this.renameSidebarControl.setValue(initialName);
    this.activeModal.set('rename_sidebar_item');
  }

  public submitRenameSidebarItemModal(): void {
    if (this.isRenamingSidebarItem()) return;
    const targetType = this.renameSidebarTargetType();
    const dbName = this.renameSidebarDbName().trim();
    const tableName = this.renameSidebarTableName().trim();
    const col = this.renameSidebarColumn();
    const cleanNewName = this.renameSidebarControl.value.trim();

    if (!cleanNewName) {
      this.renameSidebarErrorMessage.set('Please enter a valid name.');
      return;
    }

    if (targetType === 'database') {
      if (cleanNewName === dbName) {
        this.activeModal.set('none');
        return;
      }
      this.isRenamingSidebarItem.set(true);
      this.http
        .post<{
          ok: boolean;
          error?: string;
          renamedDatabaseName?: string;
          activeDatabaseName?: string;
          databases?: DbDatabaseSummary[];
          activeTableName?: string;
          tables?: DbTableSummary[];
          activities?: ActivityLogItem[];
        }>('/api/workspace/databases/rename', {
          oldDatabaseName: dbName,
          newDatabaseName: cleanNewName,
          userName: this.currentUserName(),
          userColor: this.currentUserColor(),
        })
        .subscribe({
          next: (res) => {
            this.isRenamingSidebarItem.set(false);
            if (!res?.ok) {
              this.renameSidebarErrorMessage.set(res?.error || 'Could not rename database.');
              return;
            }
            const nextDbName = res.renamedDatabaseName || cleanNewName;
            const wasActiveDb =
              dbName.toLowerCase() === this.activeDatabaseName().toLowerCase();
            if (Array.isArray(res.databases)) {
              this.databases.set(res.databases);
            }
            if (wasActiveDb) {
              this.activeDatabaseName.set(nextDbName);
              this.syncTablesSignalForActiveDatabase(this.databases(), nextDbName);
            } else {
              this.syncTablesSignalForActiveDatabase(this.databases());
            }
            this.databaseTabs.update((tabs) =>
              tabs.map((t) =>
                t.databaseName.toLowerCase() === dbName.toLowerCase()
                  ? { ...t, databaseName: nextDbName }
                  : t
              )
            );
            if (Array.isArray(res.activities)) {
              this.activities.set(res.activities);
            }
            this.expandedDatabaseNodes.update((prev) => {
              const next = new Set(prev);
              if (next.has(dbName)) {
                next.delete(dbName);
                next.add(nextDbName);
              }
              return next;
            });
            this.expandedTableNodes.update((prev) => {
              const next = new Set<string>();
              const oldPrefix = `${dbName}::`;
              for (const k of prev) {
                if (k.startsWith(oldPrefix)) {
                  next.add(`${nextDbName}::${k.slice(oldPrefix.length)}`);
                } else {
                  next.add(k);
                }
              }
              return next;
            });
            this.saveSidebarTreeStateToStorage();
            this.activeModal.set('none');
            this.showBanner('success', `Renamed database "${dbName}" to "${nextDbName}".`);
          },
          error: () => {
            this.isRenamingSidebarItem.set(false);
            this.renameSidebarErrorMessage.set('Server error while renaming database.');
          },
        });
      return;
    }

    if (targetType === 'table') {
      if (cleanNewName === tableName) {
        this.activeModal.set('none');
        return;
      }
      this.isRenamingSidebarItem.set(true);
      this.http
        .post<{
          ok: boolean;
          error?: string;
          renamedTableName?: string;
          activeDatabaseName?: string;
          databases?: DbDatabaseSummary[];
          activeTableName?: string;
          tables?: DbTableSummary[];
          activities?: ActivityLogItem[];
        }>('/api/workspace/tables/rename', {
          databaseName: dbName,
          oldTableName: tableName,
          newTableName: cleanNewName,
          userName: this.currentUserName(),
          userColor: this.currentUserColor(),
        })
        .subscribe({
          next: (res) => {
            this.isRenamingSidebarItem.set(false);
            if (!res?.ok) {
              this.renameSidebarErrorMessage.set(res?.error || 'Could not rename table.');
              return;
            }
            const nextTblName = res.renamedTableName || cleanNewName;
            const isTargetActiveDb =
              dbName.toLowerCase() === this.activeDatabaseName().toLowerCase();
            if (Array.isArray(res.databases)) {
              this.databases.set(res.databases);
            }
            this.syncTablesSignalForActiveDatabase(this.databases());
            if (
              isTargetActiveDb &&
              tableName.toLowerCase() === this.activeTableName().toLowerCase()
            ) {
              this.activeTableName.set(nextTblName);
              this.workspaceName.set(nextTblName || this.activeDatabaseName());
              this.workspaceNameControl.setValue(nextTblName || this.activeDatabaseName());
            }
            this.renameTableInLastUsedOrder(dbName, tableName, nextTblName);
            this.databaseTabs.update((tabs) =>
              tabs.map((t) =>
                t.databaseName.toLowerCase() === dbName.toLowerCase() &&
                t.activeTableName.toLowerCase() === tableName.toLowerCase()
                  ? { ...t, activeTableName: nextTblName }
                  : t
              )
            );
            if (Array.isArray(res.activities)) {
              this.activities.set(res.activities);
            }
            this.expandedTableNodes.update((prev) => {
              const next = new Set(prev);
              const oldKey = `${dbName}::${tableName}`;
              if (next.has(oldKey)) {
                next.delete(oldKey);
                next.add(`${dbName}::${nextTblName}`);
              }
              return next;
            });
            this.saveSidebarTreeStateToStorage();
            this.activeModal.set('none');
            this.showBanner('success', `Renamed table "${tableName}" to "${nextTblName}".`);
          },
          error: () => {
            this.isRenamingSidebarItem.set(false);
            this.renameSidebarErrorMessage.set('Server error while renaming table.');
          },
        });
      return;
    }

    if (targetType === 'field' && col) {
      if (this.isProtectedIdColumn(col)) {
        this.renameSidebarErrorMessage.set(
          `The "${col.name}" primary key field cannot be renamed until the table "${tableName}" itself is deleted.`
        );
        return;
      }
      if (cleanNewName.toLowerCase() === 'id') {
        this.renameSidebarErrorMessage.set('Field name "ID" is reserved for the Primary Key.');
        return;
      }
      this.openEditColumnFromTree(dbName, tableName, col);
      this.columnSchemaForm.patchValue({ name: cleanNewName });
      this.saveColumnSchema();
    }
  }

  public openEditColumnFromTree(
    dbName: string,
    tableName: string,
    col: GridColumn,
    event?: Event
  ): void {
    event?.stopPropagation();
    if (this.isProtectedIdColumn(col)) {
      this.showBanner(
        'info',
        `The "${col.name}" primary key field cannot be edited or deleted until the table "${tableName}" itself is deleted.`
      );
      return;
    }
    this.openEditColumnModal(col, event, dbName, tableName);
  }

  public deleteColumnFromTree(
    dbName: string,
    tableName: string,
    col: GridColumn,
    event?: Event
  ): void {
    event?.stopPropagation();
    if (this.isProtectedIdColumn(col)) {
      this.showBanner(
        'info',
        `The "${col.name}" primary key field cannot be deleted until the table "${tableName}" itself is deleted.`
      );
      return;
    }
    const isTargetActive =
      dbName.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
      tableName.toLowerCase() === this.activeTableName().toLowerCase();
    if (isTargetActive) {
      this.deleteColumn(col.id, event);
      return;
    }

    this.closeAllMenus();
    this.requestConfirmation(
      'Confirm Drop Field',
      `Are you sure you want to drop the field "${col.name}" from table "${dbName}.${tableName}"?`,
      `Drop "${col.name}"`,
      'danger',
      () => {
        const dbObj = this.databases().find(
          (d) => d.databaseName.toLowerCase() === dbName.toLowerCase()
        );
        const tblObj = dbObj?.tables?.find(
          (t) => t.tableName.toLowerCase() === tableName.toLowerCase()
        );
        const nextCols = (tblObj?.columns || []).filter((c) => c.id !== col.id);

        this.databases.update((dbs) =>
          dbs.map((db) => {
            if (db.databaseName.toLowerCase() !== dbName.toLowerCase()) return db;
            return {
              ...db,
              tables: (db.tables || []).map((t) =>
                t.tableName.toLowerCase() === tableName.toLowerCase()
                  ? { ...t, columnCount: nextCols.length, columns: nextCols }
                  : t
              ),
            };
          })
        );
        if (dbName.toLowerCase() === this.activeDatabaseName().toLowerCase()) {
          this.tables.update((list) =>
            list.map((t) =>
              t.tableName.toLowerCase() === tableName.toLowerCase()
                ? { ...t, columnCount: nextCols.length, columns: nextCols }
                : t
            )
          );
        }

        this.http
          .post<{
            ok: boolean;
            databases?: DbDatabaseSummary[];
            tables?: DbTableSummary[];
            columns?: GridColumn[];
            rows?: GridRow[];
            activities?: ActivityLogItem[];
          }>('/api/workspace/sync', {
            clientId: this.currentClientId(),
            userName: this.currentUserName(),
            userColor: this.currentUserColor(),
            actionType: 'Field Deleted',
            actionDetail: `Removed field "${col.name}" from "${dbName}.${tableName}"`,
            databaseName: dbName,
            tableName,
            preserveActiveContext: true,
            columns: nextCols,
          })
          .subscribe({
            next: (res) => {
              if (Array.isArray(res?.databases)) {
                this.databases.set(res.databases);
                this.syncTablesSignalForActiveDatabase(res.databases);
              }
              if (Array.isArray(res?.columns)) {
                this.columns.set(res.columns);
                if (Array.isArray(res?.rows)) {
                  const sanitized = this.sanitizeClientRowsAgainstColumns(res.columns, res.rows);
                  this.rows.set(sanitized);
                  this.snapshotValidRows(sanitized);
                }
              }
              if (Array.isArray(res?.activities)) {
                this.activities.set(res.activities);
              }
              this.showBanner('info', `Deleted field "${col.name}" from "${tableName}".`);
            },
          });
      }
    );
  }

  public syncLocalActiveTableIntoDatabasesTree(): void {
    const activeDb = this.activeDatabaseName();
    const activeTbl = this.activeTableName();
    if (!activeDb || !activeTbl) return;
    const currentCols = this.sortedColumns();
    const currentRowCount = this.rows().length;

    this.tables.update((list) =>
      list.map((t) =>
        t.tableName.toLowerCase() === activeTbl.toLowerCase()
          ? {
              ...t,
              columnCount: currentCols.length,
              columns: currentCols,
              rowCount: Math.max(t.rowCount, currentRowCount),
            }
          : t
      )
    );

    this.databases.update((dbs) =>
      dbs.map((db) => {
        if (db.databaseName.toLowerCase() !== activeDb.toLowerCase()) return db;
        return {
          ...db,
          activeTableName: activeTbl,
          tables: (db.tables || []).map((t) =>
            t.tableName.toLowerCase() === activeTbl.toLowerCase()
              ? {
                  ...t,
                  columnCount: currentCols.length,
                  columns: currentCols,
                  rowCount: Math.max(t.rowCount, currentRowCount),
                }
              : t
          ),
        };
      })
    );
  }

  // =========================================================================
  // MULTI-DATABASE ENGINE: CREATE DATABASE, SWITCH DATABASE & DROP DATABASE
  // =========================================================================

  public openCreateDatabaseModal(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    this.createDatabaseErrorMessage.set('');
    const nextNum = this.databases().length + 1;
    this.newDatabaseForm.reset({
      databaseName: `Database_${nextNum}`,
      createStarterTable: false,
      starterTableName: 'Table_1',
    });
    this.activeModal.set('create_database');
  }

  public submitCreateDatabaseModal(): void {
    if (this.isCreatingDatabase()) return;
    this.createDatabaseErrorMessage.set('');
    const raw = this.newDatabaseForm.getRawValue();
    const databaseName = raw.databaseName.trim();
    if (!databaseName) {
      this.createDatabaseErrorMessage.set('Please enter a database name.');
      return;
    }

    this.isCreatingDatabase.set(true);
    this.http
      .post<{
        ok: boolean;
        error?: string;
        activeDatabaseName?: string;
        databases?: DbDatabaseSummary[];
        activeTableName?: string;
        tables?: DbTableSummary[];
        columns?: GridColumn[];
        rows?: GridRow[];
        totalRows?: number;
        filteredTotalRows?: number;
        hasMore?: boolean;
        uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
        activities?: ActivityLogItem[];
      }>('/api/workspace/databases', {
        databaseName,
        createStarterTable: raw.createStarterTable,
        starterTableName: raw.starterTableName.trim() || 'Table_1',
        userName: this.currentUserName(),
        userColor: this.currentUserColor(),
      })
      .subscribe({
        next: (res) => {
          this.isCreatingDatabase.set(false);
          if (!res?.ok) {
            this.createDatabaseErrorMessage.set(
              res?.error || 'Could not create database in backend.'
            );
            return;
          }

          const createdDb = res.activeDatabaseName || databaseName;
          const activeTbl = res.activeTableName ?? '';
          const cols = Array.isArray(res.columns) ? res.columns : [];
          const rawRows = Array.isArray(res.rows) ? res.rows : [];
          const sanitizedRows = this.sanitizeClientRowsAgainstColumns(cols, rawRows);

          this.activeDatabaseName.set(createdDb);
          if (Array.isArray(res.databases)) {
            this.databases.set(res.databases);
          }
          this.activeTableName.set(activeTbl);
          this.workspaceName.set(activeTbl || createdDb);
          this.workspaceNameControl.setValue(activeTbl || createdDb);
          this.syncTablesSignalForActiveDatabase(this.databases(), createdDb);
          this.columns.set(cols);
          this.rows.set(sanitizedRows);
          this.visibleRowLimit.set(Math.max(this.lazyBatchSize, sanitizedRows.length));
          this.dbTotalRows.set(res.totalRows ?? sanitizedRows.length);
          this.dbFilteredTotalRows.set(res.filteredTotalRows ?? sanitizedRows.length);
          this.dbHasMoreRows.set(Boolean(res.hasMore));
          this.dbUniqueValuesByColumn.set(res.uniqueValuesByColumn || {});
          if (Array.isArray(res.activities)) {
            this.activities.set(res.activities);
          }

          // Open or activate a dedicated SQL Server Database Tab for the newly created database
          if (activeTbl && raw.createStarterTable) {
            this.openTableTab(createdDb, activeTbl);
            this.recordTableUsed(createdDb, activeTbl);
          } else {
            this.activeTableName.set('');
            this.columns.set([]);
            this.rows.set([]);
          }
          this.ensureDatabaseTabOpenedAndActive(
            createdDb,
            raw.createStarterTable ? activeTbl : '',
            true
          );

          this.editingCell.set(null);
          this.activeCell.set(null);
          this.selectedRowIds.set(new Set());
          this.cellValidationErrors.set({});
          this.pendingUnsavedRowIds.set(new Set());
          this.pendingUnsavedColIds.set(new Set());
          this.sortRules.set([]);
          this.filterRules.set({});
          this.columnHeaderSearches.set({});
          this.globalSearchQuery.set('');
          this.searchInputControl.setValue('');
          this.snapshotValidRows(sanitizedRows);

          this.activeModal.set('none');
          this.isManageSidebarOpen.set(true);
          this.showBanner(
            'success',
            `Created database "${createdDb}" and connected it in a new Database Tab.`
          );
        },
        error: () => {
          this.isCreatingDatabase.set(false);
          this.createDatabaseErrorMessage.set('Server error while creating database.');
        },
      });
  }

  /**
   * Ensures a SQL Server Database Tab exists for `databaseName` and sets it as the active tab.
   * If the currently active tab is a blank "Select Database" tab (`!databaseName`), it binds that tab.
   * If `forceNewTab` is true and no tab for `databaseName` exists, it appends a new tab.
   */
  public ensureDatabaseTabOpenedAndActive(
    databaseName: string,
    activeTableName = '',
    openInNewTabIfNotFound = true
  ): void {
    const cleanDb = (databaseName || '').trim();
    if (!cleanDb) return;
    const currentTabs = this.databaseTabs();
    const currentActiveId = this.activeDatabaseTabId();
    const currentActiveTab = currentTabs.find((t) => t.tabId === currentActiveId);

    // If the currently focused tab is a newly created blank tab waiting for database selection, bind it!
    if (currentActiveTab && !currentActiveTab.databaseName) {
      this.databaseTabs.update((tabs) =>
        tabs.map((t) =>
          t.tabId === currentActiveId
            ? { ...t, databaseName: cleanDb, activeTableName }
            : t
        )
      );
      return;
    }

    // Check if there is already an open tab for this database
    const existingTab = currentTabs.find(
      (t) => t.databaseName.toLowerCase() === cleanDb.toLowerCase()
    );
    if (existingTab) {
      this.activeDatabaseTabId.set(existingTab.tabId);
      if (activeTableName) {
        this.databaseTabs.update((tabs) =>
          tabs.map((t) =>
            t.tabId === existingTab.tabId ? { ...t, activeTableName } : t
          )
        );
      }
      return;
    }

    if (openInNewTabIfNotFound || currentTabs.length === 0) {
      const newTabId = `db_tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this.databaseTabs.update((tabs) => [
        ...tabs,
        {
          tabId: newTabId,
          databaseName: cleanDb,
          activeTableName,
        },
      ]);
      this.activeDatabaseTabId.set(newTabId);
    } else if (currentActiveTab) {
      this.databaseTabs.update((tabs) =>
        tabs.map((t) =>
          t.tabId === currentActiveTab.tabId
            ? { ...t, databaseName: cleanDb, activeTableName }
            : t
        )
      );
    }
  }

  public isDatabaseConnectedInAnyTab(databaseName: string): boolean {
    const clean = (databaseName || '').trim().toLowerCase();
    if (!clean) return false;
    return this.databaseTabs().some((t) => t.databaseName.toLowerCase() === clean);
  }

  /**
   * Right-click sidebar action: Connect / Switch to Database (opens a new Database Tab or activates its tab,
   * disconnects active focus from the previous database, and syncs the sidebar dropdown + bold highlight).
   */
  public connectDatabaseFromSidebar(
    databaseName: string,
    alwaysCreateNewTab = false,
    event?: Event
  ): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const cleanDb = (databaseName || '').trim();
    if (!cleanDb) return;

    if (alwaysCreateNewTab) {
      const openTbl = this.getLastUsedTableForDatabase(cleanDb);
      const newTabId = `db_tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this.databaseTabs.update((tabs) => [
        ...tabs,
        {
          tabId: newTabId,
          databaseName: cleanDb,
          activeTableName: openTbl,
        },
      ]);
      this.activeDatabaseTabId.set(newTabId);
    } else {
      this.ensureDatabaseTabOpenedAndActive(
        cleanDb,
        this.getLastUsedTableForDatabase(cleanDb),
        true
      );
    }

    this.switchDatabase(cleanDb, undefined, event, false);
  }

  /**
   * Right-click sidebar action or Tab close button: Disconnect from `databaseName` and close its Database Tab.
   * Even if there is only 1 tab, allows closing it and shows the blank "No Active Connection" screen.
   */
  public disconnectDatabaseFromSidebar(databaseName: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const cleanDb = (databaseName || '').trim();
    if (!cleanDb) return;

    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.flushAllDirtyRowsAutoSave();

    const remaining = this.databaseTabs().filter(
      (t) => t.databaseName.toLowerCase() !== cleanDb.toLowerCase()
    );
    if (remaining.length > 0) {
      const nextTab = remaining[remaining.length - 1];
      this.databaseTabs.set(remaining);
      this.activeDatabaseTabId.set(nextTab.tabId);
      if (nextTab.databaseName) {
        this.switchDatabase(
          nextTab.databaseName,
          nextTab.activeTableName || undefined,
          undefined,
          false
        );
      }
      return;
    }

    // No active connection tabs remaining -> blank screen with "No Active Connection"
    this.setNoActiveConnectionState();
  }

  private setNoActiveConnectionState(): void {
    this.databaseTabs.set([]);
    this.activeDatabaseTabId.set('');
    this.activeDatabaseName.set('');
    this.activeTableName.set('');
    this.workspaceName.set('');
    this.workspaceNameControl.setValue('');
    this.tables.set([]);
    this.columns.set([]);
    this.rows.set([]);
    this.dbTotalRows.set(0);
    this.dbFilteredTotalRows.set(0);
    this.dbHasMoreRows.set(false);
    this.activeCell.set(null);
    this.editingCell.set(null);
    this.selectedRowIds.set(new Set());
    this.selectedColumnId.set(null);
    this.cellValidationErrors.set({});
    this.pendingUnsavedRowIds.set(new Set());
    this.pendingUnsavedColIds.set(new Set());
  }

  /**
   * Creates a new browser/SSMS-style Database Tab where the user can select which database is active for the tab.
   */
  public createNewDatabaseTab(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    const newTabId = `db_tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.databaseTabs.update((tabs) => [
      ...tabs,
      {
        tabId: newTabId,
        databaseName: '',
        activeTableName: '',
      },
    ]);
    this.activeDatabaseTabId.set(newTabId);
  }

  /**
   * Switches between open SQL Server Database Tabs in the table area and automatically syncs
   * the Object Explorer Available Databases dropdown, bold highlight, and Excel table tabs footer.
   */
  public selectDatabaseTab(tabId: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const tab = this.databaseTabs().find((t) => t.tabId === tabId);
    if (!tab) return;
    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.flushAllDirtyRowsAutoSave();
    this.activeDatabaseTabId.set(tab.tabId);
    if (tab.databaseName) {
      const openTbl = this.getLastUsedTableForDatabase(tab.databaseName);
      this.switchDatabase(tab.databaseName, openTbl || undefined, undefined, false);
    }
  }

  /**
   * Assigns or changes the active database for a specific Database Tab.
   */
  public assignDatabaseToTab(tabId: string, databaseName: string, event?: Event): void {
    event?.stopPropagation();
    const cleanDb = (databaseName || '').trim();
    if (!cleanDb) return;
    const defaultTbl = this.getLastUsedTableForDatabase(cleanDb);
    this.databaseTabs.update((tabs) =>
      tabs.map((t) =>
        t.tabId === tabId
          ? { ...t, databaseName: cleanDb, activeTableName: defaultTbl }
          : t
      )
    );
    this.activeDatabaseTabId.set(tabId);
    this.switchDatabase(cleanDb, defaultTbl || undefined, undefined, false);
  }

  /**
   * Closes/disconnects a Database Tab from the top tab bar.
   * Even when there is only 1 tab, allows closing it and leaves the table screen blank with "No Active Connection".
   */
  public closeDatabaseTab(tabId: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.flushAllDirtyRowsAutoSave();

    const currentTabs = this.databaseTabs();
    const targetTab = currentTabs.find((t) => t.tabId === tabId);
    if (!targetTab) return;

    const remaining = currentTabs.filter((t) => t.tabId !== tabId);
    if (remaining.length === 0) {
      this.setNoActiveConnectionState();
      return;
    }

    this.databaseTabs.set(remaining);
    if (this.activeDatabaseTabId() === tabId) {
      const nextTab = remaining[remaining.length - 1];
      this.activeDatabaseTabId.set(nextTab.tabId);
      if (nextTab.databaseName) {
        const openTbl = this.getLastUsedTableForDatabase(nextTab.databaseName);
        this.switchDatabase(nextTab.databaseName, openTbl || undefined, undefined, false);
      }
    }
  }

  public switchDatabase(
    databaseName: string,
    requestedTableName?: string,
    event?: Event,
    ensureTab = true
  ): void {
    event?.stopPropagation();
    const cleanDb = (databaseName || '').trim();
    if (!cleanDb) return;
    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.flushAllDirtyRowsAutoSave();
    this.closeAllMenus();

    if (requestedTableName) {
      this.openTableTab(cleanDb, requestedTableName);
    }
    const resolvedRequestedTable =
      requestedTableName || this.getLastUsedTableForDatabase(cleanDb) || '';

    if (ensureTab) {
      this.ensureDatabaseTabOpenedAndActive(cleanDb, resolvedRequestedTable, true);
    }

    this.activeDatabaseName.set(cleanDb);
    this.syncTablesSignalForActiveDatabase(this.databases(), cleanDb);
    if (resolvedRequestedTable) {
      this.recordTableUsed(cleanDb, resolvedRequestedTable);
    } else {
      this.activeTableName.set('');
      this.columns.set([]);
      this.rows.set([]);
      this.dbTotalRows.set(0);
      this.dbFilteredTotalRows.set(0);
      this.dbHasMoreRows.set(false);
    }
    this.selectedRowIds.set(new Set());
    this.selectedColumnId.set(null);
    this.activeCell.set(null);
    this.editingCell.set(null);
    this.cellValidationErrors.set({});
    this.pendingUnsavedRowIds.set(new Set());
    this.pendingUnsavedColIds.set(new Set());
    this.sortRules.set([]);
    this.filterRules.set({});
    this.columnHeaderSearches.set({});
    this.globalSearchQuery.set('');
    this.searchInputControl.setValue('');
    this.fetchWorkspaceFromServer(false, resolvedRequestedTable || undefined, cleanDb);
  }

  public deleteDatabase(databaseName: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (this.databases().length <= 1) {
      this.showBanner('error', 'At least one database must remain on the server.');
      return;
    }

    this.requestConfirmation(
      `Drop Database "${databaseName}"`,
      `Are you sure you want to drop the database "${databaseName}" and all of its tables from the backend?`,
      `Drop "${databaseName}"`,
      'danger',
      () => {
        this.http
          .post<{
            ok: boolean;
            error?: string;
            activeDatabaseName?: string;
            databases?: DbDatabaseSummary[];
            activeTableName?: string;
            tables?: DbTableSummary[];
            columns?: GridColumn[];
            rows?: GridRow[];
            totalRows?: number;
            filteredTotalRows?: number;
            hasMore?: boolean;
            uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
            activities?: ActivityLogItem[];
          }>('/api/workspace/databases/delete', {
            databaseName,
            userName: this.currentUserName(),
            userColor: this.currentUserColor(),
          })
          .subscribe({
            next: (res) => {
              if (!res?.ok) {
                this.showBanner('error', res?.error || 'Could not drop database.');
                return;
              }
              const wasActiveDeleted =
                databaseName.toLowerCase() === this.activeDatabaseName().toLowerCase();
              const nextDb = wasActiveDeleted
                ? res.activeDatabaseName || 'GridPulse_DB'
                : this.activeDatabaseName();

              if (Array.isArray(res.databases)) {
                this.databases.set(res.databases);
              }

              // Remove any open Database Tabs for the deleted database
              this.databaseTabs.update((tabs) =>
                tabs.filter((t) => t.databaseName.toLowerCase() !== databaseName.toLowerCase())
              );

              if (wasActiveDeleted) {
                const nextTbl = res.activeTableName ?? '';
                const cols = Array.isArray(res.columns) ? res.columns : [];
                const rawRows = Array.isArray(res.rows) ? res.rows : [];
                const sanitizedRows = this.sanitizeClientRowsAgainstColumns(cols, rawRows);

                this.activeDatabaseName.set(nextDb);
                this.activeTableName.set(nextTbl);
                this.workspaceName.set(nextTbl || nextDb);
                this.workspaceNameControl.setValue(nextTbl || nextDb);
                this.syncTablesSignalForActiveDatabase(this.databases(), nextDb);
                this.ensureDatabaseTabOpenedAndActive(nextDb, nextTbl, true);
                this.columns.set(cols);
                this.rows.set(sanitizedRows);
                this.visibleRowLimit.set(Math.max(this.lazyBatchSize, sanitizedRows.length));
                this.dbTotalRows.set(res.totalRows ?? sanitizedRows.length);
                this.dbFilteredTotalRows.set(res.filteredTotalRows ?? sanitizedRows.length);
                this.dbHasMoreRows.set(Boolean(res.hasMore));
                this.dbUniqueValuesByColumn.set(res.uniqueValuesByColumn || {});
                this.snapshotValidRows(sanitizedRows);
              } else {
                this.syncTablesSignalForActiveDatabase(this.databases());
              }

              if (Array.isArray(res.activities)) {
                this.activities.set(res.activities);
              }
              this.showBanner('info', `Dropped database "${databaseName}" from backend.`);
            },
            error: () => {
              this.showBanner('error', 'Failed to drop database from backend.');
            },
          });
      }
    );
  }

  // =========================================================================
  // MULTI-TABLE ENGINE: CREATE NEW TABLE & EXCEL SHEET TABS FOOTER BAR
  // =========================================================================

  private buildBlankNewTableTopDraft(): NewTableColumnDraft {
    return {
      id: '__top_draft__',
      name: '',
      colType: 'text',
      isNullable: true,
      columnValue: '',
      formula: '',
      optionsCsv: '',
      lookupTableName: '',
      isPrimaryKey: false,
      isIdentity: false,
    };
  }

  public getAvailableLookupTables(
    databaseName?: string,
    includeCurrentTableName?: string
  ): DbTableSummary[] {
    const cleanDb = (databaseName || this.activeDatabaseName() || 'GridPulse_DB').trim();
    const dbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === cleanDb.toLowerCase()
    );
    const baseTables = [...(dbObj?.tables || this.tables() || [])];
    const extraTbl = (includeCurrentTableName || '').trim();
    if (
      extraTbl &&
      !baseTables.some((t) => t.tableName.toLowerCase() === extraTbl.toLowerCase())
    ) {
      const draftCols = this.newTableColumns().filter((c) => c.name.trim().length > 0);
      baseTables.unshift({
        tableName: extraTbl,
        rowCount: 0,
        columnCount: draftCols.length + 1,
        identitySeed: 1,
        identityIncrement: 1,
        nextIdentityValue: 1,
        createdAt: '',
        updatedAt: '',
      });
    }
    return baseTables;
  }

  public getAvailableLookupTablesForSchemaModal(): DbTableSummary[] {
    const dbName = this.targetColumnSchemaDbName() || this.activeDatabaseName();
    const tblName = this.targetColumnSchemaTableName() || this.activeTableName();
    return this.getAvailableLookupTables(dbName, tblName);
  }

  public getAvailableLookupTablesForCreateTableModal(): DbTableSummary[] {
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    const currentTbl =
      this.newTableForm.controls.tableName.value ||
      this.editingTableOriginalName() ||
      this.activeTableName();
    return this.getAvailableLookupTables(dbName, currentTbl);
  }

  public getTargetLookupTableColumns(
    databaseName: string,
    targetTableName: string,
    excludeDraftIndex = -999
  ): GridColumn[] {
    const cleanDb = (databaseName || this.activeDatabaseName() || 'GridPulse_DB').trim();
    const cleanTbl = (targetTableName || '').trim();
    if (!cleanTbl) return [];

    // Check if the target table is the table currently being created/edited in the Create/Edit Table modal
    const modalTblName = (this.newTableForm.controls.tableName.value || '').trim();
    const modalOrigName = (this.editingTableOriginalName() || '').trim();
    if (
      this.activeModal() === 'create_table' &&
      (cleanTbl.toLowerCase() === modalTblName.toLowerCase() ||
        (modalOrigName && cleanTbl.toLowerCase() === modalOrigName.toLowerCase()))
    ) {
      const synthCols: GridColumn[] = [
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
          formula: '',
          optionsCsv: '',
        },
      ];
      const topName = (this.newTableTopDraft().name || '').trim();
      if (excludeDraftIndex !== -1 && topName && topName.toLowerCase() !== 'id') {
        synthCols.push({
          id: topName,
          name: topName,
          colType: this.newTableTopDraft().colType,
          orderIndex: synthCols.length,
          width: 150,
          required: !this.newTableTopDraft().isNullable,
          isNullable: this.newTableTopDraft().isNullable,
          defaultValue: this.newTableTopDraft().columnValue,
          formula: this.newTableTopDraft().formula || '',
          optionsCsv: this.newTableTopDraft().optionsCsv || '',
          lookupTableName: this.newTableTopDraft().lookupTableName || '',
        });
      }
      this.newTableColumns().forEach((draft, idx) => {
        if (idx === excludeDraftIndex) return;
        const dName = (draft.name || '').trim();
        if (
          dName &&
          dName.toLowerCase() !== 'id' &&
          !synthCols.some((c) => c.name.toLowerCase() === dName.toLowerCase())
        ) {
          synthCols.push({
            id: dName,
            name: dName,
            colType: draft.colType,
            orderIndex: synthCols.length,
            width: 150,
            required: !draft.isNullable,
            isNullable: draft.isNullable,
            defaultValue: draft.columnValue,
            formula: draft.formula,
            optionsCsv: draft.optionsCsv,
            lookupTableName: draft.lookupTableName,
          });
        }
      });
      return synthCols;
    }

    const dbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === cleanDb.toLowerCase()
    );
    const tblObj = dbObj?.tables?.find(
      (t) => t.tableName.toLowerCase() === cleanTbl.toLowerCase()
    );
    if (tblObj?.columns && tblObj.columns.length > 0) {
      return [...tblObj.columns].sort((a, b) => a.orderIndex - b.orderIndex);
    }
    if (
      cleanDb.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
      cleanTbl.toLowerCase() === this.activeTableName().toLowerCase()
    ) {
      return this.sortedColumns();
    }
    return [];
  }

  public getTargetLookupTableColumnNames(
    databaseName: string,
    targetTableName: string,
    excludeDraftIndex = -999
  ): string[] {
    const cols = this.getTargetLookupTableColumns(
      databaseName,
      targetTableName,
      excludeDraftIndex
    );
    const names: string[] = ['ID'];
    for (const c of cols) {
      const clean = (c.name || '').trim();
      if (clean && !names.some((n) => n.toLowerCase() === clean.toLowerCase())) {
        names.push(clean);
      }
    }
    return names;
  }

  public getSchemaLookupTargetColumns(): string[] {
    const dbName = this.targetColumnSchemaDbName() || this.activeDatabaseName();
    const linkedTbl = (this.columnSchemaForm.controls.lookupTableName.value || '').trim();
    if (!linkedTbl) return ['ID'];
    const editingId = (this.editingSchemaColId() || '').trim().toLowerCase();
    const targetTbl = (this.targetColumnSchemaTableName() || this.activeTableName()).trim();
    const isSelfTable = linkedTbl.toLowerCase() === targetTbl.toLowerCase();
    return this.getTargetLookupTableColumnNames(dbName, linkedTbl).filter(
      (n) => !isSelfTable || n.toLowerCase() !== editingId
    );
  }

  public isSchemaLookupFieldSelected(fieldName: string): boolean {
    if (fieldName.trim().toLowerCase() === 'id') return true;
    const rawTemplate = this.columnSchemaForm.controls.formula.value || '';
    const tokens = extractLookupTemplateTokens(rawTemplate);
    return tokens.some((t) => t.toLowerCase() === fieldName.trim().toLowerCase());
  }

  public toggleSchemaLookupFieldChip(fieldName: string): void {
    const cleanField = fieldName.trim();
    if (!cleanField || cleanField.toLowerCase() === 'id') return;
    const dbName = this.targetColumnSchemaDbName() || this.activeDatabaseName();
    const linkedTbl = (this.columnSchemaForm.controls.lookupTableName.value || '').trim();
    const targetCols = this.getTargetLookupTableColumns(dbName, linkedTbl);
    const currentRaw = this.columnSchemaForm.controls.formula.value || '';
    const { selectedColumns } = resolveLookupTemplateAndColumns(currentRaw, targetCols);
    const currentNames = selectedColumns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase() !== 'id');

    const exists = currentNames.some((n) => n.toLowerCase() === cleanField.toLowerCase());
    let nextNames: string[];
    if (exists) {
      nextNames = currentNames.filter((n) => n.toLowerCase() !== cleanField.toLowerCase());
    } else {
      nextNames = [...currentNames, cleanField];
    }
    const nextTemplate = formatLookupTemplateFromFieldNames(['ID', ...nextNames]);
    this.columnSchemaForm.controls.formula.setValue(nextTemplate);
    this.onSchemaLookupTemplateInput();
  }

  public onSchemaLookupTemplateInput(): void {
    const linkedTbl = (this.columnSchemaForm.controls.lookupTableName.value || '').trim();
    if (!linkedTbl) return;
    const dbName = this.targetColumnSchemaDbName() || this.activeDatabaseName();
    const rawTemplate = this.columnSchemaForm.controls.formula.value || '';
    const previewJson = this.buildClientLinkedLookupPreviewJson(
      dbName,
      linkedTbl,
      rawTemplate
    );
    if (previewJson) {
      this.columnSchemaForm.controls.optionsCsv.setValue(previewJson);
    }
    const items = this.getSchemaModalLookupItems();
    if (items.length > 0) {
      const currentDefault = (this.columnSchemaForm.controls.defaultValue.value || '').trim();
      const matched = currentDefault ? matchLookupItemFromRaw(items, currentDefault) : undefined;
      if (matched) {
        this.columnSchemaForm.controls.defaultValue.setValue(matched.json);
      } else {
        const activeItem = items.find((i) => i.isActive !== false) || items[0];
        this.columnSchemaForm.controls.defaultValue.setValue(activeItem.json);
      }
    }
  }

  public getDraftLookupTargetColumns(
    lookupTableName: string,
    excludeDraftIndex: number
  ): string[] {
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    return this.getTargetLookupTableColumnNames(
      dbName,
      lookupTableName,
      excludeDraftIndex
    );
  }

  public isDraftLookupFieldSelected(
    draft: NewTableColumnDraft,
    fieldName: string,
    excludeDraftIndex = -999
  ): boolean {
    if (fieldName.trim().toLowerCase() === 'id') return true;
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    const targetCols = this.getTargetLookupTableColumns(
      dbName,
      draft.lookupTableName || '',
      excludeDraftIndex
    );
    const { selectedColumns } = resolveLookupTemplateAndColumns(
      draft.formula || '',
      targetCols
    );
    return selectedColumns.some(
      (c) => c.name.trim().toLowerCase() === fieldName.trim().toLowerCase()
    );
  }

  public toggleTopDraftLookupFieldChip(fieldName: string): void {
    const cleanField = fieldName.trim();
    if (!cleanField || cleanField.toLowerCase() === 'id') return;
    const top = this.newTableTopDraft();
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    const targetCols = this.getTargetLookupTableColumns(
      dbName,
      top.lookupTableName || '',
      -1
    );
    const { selectedColumns } = resolveLookupTemplateAndColumns(
      top.formula || '',
      targetCols
    );
    const currentNames = selectedColumns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase() !== 'id');
    const exists = currentNames.some((n) => n.toLowerCase() === cleanField.toLowerCase());
    const nextNames = exists
      ? currentNames.filter((n) => n.toLowerCase() !== cleanField.toLowerCase())
      : [...currentNames, cleanField];
    const nextTemplate = formatLookupTemplateFromFieldNames(['ID', ...nextNames]);
    this.updateTopNewTableColumnDraft({ formula: nextTemplate });
  }

  public toggleRowDraftLookupFieldChip(index: number, fieldName: string): void {
    const cleanField = fieldName.trim();
    if (!cleanField || cleanField.toLowerCase() === 'id') return;
    const draft = this.newTableColumns()[index];
    if (!draft) return;
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    const targetCols = this.getTargetLookupTableColumns(
      dbName,
      draft.lookupTableName || '',
      index
    );
    const { selectedColumns } = resolveLookupTemplateAndColumns(
      draft.formula || '',
      targetCols
    );
    const currentNames = selectedColumns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase() !== 'id');
    const exists = currentNames.some((n) => n.toLowerCase() === cleanField.toLowerCase());
    const nextNames = exists
      ? currentNames.filter((n) => n.toLowerCase() !== cleanField.toLowerCase())
      : [...currentNames, cleanField];
    const nextTemplate = formatLookupTemplateFromFieldNames(['ID', ...nextNames]);
    this.updateNewTableColumnDraft(index, { formula: nextTemplate });
  }

  public buildClientLinkedLookupPreviewJson(
    databaseName: string,
    targetTableName: string,
    rawTemplate?: string,
    excludeDraftIndex = -999
  ): string {
    const cleanDb = (databaseName || this.activeDatabaseName() || 'GridPulse_DB').trim();
    const cleanTbl = (targetTableName || '').trim();
    if (!cleanTbl) return '';

    const cols = this.getTargetLookupTableColumns(
      cleanDb,
      cleanTbl,
      excludeDraftIndex
    );
    const { selectedColumns } = resolveLookupTemplateAndColumns(rawTemplate, cols);
    const colsToProject = selectedColumns.length > 0 ? selectedColumns : cols;
    const pkCol = cols.find((c) => c.isPrimaryKey || c.isIdentity || c.name.toLowerCase() === 'id');

    // If the target table is currently loaded on screen, build directly from its live rows
    if (
      cleanDb.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
      cleanTbl.toLowerCase() === this.activeTableName().toLowerCase() &&
      this.rows().length > 0
    ) {
      const records = this.rows().map((row, idx) => {
        const obj: Record<string, string | number | boolean> = {};
        const rawPk = pkCol
          ? row.cells[pkCol.name] !== undefined
            ? row.cells[pkCol.name]
            : row.cells[pkCol.id]
          : row.cells['ID'];
        const numericId = Number(rawPk);
        obj['ID'] = Number.isFinite(numericId) && numericId > 0 ? numericId : idx + 1;

        for (const c of colsToProject) {
          if (c.isPrimaryKey || c.isIdentity || c.name.toLowerCase() === 'id') continue;
          if (c.colType === 'formula') {
            obj[c.name] = evaluateFormula(c.formula, row, cols);
          } else {
            const raw = row.cells[c.name] !== undefined ? row.cells[c.name] : row.cells[c.id];
            obj[c.name] = raw !== undefined && raw !== null ? raw : '';
          }
        }
        return obj;
      });
      return JSON.stringify(records);
    }

    // Check if any existing column in the database already has a live synced optionsCsv for this lookupTableName
    const dbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === cleanDb.toLowerCase()
    );
    if (dbObj?.tables) {
      for (const t of dbObj.tables) {
        for (const c of t.columns || []) {
          if (
            c.colType === 'lookup' &&
            c.lookupTableName &&
            c.lookupTableName.toLowerCase() === cleanTbl.toLowerCase() &&
            c.optionsCsv &&
            c.optionsCsv.trim().startsWith('[')
          ) {
            try {
              const parsed = JSON.parse(c.optionsCsv.trim());
              if (Array.isArray(parsed) && parsed.length > 0) {
                const projected = parsed.map((entry: Record<string, unknown>, idx: number) => {
                  const obj: Record<string, string | number | boolean> = {
                    ID: Number(entry['ID'] ?? entry['id'] ?? idx + 1),
                  };
                  for (const selCol of colsToProject) {
                    if (
                      selCol.isPrimaryKey ||
                      selCol.isIdentity ||
                      selCol.name.toLowerCase() === 'id'
                    ) {
                      continue;
                    }
                    const val = entry[selCol.name];
                    obj[selCol.name] =
                      typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
                        ? val
                        : selCol.defaultValue || `${cleanTbl}_${idx + 1}`;
                  }
                  return obj;
                });
                return JSON.stringify(projected);
              }
            } catch {
              // ignore parse error
            }
          }
        }
      }
    }

    // Build schema-accurate preview records from the target table's selected columns (server will populate full table rows on save)
    if (colsToProject.length > 0) {
      const sampleRow: Record<string, string | number | boolean> = { ID: 1 };
      for (const c of colsToProject) {
        if (c.isPrimaryKey || c.isIdentity || c.name.toLowerCase() === 'id') {
          continue;
        } else if (c.colType === 'number' || c.colType === 'formula') {
          sampleRow[c.name] = Number(c.defaultValue) || 1;
        } else if (c.colType === 'checkbox') {
          sampleRow[c.name] = true;
        } else {
          sampleRow[c.name] = c.defaultValue || `${cleanTbl}_1`;
        }
      }
      return JSON.stringify([sampleRow]);
    }

    return '[{"ID":1,"Name":"Record 1"}]';
  }

  public getDraftLookupItems(draft: NewTableColumnDraft): LookupItem[] {
    return getLookupOptions({
      id: draft.id,
      name: draft.name || 'Lookup',
      colType: 'lookup',
      orderIndex: 0,
      width: 160,
      required: !draft.isNullable,
      formula: draft.formula || '',
      optionsCsv: draft.optionsCsv || '',
      lookupTableName: draft.lookupTableName || '',
    });
  }

  public getSchemaModalLookupItems(): LookupItem[] {
    const raw = this.columnSchemaForm.getRawValue();
    return getLookupOptions({
      id: 'schema_preview',
      name: raw.name || 'Lookup',
      colType: 'lookup',
      orderIndex: 0,
      width: 160,
      required: Boolean(raw.required),
      formula: raw.formula || '',
      optionsCsv: raw.optionsCsv || '',
      lookupTableName: raw.lookupTableName || '',
    });
  }

  public openCreateTableModal(event?: Event, targetDatabaseName?: string): void {
    event?.stopPropagation();
    this.closeAllMenus();
    this.editingTableOriginalName.set('');
    this.createTableErrorMessage.set('');
    const dbName = targetDatabaseName || this.activeDatabaseName() || 'GridPulse_DB';
    const targetDbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === dbName.toLowerCase()
    );
    const nextNum = (targetDbObj ? targetDbObj.tables.length : this.tables().length) + 1;
    this.newTableForm.reset({
      databaseName: dbName,
      tableName: `Table_${nextNum}`,
      pkColumnName: 'ID',
      includeDefaultPk: true,
      initialRowCount: 0,
    });
    this.newTableTopDraft.set(this.buildBlankNewTableTopDraft());
    this.newTableColumns.set([]);
    this.activeModal.set('create_table');
  }

  public openEditTableModal(
    databaseName: string,
    tableName: string,
    event?: Event
  ): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const cleanDb = (databaseName || this.activeDatabaseName() || 'GridPulse_DB').trim();
    const cleanTbl = (tableName || this.activeTableName()).trim();
    if (!cleanTbl) return;

    this.editingTableOriginalName.set(cleanTbl);
    this.createTableErrorMessage.set('');
    this.newTableForm.reset({
      databaseName: cleanDb,
      tableName: cleanTbl,
      pkColumnName: 'ID',
      includeDefaultPk: true,
      initialRowCount: 0,
    });
    this.newTableTopDraft.set(this.buildBlankNewTableTopDraft());

    const dbObj = this.databases().find(
      (d) => d.databaseName.toLowerCase() === cleanDb.toLowerCase()
    );
    const tblObj = dbObj?.tables?.find(
      (t) => t.tableName.toLowerCase() === cleanTbl.toLowerCase()
    );
    const sourceCols = tblObj
      ? this.getColumnsForManageTable(cleanDb, tblObj)
      : cleanDb.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
        cleanTbl.toLowerCase() === this.activeTableName().toLowerCase()
      ? this.sortedColumns()
      : [];

    const existingDrafts: NewTableColumnDraft[] = sourceCols
      .filter((c) => !this.isProtectedIdColumn(c))
      .map((c) => {
        let initialFormula = c.formula || '';
        if (c.colType === 'lookup' && c.lookupTableName) {
          const targetCols = this.getTargetLookupTableColumns(cleanDb, c.lookupTableName);
          initialFormula = resolveLookupTemplateAndColumns(c.formula, targetCols).normalizedTemplate;
        }
        return {
          id: c.name,
          name: c.name,
          colType: c.colType,
          isNullable:
            c.colType === 'formula'
              ? true
              : c.isNullable !== undefined
              ? Boolean(c.isNullable)
              : !c.required,
          columnValue: c.defaultValue !== undefined ? String(c.defaultValue) : '',
          formula: initialFormula,
          optionsCsv: c.optionsCsv || '',
          lookupTableName: c.lookupTableName || '',
          isPrimaryKey: false,
          isIdentity: false,
        };
      });

    this.newTableColumns.set(existingDrafts);
    this.activeModal.set('create_table');
  }

  public clearAllNewTableDraftColumns(): void {
    this.newTableTopDraft.set(this.buildBlankNewTableTopDraft());
    this.newTableColumns.set([]);
  }

  public updateTopNewTableColumnDraft(patch: Partial<NewTableColumnDraft>): void {
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    this.newTableTopDraft.update((item) => {
      const updated = { ...item, ...patch };
      if (
        patch.colType === 'lookup' ||
        (updated.colType === 'lookup' &&
          (patch.lookupTableName !== undefined || patch.formula !== undefined))
      ) {
        if (!updated.lookupTableName && patch.lookupTableName === undefined) {
          const avail = this.getAvailableLookupTablesForCreateTableModal();
          const preferred =
            avail.find((t) => t.tableName.toLowerCase().includes('lookup')) || avail[0];
          if (preferred) {
            updated.lookupTableName = preferred.tableName;
          }
        }
        if (updated.lookupTableName) {
          const targetCols = this.getTargetLookupTableColumns(
            dbName,
            updated.lookupTableName,
            -1
          );
          const { normalizedTemplate } = resolveLookupTemplateAndColumns(
            patch.lookupTableName !== undefined && patch.formula === undefined
              ? ''
              : updated.formula,
            targetCols
          );
          updated.formula = normalizedTemplate;
          updated.optionsCsv = this.buildClientLinkedLookupPreviewJson(
            dbName,
            updated.lookupTableName,
            updated.formula,
            -1
          );
          const items = this.getDraftLookupItems(updated);
          if (
            items.length > 0 &&
            (!updated.columnValue ||
              patch.lookupTableName !== undefined ||
              patch.formula !== undefined)
          ) {
            const matched = updated.columnValue
              ? matchLookupItemFromRaw(items, updated.columnValue)
              : undefined;
            const activeItem =
              matched || items.find((it) => it.isActive !== false) || items[0];
            updated.columnValue = activeItem.json;
          }
        } else if (
          !updated.optionsCsv ||
          updated.optionsCsv === 'Option A, Option B' ||
          updated.optionsCsv === 'High, Medium, Low'
        ) {
          if (!updated.formula || !updated.formula.includes('[')) {
            updated.formula = '{[ID], [Name]}';
          }
          updated.optionsCsv = '[{"ID":1,"Name":"car"},{"ID":2,"Name":"bus"},{"ID":3,"Name":"truck"}]';
        }
      } else if (patch.colType === 'dropdown') {
        updated.lookupTableName = '';
        if (!updated.optionsCsv || updated.optionsCsv.trim().startsWith('[')) {
          updated.optionsCsv = 'High, Medium, Low';
        }
      } else if (patch.colType === 'formula') {
        updated.lookupTableName = '';
        updated.isNullable = true;
        if (!updated.formula || updated.formula.trim().startsWith('{')) {
          const numCols = this.newTableColumns().filter(
            (c) => c.colType === 'number' && c.name.trim().length > 0
          );
          if (numCols.length >= 2) {
            updated.formula = `=[${numCols[0].name.trim()}] * [${numCols[1].name.trim()}]`;
          } else if (numCols.length === 1) {
            updated.formula = `=[${numCols[0].name.trim()}] * 2`;
          } else {
            updated.formula = '=[ID] * 10';
          }
        }
      } else if (patch.colType) {
        updated.lookupTableName = '';
      }
      return updated;
    });
  }

  public appendColumnRefToTopNewTableFormula(refColName: string): void {
    const top = this.newTableTopDraft();
    const current = (top.formula || '').trim();
    const prefix = current.startsWith('=') ? current : `=${current}`;
    this.updateTopNewTableColumnDraft({
      formula: `${prefix} [${refColName}]`.trim(),
    });
  }

  public commitTopNewTableColumnDraft(focusTopNameAfter = true): boolean {
    const top = this.newTableTopDraft();
    const cleanName = top.name.trim();
    if (!cleanName) {
      this.createTableErrorMessage.set('Please enter a Field Name in the top row to add a field.');
      if (this.isBrowser) {
        setTimeout(() => {
          document.getElementById('create-tbl-top-name')?.focus();
        }, 10);
      }
      return false;
    }
    if (cleanName.toLowerCase() === 'id') {
      this.createTableErrorMessage.set('Field name "ID" is reserved for the Primary Key.');
      return false;
    }
    if (
      this.newTableColumns().some(
        (c) => c.name.trim().toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      this.createTableErrorMessage.set(`A field named "${cleanName}" is already in the table list.`);
      return false;
    }
    if (top.colType === 'formula' && !top.formula.trim()) {
      this.createTableErrorMessage.set(`Please enter a Formula Expression for "${cleanName}".`);
      return false;
    }
    if (top.colType === 'dropdown' && !top.optionsCsv.trim()) {
      this.createTableErrorMessage.set(`Please enter Dropdown options for "${cleanName}".`);
      return false;
    }
    if (
      top.colType === 'lookup' &&
      !(top.lookupTableName || '').trim() &&
      !top.optionsCsv.trim()
    ) {
      this.createTableErrorMessage.set(
        `Please select a Foreign Key Linked Table or enter Lookup JSON for "${cleanName}".`
      );
      return false;
    }

    this.createTableErrorMessage.set('');
    const newRow: NewTableColumnDraft = {
      ...top,
      id: `draft_col_${Date.now()}_${this.newTableColumns().length + 1}`,
      name: cleanName,
    };
    this.newTableColumns.update((list) => [...list, newRow]);
    this.newTableTopDraft.set(this.buildBlankNewTableTopDraft());

    if (focusTopNameAfter && this.isBrowser) {
      setTimeout(() => {
        document.getElementById('create-tbl-top-name')?.focus();
      }, 20);
    }
    return true;
  }

  public addNewTableColumnDraft(focusFirstCell = false): void {
    if (this.newTableTopDraft().name.trim().length > 0) {
      this.commitTopNewTableColumnDraft(focusFirstCell);
      return;
    }
    const idx = this.newTableColumns().length;
    this.newTableColumns.update((list) => [
      ...list,
      {
        id: `draft_col_${Date.now()}_${idx + 1}`,
        name: '',
        colType: 'text',
        isNullable: true,
        columnValue: '',
        formula: '',
        optionsCsv: '',
        lookupTableName: '',
        isPrimaryKey: false,
        isIdentity: false,
      },
    ]);
    if (focusFirstCell && this.isBrowser) {
      setTimeout(() => {
        const el = document.getElementById(`create-tbl-name-${idx}`) as HTMLElement | null;
        el?.focus();
      }, 20);
    }
  }

  public removeNewTableColumnDraft(index: number): void {
    this.newTableColumns.update((list) => list.filter((_, i) => i !== index));
  }

  public updateNewTableColumnDraft(
    index: number,
    patch: Partial<NewTableColumnDraft>
  ): void {
    const dbName =
      this.newTableForm.controls.databaseName.value || this.activeDatabaseName();
    this.newTableColumns.update((list) =>
      list.map((item, i) => {
        if (i !== index) return item;
        const updated = { ...item, ...patch };
        if (
          patch.colType === 'lookup' ||
          (updated.colType === 'lookup' &&
            (patch.lookupTableName !== undefined || patch.formula !== undefined))
        ) {
          if (!updated.lookupTableName && patch.lookupTableName === undefined) {
            const avail = this.getAvailableLookupTablesForCreateTableModal();
            const preferred =
              avail.find((t) => t.tableName.toLowerCase().includes('lookup')) || avail[0];
            if (preferred) {
              updated.lookupTableName = preferred.tableName;
            }
          }
          if (updated.lookupTableName) {
            const targetCols = this.getTargetLookupTableColumns(
              dbName,
              updated.lookupTableName,
              index
            );
            const { normalizedTemplate } = resolveLookupTemplateAndColumns(
              patch.lookupTableName !== undefined && patch.formula === undefined
                ? ''
                : updated.formula,
              targetCols
            );
            updated.formula = normalizedTemplate;
            updated.optionsCsv = this.buildClientLinkedLookupPreviewJson(
              dbName,
              updated.lookupTableName,
              updated.formula,
              index
            );
            const items = this.getDraftLookupItems(updated);
            if (
              items.length > 0 &&
              (!updated.columnValue ||
                patch.lookupTableName !== undefined ||
                patch.formula !== undefined)
            ) {
              const matched = updated.columnValue
                ? matchLookupItemFromRaw(items, updated.columnValue)
                : undefined;
              const activeItem =
                matched || items.find((it) => it.isActive !== false) || items[0];
              updated.columnValue = activeItem.json;
            }
          } else if (
            !updated.optionsCsv ||
            updated.optionsCsv === 'Option A, Option B' ||
            updated.optionsCsv === 'High, Medium, Low'
          ) {
            if (!updated.formula || !updated.formula.includes('[')) {
              updated.formula = '{[ID], [Name]}';
            }
            updated.optionsCsv = '[{"ID":1,"Name":"car"},{"ID":2,"Name":"bus"},{"ID":3,"Name":"truck"}]';
          }
        } else if (patch.colType === 'dropdown') {
          updated.lookupTableName = '';
          if (!updated.optionsCsv || updated.optionsCsv.trim().startsWith('[')) {
            updated.optionsCsv = 'High, Medium, Low';
          }
        } else if (patch.colType === 'formula') {
          updated.lookupTableName = '';
          updated.isNullable = true;
          if (!updated.formula || updated.formula.trim().startsWith('{')) {
            const numCols = list.filter(
              (c, cIdx) => cIdx !== index && c.colType === 'number' && c.name.trim().length > 0
            );
            if (numCols.length >= 2) {
              updated.formula = `=[${numCols[0].name.trim()}] * [${numCols[1].name.trim()}]`;
            } else if (numCols.length === 1) {
              updated.formula = `=[${numCols[0].name.trim()}] * 2`;
            } else {
              updated.formula = '=[ID] * 10';
            }
          }
        } else if (patch.colType) {
          updated.lookupTableName = '';
        }
        return updated;
      })
    );
  }

  public getNewTableFormulaReferences(excludeIndex: number): string[] {
    const refs: string[] = ['ID'];
    const topName = (this.newTableTopDraft().name || '').trim();
    if (excludeIndex !== -1 && topName && topName.toLowerCase() !== 'id') {
      refs.push(topName);
    }
    const drafts = this.newTableColumns();
    for (let i = 0; i < drafts.length; i++) {
      if (i === excludeIndex) continue;
      const clean = (drafts[i].name || '').trim();
      if (clean && clean.toLowerCase() !== 'id' && !refs.includes(clean)) {
        refs.push(clean);
      }
    }
    return refs;
  }

  public appendColumnRefToNewTableFormula(colIndex: number, refColName: string): void {
    const col = this.newTableColumns()[colIndex];
    if (!col) return;
    const current = (col.formula || '').trim();
    const prefix = current.startsWith('=') ? current : `=${current}`;
    this.updateNewTableColumnDraft(colIndex, {
      formula: `${prefix} [${refColName}]`.trim(),
    });
  }

  /**
   * Handles keyboard navigation (Tab, Shift+Tab, ArrowUp, ArrowDown, Enter) inside the
   * Create / Edit Table tabular field designer (including the Top "Add Field" row at rowIndex = -1).
   */
  public onCreateTableCellKeydown(
    event: KeyboardEvent,
    rowIndex: number,
    colKey: 'name' | 'type' | 'options' | 'default' | 'null',
    isLastCellInRow = false
  ): void {
    // Pressing Enter inside the Top "Add Field" row commits that new field into the list
    if (rowIndex === -1 && event.key === 'Enter') {
      event.preventDefault();
      this.commitTopNewTableColumnDraft(true);
      return;
    }

    // Pressing Tab on the last cell of the Top Row:
    // If the user entered a field name in the Top Row, commit it and keep focus ready for next field
    if (rowIndex === -1 && event.key === 'Tab' && !event.shiftKey && isLastCellInRow) {
      if (this.newTableTopDraft().name.trim().length > 0) {
        event.preventDefault();
        this.commitTopNewTableColumnDraft(true);
        return;
      }
      return;
    }

    // Pressing Tab on the last cell of the last existing row appends a new field row
    if (rowIndex >= 0 && event.key === 'Tab' && !event.shiftKey && isLastCellInRow) {
      if (rowIndex === this.newTableColumns().length - 1) {
        event.preventDefault();
        this.addNewTableColumnDraft(true);
      }
      return;
    }

    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      colKey !== 'type' &&
      colKey !== 'null'
    ) {
      const targetRow = event.key === 'ArrowDown' ? rowIndex + 1 : rowIndex - 1;
      if (targetRow === -1) {
        event.preventDefault();
        const topEl =
          (document.getElementById(`create-tbl-top-${colKey}`) as HTMLElement | null) ||
          (document.getElementById('create-tbl-top-name') as HTMLElement | null);
        topEl?.focus();
        return;
      }
      if (targetRow >= 0 && targetRow < this.newTableColumns().length) {
        event.preventDefault();
        const targetEl = document.getElementById(
          `create-tbl-${colKey}-${targetRow}`
        ) as HTMLElement | null;
        if (targetEl) {
          targetEl.focus();
        } else {
          const fallbackEl = document.getElementById(
            `create-tbl-name-${targetRow}`
          ) as HTMLElement | null;
          fallbackEl?.focus();
        }
      }
    }
  }

  public submitCreateTableModal(): void {
    if (this.isCreatingTable()) return;
    this.createTableErrorMessage.set('');
    const formVal = this.newTableForm.getRawValue();
    const databaseName = (formVal.databaseName || this.activeDatabaseName()).trim();
    const tableName = formVal.tableName.trim();
    const editingOriginalTbl = this.editingTableOriginalName().trim();

    if (!tableName) {
      this.createTableErrorMessage.set('Please enter a table name.');
      return;
    }

    // Collect existing/added rows + include the Top "Add Field" row if the user typed a field name in it
    const combinedDrafts: NewTableColumnDraft[] = [...this.newTableColumns()];
    const topDraft = this.newTableTopDraft();
    if (
      topDraft.name.trim().length > 0 ||
      topDraft.columnValue.trim().length > 0 ||
      (topDraft.colType === 'formula' && topDraft.formula.trim().length > 0)
    ) {
      combinedDrafts.push({
        ...topDraft,
        id: `draft_col_top_${Date.now()}`,
      });
    }

    const activeDrafts = combinedDrafts.filter(
      (c) =>
        c.name.trim().length > 0 ||
        c.columnValue.trim().length > 0 ||
        (c.colType === 'formula' && c.formula.trim().length > 0)
    );

    const seenNames = new Set<string>(['id']);
    const payloadColumns: {
      originalName?: string;
      name: string;
      colType: ColumnType;
      isNullable: boolean;
      defaultValue: string;
      columnValue: string;
      formula: string;
      optionsCsv: string;
      lookupTableName?: string;
    }[] = [];

    for (let i = 0; i < activeDrafts.length; i++) {
      const draft = activeDrafts[i];
      const cleanName = draft.name.trim();
      if (!cleanName) {
        this.createTableErrorMessage.set(
          `Please enter a Field Name for row #${i + 1}, or remove the row.`
        );
        return;
      }
      const lowerName = cleanName.toLowerCase();
      if (lowerName === 'id') {
        this.createTableErrorMessage.set(
          'Field name "ID" is reserved for the auto-generated Primary Key.'
        );
        return;
      }
      if (seenNames.has(lowerName)) {
        this.createTableErrorMessage.set(
          `Duplicate field name "${cleanName}". Each field in the table must have a unique name.`
        );
        return;
      }
      seenNames.add(lowerName);

      if (draft.colType === 'formula' && !draft.formula.trim()) {
        this.createTableErrorMessage.set(
          `Please enter a Formula Expression for field "${cleanName}".`
        );
        return;
      }
      if (draft.colType === 'dropdown' && !draft.optionsCsv.trim()) {
        this.createTableErrorMessage.set(
          `Please enter Dropdown options for field "${cleanName}".`
        );
        return;
      }
      if (
        draft.colType === 'lookup' &&
        !(draft.lookupTableName || '').trim() &&
        !draft.optionsCsv.trim()
      ) {
        this.createTableErrorMessage.set(
          `Please select a Foreign Key Linked Table or enter Lookup JSON for field "${cleanName}".`
        );
        return;
      }

      const isNewDraftRow =
        draft.id.startsWith('draft_col_') || draft.id === '__top_draft__';

      payloadColumns.push({
        originalName: isNewDraftRow ? '' : draft.id,
        name: cleanName,
        colType: draft.colType,
        isNullable: draft.colType === 'formula' ? true : Boolean(draft.isNullable),
        defaultValue: draft.colType === 'formula' ? '' : draft.columnValue.trim(),
        columnValue: draft.colType === 'formula' ? '' : draft.columnValue.trim(),
        formula:
          draft.colType === 'formula'
            ? draft.formula.trim().startsWith('=')
              ? draft.formula.trim()
              : `=${draft.formula.trim()}`
            : draft.colType === 'lookup'
            ? draft.formula.trim() || '{[ID]}'
            : '',
        optionsCsv:
          draft.colType === 'lookup' || draft.colType === 'dropdown'
            ? draft.optionsCsv.trim()
            : '',
        lookupTableName:
          draft.colType === 'lookup' ? (draft.lookupTableName || '').trim() : '',
      });
    }

    this.isCreatingTable.set(true);

    // EDIT TABLE MODE: Update existing table name and tabular fields
    if (editingOriginalTbl) {
      this.http
        .post<{
          ok: boolean;
          error?: string;
          renamedDatabaseName?: string;
          renamedTableName?: string;
          activeDatabaseName?: string;
          databases?: DbDatabaseSummary[];
          activeTableName?: string;
          tables?: DbTableSummary[];
          columns?: GridColumn[];
          rows?: GridRow[];
          totalRows?: number;
          filteredTotalRows?: number;
          hasMore?: boolean;
          uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
          activities?: ActivityLogItem[];
        }>('/api/workspace/tables/rename', {
          databaseName,
          oldTableName: editingOriginalTbl,
          newTableName: tableName,
          columns: payloadColumns,
          userName: this.currentUserName(),
          userColor: this.currentUserColor(),
        })
        .subscribe({
          next: (res) => {
            this.isCreatingTable.set(false);
            if (!res?.ok) {
              this.createTableErrorMessage.set(
                res?.error || 'Could not save table changes.'
              );
              return;
            }
            const nextTblName = res.renamedTableName || tableName;
            const isTargetActiveDb =
              databaseName.toLowerCase() === this.activeDatabaseName().toLowerCase();
            if (Array.isArray(res.databases)) {
              this.databases.set(res.databases);
            }
            this.syncTablesSignalForActiveDatabase(this.databases());

            if (
              isTargetActiveDb &&
              editingOriginalTbl.toLowerCase() === this.activeTableName().toLowerCase()
            ) {
              this.activeTableName.set(nextTblName);
              this.workspaceName.set(nextTblName || this.activeDatabaseName());
              this.workspaceNameControl.setValue(nextTblName || this.activeDatabaseName());
              if (Array.isArray(res.columns)) {
                this.columns.set(res.columns);
                if (Array.isArray(res.rows)) {
                  const sanitized = this.sanitizeClientRowsAgainstColumns(res.columns, res.rows);
                  this.rows.set(sanitized);
                  this.visibleRowLimit.set(Math.max(this.lazyBatchSize, sanitized.length));
                  this.snapshotValidRows(sanitized);
                }
              }
              if (res.totalRows !== undefined) {
                this.dbTotalRows.set(res.totalRows);
              }
              if (res.filteredTotalRows !== undefined) {
                this.dbFilteredTotalRows.set(res.filteredTotalRows);
              }
              if (res.hasMore !== undefined) {
                this.dbHasMoreRows.set(Boolean(res.hasMore));
              }
              if (res.uniqueValuesByColumn) {
                this.dbUniqueValuesByColumn.set(res.uniqueValuesByColumn);
              }
            } else if (
              isTargetActiveDb &&
              this.columns().some((c) => c.colType === 'lookup')
            ) {
              // Refresh active table immediately so any Lookup columns linked to the edited table update their JSON
              this.fetchWorkspaceFromServer(
                false,
                this.activeTableName(),
                this.activeDatabaseName()
              );
            }

            this.renameTableInLastUsedOrder(databaseName, editingOriginalTbl, nextTblName);
            this.databaseTabs.update((tabs) =>
              tabs.map((t) =>
                t.databaseName.toLowerCase() === databaseName.toLowerCase() &&
                t.activeTableName.toLowerCase() === editingOriginalTbl.toLowerCase()
                  ? { ...t, activeTableName: nextTblName }
                  : t
              )
            );
            if (Array.isArray(res.activities)) {
              this.activities.set(res.activities);
            }
            if (editingOriginalTbl !== nextTblName) {
              this.expandedTableNodes.update((prev) => {
                const next = new Set(prev);
                const oldKey = `${databaseName}::${editingOriginalTbl}`;
                if (next.has(oldKey)) {
                  next.delete(oldKey);
                  next.add(`${databaseName}::${nextTblName}`);
                }
                return next;
              });
              this.saveSidebarTreeStateToStorage();
            }

            this.editingTableOriginalName.set('');
            this.activeModal.set('none');
            this.showBanner(
              'success',
              `Saved table "${nextTblName}" (${payloadColumns.length + 1} fields) in database "${databaseName}".`
            );
          },
          error: () => {
            this.isCreatingTable.set(false);
            this.createTableErrorMessage.set('Server error while saving table changes.');
          },
        });
      return;
    }

    // CREATE TABLE MODE
    this.http
      .post<{
        ok: boolean;
        error?: string;
        createdInDatabaseName?: string;
        createdTableName?: string;
        activeDatabaseName?: string;
        databases?: DbDatabaseSummary[];
        activeTableName?: string;
        tables?: DbTableSummary[];
        columns?: GridColumn[];
        rows?: GridRow[];
        totalRows?: number;
        filteredTotalRows?: number;
        hasMore?: boolean;
        uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
        activities?: ActivityLogItem[];
      }>('/api/workspace/tables', {
        databaseName,
        tableName,
        pkColumnName: 'ID',
        includeDefaultPk: true,
        columns: payloadColumns,
        initialRowCount: 0,
        userName: this.currentUserName(),
        userColor: this.currentUserColor(),
      })
      .subscribe({
        next: (res) => {
          this.isCreatingTable.set(false);
          if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
            this.createTableErrorMessage.set(
              res?.error || 'Could not create database table.'
            );
            return;
          }

          const targetDbName = res.createdInDatabaseName || databaseName;
          const createdTableName = res.createdTableName || tableName;
          const isTargetActiveDb =
            targetDbName.toLowerCase() === this.activeDatabaseName().toLowerCase();

          if (Array.isArray(res.databases)) {
            this.databases.set(res.databases);
          }
          if (Array.isArray(res.activities)) {
            this.activities.set(res.activities);
          }

          this.openTableTab(targetDbName, createdTableName);
          this.recordTableUsed(targetDbName, createdTableName);
          if (!this.hasActiveConnection()) {
            this.activeDatabaseName.set(targetDbName);
            this.ensureDatabaseTabOpenedAndActive(targetDbName, createdTableName, true);
          }
          const isNowActiveDb =
            targetDbName.toLowerCase() === this.activeDatabaseName().toLowerCase();

          if (isNowActiveDb) {
            const sanitizedRows = this.sanitizeClientRowsAgainstColumns(res.columns, res.rows);
            this.activeTableName.set(createdTableName);
            this.workspaceName.set(createdTableName);
            this.workspaceNameControl.setValue(createdTableName);
            this.syncTablesSignalForActiveDatabase(this.databases());
            this.databaseTabs.update((tabs) =>
              tabs.map((t) =>
                t.databaseName.toLowerCase() === targetDbName.toLowerCase()
                  ? { ...t, activeTableName: createdTableName }
                  : t
              )
            );
            this.columns.set(res.columns);
            this.rows.set(sanitizedRows);
            this.visibleRowLimit.set(Math.max(this.lazyBatchSize, sanitizedRows.length));
            this.dbTotalRows.set(res.totalRows ?? sanitizedRows.length);
            this.dbFilteredTotalRows.set(res.filteredTotalRows ?? sanitizedRows.length);
            this.dbHasMoreRows.set(Boolean(res.hasMore));
            if (res.uniqueValuesByColumn) {
              this.dbUniqueValuesByColumn.set(res.uniqueValuesByColumn);
            }

            this.editingCell.set(null);
            this.selectedRowIds.set(new Set());
            this.cellValidationErrors.set({});
            this.pendingUnsavedRowIds.set(new Set());
            this.pendingUnsavedColIds.set(new Set());
            this.sortRules.set([]);
            this.filterRules.set({});
            this.columnHeaderSearches.set({});
            this.globalSearchQuery.set('');
            this.searchInputControl.setValue('');
            this.snapshotValidRows(sanitizedRows);
            this.activeCell.set(null);
            setTimeout(() => {
              const el = document.getElementById('excel-sheet-tabs-scroll-container');
              if (el) el.scrollTo({ left: 0, behavior: 'smooth' });
            }, 60);
          } else {
            // Keep active database & its table list untouched
            this.syncTablesSignalForActiveDatabase(this.databases());
          }

          this.editingTableOriginalName.set('');
          this.activeModal.set('none');
          this.showBanner(
            'success',
            `Created table "${createdTableName}" in database "${targetDbName}".`
          );
        },
        error: () => {
          this.isCreatingTable.set(false);
          this.createTableErrorMessage.set('Server error while creating database table.');
        },
      });
  }

  public switchTable(tableName: string, event?: Event): void {
    event?.stopPropagation();
    if (!tableName || tableName === this.activeTableName()) return;
    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.flushAllDirtyRowsAutoSave();
    this.closeAllMenus();
    const currentDb = this.activeDatabaseName();
    this.openTableTab(currentDb, tableName);
    this.recordTableUsed(currentDb, tableName);
    this.activeTableName.set(tableName);
    this.workspaceName.set(tableName);
    this.workspaceNameControl.setValue(tableName);
    const activeTabId = this.activeDatabaseTabId();
    this.databaseTabs.update((tabs) =>
      tabs.map((t) =>
        t.tabId === activeTabId || t.databaseName.toLowerCase() === currentDb.toLowerCase()
          ? { ...t, activeTableName: tableName }
          : t
      )
    );
    this.selectedRowIds.set(new Set());
    this.selectedColumnId.set(null);
    this.activeCell.set(null);
    this.editingCell.set(null);
    this.cellValidationErrors.set({});
    this.pendingUnsavedRowIds.set(new Set());
    this.pendingUnsavedColIds.set(new Set());
    this.sortRules.set([]);
    this.filterRules.set({});
    this.columnHeaderSearches.set({});
    this.globalSearchQuery.set('');
    this.searchInputControl.setValue('');
    this.fetchWorkspaceFromServer(false, tableName, currentDb);
    if (this.isBrowser) {
      setTimeout(() => {
        const el = document.getElementById('excel-sheet-tabs-scroll-container');
        if (el) el.scrollTo({ left: 0, behavior: 'smooth' });
      }, 40);
    }
  }

  public deleteTable(tableName: string, event?: Event, targetDatabaseName?: string): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const dbName = targetDatabaseName || this.activeDatabaseName();

    this.requestConfirmation(
      `Delete Table "${dbName}.${tableName}"`,
      `Are you sure you want to drop the table "${tableName}" and its sheet tab from database "${dbName}"?`,
      `Drop "${tableName}"`,
      'danger',
      () => {
        this.http
          .post<{
            ok: boolean;
            error?: string;
            activeDatabaseName?: string;
            databases?: DbDatabaseSummary[];
            activeTableName?: string;
            tables?: DbTableSummary[];
            columns?: GridColumn[];
            rows?: GridRow[];
            totalRows?: number;
            filteredTotalRows?: number;
            hasMore?: boolean;
            uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
            activities?: ActivityLogItem[];
          }>('/api/workspace/tables/delete', {
            databaseName: dbName,
            tableName,
            userName: this.currentUserName(),
            userColor: this.currentUserColor(),
          })
          .subscribe({
            next: (res) => {
              if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
                this.showBanner('error', res?.error || 'Could not delete table.');
                return;
              }
              const isTargetActiveDb =
                dbName.toLowerCase() === this.activeDatabaseName().toLowerCase();
              if (Array.isArray(res.databases)) {
                this.databases.set(res.databases);
              }
              this.syncTablesSignalForActiveDatabase(this.databases());

              this.removeTableFromLastUsedOrder(dbName, tableName);
              if (isTargetActiveDb) {
                const nextActive = this.getLastUsedTableForDatabase(dbName);
                this.activeTableName.set(nextActive);
                this.workspaceName.set(nextActive || this.activeDatabaseName());
                this.workspaceNameControl.setValue(nextActive || this.activeDatabaseName());
                this.databaseTabs.update((tabs) =>
                  tabs.map((t) =>
                    t.databaseName.toLowerCase() === dbName.toLowerCase()
                      ? { ...t, activeTableName: nextActive }
                      : t
                  )
                );
                if (nextActive) {
                  this.recordTableUsed(dbName, nextActive);
                  this.fetchWorkspaceFromServer(false, nextActive, dbName);
                } else {
                  this.columns.set([]);
                  this.rows.set([]);
                  this.dbTotalRows.set(0);
                  this.dbFilteredTotalRows.set(0);
                  this.dbHasMoreRows.set(false);
                  this.selectedRowIds.set(new Set());
                  this.selectedColumnId.set(null);
                  this.activeCell.set(null);
                  this.editingCell.set(null);
                }
              }
              if (Array.isArray(res.activities)) {
                this.activities.set(res.activities);
              }
              this.showBanner('info', `Dropped table "${tableName}" from database "${dbName}".`);
            },
            error: () => {
              this.showBanner('error', 'Failed to delete table from database.');
            },
          });
      }
    );
  }

  public scrollTabsBar(direction: 'left' | 'right', event?: Event): void {
    event?.stopPropagation();
    if (!this.isBrowser) return;
    const el =
      document.getElementById('excel-sheet-tabs-scroll-container') ||
      document.getElementById('sheetTabsScrollContainer');
    if (!el) return;
    const delta = direction === 'left' ? -220 : 220;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  }

  // =========================================================================
  // UNIFIED RIGHT-CLICK & MOBILE LONG-PRESS CONTEXT MENU
  // =========================================================================

  public onContextMenu(
    event: MouseEvent,
    targetType: 'cell' | 'column' | 'row' | 'table' | 'new_row',
    rowId: string | null,
    colId: string | null,
    rowNumber: number | null = null
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.openContextMenuAt(event.clientX, event.clientY, targetType, rowId, colId, rowNumber);
  }

  public onTouchStart(
    event: TouchEvent,
    targetType: 'cell' | 'column' | 'row' | 'table' | 'new_row',
    rowId: string | null,
    colId: string | null,
    rowNumber: number | null = null
  ): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
    }
    const touch = event.touches[0];
    if (!touch) return;
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    this.longPressTimer = setTimeout(() => {
      this.openContextMenuAt(clientX, clientY, targetType, rowId, colId, rowNumber);
    }, 480);
  }

  public onTouchEndOrMove(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  public openContextMenuAt(
    clientX: number,
    clientY: number,
    targetType: 'cell' | 'column' | 'row' | 'table' | 'new_row',
    rowId: string | null,
    colId: string | null,
    rowNumber: number | null = null
  ): void {
    if (this.sidebarContextMenu().visible) {
      this.sidebarContextMenu.update((m) => ({ ...m, visible: false }));
    }

    if (rowId === '__new_row__') {
      this.activeCell.set({
        rowId: '__new_row__',
        colId: colId || this.selectedColumnId() || this.sortedColumns()[0]?.id || 'ID',
      });
      if (colId) {
        this.selectedColumnId.set(colId);
      }
    } else if (rowId && colId) {
      this.selectCell(rowId, colId);
    } else if (colId) {
      this.selectedColumnId.set(colId);
    }

    const effectiveRowId =
      rowId ||
      this.editingCell()?.rowId ||
      this.activeCell()?.rowId ||
      Array.from(this.selectedRowIds())[0] ||
      null;
    const effectiveColId =
      colId ||
      this.editingNewRowColId() ||
      this.editingCell()?.colId ||
      this.selectedColumnId() ||
      this.activeCell()?.colId ||
      null;

    let effectiveRowNumber = rowNumber;
    if (effectiveRowId === '__new_row__') {
      effectiveRowNumber = 0;
    } else if (!effectiveRowNumber && effectiveRowId) {
      const idx = this.visibleRows().findIndex((r) => r.id === effectiveRowId);
      if (idx >= 0) {
        effectiveRowNumber = idx + 1;
      }
    }

    const vw = this.isBrowser ? window.innerWidth : 1280;
    const vh = this.isBrowser ? window.innerHeight : 800;
    const menuWidth = Math.min(275, Math.max(200, vw - 24));
    const menuHeight = Math.min(430, Math.max(160, vh - 24));

    const clampedX = Math.max(12, Math.min(clientX, vw - menuWidth - 12));
    const clampedY = Math.max(12, Math.min(clientY, vh - menuHeight - 12));

    const colName = effectiveColId ? this.getColumnNameById(effectiveColId) : null;

    this.contextMenu.set({
      visible: true,
      x: clampedX,
      y: clampedY,
      targetType,
      rowId: effectiveRowId,
      rowNumber: effectiveRowNumber,
      colId: effectiveColId,
      colName,
    });
  }

  public isTargetNewRow(rowId?: string | null): boolean {
    const resolved = rowId ?? this.contextMenu().rowId ?? this.activeCell()?.rowId ?? null;
    return resolved === '__new_row__';
  }

  /**
   * Returns true if "Add Row Above" or "Paste Row Above" must be disabled:
   * - Visually Row 1 (the "Add Row" row `__new_row__`)
   * - Visually Row 2 (the first data row `visibleRows()[0]` right below the "Add Row" row)
   * - Or when the table has 0 data rows
   */
  public isAddRowAboveOrPasteAboveDisabled(rowId?: string | null): boolean {
    const visible = this.visibleRows();
    if (visible.length === 0) return true;
    const resolved =
      rowId ||
      this.contextMenu().rowId ||
      this.activeCell()?.rowId ||
      Array.from(this.selectedRowIds())[0] ||
      null;
    if (!resolved || resolved === '__new_row__') return true;
    return visible[0]?.id === resolved;
  }

  public isAddOrPasteAboveDisabledForContextMenu(rowId?: string | null): boolean {
    return this.isAddRowAboveOrPasteAboveDisabled(rowId);
  }

  /**
   * Returns true if "Delete Row" must be disabled (e.g. on the first "Add Row" row `__new_row__`).
   */
  public isDeleteRowDisabled(rowId?: string | null): boolean {
    if (this.selectedRowIds().size > 0) return false;
    const resolved = rowId ?? this.contextMenu().rowId ?? this.activeCell()?.rowId ?? null;
    if (!resolved || resolved === '__new_row__') return true;
    return this.visibleRows().length === 0;
  }

  public isDeleteRowDisabledForContextMenu(rowId?: string | null): boolean {
    return this.isDeleteRowDisabled(rowId);
  }

  public toggleSettingsDropdown(event: Event): void {
    event.stopPropagation();
    if (this.contextMenu().visible) {
      this.contextMenu.update((m) => ({ ...m, visible: false }));
    }
    if (this.sidebarContextMenu().visible) {
      this.sidebarContextMenu.update((m) => ({ ...m, visible: false }));
    }
    this.isSettingsDropdownOpen.update((v) => !v);
  }

  public closeAllMenus(): void {
    if (this.contextMenu().visible) {
      this.contextMenu.update((m) => ({ ...m, visible: false }));
    }
    if (this.sidebarContextMenu().visible) {
      this.sidebarContextMenu.update((m) => ({ ...m, visible: false }));
    }
    if (this.isSettingsDropdownOpen()) {
      this.isSettingsDropdownOpen.set(false);
    }
  }

  public requestConfirmation(
    title: string,
    message: string,
    confirmLabel: string,
    variant: 'primary' | 'danger',
    action: () => void
  ): void {
    this.closeAllMenus();
    this.confirmDialog.set({
      visible: true,
      title,
      message,
      confirmLabel,
      variant,
      onConfirm: action,
    });
  }

  public confirmPendingAction(): void {
    const current = this.confirmDialog();
    this.confirmDialog.update((d) => ({ ...d, visible: false, onConfirm: null }));
    if (current.onConfirm) {
      current.onConfirm();
    }
  }

  public cancelConfirmation(): void {
    this.confirmDialog.update((d) => ({ ...d, visible: false, onConfirm: null }));
  }

  // =========================================================================
  // REAL-TIME CLOUD SYNC (SERVER SSE + DATABASE)
  // =========================================================================

  public refreshTableData(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (!this.hasActiveConnection()) {
      this.refreshObjectExplorerTreeFromDb();
      return;
    }
    this.editingCell.set(null);
    this.cellValidationErrors.set({});
    this.pendingUnsavedRowIds.set(new Set());
    this.pendingUnsavedColIds.set(new Set());
    this.invalidCellKey.set(null);
    this.cloudSyncStatus.set('syncing');
    this.fetchWorkspaceFromServer(
      true,
      this.activeTableName() || undefined,
      this.activeDatabaseName()
    );
  }

  private fetchWorkspaceFromServer(
    showRefreshToast = false,
    requestedTableName?: string,
    requestedDatabaseName?: string
  ): void {
    const dbParam = requestedDatabaseName
      ? `&databaseName=${encodeURIComponent(requestedDatabaseName)}`
      : '';
    const tableParam = requestedTableName
      ? `&tableName=${encodeURIComponent(requestedTableName)}`
      : '';
    this.http
      .get<{
        workspaceId: string;
        workspaceName: string;
        activeDatabaseName?: string;
        databases?: DbDatabaseSummary[];
        activeTableName?: string;
        tables?: DbTableSummary[];
        updatedAt: string;
        totalRows?: number;
        filteredTotalRows?: number;
        hasMore?: boolean;
        columns: GridColumn[];
        rows: GridRow[];
        uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
        presence: CollaboratorPresence[];
        activities: ActivityLogItem[];
        versions?: VersionCommitItem[];
      }>(`/api/workspace?limit=${this.lazyBatchSize}${dbParam}${tableParam}`)
      .subscribe({
        next: (res) => {
          if (res && Array.isArray(res.columns) && Array.isArray(res.rows)) {
            const activeDb =
              requestedDatabaseName || res.activeDatabaseName || this.activeDatabaseName() || 'GridPulse_DB';
            let activeTbl = res.activeTableName ?? '';

            if (!this.hasInitializedWorkspace) {
              this.hasInitializedWorkspace = true;
              if (activeDb && activeTbl) {
                this.openTableTab(activeDb, activeTbl);
              }
            } else {
              const openNames = this.getOpenTableNamesForDb(activeDb);
              if (requestedTableName) {
                this.openTableTab(activeDb, requestedTableName);
              } else if (openNames.length === 0) {
                activeTbl = '';
              } else if (
                activeTbl &&
                !openNames.some((o) => o.trim().toLowerCase() === activeTbl.toLowerCase())
              ) {
                activeTbl = this.getLastUsedTableForDatabase(activeDb);
              }
            }

            const sanitizedRows = activeTbl
              ? this.sanitizeClientRowsAgainstColumns(res.columns, res.rows)
              : [];
            const effectiveCols = activeTbl ? res.columns : [];

            this.workspaceId.set(res.workspaceId || 'ws_gridpulse_main');
            this.activeDatabaseName.set(activeDb);
            if (Array.isArray(res.databases)) {
              this.databases.set(res.databases);
              this.syncTablesSignalForActiveDatabase(res.databases, activeDb);
            } else if (Array.isArray(res.tables)) {
              this.tables.set(res.tables);
            }
            this.activeTableName.set(activeTbl);
            if (activeTbl) {
              this.recordTableUsed(activeDb, activeTbl);
            }
            this.workspaceName.set(activeTbl || activeDb);
            this.workspaceNameControl.setValue(activeTbl || activeDb);

            // Ensure there is an active SQL Server Database Tab for this connected database
            if (this.databaseTabs().length === 0) {
              const initTabId = 'db_tab_initial';
              this.databaseTabs.set([
                {
                  tabId: initTabId,
                  databaseName: activeDb,
                  activeTableName: activeTbl,
                },
              ]);
              this.activeDatabaseTabId.set(initTabId);
            } else {
              const currentTab = this.activeDatabaseTab();
              this.databaseTabs.update((tabs) =>
                tabs.map((t) =>
                  (currentTab && t.tabId === currentTab.tabId) ||
                  t.databaseName.toLowerCase() === activeDb.toLowerCase()
                    ? { ...t, activeTableName: activeTbl }
                    : t
                )
              );
            }
            this.columns.set(effectiveCols);
            this.rows.set(sanitizedRows);
            this.visibleRowLimit.set(Math.max(this.lazyBatchSize, sanitizedRows.length));
            this.dbTotalRows.set(activeTbl ? (res.totalRows ?? sanitizedRows.length) : 0);
            this.dbFilteredTotalRows.set(
              activeTbl
                ? (res.filteredTotalRows ?? res.totalRows ?? sanitizedRows.length)
                : 0
            );
            this.dbHasMoreRows.set(activeTbl ? Boolean(res.hasMore) : false);
            this.dbUniqueValuesByColumn.set(activeTbl ? (res.uniqueValuesByColumn || {}) : {});
            if (Array.isArray(res.versions)) {
              this.versions.set(res.versions);
            }
            this.snapshotValidRows(sanitizedRows);
            this.collaborators.set(res.presence || []);
            this.activities.set(res.activities || []);
            this.cloudSyncStatus.set('synced');
            this.lastSyncedTime.set(this.formatTimeShort(res.updatedAt));

            const firstRow = sanitizedRows[0];
            if (firstRow && !this.activeCell()) {
              const defaultCol = effectiveCols[1] || effectiveCols[0];
              if (defaultCol) {
                this.selectCell(firstRow.id, defaultCol.id);
              }
            }
            this.broadcastPresence();
            if (showRefreshToast) {
              this.showBanner(
                'success',
                activeTbl
                  ? `Synced "${activeDb}.${activeTbl}" (${sanitizedRows.length} rows loaded, ${this.dbTotalRows()} total in database).`
                  : `Synced database "${activeDb}".`
              );
            }
          }
        },
        error: () => {
          this.cloudSyncStatus.set('offline');
          if (showRefreshToast) {
            this.showBanner('error', 'Could not reach server to refresh database.');
          }
        },
      });
  }

  public queryDatabaseRows(resetOffset = true, customLimit?: number): void {
    if (!this.isBrowser) return;
    const offset = resetOffset ? 0 : this.rows().length;
    const limit = customLimit ?? this.lazyBatchSize;

    if (!resetOffset) {
      this.isLazyLoadingMore.set(true);
    } else {
      this.cloudSyncStatus.set('syncing');
    }

    this.http
      .post<{
        ok: boolean;
        activeDatabaseName?: string;
        databases?: DbDatabaseSummary[];
        activeTableName?: string;
        tables?: DbTableSummary[];
        columns?: GridColumn[];
        rows: GridRow[];
        totalRows: number;
        filteredTotalRows: number;
        offset: number;
        limit: number;
        hasMore: boolean;
        uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
      }>('/api/workspace/query', {
        databaseName: this.activeDatabaseName(),
        tableName: this.activeTableName(),
        offset,
        limit,
        globalSearchQuery: this.globalSearchQuery(),
        searchScopeColId: this.searchScopeColId(),
        columnHeaderSearches: this.columnHeaderSearches(),
        filterRules: this.filterRules(),
        sortRules: this.sortRules(),
      })
      .subscribe({
        next: (res) => {
          this.isLazyLoadingMore.set(false);
          this.cloudSyncStatus.set('synced');
          if (!res || !Array.isArray(res.rows)) return;

          if (Array.isArray(res.databases)) {
            this.databases.set(res.databases);
            this.syncTablesSignalForActiveDatabase(res.databases);
          }

          const sanitizedIncoming = this.sanitizeClientRowsAgainstColumns(
            this.columns(),
            res.rows
          );
          this.snapshotValidRows(sanitizedIncoming);

          // Preserve any local unsaved invalid row state on top of fetched database rows
          const invalidSet = this.invalidRowIds();
          const currentLocalMap = new Map<string, GridRow>(
            this.rows().map((r) => [r.id, r])
          );

          if (resetOffset) {
            const merged = sanitizedIncoming.map((r) =>
              invalidSet.has(r.id) && currentLocalMap.has(r.id)
                ? currentLocalMap.get(r.id)!
                : r
            );
            this.rows.set(merged);
            this.visibleRowLimit.set(Math.max(this.lazyBatchSize, merged.length));
          } else {
            const existingIds = new Set(this.rows().map((r) => r.id));
            const appended = [...this.rows()];
            for (const incoming of sanitizedIncoming) {
              if (!existingIds.has(incoming.id)) {
                appended.push(incoming);
              }
            }
            this.rows.set(appended);
            this.visibleRowLimit.set(appended.length);
          }

          this.dbTotalRows.set(res.totalRows);
          this.dbFilteredTotalRows.set(res.filteredTotalRows);
          this.dbHasMoreRows.set(Boolean(res.hasMore));
          if (res.uniqueValuesByColumn) {
            this.dbUniqueValuesByColumn.set(res.uniqueValuesByColumn);
          }
        },
        error: () => {
          this.isLazyLoadingMore.set(false);
          this.cloudSyncStatus.set('offline');
        },
      });
  }

  private connectRealTimeStream(): void {
    if (!this.isBrowser || typeof EventSource === 'undefined') return;

    this.eventSource = new EventSource('/api/stream');

    this.eventSource.addEventListener('workspace_sync', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.clientId && data.clientId === this.currentClientId()) {
          return;
        }
        if (Array.isArray(data.databases)) {
          this.databases.set(data.databases);
        }
        if (
          data.activeDatabaseName &&
          data.activeDatabaseName.toLowerCase() === this.activeDatabaseName().toLowerCase()
        ) {
          if (Array.isArray(data.tables)) {
            this.tables.set(data.tables);
          }
          if (data.activeTableName && data.activeTableName === this.activeTableName()) {
            if (Array.isArray(data.columns)) {
              this.columns.set(data.columns);
            }
            if (typeof data.totalRows === 'number') {
              this.dbTotalRows.set(data.totalRows);
            }
            this.queryDatabaseRows(true);
          }
        }
        if (Array.isArray(data.activities)) {
          this.activities.set(data.activities);
        }
        this.cloudSyncStatus.set('synced');
        this.lastSyncedTime.set(this.formatTimeShort(data.updatedAt));
      } catch {
        // Ignore malformed SSE frame
      }
    });

    this.eventSource.addEventListener('presence', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (Array.isArray(data.presence)) {
          this.collaborators.set(data.presence);
        }
      } catch {
        // Ignore
      }
    });
  }

  public persistToCloud(
    actionType: string,
    actionDetail: string,
    changedRow?: GridRow,
    changedCol?: GridColumn,
    bulkRows?: GridRow[],
    bulkCols?: GridColumn[],
    deletedRowIds?: string[],
    applyDefaultToAllRowsForColId?: string,
    renamedColumns?: { oldName: string; newName: string }[]
  ): void {
    if (!this.isBrowser) return;

    // Immediately keep the local Manage Object Explorer tree in sync with column/row changes
    this.syncLocalActiveTableIntoDatabasesTree();

    const invalidRows = this.invalidRowIds();

    // Update our lastValidRowSnapshots for all currently valid rows
    this.snapshotValidRows(this.rows());

    // Build database-safe row list where any currently invalid row falls back to its last valid DB snapshot
    const dbSafeRows: GridRow[] = [];
    for (const r of this.rows()) {
      if (invalidRows.has(r.id)) {
        const prevValid = this.lastValidRowSnapshots.get(r.id);
        if (prevValid) {
          dbSafeRows.push(prevValid);
        }
      } else {
        dbSafeRows.push(r);
      }
    }

    const reqDbName = this.activeDatabaseName();
    const reqTblName = this.activeTableName();
    this.cloudSyncStatus.set('syncing');

    this.http
      .post<{
        ok: boolean;
        activeDatabaseName?: string;
        databases?: DbDatabaseSummary[];
        activeTableName?: string;
        tables?: DbTableSummary[];
        columns?: GridColumn[];
        rows?: GridRow[];
        updatedAt: string;
        totalRows?: number;
        activities: ActivityLogItem[];
      }>('/api/workspace/sync', {
        clientId: this.currentClientId(),
        userName: this.currentUserName(),
        userColor: this.currentUserColor(),
        actionType,
        actionDetail,
        databaseName: reqDbName,
        tableName: reqTblName,
        workspaceName: this.workspaceName(),
        columns: this.columns(),
        rows: dbSafeRows,
        deletedRowIds,
        changedRowId: changedRow?.id,
        changedColId: changedCol?.id,
        changedRowCount: bulkRows?.length,
        changedColCount: bulkCols?.length,
        applyDefaultToAllRowsForColId,
        renamedColumns,
      })
      .subscribe({
        next: (res) => {
          this.cloudSyncStatus.set('synced');
          this.lastSyncedTime.set(this.formatTimeShort(res.updatedAt));
          if (Array.isArray(res.databases)) {
            this.databases.set(res.databases);
            this.syncTablesSignalForActiveDatabase(res.databases);
          }
          const isStillSameTable =
            this.activeDatabaseName().toLowerCase() === reqDbName.toLowerCase() &&
            this.activeTableName().toLowerCase() === reqTblName.toLowerCase();

          if (isStillSameTable && Array.isArray(res.columns)) {
            this.columns.set(res.columns);
            const shouldAcceptServerRows =
              Boolean(applyDefaultToAllRowsForColId) ||
              Boolean(renamedColumns && renamedColumns.length > 0);
            if (shouldAcceptServerRows && Array.isArray(res.rows)) {
              const sanitized = this.sanitizeClientRowsAgainstColumns(res.columns, res.rows);
              const localInvalid = this.invalidRowIds();
              const localMap = new Map<string, GridRow>(this.rows().map((r) => [r.id, r]));
              const merged = sanitized.map((r) =>
                (localInvalid.has(r.id) || this.dirtyRowIds.has(r.id)) && localMap.has(r.id)
                  ? localMap.get(r.id)!
                  : r
              );
              this.rows.set(merged);
              this.snapshotValidRows(merged);
            } else if (res.columns.some((c) => c.colType === 'lookup')) {
              const resynced = this.sanitizeClientRowsAgainstColumns(res.columns, this.rows());
              this.rows.set(resynced);
              this.snapshotValidRows(resynced);
            }
          }
          if (isStillSameTable && typeof res.totalRows === 'number') {
            this.dbTotalRows.set(res.totalRows);
            if (this.activeFilterCount() === 0 && !this.globalSearchQuery().trim()) {
              this.dbFilteredTotalRows.set(res.totalRows);
            }
          }
          if (Array.isArray(res.activities)) {
            this.activities.set(res.activities);
          }
        },
        error: () => {
          this.cloudSyncStatus.set('offline');
        },
      });
  }

  public broadcastPresence(): void {
    if (!this.isBrowser) return;
    const active = this.activeCell();
    const presencePayload: CollaboratorPresence = {
      userId: this.currentClientId(),
      displayName: this.currentUserName(),
      color: this.currentUserColor(),
      isAnonymous: !this.firebaseUser(),
      activeRowId: active?.rowId || '',
      activeColId: active?.colId || '',
      updatedAt: new Date().toISOString(),
    };

    this.http
      .post<{ ok: boolean; presence: CollaboratorPresence[] }>(
        '/api/workspace/presence',
        presencePayload
      )
      .subscribe({
        next: (res) => {
          if (res && Array.isArray(res.presence)) {
            this.collaborators.set(res.presence);
          }
        },
        error: () => {
          // Ignore transient presence network errors
        },
      });
  }

  // =========================================================================
  // POSTGRESQL USER AUTHENTICATION & COLLABORATOR PROFILE
  // =========================================================================

  public handleGoogleSignIn(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    this.authErrorMessage.set('');
    this.authMode.set('login');
    this.activeModal.set('postgres_auth');
  }

  public fillDemoPostgresUser(email: string, displayName: string): void {
    this.authErrorMessage.set('');
    this.authForm.patchValue({
      email,
      password: 'GridPulse@2026',
      displayName,
    });
  }

  public submitPostgresAuth(): void {
    this.authErrorMessage.set('');
    const raw = this.authForm.getRawValue();
    const endpoint =
      this.authMode() === 'register' ? '/api/auth/register' : '/api/auth/login';

    this.http
      .post<{
        ok: boolean;
        token?: string;
        user?: PostgresAuthUser;
        error?: string;
      }>(endpoint, {
        email: raw.email.trim(),
        password: raw.password,
        displayName: raw.displayName.trim(),
        color: raw.color || '#f59e0b',
      })
      .subscribe({
        next: (res) => {
          if (!res?.ok || !res.user || !res.token) {
            this.authErrorMessage.set(
              res?.error || 'Could not authenticate user account.'
            );
            return;
          }
          if (this.isBrowser) {
            localStorage.setItem('gridpulse_pg_token', res.token);
            localStorage.setItem('gridpulse_user_name', res.user.displayName);
            localStorage.setItem('gridpulse_user_color', res.user.color);
          }
          this.firebaseUser.set(res.user);
          this.currentUserName.set(res.user.displayName);
          this.currentUserColor.set(res.user.color);
          this.profileForm.patchValue({
            displayName: res.user.displayName,
            color: res.user.color,
          });
          this.activeModal.set('none');
          this.broadcastPresence();
          this.showBanner(
            'success',
            `Signed in as ${res.user.displayName} (${res.user.email}).`
          );
        },
        error: () => {
          this.authErrorMessage.set('Could not reach authentication endpoint.');
        },
      });
  }

  public handleSignOut(): void {
    const token = this.isBrowser ? localStorage.getItem('gridpulse_pg_token') || '' : '';
    if (this.isBrowser) {
      localStorage.removeItem('gridpulse_pg_token');
    }
    this.firebaseUser.set(null);
    if (token) {
      this.http
        .post(
          '/api/auth/logout',
          {},
          { headers: { Authorization: `Bearer ${token}` } }
        )
        .subscribe({
          error: () => {
            // Ignore logout network error
          },
        });
    }
    this.broadcastPresence();
    this.showBanner('info', 'Signed out of user session.');
  }

  public saveCollaboratorProfile(): void {
    if (this.profileForm.invalid) return;
    const { displayName, color } = this.profileForm.getRawValue();
    this.currentUserName.set(displayName.trim());
    this.currentUserColor.set(color);
    if (this.isBrowser) {
      localStorage.setItem('gridpulse_user_name', displayName.trim());
      localStorage.setItem('gridpulse_user_color', color);
    }
    this.broadcastPresence();
    this.activeModal.set('none');
    this.showBanner('success', `Collaborator identity updated to ${displayName.trim()}.`);
  }

  // =========================================================================
  // DATABASE VERSION CONTROL (COMMITS, HISTORY & ROLLBACK)
  // =========================================================================

  public openVersionControlModal(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    this.activeModal.set('version_control');
  }

  public commitNewVersion(): void {
    if (this.isCommittingVersion()) return;
    const raw = this.versionForm.getRawValue();
    const title = raw.title.trim() || 'Workspace Checkpoint';
    const message = raw.message.trim();

    this.isCommittingVersion.set(true);
    this.http
      .post<{
        ok: boolean;
        committed?: VersionCommitItem;
        versions?: VersionCommitItem[];
        activities?: ActivityLogItem[];
      }>('/api/workspace/versions', {
        title,
        message,
        authorName: this.currentUserName(),
        authorColor: this.currentUserColor(),
      })
      .subscribe({
        next: (res) => {
          this.isCommittingVersion.set(false);
          if (res?.ok && Array.isArray(res.versions)) {
            this.versions.set(res.versions);
            if (Array.isArray(res.activities)) {
              this.activities.set(res.activities);
            }
            this.versionForm.patchValue({
              title: '',
              message: '',
            });
            this.showBanner(
              'success',
              `Committed version ${res.committed?.versionTag || ''} ("${title}").`
            );
          }
        },
        error: () => {
          this.isCommittingVersion.set(false);
          this.showBanner('error', 'Failed to commit version snapshot.');
        },
      });
  }

  public restoreVersionSnapshot(ver: VersionCommitItem, event?: Event): void {
    event?.stopPropagation();
    this.requestConfirmation(
      `Restore Version ${ver.versionTag}`,
      `Are you sure you want to roll back the database to "${ver.title}" (${ver.versionTag}, ${ver.rowCount} rows)?`,
      `Restore ${ver.versionTag}`,
      'primary',
      () => {
        this.recordHistorySnapshot(`Rollback to ${ver.versionTag}`);
        this.http
          .post<{
            ok: boolean;
            restoredVersion?: string;
            columns?: GridColumn[];
            rows?: GridRow[];
            totalRows?: number;
            filteredTotalRows?: number;
            hasMore?: boolean;
            uniqueValuesByColumn?: Record<string, { label: string; count: number }[]>;
            activities?: ActivityLogItem[];
          }>('/api/workspace/versions/restore', {
            versionId: ver.id,
            userName: this.currentUserName(),
            userColor: this.currentUserColor(),
          })
          .subscribe({
            next: (res) => {
              if (res?.ok && Array.isArray(res.columns) && Array.isArray(res.rows)) {
                const sanitized = this.sanitizeClientRowsAgainstColumns(
                  res.columns,
                  res.rows
                );
                this.columns.set(res.columns);
                this.rows.set(sanitized);
                this.visibleRowLimit.set(Math.max(this.lazyBatchSize, sanitized.length));
                if (typeof res.totalRows === 'number') {
                  this.dbTotalRows.set(res.totalRows);
                }
                if (typeof res.filteredTotalRows === 'number') {
                  this.dbFilteredTotalRows.set(res.filteredTotalRows);
                }
                this.dbHasMoreRows.set(Boolean(res.hasMore));
                if (res.uniqueValuesByColumn) {
                  this.dbUniqueValuesByColumn.set(res.uniqueValuesByColumn);
                }
                if (Array.isArray(res.activities)) {
                  this.activities.set(res.activities);
                }
                this.cellValidationErrors.set({});
                this.pendingUnsavedRowIds.set(new Set());
                this.snapshotValidRows(sanitized);
                this.showBanner(
                  'success',
                  `Restored database to version ${ver.versionTag} ("${ver.title}").`
                );
              }
            },
            error: () => {
              this.showBanner('error', 'Could not restore version snapshot.');
            },
          });
      }
    );
  }

  public toggleCoEditorPresence(): void {
    this.closeAllMenus();
    if (this.isCoEditorSimActive()) {
      this.isCoEditorSimActive.set(false);
      if (this.coEditorInterval) {
        clearInterval(this.coEditorInterval);
        this.coEditorInterval = null;
      }
      this.showBanner('info', 'Live Co-Editor cursor demonstration paused.');
      return;
    }

    this.isCoEditorSimActive.set(true);
    this.showBanner(
      'success',
      'Live Co-Editor "Maya Lin" joined the sheet! Watch her colored cell cursor in the grid.'
    );

    const pulseCoEditor = () => {
      const visible = this.visibleRows();
      const editableCols = this.sortedColumns().filter((c) => c.colType !== 'formula');
      if (visible.length === 0 || editableCols.length === 0) return;

      const targetRow = visible[Math.floor(Math.random() * Math.min(12, visible.length))];
      const targetCol = editableCols[Math.floor(Math.random() * editableCols.length)];

      const coPresence: CollaboratorPresence = {
        userId: 'collab_maya_lin_live',
        displayName: 'Maya Lin (Product Ops)',
        color: '#34A853',
        isAnonymous: false,
        activeRowId: targetRow.id,
        activeColId: targetCol.id,
        updatedAt: new Date().toISOString(),
      };

      this.http.post('/api/workspace/presence', coPresence).subscribe({
        error: () => {
          // Ignore transient presence errors
        },
      });
    };

    pulseCoEditor();
    this.coEditorInterval = setInterval(pulseCoEditor, 3500);
  }

  // =========================================================================
  // CELL DISPLAY, SELECTION & INLINE CRUD EDITING
  // =========================================================================

  public getDisplayCellValue(row: GridRow, col: GridColumn): CellPrimitive {
    if (col.colType === 'formula') {
      const rawFormulaCell =
        row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
      if (
        this.isCellInvalid(row.id, col.id) &&
        rawFormulaCell !== undefined &&
        rawFormulaCell !== ''
      ) {
        return rawFormulaCell;
      }
      return evaluateFormula(col.formula, row, this.columns());
    }
    const val = row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
    if (val === undefined || val === null) {
      return col.colType === 'checkbox' ? false : '';
    }
    if (col.colType === 'lookup') {
      const rawStr = String(val).trim();
      if (!rawStr) return '';
      const items = getLookupOptions(col);
      if (items.length > 0) {
        const matched = matchLookupItemFromRaw(items, rawStr);
        if (matched) {
          return matched.json;
        }
      }
      return rawStr;
    }
    if (col.colType === 'number' && typeof val === 'boolean') {
      return val ? 1 : 0;
    }
    return val;
  }

  public formatCellForGrid(row: GridRow, col: GridColumn): string {
    const val = this.getDisplayCellValue(row, col);
    if (col.colType === 'checkbox') {
      return val === true ? 'true' : 'false';
    }
    if (col.isPrimaryKey || col.isIdentity) {
      return String(val);
    }
    if (col.colType === 'lookup') {
      return String(val ?? '');
    }
    if (col.colType === 'number' || col.colType === 'formula') {
      const normalizedVal = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      const num = Number(normalizedVal);
      if (!Number.isNaN(num) && Number.isFinite(num) && String(normalizedVal).trim() !== '') {
        const isCurrency =
          col.name.toLowerCase().includes('cost') ||
          col.name.toLowerCase().includes('budget') ||
          col.name.toLowerCase().includes('value') ||
          col.name.toLowerCase().includes('price') ||
          col.name.toLowerCase().includes('revenue') ||
          col.name.toLowerCase().includes('amount') ||
          col.name.toLowerCase().includes('total');
        const formatted = num.toLocaleString('en-US', {
          minimumFractionDigits: isCurrency ? 2 : 0,
          maximumFractionDigits: 2,
        });
        return isCurrency ? `$${formatted}` : formatted;
      }
    }
    return String(val);
  }

  // =========================================================================
  // ALWAYS-CONTENTEDITABLE CELLS & ROW-EXIT AUTO-SAVE TO DATABASE
  // =========================================================================

  private readonly liveCellDraftMap = new Map<string, string>();
  private readonly dirtyRowIds = new Set<string>();
  readonly activeEditingRowId = signal<string | null>(null);
  private readonly newRowLiveDraftMap = new Map<string, string>();
  readonly hasNewRowLiveDraft = signal<boolean>(false);

  public getRawCellString(row: GridRow, col: GridColumn): string {
    const val = row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
    return val !== undefined && val !== null ? String(val) : '';
  }

  public getMatchedLookupCellJson(row: GridRow, col: GridColumn): string {
    const raw = this.getRawCellString(row, col);
    if (!raw) return '';
    const items = getLookupOptions(col);
    const matched = matchLookupItemFromRaw(items, raw);
    return matched ? matched.json : raw;
  }

  public getEditableCellDomText(row: GridRow, col: GridColumn): string {
    if (col.colType === 'lookup') {
      return String(this.getDisplayCellValue(row, col) ?? '');
    }
    const val = row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
    return val !== undefined && val !== null ? String(val) : '';
  }

  public getNewRowEditableCellDomText(col: GridColumn): string {
    const val = this.getNewRowCellDisplayValue(col);
    if (val === undefined || val === null || val === false) return '';
    return String(val);
  }

  public getNewRowMatchedLookupCellJson(col: GridColumn): string {
    const raw = this.getNewRowEditableCellDomText(col);
    if (!raw) return '';
    const items = getLookupOptions(col);
    const matched = matchLookupItemFromRaw(items, raw);
    return matched ? matched.json : raw;
  }

  public onDataRowFocusIn(rowId: string): void {
    const prevRowId = this.activeEditingRowId();
    if (prevRowId && prevRowId !== rowId) {
      if (prevRowId === this.newRowSentinelId) {
        this.commitAllNewRowLiveDrafts();
        if (this.hasNewRowDraftValues()) {
          this.commitFirstRowAddRow();
        }
      } else {
        this.flushRowAutoSave(prevRowId);
      }
    }
    this.activeEditingRowId.set(rowId);
  }

  public onDataRowFocusOut(rowId: string, event: FocusEvent): void {
    const nextTarget = event.relatedTarget as HTMLElement | null;
    const rowEl = event.currentTarget as HTMLElement | null;
    if (nextTarget && rowEl && rowEl.contains(nextTarget)) {
      return;
    }
    if (this.isBrowser) {
      setTimeout(() => {
        if (this.contextMenu().visible) return;
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && rowEl && rowEl.contains(activeEl)) {
          return;
        }
        this.flushRowAutoSave(rowId);
      }, 15);
    } else {
      this.flushRowAutoSave(rowId);
    }
  }

  public onFirstRowFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget as HTMLElement | null;
    const rowEl = event.currentTarget as HTMLElement | null;
    const targetEl = event.target as HTMLElement | null;
    if (nextTarget && rowEl && rowEl.contains(nextTarget)) {
      return;
    }
    if (nextTarget?.closest('[data-first-row-reset="true"]')) {
      return;
    }
    if (this.isBrowser) {
      setTimeout(() => {
        if (this.contextMenu().visible) return;
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && rowEl && rowEl.contains(activeEl)) {
          return;
        }
        // When opening a native <select> popup inside the First Row, some browsers temporarily
        // set document.activeElement to body with relatedTarget === null; do not prematurely commit
        if (
          targetEl?.tagName === 'SELECT' &&
          !nextTarget &&
          (!activeEl || activeEl === document.body || activeEl === document.documentElement)
        ) {
          return;
        }
        if (activeEl?.closest('[data-first-row-reset="true"]')) {
          return;
        }
        this.commitAllNewRowLiveDrafts();
        if (this.hasNewRowDraftValues()) {
          this.commitFirstRowAddRow();
        }
      }, 15);
    } else {
      this.commitAllNewRowLiveDrafts();
      if (this.hasNewRowDraftValues()) {
        this.commitFirstRowAddRow();
      }
    }
  }

  public onCellFocus(rowId: string, colId: string, event?: Event): void {
    event?.stopPropagation();
    this.onDataRowFocusIn(rowId);
    this.activeCell.set({ rowId, colId });
    this.selectedColumnId.set(colId);

    const row = this.rows().find((r) => r.id === rowId);
    const col = this.columns().find((c) => c.id === colId);
    if (row && col) {
      if (col.colType === 'formula') {
        this.formulaBarControl.setValue(col.formula, { emitEvent: false });
      } else {
        const draftKey = `${rowId}:${colId}`;
        if (this.liveCellDraftMap.has(draftKey)) {
          this.formulaBarControl.setValue(this.liveCellDraftMap.get(draftKey) || '', {
            emitEvent: false,
          });
        } else {
          const displayVal = this.getDisplayCellValue(row, col);
          this.formulaBarControl.setValue(
            displayVal !== undefined && displayVal !== null ? String(displayVal) : '',
            { emitEvent: false }
          );
        }
      }
    }
    this.broadcastPresence();
  }

  public onContentEditableCellInput(rowId: string, colId: string, event: Event): void {
    const el = event.target as HTMLElement | null;
    if (!el) return;
    const rawText = (el.innerText ?? el.textContent ?? '').replace(/\r?\n/g, ' ');
    this.liveCellDraftMap.set(`${rowId}:${colId}`, rawText);
    this.dirtyRowIds.add(rowId);
    this.formulaBarControl.setValue(rawText, { emitEvent: false });
  }

  public onEditableCellBlur(rowId: string, colId: string, event?: FocusEvent): void {
    const el = (event?.target as HTMLElement | null) ?? null;
    this.commitLiveCellDraft(rowId, colId, el);
  }

  public commitLiveCellDraft(
    rowId: string,
    colId: string,
    el?: HTMLElement | null
  ): void {
    const draftKey = `${rowId}:${colId}`;
    if (!this.liveCellDraftMap.has(draftKey)) return;
    const rawText = this.liveCellDraftMap.get(draftKey) ?? '';
    this.liveCellDraftMap.delete(draftKey);
    this.stageCellEditInRow(rowId, colId, rawText, el);
  }

  public onSelectCellChange(rowId: string, colId: string, newValue: string): void {
    this.onDataRowFocusIn(rowId);
    this.activeCell.set({ rowId, colId });
    this.selectedColumnId.set(colId);
    this.stageCellEditInRow(rowId, colId, newValue);
    this.flushRowAutoSave(rowId);
  }

  public onCheckboxCellChange(
    rowId: string,
    colId: string,
    checked: boolean,
    event?: Event
  ): void {
    event?.stopPropagation();
    this.onCellFocus(rowId, colId, event);
    this.stageCellEditInRow(rowId, colId, checked);
    this.flushRowAutoSave(rowId);
  }

  private stageCellEditInRow(
    rowId: string,
    colId: string,
    rawInput: unknown,
    domEl?: HTMLElement | null
  ): void {
    const col = this.columns().find((c) => c.id === colId);
    const row = this.rows().find((r) => r.id === rowId);
    if (!col || !row || col.isPrimaryKey || col.isIdentity || col.colType === 'formula') {
      return;
    }

    const validation = validateCellValue(col, rawInput);
    const prevVal = row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
    const wasCellAlreadyInvalid = this.isCellInvalid(rowId, colId);

    if (prevVal === validation.normalizedValue && validation.valid && !wasCellAlreadyInvalid) {
      if (domEl && domEl.isContentEditable) {
        const cleanDom =
          col.colType === 'lookup'
            ? String(this.getDisplayCellValue(row, col) ?? '')
            : String(validation.normalizedValue ?? '');
        if (domEl.textContent !== cleanDom) {
          domEl.textContent = cleanDom;
        }
      }
      return;
    }

    const nowIso = new Date().toISOString();
    const updatedRows = this.rows().map((r) => {
      if (r.id === rowId) {
        return {
          ...r,
          cells: {
            ...r.cells,
            [col.name]: validation.normalizedValue,
            [col.id]: validation.normalizedValue,
          },
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
      }
      return r;
    });

    this.rows.set(updatedRows);
    this.dirtyRowIds.add(rowId);
    this.formulaBarControl.setValue(String(validation.normalizedValue ?? ''), {
      emitEvent: false,
    });

    if (domEl && domEl.isContentEditable) {
      const updatedRow = updatedRows.find((r) => r.id === rowId);
      const cleanDom =
        col.colType === 'lookup' && updatedRow
          ? String(this.getDisplayCellValue(updatedRow, col) ?? '')
          : String(validation.normalizedValue ?? '');
      if (domEl.textContent !== cleanDom) {
        domEl.textContent = cleanDom;
      }
    }
  }

  public flushRowAutoSave(rowId: string): void {
    if (!rowId || rowId === this.newRowSentinelId) return;

    // Commit any remaining live drafts belonging to this row first
    const prefix = `${rowId}:`;
    for (const key of Array.from(this.liveCellDraftMap.keys())) {
      if (key.startsWith(prefix)) {
        const colId = key.slice(prefix.length);
        const domEl = this.isBrowser
          ? document.getElementById(`grid-cell-${rowId}-${colId}`)
          : null;
        this.commitLiveCellDraft(rowId, colId, domEl);
      }
    }

    if (!this.dirtyRowIds.has(rowId)) {
      return;
    }

    this.dirtyRowIds.delete(rowId);
    const row = this.rows().find((r) => r.id === rowId);
    if (!row) return;

    this.recordHistorySnapshot(`Auto-Save Row in "${this.activeTableName()}"`);
    this.validateAndSyncRows(
      [rowId],
      [],
      'Row Auto-Saved',
      `Auto-saved row changes in table "${this.activeTableName()}"`
    );
  }

  public flushAllDirtyRowsAutoSave(): void {
    for (const key of Array.from(this.liveCellDraftMap.keys())) {
      const sepIdx = key.indexOf(':');
      if (sepIdx > 0) {
        const rId = key.slice(0, sepIdx);
        const cId = key.slice(sepIdx + 1);
        this.commitLiveCellDraft(rId, cId);
      }
    }
    const dirtyIds = Array.from(this.dirtyRowIds);
    if (dirtyIds.length > 0) {
      this.dirtyRowIds.clear();
      this.recordHistorySnapshot(`Auto-Save ${dirtyIds.length} Row(s)`);
      this.validateAndSyncRows(
        dirtyIds,
        [],
        'Row Auto-Saved',
        `Auto-saved ${dirtyIds.length} row(s) in table "${this.activeTableName()}"`
      );
    }
    this.commitAllNewRowLiveDrafts();
    if (this.hasNewRowDraftValues()) {
      this.commitFirstRowAddRow();
    }
  }

  public onAlwaysEditableCellKeydown(
    event: KeyboardEvent,
    rowId: string,
    colId: string
  ): void {
    const targetEl = event.target as HTMLElement | null;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.commitLiveCellDraft(rowId, colId, targetEl);
      this.flushRowAutoSave(rowId);
      this.focusGridCellByOffset(rowId, colId, 1, 0);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      this.commitLiveCellDraft(rowId, colId, targetEl);
      this.focusGridCellByOffset(rowId, colId, 0, event.shiftKey ? -1 : 1, true);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (targetEl?.tagName === 'SELECT') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.commitLiveCellDraft(rowId, colId, targetEl);
      this.flushRowAutoSave(rowId);
      this.focusGridCellByOffset(
        rowId,
        colId,
        event.key === 'ArrowDown' ? 1 : -1,
        0
      );
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const draftKey = `${rowId}:${colId}`;
      this.liveCellDraftMap.delete(draftKey);
      const row = this.rows().find((r) => r.id === rowId);
      const col = this.columns().find((c) => c.id === colId);
      if (row && col && targetEl && targetEl.isContentEditable) {
        targetEl.textContent = this.getEditableCellDomText(row, col);
      }
      targetEl?.blur();
    }
  }

  private focusGridCellByOffset(
    currentRowId: string,
    currentColId: string,
    rowDelta: number,
    colDelta: number,
    wrapRowOnTab = false
  ): void {
    const visRows = this.visibleRows();
    const editableCols = this.sortedColumns().filter(
      (c) => !this.isProtectedIdColumn(c) && c.colType !== 'formula'
    );
    const allCols = this.sortedColumns();
    const colsPool = wrapRowOnTab && editableCols.length > 0 ? editableCols : allCols;

    let rIdx = visRows.findIndex((r) => r.id === currentRowId);
    let cIdx = colsPool.findIndex((c) => c.id === currentColId);
    if (rIdx < 0 || cIdx < 0) return;

    let nextRIdx = rIdx + rowDelta;
    let nextCIdx = cIdx + colDelta;

    if (wrapRowOnTab) {
      if (nextCIdx >= colsPool.length) {
        nextCIdx = 0;
        nextRIdx += 1;
        this.flushRowAutoSave(currentRowId);
      } else if (nextCIdx < 0) {
        nextCIdx = colsPool.length - 1;
        nextRIdx -= 1;
        this.flushRowAutoSave(currentRowId);
      }
    } else {
      nextCIdx = Math.max(0, Math.min(colsPool.length - 1, nextCIdx));
    }

    if (nextRIdx < 0) {
      // Move up into First Row (Add Row)
      const targetCol = colsPool[nextCIdx] || allCols[0];
      if (targetCol) {
        this.focusFirstRowCellDom(targetCol.id);
      }
      return;
    }

    if (nextRIdx >= visRows.length) {
      return;
    }

    const nextRow = visRows[nextRIdx];
    const nextCol = colsPool[nextCIdx];
    if (!nextRow || !nextCol) return;

    this.selectCell(nextRow.id, nextCol.id);
    if (this.isBrowser) {
      setTimeout(() => {
        const el = document.getElementById(`grid-cell-${nextRow.id}-${nextCol.id}`);
        if (el) {
          el.focus();
          this.placeCaretAtEndOfElement(el);
        }
      }, 10);
    }
  }

  private placeCaretAtEndOfElement(el: HTMLElement): void {
    if (!this.isBrowser || !el.isContentEditable) return;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      // Ignore selection range errors on non-text elements
    }
  }

  public selectCell(rowId: string, colId: string): void {
    const currentEdit = this.editingCell();
    if (currentEdit && (currentEdit.rowId !== rowId || currentEdit.colId !== colId)) {
      this.commitInlineEdit();
    }

    this.onDataRowFocusIn(rowId);
    this.activeCell.set({ rowId, colId });
    this.selectedColumnId.set(colId);

    const row = this.rows().find((r) => r.id === rowId);
    const col = this.columns().find((c) => c.id === colId);
    if (row && col) {
      if (col.colType === 'formula') {
        this.formulaBarControl.setValue(col.formula);
      } else {
        const displayVal = this.getDisplayCellValue(row, col);
        this.formulaBarControl.setValue(
          displayVal !== undefined && displayVal !== null ? String(displayVal) : ''
        );
      }
    }
    this.broadcastPresence();
  }

  public startInlineEdit(rowId: string, colId: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const col = this.columns().find((c) => c.id === colId);
    const row = this.rows().find((r) => r.id === rowId);
    if (!col || !row) return;

    if (col.isPrimaryKey || col.isIdentity) {
      this.showBanner(
        'info',
        `Primary Key column "${col.name}" (IDENTITY(1,1)) is auto-generated by the database.`
      );
      return;
    }

    if (col.colType === 'formula') {
      this.openEditColumnModal(col);
      return;
    }

    if (col.colType === 'checkbox') {
      this.toggleCheckboxCell(rowId, colId);
      return;
    }

    this.selectCell(rowId, colId);
    if (this.isBrowser) {
      setTimeout(() => {
        const el = document.getElementById(`grid-cell-${rowId}-${colId}`);
        if (el) {
          el.focus();
          this.placeCaretAtEndOfElement(el);
        }
      }, 10);
    }
  }

  public onInlineInputBlur(): void {
    if (this.contextMenu().visible) {
      return;
    }
    this.commitInlineEdit();
  }

  public commitInlineEdit(): void {
    const editing = this.editingCell();
    if (!editing) return;

    const rawInput = this.cellEditControl.value;
    this.editingCell.set(null);
    this.applyCellMutation(editing.rowId, editing.colId, rawInput);
  }

  public cancelInlineEdit(): void {
    this.editingCell.set(null);
    this.editingNewRowColId.set(null);
  }

  // =========================================================================
  // SQL SERVER ALWAYS-EMPTY FIRST ROW (ADD ROW FUNCTIONALITY & 1-BY-1 PASTE)
  // =========================================================================

  public hasNewRowDraftValues(): boolean {
    if (this.hasNewRowLiveDraft()) {
      return true;
    }
    const draft = this.newRowDraftCells();
    for (const val of Object.values(draft)) {
      if (val !== '' && val !== null && val !== undefined && val !== false) {
        return true;
      }
    }
    if (this.editingNewRowColId() && this.newRowCellEditControl.value.trim().length > 0) {
      return true;
    }
    return false;
  }

  public getNewRowCellDisplayValue(col: GridColumn): CellPrimitive {
    const draft = this.newRowDraftCells();
    if (draft[col.id] !== undefined) return draft[col.id];
    if (draft[col.name] !== undefined) return draft[col.name];
    return col.colType === 'checkbox' ? false : '';
  }

  public onNewRowCellFocus(colId: string, event?: Event): void {
    event?.stopPropagation();
    this.onDataRowFocusIn(this.newRowSentinelId);
    this.activeCell.set({ rowId: this.newRowSentinelId, colId });
    this.selectedColumnId.set(colId);
    const col = this.columns().find((c) => c.id === colId);
    if (col) {
      const liveVal = this.newRowLiveDraftMap.get(colId);
      const val = liveVal !== undefined ? liveVal : this.getNewRowCellDisplayValue(col);
      this.formulaBarControl.setValue(val !== undefined && val !== null ? String(val) : '', {
        emitEvent: false,
      });
    }
  }

  public onNewRowContentEditableInput(colId: string, event: Event): void {
    const el = event.target as HTMLElement | null;
    if (!el) return;
    const rawText = (el.innerText ?? el.textContent ?? '').replace(/\r?\n/g, ' ');
    if (rawText.trim().length > 0) {
      this.newRowLiveDraftMap.set(colId, rawText);
    } else {
      this.newRowLiveDraftMap.set(colId, '');
    }
    const anyLive = Array.from(this.newRowLiveDraftMap.values()).some(
      (v) => v.trim().length > 0
    );
    this.hasNewRowLiveDraft.set(anyLive);
    this.formulaBarControl.setValue(rawText, { emitEvent: false });
  }

  public onNewRowEditableCellBlur(colId: string, event?: FocusEvent): void {
    const el = (event?.target as HTMLElement | null) ?? null;
    this.commitNewRowLiveCellDraft(colId, el);
  }

  public onNewRowSelectChange(colId: string, newValue: string): void {
    this.onDataRowFocusIn(this.newRowSentinelId);
    this.newRowLiveDraftMap.set(colId, newValue);
    this.commitNewRowLiveCellDraft(colId);
  }

  public commitNewRowLiveCellDraft(colId: string, domEl?: HTMLElement | null): void {
    if (!this.newRowLiveDraftMap.has(colId)) return;
    const rawVal = this.newRowLiveDraftMap.get(colId) ?? '';
    this.newRowLiveDraftMap.delete(colId);
    const anyLive = Array.from(this.newRowLiveDraftMap.values()).some(
      (v) => v.trim().length > 0
    );
    this.hasNewRowLiveDraft.set(anyLive);

    const col = this.columns().find((c) => c.id === colId);
    if (col && !this.isProtectedIdColumn(col) && col.colType !== 'formula') {
      const trimmed = String(rawVal ?? '').trim();
      this.newRowDraftCells.update((prev) => {
        const next = { ...prev };
        if (trimmed === '') {
          delete next[col.id];
          delete next[col.name];
        } else {
          next[col.id] = trimmed;
          next[col.name] = trimmed;
        }
        return next;
      });
      this.newRowValidationErrors.update((prev) => {
        const next = { ...prev };
        delete next[col.id];
        return next;
      });
      if (domEl && domEl.isContentEditable && domEl.textContent !== trimmed) {
        domEl.textContent = trimmed;
      }
    }
  }

  private commitAllNewRowLiveDrafts(): void {
    for (const colId of Array.from(this.newRowLiveDraftMap.keys())) {
      const domEl = this.isBrowser
        ? document.getElementById(`new-row-inline-input-${colId}`)
        : null;
      this.commitNewRowLiveCellDraft(colId, domEl);
    }
  }

  private clearNewRowDomElements(): void {
    if (!this.isBrowser) return;
    for (const col of this.columns()) {
      const el = document.getElementById(`new-row-inline-input-${col.id}`);
      if (!el) continue;
      if (el.isContentEditable) {
        el.textContent = '';
      } else if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) {
        el.value = '';
      }
    }
  }

  private focusFirstRowCellDom(colId: string): void {
    this.selectNewRowCell(colId);
    if (this.isBrowser) {
      setTimeout(() => {
        const el = document.getElementById(`new-row-inline-input-${colId}`);
        if (el) {
          el.focus();
          this.placeCaretAtEndOfElement(el);
        }
      }, 10);
    }
  }

  public selectNewRowCell(colId: string, event?: Event): void {
    event?.stopPropagation();
    if (this.editingCell()) {
      this.commitInlineEdit();
    }
    this.onDataRowFocusIn(this.newRowSentinelId);
    this.activeCell.set({ rowId: this.newRowSentinelId, colId });
    this.selectedColumnId.set(colId);
    const col = this.columns().find((c) => c.id === colId);
    if (col) {
      const val = this.getNewRowCellDisplayValue(col);
      this.formulaBarControl.setValue(val !== undefined && val !== null ? String(val) : '');
    }
  }

  public startNewRowCellEdit(colId: string, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const col = this.columns().find((c) => c.id === colId);
    if (!col) return;
    if (this.isProtectedIdColumn(col) || col.colType === 'formula') {
      return;
    }
    if (col.colType === 'checkbox') {
      this.toggleNewRowCheckbox(colId, event);
      return;
    }
    this.focusFirstRowCellDom(colId);
  }

  public commitNewRowCellEdit(insertRowAfter = false): void {
    this.commitAllNewRowLiveDrafts();
    const colId = this.editingNewRowColId();
    if (colId) {
      const col = this.columns().find((c) => c.id === colId);
      const rawVal = this.newRowCellEditControl.value;
      this.editingNewRowColId.set(null);

      if (col && !this.isProtectedIdColumn(col) && col.colType !== 'formula') {
        const trimmed = String(rawVal ?? '').trim();
        this.newRowDraftCells.update((prev) => {
          const next = { ...prev };
          if (trimmed === '') {
            delete next[col.id];
            delete next[col.name];
          } else {
            next[col.id] = trimmed;
            next[col.name] = trimmed;
          }
          return next;
        });
      }
    }

    if (insertRowAfter && this.hasNewRowDraftValues()) {
      this.commitFirstRowAddRow();
    }
  }

  public onNewRowCellKeydown(event: KeyboardEvent, colId: string): void {
    const targetEl = event.target as HTMLElement | null;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.commitNewRowLiveCellDraft(colId, targetEl);
      if (this.hasNewRowDraftValues()) {
        this.commitFirstRowAddRow();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.newRowLiveDraftMap.delete(colId);
      const col = this.columns().find((c) => c.id === colId);
      if (col && targetEl && targetEl.isContentEditable) {
        targetEl.textContent = this.getNewRowEditableCellDomText(col);
      }
      targetEl?.blur();
      return;
    }
    if (event.key === 'ArrowDown' && targetEl?.tagName !== 'SELECT') {
      event.preventDefault();
      event.stopPropagation();
      this.commitNewRowLiveCellDraft(colId, targetEl);
      if (this.hasNewRowDraftValues()) {
        this.commitFirstRowAddRow();
      }
      const firstRow = this.visibleRows()[0];
      if (firstRow) {
        this.selectCell(firstRow.id, colId);
        if (this.isBrowser) {
          setTimeout(() => {
            const el = document.getElementById(`grid-cell-${firstRow.id}-${colId}`);
            if (el) {
              el.focus();
              this.placeCaretAtEndOfElement(el);
            }
          }, 15);
        }
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      this.commitNewRowLiveCellDraft(colId, targetEl);
      const editableCols = this.sortedColumns().filter(
        (c) => !this.isProtectedIdColumn(c) && c.colType !== 'formula'
      );
      const currIdx = editableCols.findIndex((c) => c.id === colId);
      if (currIdx >= 0) {
        const nextIdx = event.shiftKey ? currIdx - 1 : currIdx + 1;
        if (nextIdx >= 0 && nextIdx < editableCols.length) {
          this.focusFirstRowCellDom(editableCols[nextIdx].id);
        } else if (!event.shiftKey && this.hasNewRowDraftValues()) {
          this.commitFirstRowAddRow();
          if (editableCols[0]) {
            this.focusFirstRowCellDom(editableCols[0].id);
          }
        }
      }
    }
  }

  public toggleNewRowCheckbox(colId: string, event?: Event): void {
    event?.stopPropagation();
    const col = this.columns().find((c) => c.id === colId);
    if (!col || this.isProtectedIdColumn(col)) return;
    this.onDataRowFocusIn(this.newRowSentinelId);
    const curr = this.getNewRowCellDisplayValue(col) === true;
    const nextVal = !curr;
    this.newRowDraftCells.update((prev) => ({
      ...prev,
      [col.id]: nextVal,
      [col.name]: nextVal,
    }));
  }

  public clearNewRowDraft(event?: Event): void {
    event?.stopPropagation();
    this.editingNewRowColId.set(null);
    this.newRowCellEditControl.setValue('');
    this.newRowLiveDraftMap.clear();
    this.hasNewRowLiveDraft.set(false);
    this.newRowDraftCells.set({});
    this.newRowValidationErrors.set({});
    this.clearNewRowDomElements();
  }

  public resetFirstRowFieldsFromMenu(event?: Event): void {
    event?.stopPropagation();
    this.clearNewRowDraft(event);
    this.closeAllMenus();
    this.showBanner('info', 'Reset all fields in the First Row (Add Row).');
  }

  public async pasteMultipleRowsIntoFirstRowFromMenu(event?: Event): Promise<void> {
    event?.stopPropagation();
    const targetColId =
      this.contextMenu().colId ||
      this.editingNewRowColId() ||
      this.activeCell()?.colId ||
      this.selectedColumnId() ||
      null;
    this.editingNewRowColId.set(null);
    this.closeAllMenus();

    if (this.isBrowser && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim().length > 0) {
          this.lastInternalClipboardText = text;
          this.pasteRowsIntoFirstRowOneByOne(text, targetColId);
          return;
        }
      } catch {
        // Fallback below if browser clipboard read requires manual paste dialog
      }
    }

    if (this.lastInternalClipboardText && this.lastInternalClipboardText.trim().length > 0) {
      this.pasteRowsIntoFirstRowOneByOne(this.lastInternalClipboardText, targetColId);
      return;
    }

    this.activeCell.set({
      rowId: this.newRowSentinelId,
      colId: targetColId || this.sortedColumns()[0]?.id || 'ID',
    });
    this.openExcelPasteModal('append_rows');
  }

  public commitFirstRowAddRow(event?: Event): void {
    event?.stopPropagation();
    this.commitAllNewRowLiveDrafts();
    if (this.editingNewRowColId()) {
      this.commitNewRowCellEdit(false);
    }

    const draft = this.newRowDraftCells();
    const cols = this.sortedColumns();
    const nowIso = new Date().toISOString();
    const currentRows = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
    const nextIdentity = this.computeNextIdentityValue(currentRows);
    const maxOrder = Math.max(
      currentRows.reduce((max, r) => Math.max(max, r.orderIndex), 0) || 0,
      this.dbTotalRows() * 10
    );

    const cells: Record<string, CellPrimitive> = {};
    const fieldErrors: Record<string, string> = {};

    for (const col of cols) {
      if (col.colType === 'formula') continue;
      if (this.isProtectedIdColumn(col)) {
        cells[col.name] = nextIdentity;
        cells[col.id] = nextIdentity;
        continue;
      }

      const rawDraftVal =
        draft[col.id] !== undefined
          ? draft[col.id]
          : draft[col.name] !== undefined
          ? draft[col.name]
          : undefined;

      let candidateVal: unknown = rawDraftVal;
      if (candidateVal === undefined || candidateVal === '') {
        if (col.defaultValue !== undefined && String(col.defaultValue).trim() !== '') {
          candidateVal = this.resolveColumnDefaultPrimitive(col, String(col.defaultValue));
        } else if (col.colType === 'checkbox') {
          candidateVal = false;
        } else {
          candidateVal = '';
        }
      }

      const check = validateCellValue(col, candidateVal);
      cells[col.name] = check.normalizedValue;
      cells[col.id] = check.normalizedValue;
      if (!check.valid) {
        fieldErrors[col.id] = check.errorMessage;
      }
    }

    const createdRow: GridRow = {
      id: `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      orderIndex: maxOrder + 10,
      cells,
      updatedBy: this.currentUserName(),
      updatedAt: nowIso,
    };

    // Reset the First Row immediately back to empty so it is always ready for the next row
    this.newRowLiveDraftMap.clear();
    this.hasNewRowLiveDraft.set(false);
    this.newRowDraftCells.set({});
    this.newRowValidationErrors.set({});
    this.editingNewRowColId.set(null);
    this.newRowCellEditControl.setValue('');
    this.clearNewRowDomElements();

    this.recordHistorySnapshot('Add Row from First Row');
    this.rows.update((list) => [...list, createdRow]);
    this.visibleRowLimit.update((limit) => Math.max(this.lazyBatchSize, limit + 1));
    this.dbTotalRows.update((n) => n + 1);
    this.dbFilteredTotalRows.update((n) => n + 1);

    this.validateAndSyncRows(
      [createdRow.id],
      [],
      'Row Added (First Row)',
      `Added row ID=${nextIdentity} via First Row in "${this.activeTableName()}"`
    );
  }

  /**
   * When the user pastes single or multiple rows into the First Row ("Add Row" row),
   * automatically adds them one by one through the First Row Add Row functionality
   * and keeps the First Row empty afterward.
   */
  public pasteRowsIntoFirstRowOneByOne(
    rawText: string,
    startColId?: string | null
  ): void {
    const matrix = this.parseExcelClipboardMatrix(rawText);
    if (matrix.length === 0 || (matrix.length === 1 && matrix[0].length === 0)) {
      return;
    }

    const workingCols = [...this.sortedColumns()];
    const editableCols = workingCols.filter(
      (c) => !this.isProtectedIdColumn(c) && c.colType !== 'formula'
    );

    // Check if first row of pasted data matches column headers
    let dataRows = matrix;
    let headerColMap: (GridColumn | null)[] | null = null;
    if (matrix.length > 1 && matrix[0].length >= 2) {
      const firstRowCells = matrix[0].map((c) => c.trim());
      const matchCount = firstRowCells.filter((h) =>
        workingCols.some((c) => c.name.toLowerCase() === h.toLowerCase())
      ).length;
      if (matchCount >= Math.min(2, firstRowCells.length)) {
        dataRows = matrix.slice(1);
        headerColMap = firstRowCells.map(
          (h) => workingCols.find((c) => c.name.toLowerCase() === h.toLowerCase()) || null
        );
      }
    }

    if (dataRows.length === 0) return;

    this.recordHistorySnapshot(`Add ${dataRows.length} Pasted Row(s) via First Row`);

    const resolvedStartColId =
      startColId || this.editingNewRowColId() || this.activeCell()?.colId || null;
    let startEditableIdx = editableCols.findIndex((c) => c.id === resolvedStartColId);
    if (startEditableIdx < 0) startEditableIdx = 0;

    const addedRowIds: string[] = [];

    for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
      const rowValues = dataRows[rIdx];
      // If the pasted row has the exact same column count as workingCols and the first cell is a number (ID),
      // align with workingCols; otherwise align with editableCols starting at startEditableIdx
      const alignsWithAllCols =
        !headerColMap &&
        rowValues.length === workingCols.length &&
        workingCols.length > editableCols.length &&
        /^\d+$/.test((rowValues[0] || '').trim());

      const draftForThisRow: Record<string, CellPrimitive> = {};
      for (let cIdx = 0; cIdx < rowValues.length; cIdx++) {
        let targetCol: GridColumn | null = null;
        if (headerColMap) {
          targetCol = headerColMap[cIdx] || null;
        } else if (alignsWithAllCols) {
          targetCol = workingCols[cIdx] || null;
        } else {
          targetCol = editableCols[startEditableIdx + cIdx] || null;
        }

        if (!targetCol || this.isProtectedIdColumn(targetCol) || targetCol.colType === 'formula') {
          continue;
        }
        const norm = this.normalizeExcelValueForColumn(targetCol, rowValues[cIdx]);
        draftForThisRow[targetCol.id] = norm.value;
        draftForThisRow[targetCol.name] = norm.value;
      }

      // Populate First Row draft and commit this row one by one
      this.newRowDraftCells.set(draftForThisRow);

      const nowIso = new Date().toISOString();
      const currentRows = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
      const nextIdentity = this.computeNextIdentityValue(currentRows);
      const maxOrder = Math.max(
        currentRows.reduce((max, r) => Math.max(max, r.orderIndex), 0) || 0,
        (this.dbTotalRows() + rIdx) * 10
      );

      const cells: Record<string, CellPrimitive> = {};
      for (const col of workingCols) {
        if (col.colType === 'formula') continue;
        if (this.isProtectedIdColumn(col)) {
          cells[col.name] = nextIdentity;
          cells[col.id] = nextIdentity;
          continue;
        }
        const rawDraftVal =
          draftForThisRow[col.id] !== undefined
            ? draftForThisRow[col.id]
            : draftForThisRow[col.name];
        let candidateVal: unknown = rawDraftVal;
        if (candidateVal === undefined || candidateVal === '') {
          if (col.defaultValue !== undefined && String(col.defaultValue).trim() !== '') {
            candidateVal = this.resolveColumnDefaultPrimitive(col, String(col.defaultValue));
          } else if (col.colType === 'checkbox') {
            candidateVal = false;
          } else {
            candidateVal = '';
          }
        }
        const check = validateCellValue(col, candidateVal);
        cells[col.name] = check.normalizedValue;
        cells[col.id] = check.normalizedValue;
      }

      const createdRow: GridRow = {
        id: `row_firstpaste_${Date.now().toString(36)}_${rIdx}_${Math.random().toString(36).slice(2, 5)}`,
        orderIndex: maxOrder + 10,
        cells,
        updatedBy: this.currentUserName(),
        updatedAt: nowIso,
      };

      addedRowIds.push(createdRow.id);
      this.rows.update((list) => [...list, createdRow]);
    }

    // Clear the First Row after adding all pasted rows one by one
    this.newRowDraftCells.set({});
    this.newRowValidationErrors.set({});
    this.editingNewRowColId.set(null);
    this.newRowCellEditControl.setValue('');

    this.visibleRowLimit.update((limit) =>
      Math.max(this.lazyBatchSize, limit + addedRowIds.length, this.rows().length)
    );
    this.dbTotalRows.update((n) => n + addedRowIds.length);
    this.dbFilteredTotalRows.update((n) => n + addedRowIds.length);

    this.validateAndSyncRows(
      addedRowIds,
      [],
      'Rows Pasted via First Row',
      `Added ${addedRowIds.length} pasted row(s) one by one via First Row in "${this.activeTableName()}"`
    );
  }

  public commitFormulaBarEdit(): void {
    const active = this.activeCell();
    if (!active) return;
    const col = this.columns().find((c) => c.id === active.colId);
    if (!col) return;

    if (col.isPrimaryKey || col.isIdentity) {
      this.showBanner(
        'info',
        `Primary Key column "${col.name}" (IDENTITY(1,1)) is auto-generated by the database.`
      );
      return;
    }

    const inputVal = this.formulaBarControl.value.trim();

    if (col.colType === 'formula') {
      const updatedFormula = inputVal.startsWith('=') ? inputVal : `=${inputVal}`;
      this.recordHistorySnapshot(`Update Formula on "${col.name}"`);
      let updatedColRef: GridColumn | undefined;
      this.columns.update((cols) =>
        cols.map((c) => {
          if (c.id === col.id) {
            updatedColRef = { ...c, formula: updatedFormula };
            return updatedColRef;
          }
          return c;
        })
      );
      this.persistToCloud(
        'Formula Updated',
        `Updated formula on "${col.name}" to ${updatedFormula}`,
        undefined,
        updatedColRef
      );
      this.showBanner('success', `Updated formula on "${col.name}" to ${updatedFormula}`);
      return;
    }

    this.applyCellMutation(active.rowId, active.colId, inputVal);
  }

  public toggleCheckboxCell(rowId: string, colId: string, event?: Event): void {
    event?.stopPropagation();
    const row = this.rows().find((r) => r.id === rowId);
    const col = this.columns().find((c) => c.id === colId);
    if (!row || !col || col.isPrimaryKey || col.isIdentity) return;
    const currVal = row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
    const nextVal = !(currVal === true);
    this.applyCellMutation(rowId, colId, nextVal);
  }

  private applyCellMutation(rowId: string, colId: string, rawInput: unknown): void {
    const col = this.columns().find((c) => c.id === colId);
    const row = this.rows().find((r) => r.id === rowId);
    if (!col || !row || col.isPrimaryKey || col.isIdentity) return;

    const validation = validateCellValue(col, rawInput);
    const prevVal = row.cells[col.name] !== undefined ? row.cells[col.name] : row.cells[col.id];
    const wasCellAlreadyInvalid = this.isCellInvalid(rowId, colId);
    if (prevVal === validation.normalizedValue && validation.valid && !wasCellAlreadyInvalid) {
      return;
    }

    this.recordHistorySnapshot(`Edit "${col.name}"`);

    const nowIso = new Date().toISOString();
    const updatedRows = this.rows().map((r) => {
      if (r.id === rowId) {
        return {
          ...r,
          cells: {
            ...r.cells,
            [col.name]: validation.normalizedValue,
            [col.id]: validation.normalizedValue,
          },
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
      }
      return r;
    });

    this.rows.set(updatedRows);
    this.formulaBarControl.setValue(String(validation.normalizedValue));

    this.validateAndSyncRows(
      [rowId],
      [],
      'Cell Updated',
      `Set "${col.name}" to "${String(validation.normalizedValue)}"`
    );
  }

  /**
   * Validates all cells in the specified target rows (plus any rows with pending unsaved changes).
   * - Marks any cell with a datatype/integrity mismatch in cellValidationErrors (red cell)
   *   and marks its row in invalidRowIds (light red row).
   * - If the target rows have any validation errors, blocks database saving until corrected.
   * - Once corrections are made for a row (or multiple rows at once), immediately persists
   *   all valid corrected rows to the cloud database and Firestore.
   */
  private validateAndSyncRows(
    mutatedRowIds: string[],
    mutatedCols: GridColumn[],
    actionType: string,
    actionDetail: string,
    applyDefaultToAllRowsForColId?: string,
    renamedColumns?: { oldName: string; newName: string }[]
  ): void {
    const cols = this.sortedColumns();
    const nextErrors: Record<string, string> = { ...this.cellValidationErrors() };
    const nextPendingRows = new Set<string>(this.pendingUnsavedRowIds());
    for (const id of mutatedRowIds) {
      nextPendingRows.add(id);
    }

    const nextPendingCols = new Set<string>(this.pendingUnsavedColIds());
    for (const c of mutatedCols) {
      nextPendingCols.add(c.id);
    }

    const rowMap = new Map<string, GridRow>(this.rows().map((r) => [r.id, r]));
    const rowsToValidate = new Set<string>([...mutatedRowIds, ...nextPendingRows]);

    const newlyValidatedRows: GridRow[] = [];
    const stillInvalidRowIds = new Set<string>();
    let firstErrorMsg = '';
    let invalidCellsInMutated = 0;

    for (const rId of rowsToValidate) {
      const r = rowMap.get(rId);
      if (!r) {
        nextPendingRows.delete(rId);
        continue;
      }

      let rowHasError = false;
      const updatedCells: Record<string, CellPrimitive> = { ...r.cells };

      for (const col of cols) {
        const cellKey = `${r.id}:${col.id}`;
        if (col.isPrimaryKey || col.isIdentity) {
          delete nextErrors[cellKey];
          continue;
        }
        const rawVal =
          updatedCells[col.name] !== undefined ? updatedCells[col.name] : updatedCells[col.id];
        const check = validateCellValue(col, rawVal);
        updatedCells[col.name] = check.normalizedValue;
        updatedCells[col.id] = check.normalizedValue;

        if (!check.valid) {
          rowHasError = true;
          nextErrors[cellKey] = check.errorMessage;
          if (!firstErrorMsg) {
            firstErrorMsg = check.errorMessage;
          }
          if (mutatedRowIds.includes(r.id)) {
            invalidCellsInMutated++;
          }
        } else {
          delete nextErrors[cellKey];
        }
      }

      const nextRowObj: GridRow = {
        ...r,
        cells: updatedCells,
      };
      rowMap.set(r.id, nextRowObj);

      if (rowHasError) {
        stillInvalidRowIds.add(r.id);
      } else {
        nextPendingRows.delete(r.id);
        newlyValidatedRows.push(nextRowObj);
      }
    }

    this.rows.set(
      Array.from(rowMap.values()).sort((a, b) => a.orderIndex - b.orderIndex)
    );
    this.cellValidationErrors.set(nextErrors);
    this.pendingUnsavedRowIds.set(nextPendingRows);

    const mutatedHasErrors = mutatedRowIds.some((id) => stillInvalidRowIds.has(id));
    const totalErrorCells = Object.keys(nextErrors).length;
    const totalErrorRows = new Set(
      Object.keys(nextErrors).map((k) => k.slice(0, k.indexOf(':')))
    ).size;

    // If the user's current edit/paste introduced validation errors and no previously invalid row was fixed:
    // still sync any column schema mutations (mutatedCols) while holding back invalid rows via dbSafeRows!
    if (mutatedHasErrors && newlyValidatedRows.length === 0) {
      if (mutatedCols.length > 0) {
        const colsToSync = this.columns().filter((c) => nextPendingCols.has(c.id));
        nextPendingCols.clear();
        this.pendingUnsavedColIds.set(nextPendingCols);
        this.persistToCloud(
          actionType,
          actionDetail,
          undefined,
          colsToSync[0],
          [],
          colsToSync,
          undefined,
          applyDefaultToAllRowsForColId,
          renamedColumns
        );
      }
      this.invalidCellKey.set(Object.keys(nextErrors)[0] || null);
      this.showBanner(
        'error',
        `Validation Error (${invalidCellsInMutated} cell${invalidCellsInMutated > 1 ? 's' : ''} in ${stillInvalidRowIds.size} row${stillInvalidRowIds.size > 1 ? 's' : ''}): ${firstErrorMsg} — Invalid row data is NOT saved to database until corrected.`
      );
      return;
    }

    // If one or more rows are now valid (either corrected single row, corrected multiple rows at once, or valid edit/paste):
    if (newlyValidatedRows.length > 0 || mutatedCols.length > 0) {
      const colsToSync = this.columns().filter((c) => nextPendingCols.has(c.id));
      nextPendingCols.clear();
      this.pendingUnsavedColIds.set(nextPendingCols);

      this.persistToCloud(
        actionType,
        actionDetail,
        newlyValidatedRows[0],
        colsToSync[0],
        newlyValidatedRows,
        colsToSync,
        undefined,
        applyDefaultToAllRowsForColId,
        renamedColumns
      );

      if (totalErrorCells === 0) {
        this.invalidCellKey.set(null);
        this.showBanner(
          'success',
          `${newlyValidatedRows.length} valid row(s) saved to table "${this.activeTableName()}" in database.`
        );
      } else {
        this.showBanner(
          'error',
          `Saved ${newlyValidatedRows.length} valid row(s) to database. ${totalErrorCells} cell(s) in ${totalErrorRows} red row(s) still have validation errors — correct them to save.`
        );
      }
    }
  }

  // =========================================================================
  // ROW CRUD: CREATE, DUPLICATE, MOVE, DELETE & SELECT ALL
  // =========================================================================

  private computeNextIdentityValue(existingRows: GridRow[]): number {
    const pkCol = this.columns().find((c) => c.isPrimaryKey || c.isIdentity);
    const seed = pkCol?.identitySeed ?? 1;
    const increment = pkCol?.identityIncrement ?? 1;
    const totalInDb = this.dbTotalRows();
    if (!pkCol || (existingRows.length === 0 && totalInDb === 0)) return seed;

    let maxVal = seed - increment;
    for (const r of existingRows) {
      const raw = r.cells[pkCol.name] !== undefined ? r.cells[pkCol.name] : r.cells[pkCol.id];
      const num = Number(raw);
      if (Number.isFinite(num) && num > maxVal) {
        maxVal = num;
      }
    }
    const dbFloor = totalInDb > existingRows.length ? seed + (totalInDb - 1) * increment : maxVal;
    return Math.max(maxVal, dbFloor) + increment;
  }

  public toggleSelectAllFiltered(): void {
    const visible = this.visibleRows();
    if (this.isAllFilteredSelected()) {
      this.selectedRowIds.set(new Set());
      return;
    }
    this.selectedRowIds.set(new Set(visible.map((r) => r.id)));
  }

  public selectAllRowsExplicit(): void {
    this.closeAllMenus();
    const visible = this.visibleRows();
    this.selectedRowIds.set(new Set(visible.map((r) => r.id)));
    this.showBanner(
      'info',
      `Selected all ${visible.length} loaded row(s) in UI.`
    );
  }

  public clearRowSelection(): void {
    this.closeAllMenus();
    this.selectedRowIds.set(new Set());
  }

  public toggleRowSelection(rowId: string, event?: Event): void {
    event?.stopPropagation();
    const next = new Set(this.selectedRowIds());
    if (next.has(rowId)) {
      next.delete(rowId);
    } else {
      next.add(rowId);
    }
    this.selectedRowIds.set(next);
  }

  public createBlankRow(
    position: 'top' | 'bottom' | 'above_active' | 'below_active' = 'top',
    anchorRowId?: string | null
  ): void {
    this.closeAllMenus();
    const refRowId = anchorRowId || this.activeCell()?.rowId;

    if (position === 'above_active' && this.isAddRowAboveOrPasteAboveDisabled(refRowId)) {
      this.showBanner(
        'info',
        'Add Row Above is disabled for the First Row (Add Row) and the first data row (Row 2).'
      );
      return;
    }

    const posLabel =
      position === 'above_active'
        ? 'above the selected row'
        : position === 'below_active'
        ? 'below the selected row'
        : `to table "${this.activeTableName()}"`;

    this.requestConfirmation(
      'Confirm Add New Row',
      `Are you sure you want to insert a new row ${posLabel}?`,
      'Add Row',
      'primary',
      () => {
        const currentRows = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
        const cols = this.sortedColumns();
        const nowIso = new Date().toISOString();
        const nextIdentity = this.computeNextIdentityValue(currentRows);

        let targetOrder = 10;

        if (position === 'top' || (position === 'below_active' && refRowId === this.newRowSentinelId)) {
          targetOrder = currentRows.length > 0 ? currentRows[0].orderIndex - 10 : 10;
        } else if (position === 'bottom') {
          targetOrder =
            currentRows.length > 0 ? currentRows[currentRows.length - 1].orderIndex + 10 : 10;
        } else if (position === 'above_active' && refRowId) {
          const idx = currentRows.findIndex((r) => r.id === refRowId);
          if (idx >= 0) {
            const currOrder = currentRows[idx].orderIndex;
            const prevOrder = idx > 0 ? currentRows[idx - 1].orderIndex : currOrder - 20;
            targetOrder = (prevOrder + currOrder) / 2;
          }
        } else if (refRowId) {
          const idx = currentRows.findIndex((r) => r.id === refRowId);
          if (idx >= 0) {
            const currOrder = currentRows[idx].orderIndex;
            const nextOrder =
              idx + 1 < currentRows.length ? currentRows[idx + 1].orderIndex : currOrder + 20;
            targetOrder = (currOrder + nextOrder) / 2;
          }
        }

        const cells: Record<string, CellPrimitive> = {};
        for (const col of cols) {
          if (col.colType === 'formula') continue;
          let cellVal: CellPrimitive;
          if (col.isPrimaryKey || col.isIdentity) {
            cellVal = nextIdentity;
          } else if (col.defaultValue !== undefined && String(col.defaultValue).trim() !== '') {
            cellVal = this.resolveColumnDefaultPrimitive(col, String(col.defaultValue));
          } else if (col.name === 'Record Code' || col.id === 'col_code') {
            cellVal = `GP-${1000 + nextIdentity}`;
          } else if (col.colType === 'number') {
            cellVal = 1;
          } else if (col.colType === 'checkbox') {
            cellVal = false;
          } else if (col.colType === 'date') {
            cellVal = nowIso.slice(0, 10);
          } else if (col.colType === 'dropdown') {
            const opts = getDropdownOptions(col);
            cellVal = opts[0] || '';
          } else if (col.colType === 'lookup') {
            const items = getLookupOptions(col);
            const activeItem = items.find((i) => i.isActive !== false) || items[0];
            cellVal = activeItem ? activeItem.json : '';
          } else {
            cellVal = col.required ? 'New Record' : '';
          }
          cells[col.name] = cellVal;
          cells[col.id] = cellVal;
        }

        const newRow: GridRow = {
          id: `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          orderIndex: targetOrder,
          cells,
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };

        if (position === 'above_active' || position === 'below_active') {
          this.sortRules.set([]);
        }

        this.recordHistorySnapshot('Add New Row');
        this.rows.update((list) => [newRow, ...list]);
        this.visibleRowLimit.update((limit) => Math.max(this.lazyBatchSize, limit + 1));
        this.dbTotalRows.update((n) => n + 1);
        this.dbFilteredTotalRows.update((n) => n + 1);
        const firstEditableCol =
          cols.find((c) => !c.isPrimaryKey && !c.isIdentity && c.colType !== 'formula') || cols[0];
        if (firstEditableCol) {
          this.selectCell(newRow.id, firstEditableCol.id);
        }
        this.persistToCloud(
          'Row Created',
          `Inserted row ID=${nextIdentity} into table "${this.activeTableName()}"`,
          newRow
        );
        this.showBanner(
          'success',
          `New row (ID: ${nextIdentity}) created and saved to database table "${this.activeTableName()}".`
        );
      }
    );
  }

  public openNewRowModal(): void {
    this.closeAllMenus();
    const defaults: Record<string, string | boolean> = {};
    const nowIso = new Date().toISOString().slice(0, 10);
    const nextIdentity = this.computeNextIdentityValue(this.rows());
    for (const col of this.sortedColumns()) {
      if (col.colType === 'formula') continue;
      if (col.isPrimaryKey || col.isIdentity) {
        defaults[col.id] = String(nextIdentity);
      } else if (col.defaultValue !== undefined && String(col.defaultValue).trim() !== '') {
        const defVal = this.resolveColumnDefaultPrimitive(col, String(col.defaultValue));
        defaults[col.id] = col.colType === 'checkbox' ? Boolean(defVal) : String(defVal);
      } else if (col.name === 'Record Code' || col.id === 'col_code') {
        defaults[col.id] = `GP-${1000 + nextIdentity}`;
      } else if (col.colType === 'number') {
        defaults[col.id] = '1';
      } else if (col.colType === 'date') {
        defaults[col.id] = nowIso;
      } else if (col.colType === 'checkbox') {
        defaults[col.id] = true;
      } else if (col.colType === 'dropdown') {
        defaults[col.id] = getDropdownOptions(col)[0] || '';
      } else if (col.colType === 'lookup') {
        const items = getLookupOptions(col);
        const activeItem = items.find((i) => i.isActive !== false) || items[0];
        defaults[col.id] = activeItem ? activeItem.json : '';
      } else {
        defaults[col.id] = '';
      }
    }
    this.newRowValues.set(defaults);
    this.activeModal.set('new_row');
  }

  public updateNewRowField(colId: string, value: string | boolean): void {
    this.newRowValues.update((prev) => ({ ...prev, [colId]: value }));
  }

  public submitNewRowModal(): void {
    const rawMap = this.newRowValues();
    const cols = this.sortedColumns();
    const validatedCells: Record<string, CellPrimitive> = {};
    const nextIdentity = this.computeNextIdentityValue(this.rows());

    for (const col of cols) {
      if (col.colType === 'formula') continue;
      if (col.isPrimaryKey || col.isIdentity) {
        validatedCells[col.name] = nextIdentity;
        validatedCells[col.id] = nextIdentity;
        continue;
      }
      const check = validateCellValue(col, rawMap[col.id]);
      if (!check.valid) {
        this.showBanner('error', check.errorMessage);
        return;
      }
      validatedCells[col.name] = check.normalizedValue;
      validatedCells[col.id] = check.normalizedValue;
    }

    this.requestConfirmation(
      'Confirm Add New Row',
      `Are you sure you want to insert this validated record into table "${this.activeTableName()}"?`,
      'Add Row',
      'primary',
      () => {
        const currentRows = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
        const firstOrder = currentRows.length > 0 ? currentRows[0].orderIndex - 10 : 10;
        const nowIso = new Date().toISOString();

        const newRow: GridRow = {
          id: `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          orderIndex: firstOrder,
          cells: validatedCells,
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };

        this.recordHistorySnapshot('Create New Row');
        this.rows.update((list) => [newRow, ...list]);
        this.activeModal.set('none');
        this.selectCell(newRow.id, cols[0]?.id || 'ID');
        this.persistToCloud(
          'Row Created',
          `Inserted verified record into table "${this.activeTableName()}"`,
          newRow
        );
        this.showBanner(
          'success',
          `Record validated, created, and saved to database table "${this.activeTableName()}".`
        );
      }
    );
  }

  public duplicateRows(specificRowId?: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const targetIds =
      this.selectedRowIds().size > 0
        ? Array.from(this.selectedRowIds())
        : specificRowId
        ? [specificRowId]
        : this.activeCell()?.rowId
        ? [this.activeCell()!.rowId]
        : [];

    if (targetIds.length === 0) {
      this.showBanner('info', 'Select one or more rows (or right-click a cell) to duplicate.');
      return;
    }

    this.requestConfirmation(
      'Confirm Duplicate Row(s)',
      `Are you sure you want to duplicate ${targetIds.length} row(s)?`,
      `Duplicate ${targetIds.length} Row(s)`,
      'primary',
      () => {
        if (this.sortRules().length > 0) {
          this.sortRules.set([]);
        }
        const nowIso = new Date().toISOString();
        const workingRows = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
        const duplicatedRows: GridRow[] = [];
        const targetIdSet = new Set(targetIds);
        const nextRowsList: GridRow[] = [];
        const pkCol = this.columns().find((c) => c.isPrimaryKey || c.isIdentity);
        let runningIdentity = this.computeNextIdentityValue(workingRows);
        const idIncrement = pkCol?.identityIncrement ?? 1;

        for (let i = 0; i < workingRows.length; i++) {
          const srcRow = workingRows[i];
          nextRowsList.push(srcRow);
          if (targetIdSet.has(srcRow.id)) {
            const clonedCells: Record<string, CellPrimitive> = { ...srcRow.cells };
            if (pkCol) {
              clonedCells[pkCol.name] = runningIdentity;
              clonedCells[pkCol.id] = runningIdentity;
              runningIdentity += idIncrement;
            }
            if (typeof clonedCells['Record Code'] === 'string') {
              clonedCells['Record Code'] = `${clonedCells['Record Code']}-COPY`;
            }

            const dup: GridRow = {
              id: `row_dup_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
              orderIndex: 0,
              cells: clonedCells,
              updatedBy: this.currentUserName(),
              updatedAt: nowIso,
            };
            duplicatedRows.push(dup);
            nextRowsList.push(dup);
          }
        }

        if (duplicatedRows.length === 0) return;

        this.recordHistorySnapshot(`Duplicate ${duplicatedRows.length} Row(s)`);

        const reindexed = nextRowsList.map((r, idx) => ({
          ...r,
          orderIndex: (idx + 1) * 10,
        }));

        this.rows.set(reindexed);
        this.visibleRowLimit.update((limit) => limit + duplicatedRows.length);
        this.persistToCloud(
          'Rows Duplicated',
          `Duplicated ${duplicatedRows.length} row(s) and saved to database`,
          duplicatedRows[0],
          undefined,
          duplicatedRows
        );
        this.showBanner(
          'success',
          `Duplicated ${duplicatedRows.length} row(s) and automatically saved to database.`
        );
      }
    );
  }

  public deleteSelectedOrSpecificRow(specificRowId?: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (specificRowId === this.newRowSentinelId && this.selectedRowIds().size === 0) {
      this.showBanner('info', 'The First Row (Add Row) cannot be deleted.');
      return;
    }
    const rawSet =
      this.selectedRowIds().size > 0
        ? new Set(this.selectedRowIds())
        : specificRowId
        ? new Set([specificRowId])
        : this.activeCell()?.rowId
        ? new Set([this.activeCell()!.rowId])
        : new Set<string>();
    rawSet.delete(this.newRowSentinelId);
    const idsToDelete = rawSet;

    if (idsToDelete.size === 0) {
      this.showBanner('info', 'Select one or more data rows to delete.');
      return;
    }

    const deleteCount = idsToDelete.size;
    this.requestConfirmation(
      'Confirm Delete Row(s)',
      `Are you sure you want to delete ${deleteCount} row(s)? This action will remove the selected record(s) from table "${this.activeTableName()}" in the database.`,
      `Delete ${deleteCount} Row(s)`,
      'danger',
      () => {
        this.recordHistorySnapshot(`Delete ${deleteCount} Row(s)`);
        this.rows.update((list) => list.filter((r) => !idsToDelete.has(r.id)));
        this.selectedRowIds.set(new Set());

        // Clear any validation errors or pending state for deleted rows
        this.cellValidationErrors.update((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            const rId = key.slice(0, key.indexOf(':'));
            if (idsToDelete.has(rId)) {
              delete next[key];
            }
          }
          return next;
        });
        this.pendingUnsavedRowIds.update((prev) => {
          const next = new Set(prev);
          for (const id of idsToDelete) {
            next.delete(id);
            this.lastValidRowSnapshots.delete(id);
          }
          return next;
        });

        const deletedIdsArray = Array.from(idsToDelete);
        this.persistToCloud(
          'Rows Deleted',
          `Deleted ${deleteCount} row(s) from "${this.activeTableName()}"`,
          undefined,
          undefined,
          undefined,
          undefined,
          deletedIdsArray
        );
        this.dbTotalRows.update((n) => Math.max(0, n - deleteCount));
        this.dbFilteredTotalRows.update((n) => Math.max(0, n - deleteCount));
        this.showBanner('info', `Deleted ${deleteCount} row(s) from database.`);
      }
    );
  }

  public moveRows(direction: 'up' | 'down', specificRowId?: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (this.sortRules().length > 0) {
      this.sortRules.set([]);
    }

    const targetIds =
      this.selectedRowIds().size > 0
        ? new Set(this.selectedRowIds())
        : specificRowId
        ? new Set([specificRowId])
        : this.activeCell()?.rowId
        ? new Set([this.activeCell()!.rowId])
        : new Set<string>();

    if (targetIds.size === 0) {
      this.showBanner('info', 'Select a row to move up or down.');
      return;
    }

    const ordered = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
    if (direction === 'up') {
      for (let i = 1; i < ordered.length; i++) {
        if (targetIds.has(ordered[i].id) && !targetIds.has(ordered[i - 1].id)) {
          const temp = ordered[i - 1];
          ordered[i - 1] = ordered[i];
          ordered[i] = temp;
        }
      }
    } else {
      for (let i = ordered.length - 2; i >= 0; i--) {
        if (targetIds.has(ordered[i].id) && !targetIds.has(ordered[i + 1].id)) {
          const temp = ordered[i + 1];
          ordered[i + 1] = ordered[i];
          ordered[i] = temp;
        }
      }
    }

    const reindexed = ordered.map((r, idx) => ({
      ...r,
      orderIndex: (idx + 1) * 10,
    }));
    const movedRows = reindexed.filter((r) => targetIds.has(r.id));

    this.recordHistorySnapshot(`Move ${targetIds.size} Row(s) ${direction}`);
    this.rows.set(reindexed);
    this.persistToCloud(
      'Rows Reordered',
      `Moved ${targetIds.size} row(s) ${direction}`,
      movedRows[0],
      undefined,
      movedRows
    );
    this.showBanner('success', `Moved ${targetIds.size} row(s) ${direction} and saved to database.`);
  }

  // =========================================================================
  // CLIPBOARD ENGINE: COPY, CUT & PASTE ROWS AND COLUMNS
  // =========================================================================

  public copyOrCutRows(mode: 'copy' | 'cut', specificRowId?: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const targetIds =
      this.selectedRowIds().size > 0
        ? Array.from(this.selectedRowIds())
        : specificRowId
        ? [specificRowId]
        : this.activeCell()?.rowId
        ? [this.activeCell()!.rowId]
        : [];

    if (targetIds.length === 0) {
      this.showBanner('info', `Select one or more rows to ${mode}.`);
      return;
    }

    const idSet = new Set(targetIds);
    const snapshot = this.filteredAndSortedRows()
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ ...r, cells: { ...r.cells } }));

    this.clipboard.set({
      mode,
      targetType: 'rows',
      sourceIds: targetIds,
      rowsSnapshot: snapshot,
      columnSnapshot: null,
      columnCellsSnapshot: {},
      createdAt: Date.now(),
    });

    const cols = this.sortedColumns();
    const tsv = snapshot
      .map((r) => cols.map((c) => String(this.getDisplayCellValue(r, c) ?? '')).join('\t'))
      .join('\n');
    this.lastInternalClipboardText = tsv;
    if (this.isBrowser && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(tsv).catch(() => undefined);
    }

    this.showBanner(
      'info',
      `${mode === 'copy' ? 'Copied' : 'Cut'} ${snapshot.length} row(s) to clipboard (also ready for Excel). Right-click or press Ctrl+V to Paste.`
    );
  }

  public copyOrCutColumn(mode: 'copy' | 'cut', colId?: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const targetColId = colId || this.selectedColumnId() || this.activeCell()?.colId;
    if (!targetColId) {
      this.showBanner('info', `Right-click a column header to ${mode}.`);
      return;
    }

    const col = this.columns().find((c) => c.id === targetColId);
    if (!col) return;

    const cellValues: Record<string, CellPrimitive> = {};
    for (const r of this.rows()) {
      const val = r.cells[col.name] !== undefined ? r.cells[col.name] : r.cells[col.id];
      if (val !== undefined) {
        cellValues[r.id] = val;
      }
    }

    this.clipboard.set({
      mode,
      targetType: 'column',
      sourceIds: [col.id],
      rowsSnapshot: [],
      columnSnapshot: { ...col },
      columnCellsSnapshot: cellValues,
      createdAt: Date.now(),
    });

    const tsv = [
      col.name,
      ...this.filteredAndSortedRows().map((r) => String(this.getDisplayCellValue(r, col) ?? '')),
    ].join('\n');
    this.lastInternalClipboardText = tsv;
    if (this.isBrowser && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(tsv).catch(() => undefined);
    }

    this.showBanner(
      'info',
      `${mode === 'copy' ? 'Copied' : 'Cut'} column "${col.name}" (also copied to Excel clipboard). Right-click or press Ctrl+V to Paste.`
    );
  }

  public pasteClipboard(
    position: 'after' | 'before' = 'after',
    targetIdOverride?: string | null,
    event?: Event
  ): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const clip = this.clipboard();
    if (!clip) {
      this.showBanner('info', 'Clipboard is empty. Copy or Cut rows or a column first.');
      return;
    }

    if (clip.targetType === 'rows') {
      this.executeRowPaste(clip, position, targetIdOverride || undefined);
    } else {
      this.executeColumnPaste(clip, position, targetIdOverride || undefined);
    }
  }

  private executeRowPaste(
    clip: ClipboardBuffer,
    position: 'after' | 'before',
    targetRowIdOverride?: string
  ): void {
    const anchorRowId =
      targetRowIdOverride ||
      this.activeCell()?.rowId ||
      Array.from(this.selectedRowIds())[0] ||
      this.rows()[0]?.id;

    if (position === 'before' && this.isAddRowAboveOrPasteAboveDisabled(anchorRowId)) {
      this.showBanner(
        'info',
        'Paste Row(s) Above is disabled for the First Row (Add Row) and the first data row (Row 2).'
      );
      return;
    }

    if (this.sortRules().length > 0) {
      this.sortRules.set([]);
    }

    const nowIso = new Date().toISOString();
    let workingRows = [...this.rows()].sort((a, b) => a.orderIndex - b.orderIndex);
    this.recordHistorySnapshot(
      clip.mode === 'cut' ? 'Cut & Paste Row(s)' : 'Paste Copied Row(s)'
    );

    if (clip.mode === 'cut') {
      const cutSet = new Set(clip.sourceIds);
      const cutRows = workingRows.filter((r) => cutSet.has(r.id));
      workingRows = workingRows.filter((r) => !cutSet.has(r.id));

      let insertIdx = workingRows.length;
      if (anchorRowId === this.newRowSentinelId) {
        insertIdx = 0;
      } else {
        let anchorIdx = workingRows.findIndex((r) => r.id === anchorRowId);
        if (anchorIdx === -1) anchorIdx = workingRows.length - 1;
        insertIdx = position === 'before' ? Math.max(0, anchorIdx) : anchorIdx + 1;
      }

      workingRows.splice(insertIdx, 0, ...cutRows);
      const reindexed = workingRows.map((r, i) => ({
        ...r,
        orderIndex: (i + 1) * 10,
        updatedBy: this.currentUserName(),
        updatedAt: nowIso,
      }));
      const updatedCutRows = reindexed.filter((r) => cutSet.has(r.id));

      this.rows.set(reindexed);
      this.clipboard.set(null);
      this.persistToCloud(
        'Cut & Pasted Rows',
        `Moved ${cutRows.length} row(s) to new position`,
        updatedCutRows[0],
        undefined,
        updatedCutRows
      );
      this.showBanner('success', `Moved ${cutRows.length} cut row(s) and saved to database.`);
    } else {
      let insertIdx = workingRows.length;
      if (anchorRowId === this.newRowSentinelId) {
        insertIdx = 0;
      } else {
        let anchorIdx = workingRows.findIndex((r) => r.id === anchorRowId);
        if (anchorIdx === -1) anchorIdx = workingRows.length - 1;
        insertIdx = position === 'before' ? Math.max(0, anchorIdx) : anchorIdx + 1;
      }

      const pkCol = this.columns().find((c) => c.isPrimaryKey || c.isIdentity);
      let runningIdentity = this.computeNextIdentityValue(workingRows);
      const idIncrement = pkCol?.identityIncrement ?? 1;

      const pastedRows: GridRow[] = clip.rowsSnapshot.map((src, i) => {
        const clonedCells = { ...src.cells };
        if (pkCol) {
          clonedCells[pkCol.name] = runningIdentity;
          clonedCells[pkCol.id] = runningIdentity;
          runningIdentity += idIncrement;
        }
        if (typeof clonedCells['Record Code'] === 'string') {
          clonedCells['Record Code'] = `${clonedCells['Record Code']}-P${i + 1}`;
        }
        return {
          id: `row_paste_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 5)}`,
          orderIndex: 0,
          cells: clonedCells,
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
      });

      workingRows.splice(insertIdx, 0, ...pastedRows);
      const reindexed = workingRows.map((r, i) => ({
        ...r,
        orderIndex: (i + 1) * 10,
      }));
      const pastedIds = new Set(pastedRows.map((p) => p.id));
      const finalPastedRows = reindexed.filter((r) => pastedIds.has(r.id));

      this.rows.set(reindexed);
      this.visibleRowLimit.update((limit) => limit + finalPastedRows.length);
      this.persistToCloud(
        'Pasted Rows',
        `Pasted ${finalPastedRows.length} copied row(s)`,
        finalPastedRows[0],
        undefined,
        finalPastedRows
      );
      this.showBanner('success', `Pasted ${finalPastedRows.length} row(s) and saved to database.`);
    }
  }

  private executeColumnPaste(
    clip: ClipboardBuffer,
    position: 'after' | 'before',
    targetColIdOverride?: string
  ): void {
    const srcCol = clip.columnSnapshot;
    if (!srcCol) return;

    const anchorColId =
      targetColIdOverride ||
      this.selectedColumnId() ||
      this.activeCell()?.colId ||
      this.sortedColumns()[this.sortedColumns().length - 1]?.id;

    let orderedCols = [...this.sortedColumns()];
    this.recordHistorySnapshot(
      clip.mode === 'cut' ? `Cut & Paste Column "${srcCol.name}"` : `Paste Column "${srcCol.name}"`
    );

    if (clip.mode === 'cut') {
      orderedCols = orderedCols.filter((c) => c.id !== srcCol.id);
      let anchorIdx = orderedCols.findIndex((c) => c.id === anchorColId);
      if (anchorIdx === -1) anchorIdx = orderedCols.length - 1;
      const insertIdx = position === 'before' ? Math.max(0, anchorIdx) : anchorIdx + 1;

      orderedCols.splice(insertIdx, 0, srcCol);
      const reindexedCols = orderedCols.map((c, idx) => ({
        ...c,
        orderIndex: idx,
      }));

      this.columns.set(reindexedCols);
      this.clipboard.set(null);
      this.persistToCloud(
        'Column Moved (Cut/Paste)',
        `Moved column "${srcCol.name}"`,
        undefined,
        srcCol,
        undefined,
        reindexedCols
      );
      this.showBanner('success', `Moved column "${srcCol.name}" and saved to database.`);
    } else {
      let anchorIdx = orderedCols.findIndex((c) => c.id === anchorColId);
      if (anchorIdx === -1) anchorIdx = orderedCols.length - 1;
      const insertIdx = position === 'before' ? Math.max(0, anchorIdx) : anchorIdx + 1;

      let copyName = `${srcCol.name}_Copy`;
      let suffix = 2;
      while (orderedCols.some((c) => c.name.toLowerCase() === copyName.toLowerCase())) {
        copyName = `${srcCol.name}_Copy_${suffix++}`;
      }
      const newCol: GridColumn = {
        ...srcCol,
        id: copyName,
        name: copyName,
        isPrimaryKey: false,
        isIdentity: false,
        orderIndex: insertIdx,
      };

      orderedCols.splice(insertIdx, 0, newCol);
      const reindexedCols = orderedCols.map((c, idx) => ({
        ...c,
        orderIndex: idx,
      }));

      const nowIso = new Date().toISOString();
      const updatedRows = this.rows().map((r) => ({
        ...r,
        cells: {
          ...r.cells,
          ...(clip.columnCellsSnapshot[r.id] !== undefined
            ? {
                [copyName]: clip.columnCellsSnapshot[r.id],
                [newCol.id]: clip.columnCellsSnapshot[r.id],
              }
            : {}),
        },
        updatedAt: nowIso,
      }));

      this.columns.set(reindexedCols);
      this.rows.set(updatedRows);
      this.persistToCloud(
        'Column Copied & Pasted',
        `Created "${newCol.name}" from clipboard`,
        undefined,
        newCol,
        updatedRows.slice(0, 30),
        [newCol]
      );
      this.showBanner('success', `Pasted column "${newCol.name}" and saved to database.`);
    }
  }

  public isRowInClipboard(rowId: string, mode: 'copy' | 'cut'): boolean {
    const clip = this.clipboard();
    if (!clip || clip.targetType !== 'rows' || clip.mode !== mode) return false;
    return clip.sourceIds.includes(rowId);
  }

  public isColInClipboard(colId: string, mode: 'copy' | 'cut'): boolean {
    const clip = this.clipboard();
    if (!clip || clip.targetType !== 'column' || clip.mode !== mode) return false;
    return clip.sourceIds.includes(colId);
  }

  // =========================================================================
  // DYNAMIC COLUMNS: CREATE, EDIT, MOVE LEFT/RIGHT, DUPLICATE, DELETE
  // =========================================================================

  public openAddColumnModal(targetDbName?: string, targetTableName?: string): void {
    this.closeAllMenus();
    this.editingSchemaColId.set(null);
    this.schemaModalColType.set('text');
    this.targetColumnSchemaDbName.set(targetDbName || this.activeDatabaseName());
    this.targetColumnSchemaTableName.set(targetTableName || this.activeTableName());
    this.columnSchemaForm.reset({
      name: '',
      colType: 'text',
      width: 150,
      required: false,
      isNullable: true,
      lookupTableName: '',
      optionsCsv: 'High, Medium, Low',
      formula: '=[Units] * [Unit Cost]',
      defaultValue: '',
    });
    this.activeModal.set('column_schema');
  }

  public openEditColumnModalById(colId: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const targetId = colId || this.selectedColumnId() || this.activeCell()?.colId;
    const col = this.columns().find((c) => c.id === targetId);
    if (col) {
      this.openEditColumnModal(col, event, this.activeDatabaseName(), this.activeTableName());
    }
  }

  public openEditColumnModal(
    col: GridColumn,
    event?: Event,
    targetDbName?: string,
    targetTableName?: string
  ): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (this.isProtectedIdColumn(col)) {
      this.showBanner(
        'info',
        `The "${col.name}" primary key field cannot be edited or deleted until the table itself is deleted.`
      );
      return;
    }
    this.editingSchemaColId.set(col.id);
    this.schemaModalColType.set(col.colType);
    this.targetColumnSchemaDbName.set(targetDbName || this.activeDatabaseName());
    this.targetColumnSchemaTableName.set(targetTableName || this.activeTableName());
    const isNullAllowed = col.isNullable !== undefined ? col.isNullable : !col.required;
    const targetDb = targetDbName || this.activeDatabaseName();
    let initialFormula = col.formula || '=[Units] * [Unit Cost]';
    if (col.colType === 'lookup') {
      const targetCols = col.lookupTableName
        ? this.getTargetLookupTableColumns(targetDb, col.lookupTableName)
        : [];
      initialFormula = resolveLookupTemplateAndColumns(col.formula, targetCols).normalizedTemplate;
    }
    this.columnSchemaForm.reset({
      name: col.name,
      colType: col.colType,
      width: col.width,
      required: !isNullAllowed,
      isNullable: isNullAllowed,
      lookupTableName: col.lookupTableName || '',
      optionsCsv: col.optionsCsv || 'Option A, Option B',
      formula: initialFormula,
      defaultValue: col.defaultValue !== undefined ? String(col.defaultValue) : '',
    });
    this.activeModal.set('column_schema');
  }

  public onSchemaColTypeChange(): void {
    const selectedType = this.columnSchemaForm.controls.colType.value;
    this.schemaModalColType.set(selectedType);
    const currentOpts = (this.columnSchemaForm.controls.optionsCsv.value || '').trim();
    if (selectedType === 'lookup') {
      const currentLinked = (this.columnSchemaForm.controls.lookupTableName.value || '').trim();
      const avail = this.getAvailableLookupTablesForSchemaModal();
      const preferred =
        avail.find((t) => t.tableName.toLowerCase() === currentLinked.toLowerCase()) ||
        avail.find((t) => t.tableName.toLowerCase().includes('lookup')) ||
        avail[0];
      if (preferred && !currentLinked) {
        this.columnSchemaForm.controls.lookupTableName.setValue(preferred.tableName);
      }
      const resolvedTable =
        this.columnSchemaForm.controls.lookupTableName.value || preferred?.tableName || '';
      if (resolvedTable) {
        const dbName = this.targetColumnSchemaDbName() || this.activeDatabaseName();
        const targetCols = this.getTargetLookupTableColumns(dbName, resolvedTable);
        const currentFormula = this.columnSchemaForm.controls.formula.value || '';
        const { normalizedTemplate } = resolveLookupTemplateAndColumns(
          currentFormula.startsWith('=') ? '' : currentFormula,
          targetCols
        );
        this.columnSchemaForm.controls.formula.setValue(normalizedTemplate);
        const previewJson = this.buildClientLinkedLookupPreviewJson(
          dbName,
          resolvedTable,
          normalizedTemplate
        );
        if (previewJson) {
          this.columnSchemaForm.controls.optionsCsv.setValue(previewJson);
        }
        const items = this.getSchemaModalLookupItems();
        if (items.length > 0 && !this.columnSchemaForm.controls.defaultValue.value) {
          const activeItem = items.find((i) => i.isActive !== false) || items[0];
          this.columnSchemaForm.controls.defaultValue.setValue(activeItem.json);
        }
      } else if (
        !currentOpts ||
        currentOpts === 'High, Medium, Low' ||
        currentOpts === 'Option A, Option B'
      ) {
        this.columnSchemaForm.controls.formula.setValue('{[ID], [Name]}');
        this.columnSchemaForm.controls.optionsCsv.setValue(
          '[{"ID":1,"Name":"car"},{"ID":2,"Name":"bus"},{"ID":3,"Name":"truck"}]'
        );
      }
    } else if (selectedType === 'dropdown') {
      this.columnSchemaForm.controls.lookupTableName.setValue('');
      if (!currentOpts || currentOpts.startsWith('[')) {
        this.columnSchemaForm.controls.optionsCsv.setValue('High, Medium, Low');
      }
    } else if (selectedType === 'formula') {
      this.columnSchemaForm.controls.lookupTableName.setValue('');
      const currentFormula = (this.columnSchemaForm.controls.formula.value || '').trim();
      if (!currentFormula || currentFormula.startsWith('{')) {
        this.columnSchemaForm.controls.formula.setValue('=[Units] * [Unit Cost]');
      }
    } else {
      this.columnSchemaForm.controls.lookupTableName.setValue('');
    }
  }

  public onSchemaLookupTableChange(): void {
    const selectedTable = (this.columnSchemaForm.controls.lookupTableName.value || '').trim();
    if (!selectedTable) return;
    const dbName = this.targetColumnSchemaDbName() || this.activeDatabaseName();
    const targetCols = this.getTargetLookupTableColumns(dbName, selectedTable);
    const { normalizedTemplate } = resolveLookupTemplateAndColumns('', targetCols);
    this.columnSchemaForm.controls.formula.setValue(normalizedTemplate);
    const previewJson = this.buildClientLinkedLookupPreviewJson(
      dbName,
      selectedTable,
      normalizedTemplate
    );
    if (previewJson) {
      this.columnSchemaForm.controls.optionsCsv.setValue(previewJson);
    }
    const items = this.getSchemaModalLookupItems();
    if (items.length > 0) {
      const activeItem = items.find((i) => i.isActive !== false) || items[0];
      this.columnSchemaForm.controls.defaultValue.setValue(activeItem.json);
    }
  }

  public onSchemaIsNullableChange(): void {
    const isNull = this.columnSchemaForm.controls.isNullable.value;
    this.columnSchemaForm.controls.required.setValue(!isNull, { emitEvent: false });
  }

  public onSchemaRequiredChange(): void {
    const req = this.columnSchemaForm.controls.required.value;
    this.columnSchemaForm.controls.isNullable.setValue(!req, { emitEvent: false });
  }

  public appendTokenToFormula(colName: string): void {
    const current = this.columnSchemaForm.controls.formula.value;
    const prefix = current.trim().startsWith('=') ? current : `=${current}`;
    this.columnSchemaForm.controls.formula.setValue(`${prefix} [${colName}]`.trim());
  }

  private resolveColumnDefaultPrimitive(col: GridColumn, rawDefault: string): CellPrimitive {
    const trimmed = String(rawDefault ?? '').trim();
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
      const opts = getDropdownOptions(col);
      const matched = opts.find((o) => o.toLowerCase() === trimmed.toLowerCase());
      return matched || opts[0] || '';
    }
    if (col.colType === 'lookup') {
      const items = getLookupOptions(col);
      if (items.length > 0) {
        const matched = matchLookupItemFromRaw(items, trimmed);
        if (matched) return matched.json;
        const activeDefault = items.find((i) => i.isActive !== false) || items[0];
        if (!trimmed) {
          return col.required && activeDefault ? activeDefault.json : '';
        }
        return activeDefault ? activeDefault.json : trimmed;
      }
      return trimmed;
    }
    if (col.colType === 'text' || col.colType === 'varchar_max') {
      return trimmed.slice(0, 2000) || (col.required ? 'TBD' : '');
    }
    return '';
  }

  public saveColumnSchema(): void {
    if (this.columnSchemaForm.invalid) {
      this.showBanner('error', 'Please provide a valid field name.');
      return;
    }

    const val = this.columnSchemaForm.getRawValue();
    const editingId = this.editingSchemaColId();
    const cleanName = val.name.trim();
    const isRequired = Boolean(val.required);
    const isNullAllowed = !isRequired;
    const targetDbName = (this.targetColumnSchemaDbName() || this.activeDatabaseName()).trim();
    const targetTableName = (this.targetColumnSchemaTableName() || this.activeTableName()).trim();
    const isTargetActiveTable =
      targetDbName.toLowerCase() === this.activeDatabaseName().toLowerCase() &&
      targetTableName.toLowerCase() === this.activeTableName().toLowerCase();

    const existingTargetCols = this.targetColumnSchemaColumns();

    if (editingId) {
      const prevCol = existingTargetCols.find((c) => c.id === editingId);
      if (
        prevCol &&
        cleanName.toLowerCase() !== prevCol.name.toLowerCase() &&
        existingTargetCols.some(
          (c) => c.id !== editingId && c.name.toLowerCase() === cleanName.toLowerCase()
        )
      ) {
        this.showBanner('error', `A field named "${cleanName}" already exists in table "${targetTableName}".`);
        return;
      }

      const renamedColumnsPayload =
        prevCol && prevCol.name !== cleanName
          ? [{ oldName: prevCol.name, newName: cleanName }]
          : undefined;

      if (!isTargetActiveTable) {
        const hasExplicitDefault = String(val.defaultValue ?? '').trim().length > 0;
        const updatedCols = existingTargetCols.map((c) => {
          if (c.id !== editingId) return c;
          const isPk = Boolean(c.isPrimaryKey || c.isIdentity);
          return {
            ...c,
            id: cleanName,
            name: cleanName,
            colType: isPk ? ('number' as ColumnType) : val.colType,
            width: Number(val.width) || 150,
            required: isPk ? true : isRequired,
            isNullable: isPk ? false : isNullAllowed,
            defaultValue: String(val.defaultValue ?? '').trim(),
            lookupTableName:
              val.colType === 'lookup' ? (val.lookupTableName || '').trim() : '',
            optionsCsv:
              val.colType === 'dropdown' || val.colType === 'lookup'
                ? val.optionsCsv.trim()
                : '',
            formula:
              val.colType === 'formula'
                ? val.formula.trim().startsWith('=')
                  ? val.formula.trim()
                  : `=${val.formula.trim()}`
                : val.colType === 'lookup'
                ? val.formula.trim() || '{[ID]}'
                : '',
          };
        });

        this.databases.update((dbs) =>
          dbs.map((db) => {
            if (db.databaseName.toLowerCase() !== targetDbName.toLowerCase()) return db;
            return {
              ...db,
              tables: (db.tables || []).map((t) =>
                t.tableName.toLowerCase() === targetTableName.toLowerCase()
                  ? { ...t, columnCount: updatedCols.length, columns: updatedCols }
                  : t
              ),
            };
          })
        );
        if (targetDbName.toLowerCase() === this.activeDatabaseName().toLowerCase()) {
          this.tables.update((list) =>
            list.map((t) =>
              t.tableName.toLowerCase() === targetTableName.toLowerCase()
                ? { ...t, columnCount: updatedCols.length, columns: updatedCols }
                : t
            )
          );
        }

        this.activeModal.set('none');
        this.http
          .post<{
            ok: boolean;
            databases?: DbDatabaseSummary[];
            tables?: DbTableSummary[];
            columns?: GridColumn[];
            rows?: GridRow[];
            activities?: ActivityLogItem[];
          }>('/api/workspace/sync', {
            clientId: this.currentClientId(),
            userName: this.currentUserName(),
            userColor: this.currentUserColor(),
            actionType: 'Field Schema Updated',
            actionDetail: `Updated field "${cleanName}" (${val.colType}) in "${targetDbName}.${targetTableName}"`,
            databaseName: targetDbName,
            tableName: targetTableName,
            preserveActiveContext: true,
            columns: updatedCols,
            renamedColumns: renamedColumnsPayload,
            applyDefaultToAllRowsForColId: hasExplicitDefault ? cleanName : undefined,
          })
          .subscribe({
            next: (res) => {
              if (Array.isArray(res?.databases)) {
                this.databases.set(res.databases);
                this.syncTablesSignalForActiveDatabase(res.databases);
              }
              if (Array.isArray(res?.columns)) {
                this.columns.set(res.columns);
                if (Array.isArray(res?.rows)) {
                  const sanitized = this.sanitizeClientRowsAgainstColumns(res.columns, res.rows);
                  this.rows.set(sanitized);
                  this.snapshotValidRows(sanitized);
                }
              }
              if (Array.isArray(res?.activities)) {
                this.activities.set(res.activities);
              }
              this.showBanner('success', `Updated field "${cleanName}" in table "${targetTableName}".`);
            },
          });
        return;
      }

      const prevCols = this.columns();
      this.recordHistorySnapshot(`Edit Schema for "${cleanName}"`);
      let updatedColRef: GridColumn | undefined;
      const hasExplicitDefault = String(val.defaultValue ?? '').trim().length > 0;

      this.columns.update((cols) =>
        cols.map((c) => {
          if (c.id === editingId) {
            const isPk = Boolean(c.isPrimaryKey || c.isIdentity);
            updatedColRef = {
              ...c,
              id: cleanName,
              name: cleanName,
              colType: isPk ? 'number' : val.colType,
              width: Number(val.width) || 150,
              required: isPk ? true : isRequired,
              isNullable: isPk ? false : isNullAllowed,
              defaultValue: String(val.defaultValue ?? '').trim(),
              lookupTableName:
                val.colType === 'lookup' ? (val.lookupTableName || '').trim() : '',
              optionsCsv:
                val.colType === 'dropdown' || val.colType === 'lookup'
                  ? val.optionsCsv.trim()
                  : '',
              formula:
                val.colType === 'formula'
                  ? val.formula.trim().startsWith('=')
                    ? val.formula.trim()
                    : `=${val.formula.trim()}`
                  : val.colType === 'lookup'
                  ? val.formula.trim() || '{[ID]}'
                  : '',
            };
            return updatedColRef;
          }
          return c;
        })
      );

      if (updatedColRef) {
        const targetCol = updatedColRef;
        const resolvedDefault = hasExplicitDefault
          ? this.resolveColumnDefaultPrimitive(targetCol, val.defaultValue)
          : undefined;

        this.rows.update((list) =>
          list.map((r) => {
            const nextCells: Record<string, CellPrimitive> = { ...r.cells };
            const oldVal =
              prevCol && nextCells[prevCol.name] !== undefined
                ? nextCells[prevCol.name]
                : nextCells[editingId];
            if (prevCol && prevCol.name !== cleanName) {
              delete nextCells[prevCol.name];
            }
            if (editingId !== cleanName) {
              delete nextCells[editingId];
            }

            if (targetCol.colType === 'formula') {
              delete nextCells[cleanName];
            } else if (prevCol?.colType === 'formula') {
              if (resolvedDefault !== undefined) {
                nextCells[cleanName] = resolvedDefault;
                nextCells[targetCol.id] = resolvedDefault;
              } else if (
                targetCol.colType === 'number' ||
                targetCol.colType === 'text' ||
                targetCol.colType === 'varchar_max'
              ) {
                const evalVal = evaluateFormula(prevCol.formula, r, prevCols);
                nextCells[cleanName] = evalVal;
                nextCells[targetCol.id] = evalVal;
              } else if (targetCol.colType === 'checkbox') {
                nextCells[cleanName] = false;
                nextCells[targetCol.id] = false;
              }
            } else if (resolvedDefault !== undefined) {
              // Apply the updated default value across all rows in the table
              nextCells[cleanName] = resolvedDefault;
              nextCells[targetCol.id] = resolvedDefault;
            } else {
              const fallbackVal = oldVal !== undefined ? oldVal : '';
              nextCells[cleanName] = fallbackVal;
              nextCells[targetCol.id] = fallbackVal;
            }
            return {
              ...r,
              cells: nextCells,
            };
          })
        );
      }

      this.activeModal.set('none');
      if (updatedColRef) {
        const allRowIds = this.rows().map((r) => r.id);
        this.validateAndSyncRows(
          allRowIds,
          [updatedColRef],
          'Field Schema Updated',
          `Updated field "${cleanName}" (${val.colType})`,
          hasExplicitDefault ? updatedColRef.id : undefined,
          renamedColumnsPayload
        );
      }
    } else {
      if (existingTargetCols.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
        this.showBanner('error', `A field named "${cleanName}" already exists in table "${targetTableName}".`);
        return;
      }

      const newColId = cleanName;
      const nextOrder =
        existingTargetCols.reduce((max, c) => Math.max(max, c.orderIndex), -1) + 1;
      const newCol: GridColumn = {
        id: newColId,
        name: cleanName,
        colType: val.colType,
        orderIndex: nextOrder,
        width: Number(val.width) || 150,
        required: isRequired,
        isNullable: isNullAllowed,
        defaultValue: String(val.defaultValue ?? '').trim(),
        lookupTableName:
          val.colType === 'lookup' ? (val.lookupTableName || '').trim() : '',
        optionsCsv:
          val.colType === 'dropdown' || val.colType === 'lookup'
            ? val.optionsCsv.trim()
            : '',
        formula:
          val.colType === 'formula'
            ? val.formula.trim().startsWith('=')
              ? val.formula.trim()
              : `=${val.formula.trim()}`
            : val.colType === 'lookup'
            ? val.formula.trim() || '{[ID]}'
            : '',
      };

      if (!isTargetActiveTable) {
        const updatedCols = [...existingTargetCols, newCol];
        this.databases.update((dbs) =>
          dbs.map((db) => {
            if (db.databaseName.toLowerCase() !== targetDbName.toLowerCase()) return db;
            return {
              ...db,
              tables: (db.tables || []).map((t) =>
                t.tableName.toLowerCase() === targetTableName.toLowerCase()
                  ? { ...t, columnCount: updatedCols.length, columns: updatedCols }
                  : t
              ),
            };
          })
        );
        if (targetDbName.toLowerCase() === this.activeDatabaseName().toLowerCase()) {
          this.tables.update((list) =>
            list.map((t) =>
              t.tableName.toLowerCase() === targetTableName.toLowerCase()
                ? { ...t, columnCount: updatedCols.length, columns: updatedCols }
                : t
            )
          );
        }

        this.activeModal.set('none');
        this.http
          .post<{
            ok: boolean;
            databases?: DbDatabaseSummary[];
            tables?: DbTableSummary[];
            columns?: GridColumn[];
            rows?: GridRow[];
            activities?: ActivityLogItem[];
          }>('/api/workspace/sync', {
            clientId: this.currentClientId(),
            userName: this.currentUserName(),
            userColor: this.currentUserColor(),
            actionType: 'Field Created',
            actionDetail: `Added field "${cleanName}" (${newCol.colType}) to "${targetDbName}.${targetTableName}"`,
            databaseName: targetDbName,
            tableName: targetTableName,
            preserveActiveContext: true,
            columns: updatedCols,
            applyDefaultToAllRowsForColId: newCol.id,
          })
          .subscribe({
            next: (res) => {
              if (Array.isArray(res?.databases)) {
                this.databases.set(res.databases);
                this.syncTablesSignalForActiveDatabase(res.databases);
              }
              if (Array.isArray(res?.columns)) {
                this.columns.set(res.columns);
                if (Array.isArray(res?.rows)) {
                  const sanitized = this.sanitizeClientRowsAgainstColumns(res.columns, res.rows);
                  this.rows.set(sanitized);
                  this.snapshotValidRows(sanitized);
                }
              }
              if (Array.isArray(res?.activities)) {
                this.activities.set(res.activities);
              }
              this.showBanner(
                'success',
                `Created field "${cleanName}" (${newCol.colType}) in table "${targetTableName}".`
              );
            },
          });
        return;
      }

      const initialCellVal = this.resolveColumnDefaultPrimitive(newCol, val.defaultValue);

      this.recordHistorySnapshot(`Add Field "${cleanName}"`);
      this.columns.update((cols) => [...cols, newCol]);

      if (newCol.colType !== 'formula') {
        this.rows.update((list) =>
          list.map((r) => ({
            ...r,
            cells: {
              ...r.cells,
              [cleanName]: initialCellVal,
              [newCol.id]: initialCellVal,
            },
          }))
        );
      }

      const currentRows = this.rows();
      this.activeModal.set('none');
      this.selectedColumnId.set(newColId);
      this.persistToCloud(
        'Field Created',
        `Added field "${cleanName}" (${newCol.colType}) to "${this.activeTableName()}"`,
        currentRows[0],
        newCol,
        currentRows,
        [newCol],
        undefined,
        newCol.id
      );
      this.showBanner(
        'success',
        `Created field "${cleanName}" (${newCol.colType}) and applied default value across all rows in database table "${this.activeTableName()}".`
      );
    }
  }

  public moveColumn(direction: 'left' | 'right', colId?: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const targetId = colId || this.selectedColumnId() || this.activeCell()?.colId;
    if (!targetId) {
      this.showBanner('info', 'Select a column first to move it left or right.');
      return;
    }

    const ordered = [...this.sortedColumns()];
    const idx = ordered.findIndex((c) => c.id === targetId);
    if (idx === -1) return;

    const swapIdx = direction === 'left' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;

    const temp = ordered[swapIdx];
    ordered[swapIdx] = ordered[idx];
    ordered[idx] = temp;

    const reindexed = ordered.map((c, i) => ({ ...c, orderIndex: i }));
    this.recordHistorySnapshot(`Move Column "${ordered[swapIdx].name}" ${direction}`);
    this.columns.set(reindexed);
    this.persistToCloud(
      'Column Moved',
      `Moved column "${ordered[swapIdx].name}" ${direction}`,
      undefined,
      ordered[swapIdx],
      undefined,
      [reindexed[swapIdx], reindexed[idx]]
    );
    this.showBanner('success', `Moved column "${ordered[swapIdx].name}" ${direction} and saved to database.`);
  }

  public deleteColumn(colId: string | null, event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    if (!colId) return;
    const target = this.columns().find((c) => c.id === colId);
    if (!target) return;
    if (this.isProtectedIdColumn(target)) {
      this.showBanner(
        'info',
        `The "${target.name}" primary key field cannot be deleted until the table "${this.activeTableName()}" itself is deleted.`
      );
      return;
    }

    this.requestConfirmation(
      'Confirm Drop Column',
      `Are you sure you want to drop the column "${target.name}" and all of its cell data from table "${this.activeDatabaseName()}.${this.activeTableName()}"?`,
      `Drop "${target.name}"`,
      'danger',
      () => {
        this.recordHistorySnapshot(`Delete Column "${target.name}"`);
        this.columns.update((cols) => cols.filter((c) => c.id !== colId));
        this.rows.update((list) =>
          list.map((r) => {
            const nextCells = { ...r.cells };
            delete nextCells[colId];
            delete nextCells[target.name];
            return { ...r, cells: nextCells };
          })
        );
        this.sortRules.update((rules) => rules.filter((r) => r.columnId !== colId));
        this.filterRules.update((prev) => {
          const next = { ...prev };
          delete next[colId];
          return next;
        });
        this.cellValidationErrors.update((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (key.endsWith(`:${colId}`)) {
              delete next[key];
            }
          }
          return next;
        });

        this.persistToCloud('Column Deleted', `Removed column "${target.name}" from "${this.activeTableName()}"`);
        this.showBanner('info', `Deleted column "${target.name}" and synced with database.`);
      }
    );
  }

  // =========================================================================
  // MULTI-COLUMN SORT (1, 2, 3, or N COLUMNS LIKE EXCEL)
  // =========================================================================

  public handleColumnHeaderSort(colId: string, _multiStack?: boolean, event?: Event): void {
    event?.stopPropagation();
    const current = [...this.sortRules()];
    const existingIdx = current.findIndex((r) => r.columnId === colId);

    // Cycle this column in the N-column sort stack: None -> ASC -> DESC -> None
    if (existingIdx >= 0) {
      if (current[existingIdx].direction === 'asc') {
        current[existingIdx] = { columnId: colId, direction: 'desc' };
      } else {
        current.splice(existingIdx, 1);
      }
    } else {
      current.push({ columnId: colId, direction: 'asc' });
    }
    this.sortRules.set(current);
    this.queryDatabaseRows(true);
  }

  public setQuickSortOnColumn(
    colId: string | null,
    direction: 'asc' | 'desc',
    appendToMulti = true
  ): void {
    this.closeAllMenus();
    if (!colId) return;
    const current = [...this.sortRules()];
    const existingIdx = current.findIndex((r) => r.columnId === colId);
    if (appendToMulti) {
      if (existingIdx >= 0) {
        current[existingIdx] = { columnId: colId, direction };
      } else {
        current.push({ columnId: colId, direction });
      }
      this.sortRules.set(current);
    } else {
      this.sortRules.set([{ columnId: colId, direction }]);
    }
    this.queryDatabaseRows(true);
  }

  public addSortLevel(): void {
    const current = this.sortRules();
    const usedIds = new Set(current.map((r) => r.columnId));
    const availableCol =
      this.sortedColumns().find((c) => !usedIds.has(c.id)) || this.sortedColumns()[0];
    if (!availableCol) return;

    this.sortRules.set([...current, { columnId: availableCol.id, direction: 'asc' }]);
    this.queryDatabaseRows(true);
  }

  public updateSortLevelColumn(index: number, newColId: string): void {
    this.sortRules.update((rules) =>
      rules.map((r, idx) => (idx === index ? { ...r, columnId: newColId } : r))
    );
    this.queryDatabaseRows(true);
  }

  public updateSortLevelDirection(index: number, direction: 'asc' | 'desc'): void {
    this.sortRules.update((rules) =>
      rules.map((r, idx) => (idx === index ? { ...r, direction } : r))
    );
    this.queryDatabaseRows(true);
  }

  public moveSortLevel(index: number, dir: 'up' | 'down'): void {
    const rules = [...this.sortRules()];
    const targetIdx = dir === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= rules.length) return;
    const temp = rules[targetIdx];
    rules[targetIdx] = rules[index];
    rules[index] = temp;
    this.sortRules.set(rules);
    this.queryDatabaseRows(true);
  }

  public removeSortLevel(index: number): void {
    this.sortRules.update((rules) => rules.filter((_, i) => i !== index));
    this.queryDatabaseRows(true);
  }

  public clearAllSorts(): void {
    this.closeAllMenus();
    this.sortRules.set([]);
    this.queryDatabaseRows(true);
  }

  public getColumnSortBadge(colId: string): { order: number; direction: 'asc' | 'desc' } | null {
    const idx = this.sortRules().findIndex((r) => r.columnId === colId);
    if (idx === -1) return null;
    return {
      order: idx + 1,
      direction: this.sortRules()[idx].direction,
    };
  }

  // =========================================================================
  // EXCEL-STYLE MULTI-COLUMN FILTERING & GLOBAL SEARCH (FROM DATABASE)
  // =========================================================================

  public onSearchInputChange(): void {
    this.globalSearchQuery.set(this.searchInputControl.value);
    this.queryDatabaseRows(true);
  }

  public onSearchScopeChange(): void {
    this.searchScopeColId.set(this.searchScopeControl.value);
    this.queryDatabaseRows(true);
  }

  public clearGlobalSearch(): void {
    this.searchInputControl.setValue('');
    this.globalSearchQuery.set('');
    this.queryDatabaseRows(true);
  }

  public openExcelFilterForColumn(colId: string | null, event?: Event): void {
    event?.stopPropagation();
    const wasAlreadyOpen = this.activeModal() === 'column_filter';
    this.closeAllMenus();

    if (!wasAlreadyOpen) {
      // Clone currently applied filter rules into draftFilterRules so edits do NOT call DB until Apply Filter is clicked
      const cloned: Record<string, ColumnFilterRule> = {};
      const currentApplied = this.filterRules();
      for (const [k, v] of Object.entries(currentApplied)) {
        cloned[k] = {
          ...v,
          excludedValues: [...(v.excludedValues || [])],
        };
      }
      this.draftFilterRules.set(cloned);
      this.draftColumnHeaderSearches.set({ ...this.columnHeaderSearches() });
    } else {
      // Sync current column's condition inputs into draft before switching column tabs inside the modal
      this.syncActiveColumnConditionToDraft();
    }

    const targetId = colId || this.selectedColumnId() || this.sortedColumns()[0]?.id || 'col_dept';
    this.activeFilterColId.set(targetId);
    this.filterChecklistSearch.set('');
    this.filterChecklistSearchControl.setValue('');

    const existing = this.draftFilterRules()[targetId];
    this.filterConditionControl.setValue(existing?.condition || 'none');
    this.filterValueControl.setValue(existing?.queryValue || '');
    this.filterValueEndControl.setValue(existing?.queryValueEnd || '');
    this.activeModal.set('column_filter');
  }

  private syncActiveColumnConditionToDraft(): void {
    const colId = this.activeFilterColId();
    if (!colId) return;
    const current = this.draftFilterRules()[colId] || {
      columnId: colId,
      condition: 'none' as FilterConditionType,
      queryValue: '',
      queryValueEnd: '',
      excludedValues: [],
    };
    this.draftFilterRules.update((prev) => ({
      ...prev,
      [colId]: {
        ...current,
        condition: this.filterConditionControl.value,
        queryValue: this.filterValueControl.value,
        queryValueEnd: this.filterValueEndControl.value,
      },
    }));
  }

  public onFilterChecklistSearchInput(): void {
    this.filterChecklistSearch.set(this.filterChecklistSearchControl.value);
  }

  public onFilterConditionInput(): void {
    // Only update local draft inside the filter modal — do NOT call database or show loader until Apply Filter is clicked
    this.syncActiveColumnConditionToDraft();
  }

  public toggleFilterUniqueValue(valueLabel: string): void {
    // Only update local draft inside the filter modal — do NOT call database or show loader until Apply Filter is clicked
    const colId = this.activeFilterColId();
    if (!colId) return;
    const current = this.draftFilterRules()[colId] || {
      columnId: colId,
      condition: this.filterConditionControl.value || ('none' as FilterConditionType),
      queryValue: this.filterValueControl.value || '',
      queryValueEnd: this.filterValueEndControl.value || '',
      excludedValues: [],
    };
    const excluded = new Set(current.excludedValues);
    if (excluded.has(valueLabel)) {
      excluded.delete(valueLabel);
    } else {
      excluded.add(valueLabel);
    }
    this.draftFilterRules.update((prev) => ({
      ...prev,
      [colId]: {
        ...current,
        excludedValues: Array.from(excluded),
      },
    }));
  }

  public selectAllFilterChecklistValues(selectAll: boolean): void {
    // Only update local draft inside the filter modal — do NOT call database or show loader until Apply Filter is clicked
    const col = this.activeFilterColumn();
    if (!col) return;
    const current = this.draftFilterRules()[col.id] || {
      columnId: col.id,
      condition: this.filterConditionControl.value || ('none' as FilterConditionType),
      queryValue: this.filterValueControl.value || '',
      queryValueEnd: this.filterValueEndControl.value || '',
      excludedValues: [],
    };

    if (selectAll) {
      this.draftFilterRules.update((prev) => ({
        ...prev,
        [col.id]: { ...current, excludedValues: [] },
      }));
    } else {
      const allLabels = this.uniqueValuesForActiveFilterCol().map((u) => u.label);
      this.draftFilterRules.update((prev) => ({
        ...prev,
        [col.id]: { ...current, excludedValues: allLabels },
      }));
    }
  }

  public applyColumnFilterModal(event?: Event): void {
    event?.stopPropagation();
    this.syncActiveColumnConditionToDraft();
    const nextRules: Record<string, ColumnFilterRule> = {};
    for (const [k, v] of Object.entries(this.draftFilterRules())) {
      nextRules[k] = {
        ...v,
        excludedValues: [...(v.excludedValues || [])],
      };
    }
    this.filterRules.set(nextRules);
    this.columnHeaderSearches.set({ ...this.draftColumnHeaderSearches() });
    this.activeModal.set('none');
    this.queryDatabaseRows(true);
  }

  public cancelColumnFilterModal(event?: Event): void {
    event?.stopPropagation();
    this.draftFilterRules.set({});
    this.activeModal.set('none');
  }

  public updateColumnHeaderSearch(colId: string, query: string): void {
    // Update draft only — do NOT call database or trigger loader until Apply (Enter / button) is clicked
    this.draftColumnHeaderSearches.update((prev) => ({
      ...prev,
      [colId]: query,
    }));
  }

  public applyColumnHeaderSearch(colId: string, event?: Event): void {
    event?.stopPropagation();
    const draftVal = this.draftColumnHeaderSearches()[colId] ?? '';
    this.columnHeaderSearches.update((prev) => ({
      ...prev,
      [colId]: draftVal,
    }));
    this.queryDatabaseRows(true);
  }

  public clearColumnHeaderSearch(colId: string, event?: Event): void {
    event?.stopPropagation();
    const hadApplied = Boolean((this.columnHeaderSearches()[colId] || '').trim());
    this.draftColumnHeaderSearches.update((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    this.columnHeaderSearches.update((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    if (hadApplied) {
      this.queryDatabaseRows(true);
    }
  }

  public clearFilterForColumn(colId: string, event?: Event): void {
    event?.stopPropagation();
    this.draftFilterRules.update((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    this.filterRules.update((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    this.draftColumnHeaderSearches.update((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    this.columnHeaderSearches.update((prev) => {
      const next = { ...prev };
      delete next[colId];
      return next;
    });
    if (this.activeFilterColId() === colId) {
      this.filterConditionControl.setValue('none');
      this.filterValueControl.setValue('');
      this.filterValueEndControl.setValue('');
    }
    this.activeModal.set('none');
    this.queryDatabaseRows(true);
  }

  public clearAllFiltersAndSearch(): void {
    this.closeAllMenus();
    this.draftFilterRules.set({});
    this.filterRules.set({});
    this.draftColumnHeaderSearches.set({});
    this.columnHeaderSearches.set({});
    this.searchInputControl.setValue('');
    this.globalSearchQuery.set('');
    this.queryDatabaseRows(true);
    this.showBanner('info', 'Cleared all column filters, searches, and sorts.');
  }

  public isColumnFiltered(colId: string): boolean {
    if ((this.columnHeaderSearches()[colId] || '').trim().length > 0) {
      return true;
    }
    const rulesSource =
      this.activeModal() === 'column_filter' ? this.draftFilterRules() : this.filterRules();
    const r = rulesSource[colId];
    if (!r) return false;
    return (
      r.excludedValues.length > 0 ||
      (r.condition !== 'none' &&
        (r.condition === 'empty' ||
          r.condition === 'not_empty' ||
          r.queryValue.trim().length > 0))
    );
  }

  // =========================================================================
  // AUTOMATIC SCROLL-BASED LAZY LOADING (10 ROWS AT A TIME FROM DATABASE)
  // =========================================================================

  public onTheadWheel(event: WheelEvent): void {
    const theadEl = event.currentTarget as HTMLElement | null;
    const tbodyEl = theadEl?.closest('table')?.querySelector('tbody') as HTMLElement | null;
    if (!tbodyEl) return;
    if (event.deltaX !== 0) {
      tbodyEl.scrollLeft += event.deltaX;
      if (theadEl) {
        theadEl.scrollLeft = tbodyEl.scrollLeft;
      }
    }
    if (event.deltaY !== 0) {
      tbodyEl.scrollTop += event.deltaY;
    }
  }

  public onTableScroll(event: Event): void {
    const el = (event.currentTarget || event.target) as HTMLElement | null;
    if (!el) return;
    const tableEl = el.closest('table');
    const theadEl = tableEl?.querySelector('thead') as HTMLElement | null;
    if (theadEl && theadEl.scrollLeft !== el.scrollLeft) {
      theadEl.scrollLeft = el.scrollLeft;
    }
    const remainingBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (
      (remainingBottom <= 440 && el.scrollTop > 10) &&
      this.hasMoreLazyRows() &&
      !this.isLazyLoadingMore()
    ) {
      this.loadNextLazyBatch();
    }
  }

  public onTableWheel(event: WheelEvent): void {
    if (event.deltaY <= 0) return;
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const remainingBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remainingBottom <= 460 && this.hasMoreLazyRows() && !this.isLazyLoadingMore()) {
      this.loadNextLazyBatch();
    }
  }

  public onTableTouchMove(event: TouchEvent): void {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const remainingBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remainingBottom <= 460 && this.hasMoreLazyRows() && !this.isLazyLoadingMore()) {
      this.loadNextLazyBatch();
    }
  }

  public onWindowScroll(): void {
    // Table has its own dedicated scroll container; window scroll does not auto-expand table
  }

  public loadNextLazyBatch(): void {
    if (!this.hasMoreLazyRows() || this.isLazyLoadingMore()) return;
    if (this.visibleRowLimit() < this.filteredAndSortedRows().length) {
      this.isLazyLoadingMore.set(true);
      setTimeout(() => {
        const nextLimit = this.visibleRowLimit() + this.lazyBatchSize;
        this.visibleRowLimit.set(nextLimit);
        this.isLazyLoadingMore.set(false);
        if (nextLimit > this.filteredAndSortedRows().length && this.dbHasMoreRows()) {
          this.queryDatabaseRows(false);
        }
      }, 40);
    } else if (this.dbHasMoreRows()) {
      this.queryDatabaseRows(false);
    }
  }

  // =========================================================================
  // WORKSPACE RENAME, CSV EXPORT & KEYBOARD SHORTCUTS
  // =========================================================================

  public startRenameWorkspace(): void {
    this.workspaceNameControl.setValue(this.workspaceName());
    this.isEditingWorkspaceName.set(true);
  }

  public commitRenameWorkspace(): void {
    const nextName = this.workspaceNameControl.value.trim();
    this.isEditingWorkspaceName.set(false);
    if (nextName.length > 0 && nextName !== this.workspaceName()) {
      this.recordHistorySnapshot(`Rename Workspace to "${nextName}"`);
      this.workspaceName.set(nextName);
      this.persistToCloud('Workspace Renamed', `Renamed sheet to "${nextName}"`);
    }
  }

  // =========================================================================
  // UNDO (UP TO 20 STEPS) & REDO (UP TO 20 STEPS) ENGINE
  // =========================================================================

  private captureCurrentSnapshot(label: string): HistorySnapshot {
    return {
      label,
      workspaceName: this.workspaceName(),
      columns: this.columns().map((c) => ({ ...c })),
      rows: this.rows().map((r) => ({ ...r, cells: { ...r.cells } })),
      cellValidationErrors: { ...this.cellValidationErrors() },
      pendingUnsavedRowIds: Array.from(this.pendingUnsavedRowIds()),
      pendingUnsavedColIds: Array.from(this.pendingUnsavedColIds()),
      activeCell: this.activeCell() ? { ...this.activeCell()! } : null,
      timestamp: new Date().toISOString(),
    };
  }

  public recordHistorySnapshot(label: string): void {
    const snap = this.captureCurrentSnapshot(label);
    this.undoStack.update((prev) => [...prev, snap].slice(-this.maxHistorySteps));
    this.redoStack.set([]);
  }

  public undo(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const stack = this.undoStack();
    if (stack.length === 0) {
      this.showBanner('info', 'Nothing to undo (0 steps in undo history).');
      return;
    }

    const targetSnap = stack[stack.length - 1];
    const currentSnap = this.captureCurrentSnapshot(targetSnap.label);

    this.undoStack.set(stack.slice(0, -1));
    this.redoStack.update((prev) => [...prev, currentSnap].slice(-this.maxHistorySteps));

    this.restoreHistorySnapshot(
      targetSnap,
      'Undo',
      `Undid "${targetSnap.label}" (${this.undoStack().length}/${this.maxHistorySteps} undo steps remaining)`
    );
  }

  public redo(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    const stack = this.redoStack();
    if (stack.length === 0) {
      this.showBanner('info', 'Nothing to redo (0 steps in redo history).');
      return;
    }

    const targetSnap = stack[stack.length - 1];
    const currentSnap = this.captureCurrentSnapshot(targetSnap.label);

    this.redoStack.set(stack.slice(0, -1));
    this.undoStack.update((prev) => [...prev, currentSnap].slice(-this.maxHistorySteps));

    this.restoreHistorySnapshot(
      targetSnap,
      'Redo',
      `Redid "${targetSnap.label}" (${this.redoStack().length}/${this.maxHistorySteps} redo steps remaining)`
    );
  }

  private restoreHistorySnapshot(
    snap: HistorySnapshot,
    actionType: 'Undo' | 'Redo',
    bannerMessage: string
  ): void {
    const prevRows = this.rows();
    const prevCols = this.columns();

    const restoredCols = snap.columns.map((c) => ({ ...c }));
    const restoredRows = this.sanitizeClientRowsAgainstColumns(
      restoredCols,
      snap.rows.map((r) => ({ ...r, cells: { ...r.cells } }))
    );

    const prevRowMap = new Map<string, GridRow>(prevRows.map((r) => [r.id, r]));
    const prevColMap = new Map<string, GridColumn>(prevCols.map((c) => [c.id, c]));

    const changedOrAddedRows = restoredRows.filter((r) => {
      const old = prevRowMap.get(r.id);
      if (!old) return true;
      return old.orderIndex !== r.orderIndex || JSON.stringify(old.cells) !== JSON.stringify(r.cells);
    });

    const changedOrAddedCols = restoredCols.filter((c) => {
      const old = prevColMap.get(c.id);
      if (!old) return true;
      return JSON.stringify(old) !== JSON.stringify(c);
    });

    const restoredRowIdSet = new Set(restoredRows.map((r) => r.id));
    const deletedRowIds = prevRows
      .filter((r) => !restoredRowIdSet.has(r.id))
      .map((r) => r.id);

    this.editingCell.set(null);
    this.workspaceName.set(snap.workspaceName);
    this.columns.set(restoredCols);
    this.rows.set(restoredRows);
    this.cellValidationErrors.set({ ...snap.cellValidationErrors });
    this.pendingUnsavedRowIds.set(new Set(snap.pendingUnsavedRowIds));
    this.pendingUnsavedColIds.set(new Set(snap.pendingUnsavedColIds));
    this.invalidCellKey.set(Object.keys(snap.cellValidationErrors)[0] || null);
    this.snapshotValidRows(restoredRows);

    if (snap.activeCell) {
      this.activeCell.set({ ...snap.activeCell });
    }

    this.persistToCloud(
      `${actionType}: ${snap.label}`,
      bannerMessage,
      changedOrAddedRows[0],
      changedOrAddedCols[0],
      changedOrAddedRows,
      changedOrAddedCols,
      deletedRowIds.length > 0 ? deletedRowIds : undefined
    );

    const errCount = Object.keys(snap.cellValidationErrors).length;
    this.showBanner(errCount > 0 ? 'error' : 'info', bannerMessage);
  }

  public exportToCsv(): void {
    this.closeAllMenus();
    if (!this.isBrowser) return;
    const cols = this.sortedColumns();
    const rows = this.filteredAndSortedRows();

    const escapeCsv = (val: unknown): string => {
      const s = val === null || val === undefined ? '' : String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const headerLine = cols.map((c) => escapeCsv(c.name)).join(',');
    const dataLines = rows.map((row) =>
      cols.map((col) => escapeCsv(this.getDisplayCellValue(row, col))).join(',')
    );
    const csvContent = [headerLine, ...dataLines].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${this.workspaceName().toLowerCase().replace(/\s+/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    this.showBanner('success', `Exported ${rows.length} rows to CSV.`);
  }

  public onGlobalKeydown(event: KeyboardEvent): void {
    if (this.loader.isLoading()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName?.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      if (event.key === 'Escape') {
        this.cancelInlineEdit();
        this.closeAllMenus();
      }
      return;
    }

    if (event.key === 'Escape') {
      this.closeAllMenus();
      return;
    }

    const isCmdOrCtrl = event.ctrlKey || event.metaKey;
    const lowerKey = event.key.toLowerCase();
    if (isCmdOrCtrl && lowerKey === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    } else if (isCmdOrCtrl && (lowerKey === 'y' || (lowerKey === 'z' && event.shiftKey))) {
      event.preventDefault();
      this.redo();
    } else if (isCmdOrCtrl && lowerKey === 'a') {
      event.preventDefault();
      this.selectAllRowsExplicit();
    } else if (isCmdOrCtrl && lowerKey === 'c') {
      event.preventDefault();
      this.copySelectionToSystemClipboard('copy');
    } else if (isCmdOrCtrl && lowerKey === 'x') {
      event.preventDefault();
      this.copySelectionToSystemClipboard('cut');
    } else if (isCmdOrCtrl && lowerKey === 'd') {
      event.preventDefault();
      this.duplicateRows();
    } else if (event.key === 'Enter' && this.activeCell() && !this.editingCell()) {
      event.preventDefault();
      const active = this.activeCell()!;
      this.startInlineEdit(active.rowId, active.colId);
    } else if (
      (event.key === 'ArrowDown' || event.key === 'PageDown') &&
      !this.editingCell() &&
      this.hasMoreLazyRows() &&
      !this.isLazyLoadingMore()
    ) {
      const visible = this.visibleRows();
      const activeRowId = this.activeCell()?.rowId;
      const activeIdx = activeRowId ? visible.findIndex((r) => r.id === activeRowId) : -1;
      if (activeIdx === -1 || activeIdx >= visible.length - 3) {
        this.loadNextLazyBatch();
      }
    }
  }

  // =========================================================================
  // EXCEL / SPREADSHEET COPY & PASTE ENGINE (1 Cell, Range, Rows, Cols, All)
  // =========================================================================

  public copySelectionToSystemClipboard(mode: 'copy' | 'cut', event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();

    if (this.selectedRowIds().size > 0) {
      this.copyOrCutRows(mode);
      return;
    }

    const active = this.activeCell();
    if (active) {
      const row = this.rows().find((r) => r.id === active.rowId);
      const col = this.columns().find((c) => c.id === active.colId);
      if (row && col) {
        const cellVal = String(this.getDisplayCellValue(row, col) ?? '');
        this.lastInternalClipboardText = cellVal;
        if (this.isBrowser && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(cellVal).catch(() => undefined);
        }
        if (mode === 'cut' && col.colType !== 'formula') {
          this.applyCellMutation(row.id, col.id, col.colType === 'number' ? 0 : '');
        }
        this.showBanner(
          'info',
          `${mode === 'copy' ? 'Copied' : 'Cut'} cell "${col.name}" (${cellVal}) to clipboard. Right-click or press Ctrl+V to paste.`
        );
        return;
      }
    }

    if (this.selectedColumnId()) {
      this.copyOrCutColumn(mode);
    }
  }

  public onGlobalPaste(event: ClipboardEvent): void {
    if (this.loader.isLoading()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName?.toLowerCase();
    const isExcelModalInput = target?.getAttribute('data-excel-paste-input') === 'true';

    if (isExcelModalInput) {
      // Let the modal textarea receive the pasted text and update the preview signal
      setTimeout(() => {
        this.excelPasteRawSignal.set(this.excelPasteTextControl.value);
      }, 10);
      return;
    }

    const rawText = event.clipboardData?.getData('text/plain') ?? '';
    if (rawText.length > 0) {
      this.lastInternalClipboardText = rawText;
    }

    // If the user is typing in an input/textarea (e.g. inline cell edit, First Row input, or search box):
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      // If the user is editing a cell in the First Row ("Add Row" row) and pastes multi-cell or multi-row data,
      // add all pasted rows one by one via the First Row Add Row functionality!
      if (this.editingNewRowColId() && (rawText.includes('\t') || rawText.includes('\n'))) {
        event.preventDefault();
        const startCol = this.editingNewRowColId();
        this.editingNewRowColId.set(null);
        this.pasteRowsIntoFirstRowOneByOne(rawText, startCol);
        return;
      }
      // If the user is in a grid cell (contenteditable or inline input) and pastes a multi-cell / multi-row / multi-column block from Excel,
      // intercept it and apply it across the spreadsheet grid!
      if (
        (this.editingCell() || this.activeCell()) &&
        (rawText.includes('\t') || rawText.includes('\n'))
      ) {
        const matrix = this.parseExcelClipboardMatrix(rawText);
        if (matrix.length > 1 || (matrix[0] && matrix[0].length > 1)) {
          event.preventDefault();
          this.editingCell.set(null);
          this.applyExcelPasteText(rawText, 'overlay');
          return;
        }
      }
      // If pasting plain text into a contenteditable cell, strip rich HTML formatting
      if (target?.isContentEditable && rawText.length > 0) {
        event.preventDefault();
        const singleLine = rawText.replace(/\r?\n/g, ' ').trim();
        target.textContent = singleLine;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        this.placeCaretAtEndOfElement(target);
        return;
      }
      // Otherwise let normal input paste happen (e.g. pasting part of a cell while inline editing)
      return;
    }

    // If the active cell is on the First Row ("Add Row" row) or table has 0 rows,
    // paste rows one by one via the First Row Add Row functionality!
    if (
      rawText.length > 0 &&
      (this.activeCell()?.rowId === this.newRowSentinelId || this.visibleRows().length === 0)
    ) {
      event.preventDefault();
      this.pasteRowsIntoFirstRowOneByOne(rawText, this.activeCell()?.colId);
      return;
    }

    // If internal row/column cut/copy matches the clipboard text (or clipboard text is empty), execute internal paste
    const internalClip = this.clipboard();
    if (internalClip && (!rawText || rawText === this.lastInternalClipboardText)) {
      event.preventDefault();
      this.pasteClipboard('after');
      return;
    }

    if (rawText.length > 0) {
      event.preventDefault();
      this.applyExcelPasteText(rawText, 'auto');
    }
  }

  /**
   * Triggered from the right-click dropdown on Select or Edit for:
   * - 'cell' (Paste into Current Cell)
   * - 'row' (Paste into Current Row)
   * - 'column' (Paste into Current Column)
   * - 'table' (Paste into Whole Table)
   */
  public async pasteWithTargetScope(
    scope: 'cell' | 'row' | 'column' | 'table',
    event?: Event
  ): Promise<void> {
    event?.stopPropagation();
    const menuState = this.contextMenu();
    const editingState = this.editingCell();
    const activeState = this.activeCell();

    const targetRowId =
      menuState.rowId ||
      editingState?.rowId ||
      activeState?.rowId ||
      Array.from(this.selectedRowIds())[0] ||
      this.visibleRows()[0]?.id ||
      null;

    const targetColId =
      menuState.colId ||
      editingState?.colId ||
      activeState?.colId ||
      this.selectedColumnId() ||
      this.sortedColumns()[0]?.id ||
      null;

    // Exit inline edit cleanly before applying paste
    this.editingCell.set(null);
    if (targetRowId && targetColId) {
      this.activeCell.set({ rowId: targetRowId, colId: targetColId });
    }
    if (targetColId) {
      this.selectedColumnId.set(targetColId);
    }
    this.closeAllMenus();

    if (this.isBrowser && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.length > 0) {
          this.lastInternalClipboardText = text;
          this.applyScopedPasteText(text, scope, targetRowId, targetColId);
          return;
        }
      } catch {
        // Fallback below if iframe blocks direct navigator.clipboard.readText()
      }
    }

    if (this.lastInternalClipboardText && this.lastInternalClipboardText.length > 0) {
      this.applyScopedPasteText(this.lastInternalClipboardText, scope, targetRowId, targetColId);
      return;
    }

    this.openExcelPasteModal(scope === 'table' ? 'replace_all' : scope);
  }

  public async triggerExcelPasteFromMenu(event?: Event): Promise<void> {
    event?.stopPropagation();
    const menuType = this.contextMenu().targetType;
    if (menuType === 'column') {
      await this.pasteWithTargetScope('column', event);
    } else if (menuType === 'row') {
      await this.pasteWithTargetScope('row', event);
    } else if (menuType === 'table') {
      await this.pasteWithTargetScope('table', event);
    } else {
      await this.pasteWithTargetScope('cell', event);
    }
  }

  public openExcelPasteModal(
    defaultMode: PasteTargetScope = 'overlay',
    event?: Event
  ): void {
    event?.stopPropagation();
    this.editingCell.set(null);
    this.closeAllMenus();
    this.excelPasteMode.set(defaultMode);
    this.excelPasteTextControl.setValue(this.lastInternalClipboardText || '');
    this.excelPasteRawSignal.set(this.lastInternalClipboardText || '');
    this.activeModal.set('excel_paste');
  }

  public onExcelPasteModalInput(): void {
    this.excelPasteRawSignal.set(this.excelPasteTextControl.value);
  }

  public submitExcelPasteModal(): void {
    const raw = this.excelPasteTextControl.value;
    if (!raw || raw.trim().length === 0) {
      this.showBanner('error', 'Please paste data from Excel or CSV into the box first (Ctrl+V).');
      return;
    }
    this.lastInternalClipboardText = raw;
    const mode = this.excelPasteMode();
    this.activeModal.set('none');
    this.applyScopedPasteText(
      raw,
      mode,
      this.activeCell()?.rowId || Array.from(this.selectedRowIds())[0] || null,
      this.activeCell()?.colId || this.selectedColumnId() || null
    );
  }

  /**
   * Executes paste specifically targeted at:
   * - 'cell': Current selected or edited cell (or multi-cell block starting at current cell)
   * - 'row': Current row (or selected rows) across columns starting from Column A
   * - 'column': Current column across rows (down the column or into selected rows)
   * - 'table' / 'replace_all': Whole table replacement / update starting at A1
   * - 'overlay' / 'append_rows': Standard grid overlay or row append
   */
  public applyScopedPasteText(
    rawText: string,
    scope: PasteTargetScope,
    targetRowId?: string | null,
    targetColId?: string | null
  ): void {
    const matrix = this.parseExcelClipboardMatrix(rawText);
    if (matrix.length === 0 || (matrix.length === 1 && matrix[0].length === 0)) {
      return;
    }

    const workingCols = [...this.sortedColumns()];
    const viewRows = this.filteredAndSortedRows();
    const resolvedRowId =
      targetRowId ||
      this.activeCell()?.rowId ||
      Array.from(this.selectedRowIds())[0] ||
      viewRows[0]?.id ||
      this.newRowSentinelId;
    const resolvedColId =
      targetColId ||
      this.editingNewRowColId() ||
      this.activeCell()?.colId ||
      this.selectedColumnId() ||
      workingCols[0]?.id ||
      null;

    // If pasting into the First Row ("Add Row" row) or when the table has 0 data rows:
    if (
      (scope === 'cell' || scope === 'row' || scope === 'overlay' || scope === 'append_rows') &&
      (resolvedRowId === this.newRowSentinelId || viewRows.length === 0)
    ) {
      if (scope === 'cell' && matrix.length === 1 && matrix[0].length === 1 && resolvedColId) {
        const col = workingCols.find((c) => c.id === resolvedColId);
        if (col && !this.isProtectedIdColumn(col) && col.colType !== 'formula') {
          const norm = this.normalizeExcelValueForColumn(col, matrix[0][0]);
          this.newRowDraftCells.update((prev) => ({
            ...prev,
            [col.id]: norm.value,
            [col.name]: norm.value,
          }));
          return;
        }
      }
      this.pasteRowsIntoFirstRowOneByOne(rawText, resolvedColId);
      return;
    }

    // 1. PASTE INTO CURRENT CELL
    if (scope === 'cell') {
      if (!resolvedRowId || !resolvedColId) return;
      this.activeCell.set({ rowId: resolvedRowId, colId: resolvedColId });

      // If 1x1 value, apply directly to the single current cell (even if multiple rows are selected)
      if (matrix.length === 1 && matrix[0].length === 1) {
        this.applyCellMutation(resolvedRowId, resolvedColId, matrix[0][0]);
        return;
      }
      // If multi-cell range, overlay starting at the current cell
      this.applyExcelPasteText(rawText, 'overlay');
      return;
    }

    // 2. PASTE INTO CURRENT ROW
    if (scope === 'row') {
      if (!resolvedRowId) return;
      const nowIso = new Date().toISOString();

      // Determine target row(s): if multiple rows are selected and clipboard is 1 row, paste into all selected rows;
      // otherwise paste starting at resolvedRowId
      const selectedIds = this.selectedRowIds();
      const targetRowIdsList =
        selectedIds.size > 1 && matrix.length === 1
          ? Array.from(selectedIds)
          : [resolvedRowId];

      // Single 1x1 value pasted into Current Row -> apply to active column (or allselected rows in active column)
      if (matrix.length === 1 && matrix[0].length === 1 && resolvedColId) {
        const targetCol = workingCols.find((c) => c.id === resolvedColId) || workingCols[0];
        if (!targetCol) return;
        const norm = this.normalizeExcelValueForColumn(targetCol, matrix[0][0]);
        const rowIdSet = new Set(targetRowIdsList);
        this.recordHistorySnapshot(`Paste into Row (${targetCol.name})`);

        const updatedRows = this.rows().map((r) => {
          if (!rowIdSet.has(r.id)) return r;
          return {
            ...r,
            cells: {
              ...r.cells,
              [targetCol.id]: norm.value,
              [targetCol.name]: norm.value,
            },
            updatedBy: this.currentUserName(),
            updatedAt: nowIso,
          };
        });
        this.rows.set(updatedRows);
        this.formulaBarControl.setValue(String(norm.value));
        this.validateAndSyncRows(
          targetRowIdsList,
          [],
          'Paste into Current Row',
          `Pasted "${String(norm.value).slice(0, 40)}" into ${targetRowIdsList.length} row(s)`
        );
        return;
      }

      // If 1 row of multiple columns (1 x N) and multiple rows are selected, apply that row across all selected rows
      if (matrix.length === 1 && matrix[0].length > 1 && selectedIds.size > 1) {
        const rowCells = matrix[0];
        this.recordHistorySnapshot(`Paste Row Values into ${selectedIds.size} Selected Rows`);
        const updatedRows = this.rows().map((r) => {
          if (!selectedIds.has(r.id)) return r;
          const nextCells = { ...r.cells };
          for (let cIdx = 0; cIdx < Math.min(rowCells.length, workingCols.length); cIdx++) {
            const col = workingCols[cIdx];
            if (col.colType === 'formula' || this.isProtectedIdColumn(col)) continue;
            const normVal = this.normalizeExcelValueForColumn(col, rowCells[cIdx]).value;
            nextCells[col.id] = normVal;
            nextCells[col.name] = normVal;
          }
          return {
            ...r,
            cells: nextCells,
            updatedBy: this.currentUserName(),
            updatedAt: nowIso,
          };
        });
        this.rows.set(updatedRows);
        this.validateAndSyncRows(
          Array.from(selectedIds),
          [],
          'Paste into Selected Rows',
          `Pasted row values into ${selectedIds.size} selected rows`
        );
        return;
      }

      // Otherwise start at Column A (first column) of the current row and overlay row(s)
      const firstColId = workingCols[0]?.id;
      if (firstColId) {
        this.activeCell.set({ rowId: resolvedRowId, colId: firstColId });
      }
      this.applyExcelPasteText(rawText, 'overlay');
      return;
    }

    // 3. PASTE INTO CURRENT COLUMN
    if (scope === 'column') {
      if (!resolvedColId) return;
      const targetCol = workingCols.find((c) => c.id === resolvedColId);
      if (!targetCol) return;
      if (targetCol.colType === 'formula') {
        this.showBanner('error', `Column "${targetCol.name}" is a formula column and is computed automatically.`);
        return;
      }

      const nowIso = new Date().toISOString();
      const selectedIds = this.selectedRowIds();

      // Flatten column values:
      // - If matrix is M x 1 (or M x N): take first column of each row
      // - If matrix is 1 x N (horizontal cells): take all N cells vertically down the column
      let colValues: string[] = [];
      if (matrix.length === 1 && matrix[0].length > 1) {
        colValues = [...matrix[0]];
      } else {
        colValues = matrix.map((r) => r[0] ?? '');
      }

      // Strip leading header cell if it matches the column name
      if (
        colValues.length > 1 &&
        colValues[0].trim().toLowerCase() === targetCol.name.toLowerCase()
      ) {
        colValues = colValues.slice(1);
      }

      if (colValues.length === 0) return;

      this.recordHistorySnapshot(`Paste into Column "${targetCol.name}"`);

      // Case 3A: Single value pasted into Current Column
      if (colValues.length === 1) {
        const norm = this.normalizeExcelValueForColumn(targetCol, colValues[0]);
        let targetRowIds: Set<string>;
        if (selectedIds.size > 0) {
          targetRowIds = new Set(selectedIds);
        } else if (targetRowId) {
          targetRowIds = new Set([targetRowId]);
        } else {
          // Right-clicked column header with 1 value in clipboard -> fill visible rows in this column
          targetRowIds = new Set(this.visibleRows().map((r) => r.id));
        }

        const updatedRows = this.rows().map((r) => {
          if (!targetRowIds.has(r.id)) return r;
          return {
            ...r,
            cells: {
              ...r.cells,
              [targetCol.id]: norm.value,
              [targetCol.name]: norm.value,
            },
            updatedBy: this.currentUserName(),
            updatedAt: nowIso,
          };
        });
        this.rows.set(updatedRows);
        this.formulaBarControl.setValue(String(norm.value));
        const changedIds = Array.from(targetRowIds);
        this.validateAndSyncRows(
          changedIds,
          [],
          'Paste into Column',
          `Pasted "${String(norm.value).slice(0, 40)}" into ${changedIds.length} row(s) of column "${targetCol.name}"`
        );
        return;
      }

      // Case 3B: Multiple values pasted vertically down Current Column
      let startRowIdx = 0;
      if (targetRowId && colValues.length < viewRows.length) {
        const foundIdx = viewRows.findIndex((r) => r.id === targetRowId);
        if (foundIdx >= 0) {
          startRowIdx = foundIdx;
        }
      }

      const rowById = new Map<string, GridRow>(this.rows().map((r) => [r.id, r]));
      const changedRowIds: string[] = [];

      for (let i = 0; i < colValues.length; i++) {
        const targetViewRow = viewRows[startRowIdx + i];
        if (!targetViewRow) break;
        const norm = this.normalizeExcelValueForColumn(targetCol, colValues[i]);
        const updatedRow: GridRow = {
          ...targetViewRow,
          cells: {
            ...targetViewRow.cells,
            [targetCol.id]: norm.value,
            [targetCol.name]: norm.value,
          },
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
        rowById.set(updatedRow.id, updatedRow);
        changedRowIds.push(updatedRow.id);
      }

      const finalRows = Array.from(rowById.values()).sort((a, b) => a.orderIndex - b.orderIndex);
      this.rows.set(finalRows);
      this.validateAndSyncRows(
        changedRowIds,
        [],
        'Paste into Column',
        `Pasted ${changedRowIds.length} value(s) into column "${targetCol.name}"`
      );
      return;
    }

    // 4. PASTE INTO WHOLE TABLE
    if (scope === 'table' || scope === 'replace_all') {
      this.applyExcelPasteText(rawText, 'replace_all');
      return;
    }

    // 5. OVERLAY OR APPEND ROWS
    this.applyExcelPasteText(rawText, scope);
  }

  /**
   * Parses Excel / Google Sheets TSV (or CSV) clipboard text into a 2D matrix of strings.
   * Supports quoted multi-line cells, tab delimiters, and strips Excel's trailing newline.
   */
  public parseExcelClipboardMatrix(rawText: string): string[][] {
    if (!rawText) return [];
    let normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (normalized.endsWith('\n')) {
      normalized = normalized.slice(0, -1);
    }
    if (normalized.length === 0) return [];

    // Use tab delimiter if present; fallback to comma if multi-column CSV without tabs
    const hasTabs = normalized.includes('\t');
    const firstLine = normalized.split('\n')[0] || '';
    const delimiter = !hasTabs && firstLine.split(',').length >= 3 ? ',' : '\t';

    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < normalized.length && normalized[i + 1] === '"') {
            currentCell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          currentCell += ch;
        }
      } else {
        if (ch === '"' && currentCell.length === 0) {
          inQuotes = true;
        } else if (ch === delimiter) {
          currentRow.push(currentCell);
          currentCell = '';
        } else if (ch === '\n') {
          currentRow.push(currentCell);
          rows.push(currentRow);
          currentRow = [];
          currentCell = '';
        } else {
          currentCell += ch;
        }
      }
    }
    currentRow.push(currentCell);
    rows.push(currentRow);

    return rows;
  }

  /**
   * Validates a raw Excel string against the target column's datatype & integrity rules.
   * Preserves invalid strings in `value` so invalid cells are displayed in red until corrected.
   */
  private normalizeExcelValueForColumn(
    col: GridColumn,
    rawStr: string
  ): { value: CellPrimitive; updatedCol?: GridColumn } {
    const check = validateCellValue(col, rawStr);
    return { value: check.normalizedValue };
  }

  /**
   * Applies pasted Excel data (1 cell, partial cell range, 1..N rows, 1..N columns, or whole table),
   * validates every affected cell and row, highlights any invalid cells in red and their rows in light red,
   * and only saves to the database when rows pass validation (or once corrected).
   */
  public applyExcelPasteText(
    rawText: string,
    pasteMode: 'auto' | 'overlay' | 'append_rows' | 'replace_all' = 'auto'
  ): void {
    const matrix = this.parseExcelClipboardMatrix(rawText);
    if (matrix.length === 0 || (matrix.length === 1 && matrix[0].length === 0)) {
      return;
    }

    const nowIso = new Date().toISOString();
    const workingCols = [...this.sortedColumns()];
    const changedColsMap = new Map<string, GridColumn>();
    const changedRowsMap = new Map<string, GridRow>();

    // Determine effective mode
    let effectiveMode: 'overlay' | 'append_rows' | 'replace_all' =
      pasteMode === 'auto' ? 'overlay' : pasteMode;
    if (
      pasteMode === 'auto' &&
      this.isAllFilteredSelected() &&
      matrix.length > 1 &&
      matrix[0].length >= 2
    ) {
      effectiveMode = 'replace_all';
    }

    // Case 1: Single cell (1x1) paste
    if (matrix.length === 1 && matrix[0].length === 1 && effectiveMode === 'overlay') {
      const singleRaw = matrix[0][0];
      const selectedIds = this.selectedRowIds();
      const active = this.activeCell();
      const targetColId = active?.colId || this.selectedColumnId() || workingCols[0]?.id;
      const targetColIdx = workingCols.findIndex((c) => c.id === targetColId);
      if (targetColIdx === -1) return;

      const targetCol = workingCols[targetColIdx];
      const norm = this.normalizeExcelValueForColumn(targetCol, singleRaw);

      const targetRowIds =
        selectedIds.size > 1
          ? selectedIds
          : new Set([active?.rowId || this.visibleRows()[0]?.id].filter(Boolean) as string[]);

      if (targetRowIds.size === 0) return;

      this.recordHistorySnapshot(`Paste Cell into "${targetCol.name}"`);

      const updatedRows = this.rows().map((r) => {
        if (!targetRowIds.has(r.id)) return r;
        const nextRow: GridRow = {
          ...r,
          cells: {
            ...r.cells,
            [targetCol.id]: norm.value,
            [targetCol.name]: norm.value,
          },
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
        changedRowsMap.set(nextRow.id, nextRow);
        return nextRow;
      });

      this.rows.set(updatedRows);
      this.formulaBarControl.setValue(String(norm.value));
      const changedRowIds = Array.from(changedRowsMap.keys());
      const changedColsList = Array.from(changedColsMap.values());
      this.validateAndSyncRows(
        changedRowIds,
        changedColsList,
        'Excel Paste (Cell)',
        `Pasted "${String(norm.value).slice(0, 40)}" into ${changedRowIds.length} row(s) of "${targetCol.name}"`
      );
      return;
    }

    // Check if the first row of the pasted Excel block matches column headers
    let dataRows = matrix;
    let columnMapping: number[] | null = null;

    if (matrix.length > 1 && matrix[0].length >= 2) {
      const firstRow = matrix[0].map((cell) => cell.trim());
      const matchCount = firstRow.filter((headerText) =>
        workingCols.some((c) => c.name.toLowerCase() === headerText.toLowerCase())
      ).length;

      if (matchCount >= Math.min(2, firstRow.length)) {
        dataRows = matrix.slice(1);
        columnMapping = firstRow.map((headerText, cIdx) => {
          const existingIdx = workingCols.findIndex(
            (c) => c.name.toLowerCase() === headerText.toLowerCase()
          );
          if (existingIdx !== -1) return existingIdx;

          const newCol: GridColumn = {
            id: `col_excel_${Date.now().toString(36)}_${cIdx}`,
            name: headerText || `Excel Col ${workingCols.length + 1}`,
            colType: 'text',
            orderIndex: workingCols.length,
            width: 155,
            required: false,
            formula: '',
            optionsCsv: '',
          };
          workingCols.push(newCol);
          changedColsMap.set(newCol.id, newCol);
          return workingCols.length - 1;
        });
      }
    }

    if (dataRows.length === 0) return;

    const maxPastedCols = dataRows.reduce((max, r) => Math.max(max, r.length), 0);

    const viewRows = this.filteredAndSortedRows();
    let startRowIdx = 0;
    let startColIdx = 0;

    if (effectiveMode === 'append_rows') {
      startRowIdx = viewRows.length;
      startColIdx = 0;
    } else if (effectiveMode === 'replace_all') {
      startRowIdx = 0;
      startColIdx = 0;
    } else {
      const active = this.activeCell();
      const selectedCol = this.selectedColumnId();
      const selectedRows = this.selectedRowIds();

      if (selectedCol && !active) {
        startRowIdx = 0;
        const cIdx = workingCols.findIndex((c) => c.id === selectedCol);
        startColIdx = cIdx >= 0 ? cIdx : 0;
      } else if (active) {
        const rIdx = viewRows.findIndex((r) => r.id === active.rowId);
        startRowIdx = rIdx >= 0 ? rIdx : 0;
        const cIdx = workingCols.findIndex((c) => c.id === active.colId);
        startColIdx = cIdx >= 0 ? cIdx : 0;
        if (maxPastedCols >= workingCols.length && startColIdx > 0) {
          startColIdx = 0;
        }
      } else if (selectedRows.size > 0) {
        const firstSelectedIdx = viewRows.findIndex((r) => selectedRows.has(r.id));
        startRowIdx = firstSelectedIdx >= 0 ? firstSelectedIdx : 0;
        startColIdx = 0;
      }
    }

    if (!columnMapping && startColIdx + maxPastedCols > workingCols.length) {
      const extraNeeded = startColIdx + maxPastedCols - workingCols.length;
      for (let e = 0; e < extraNeeded; e++) {
        const colNum = workingCols.length + 1;
        const newCol: GridColumn = {
          id: `col_excel_${Date.now().toString(36)}_${colNum}_${e}`,
          name: `Column ${colNum}`,
          colType: 'text',
          orderIndex: workingCols.length,
          width: 150,
          required: false,
          formula: '',
          optionsCsv: '',
        };
        workingCols.push(newCol);
        changedColsMap.set(newCol.id, newCol);
      }
    }

    const buildDefaultCellsForNewRow = (seqNum: number): Record<string, CellPrimitive> => {
      const cells: Record<string, CellPrimitive> = {};
      for (const col of workingCols) {
        if (col.colType === 'formula') continue;
        let defVal: CellPrimitive = '';
        if (col.id === 'col_code') defVal = `GP-${seqNum}`;
        else if (col.colType === 'number') defVal = 0;
        else if (col.colType === 'checkbox') defVal = false;
        else if (col.colType === 'date') defVal = nowIso.slice(0, 10);
        else if (col.colType === 'dropdown') defVal = getDropdownOptions(col)[0] || '';
        cells[col.id] = defVal;
        cells[col.name] = defVal;
      }
      return cells;
    };

    const rowById = new Map<string, GridRow>(this.rows().map((r) => [r.id, r]));
    const newRowsCreated: GridRow[] = [];

    this.recordHistorySnapshot(`Paste ${dataRows.length} Row(s) from Excel`);

    if (effectiveMode === 'replace_all') {
      rowById.clear();
      this.cellValidationErrors.set({});
      this.pendingUnsavedRowIds.set(new Set());
    }

    let maxOrderIndex =
      this.rows().reduce((max, r) => Math.max(max, r.orderIndex), 0) || 0;

    for (let rOffset = 0; rOffset < dataRows.length; rOffset++) {
      const pastedRowCells = dataRows[rOffset];
      const targetViewRow =
        effectiveMode === 'overlay' && startRowIdx + rOffset < viewRows.length
          ? viewRows[startRowIdx + rOffset]
          : null;

      const baseCells: Record<string, CellPrimitive> = targetViewRow
        ? { ...targetViewRow.cells }
        : buildDefaultCellsForNewRow(1001 + this.rows().length + rOffset);

      for (let cOffset = 0; cOffset < pastedRowCells.length; cOffset++) {
        const targetColIdx = columnMapping
          ? columnMapping[cOffset]
          : startColIdx + cOffset;
        if (targetColIdx === undefined || targetColIdx < 0 || targetColIdx >= workingCols.length) {
          continue;
        }

        const col = workingCols[targetColIdx];
        if (col.colType === 'formula') continue;
        const rawCellStr = pastedRowCells[cOffset];
        const norm = this.normalizeExcelValueForColumn(col, rawCellStr);
        baseCells[col.id] = norm.value;
        baseCells[col.name] = norm.value;
      }

      if (targetViewRow) {
        const updatedRow: GridRow = {
          ...targetViewRow,
          cells: baseCells,
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
        rowById.set(updatedRow.id, updatedRow);
        changedRowsMap.set(updatedRow.id, updatedRow);
      } else {
        maxOrderIndex += 10;
        const createdRow: GridRow = {
          id: `row_excel_${Date.now().toString(36)}_${rOffset}_${Math.random().toString(36).slice(2, 5)}`,
          orderIndex: maxOrderIndex,
          cells: baseCells,
          updatedBy: this.currentUserName(),
          updatedAt: nowIso,
        };
        newRowsCreated.push(createdRow);
        rowById.set(createdRow.id, createdRow);
        changedRowsMap.set(createdRow.id, createdRow);
      }
    }

    const finalRows = Array.from(rowById.values()).sort((a, b) => a.orderIndex - b.orderIndex);
    this.columns.set(workingCols);
    this.rows.set(finalRows);

    const neededLimit = startRowIdx + dataRows.length;
    if (neededLimit > this.visibleRowLimit()) {
      this.visibleRowLimit.set(Math.min(finalRows.length, neededLimit + 5));
    }

    const changedRowIds = Array.from(changedRowsMap.keys());
    const changedColsList = Array.from(changedColsMap.values());

    this.validateAndSyncRows(
      changedRowIds,
      changedColsList,
      'Excel Data Pasted',
      `Pasted ${dataRows.length} row(s) × ${maxPastedCols} column(s) from Excel (${newRowsCreated.length} new rows created)`
    );
  }

  // =========================================================================
  // VALIDATION STATE HELPERS FOR TEMPLATES
  // =========================================================================

  public isRowInvalid(rowId: string): boolean {
    return this.invalidRowIds().has(rowId);
  }

  public isCellInvalid(rowId: string, colId: string): boolean {
    return Boolean(this.cellValidationErrors()[`${rowId}:${colId}`]);
  }

  public getCellErrorMessage(rowId: string, colId: string): string {
    return this.cellValidationErrors()[`${rowId}:${colId}`] || '';
  }

  public getRowErrorSummary(rowId: string): string {
    const errors = this.cellValidationErrors();
    const msgs: string[] = [];
    const prefix = `${rowId}:`;
    for (const [k, v] of Object.entries(errors)) {
      if (k.startsWith(prefix)) {
        msgs.push(v);
      }
    }
    return msgs.join(' | ');
  }

  // =========================================================================
  // UI HELPERS FOR TEMPLATES
  // =========================================================================

  public getColumnLetter(colIndex: number): string {
    let idx = colIndex;
    let letter = '';
    while (idx >= 0) {
      letter = String.fromCharCode((idx % 26) + 65) + letter;
      idx = Math.floor(idx / 26) - 1;
    }
    return letter;
  }

  public getColumnLetterById(colId: string | null): string {
    if (!colId) return '';
    const idx = this.sortedColumns().findIndex((c) => c.id === colId);
    return idx >= 0 ? this.getColumnLetter(idx) : '';
  }

  public getColumnTypeIcon(colType: ColumnType): string {
    switch (colType) {
      case 'number':
        return 'tag';
      case 'date':
        return 'calendar_today';
      case 'dropdown':
        return 'arrow_drop_down_circle';
      case 'lookup':
        return 'data_array';
      case 'varchar_max':
        return 'subject';
      case 'checkbox':
        return 'check_box';
      case 'formula':
        return 'functions';
      default:
        return 'notes';
    }
  }

  public getCollaboratorOnCell(rowId: string, colId: string): CollaboratorPresence | null {
    const myId = this.currentClientId();
    for (const c of this.collaborators()) {
      if (c.userId !== myId && c.activeRowId === rowId && c.activeColId === colId) {
        return c;
      }
    }
    return null;
  }

  public getDropdownOptionsForCol(col: GridColumn): string[] {
    return getDropdownOptions(col);
  }

  public getLookupOptionsForCol(col: GridColumn): LookupItem[] {
    return getLookupOptions(col);
  }

  public formatLookupOptionLabel(item: LookupItem): string {
    return item.json || `{"ID":${JSON.stringify(item.id)},"Name":${JSON.stringify(item.name)}}`;
  }

  public getColumnNameById(colId: string): string {
    return this.columns().find((c) => c.id === colId)?.name || colId;
  }

  public showBanner(type: 'error' | 'info' | 'success', message: string): void {
    this.validationBanner.set({ type, message });
    if (this.bannerTimeout) {
      clearTimeout(this.bannerTimeout);
    }
    this.bannerTimeout = setTimeout(() => {
      this.validationBanner.set(null);
    }, 5000);
  }

  public dismissBanner(): void {
    this.validationBanner.set(null);
  }

  public formatTimeShort(iso: string): string {
    if (!iso) return 'Just now';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return 'Just now';
    }
  }

  private hashCode(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  // =========================================================================
  // GITHUB OAUTH DEVICE AUTHORIZATION & CREATE NEW REPOSITORY UPLOAD
  // =========================================================================

  public openGitHubModal(event?: Event): void {
    event?.stopPropagation();
    this.closeAllMenus();
    this.activeModal.set('github_push');
    if (
      !this.githubAccessToken() &&
      !this.githubForm.getRawValue().manualToken.trim() &&
      this.githubAuthStatus() === 'idle'
    ) {
      this.startGitHubDeviceAuth();
    }
  }

  public startGitHubDeviceAuth(): void {
    if (this.githubPollTimer) {
      clearInterval(this.githubPollTimer);
      this.githubPollTimer = null;
    }
    this.githubStatusMessage.set('Requesting GitHub authorization code...');
    this.githubAuthStatus.set('awaiting_device');

    this.http
      .post<{
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        interval?: number;
        error?: string;
      }>('/api/github/device-code', {})
      .subscribe({
        next: (res) => {
          if (!res || !res.device_code || !res.user_code) {
            this.githubAuthStatus.set('error');
            this.githubStatusMessage.set(
              res?.error || 'Could not initiate GitHub Device Flow.'
            );
            return;
          }

          this.githubUserCode.set(res.user_code);
          this.githubVerificationUri.set(
            res.verification_uri || 'https://github.com/login/device'
          );
          this.githubStatusMessage.set(
            'Enter the 8-character code on GitHub and click Authorize. Once authorized, your code commits automatically!'
          );

          const deviceCode = res.device_code;
          const pollIntervalMs = Math.max(5, Number(res.interval || 5)) * 1000;

          this.githubPollTimer = setInterval(() => {
            if (this.activeModal() !== 'github_push') {
              if (this.githubPollTimer) {
                clearInterval(this.githubPollTimer);
                this.githubPollTimer = null;
              }
              return;
            }
            this.http
              .post<{
                status?: string;
                accessToken?: string;
                username?: string;
                message?: string;
              }>('/api/github/device-poll', { deviceCode })
              .subscribe({
                next: (pollRes) => {
                  if (!pollRes) return;
                  if (pollRes.status === 'authorized' && pollRes.accessToken) {
                    if (this.githubPollTimer) {
                      clearInterval(this.githubPollTimer);
                      this.githubPollTimer = null;
                    }
                    this.githubAccessToken.set(pollRes.accessToken);
                    this.githubAuthorizedUser.set(pollRes.username || 'GitHub User');
                    this.githubAuthStatus.set('authorized');
                    if (this.isBrowser) {
                      localStorage.setItem('gridario_gh_token', pollRes.accessToken);
                      localStorage.setItem(
                        'gridario_gh_user',
                        pollRes.username || 'GitHub User'
                      );
                    }
                    this.githubStatusMessage.set(
                      `Authorized as @${pollRes.username || 'user'}. Committing and pushing to GitHub...`
                    );
                    this.createGitHubRepoAndUpload();
                  } else if (
                    pollRes.status === 'expired_token' ||
                    pollRes.status === 'access_denied'
                  ) {
                    if (this.githubPollTimer) {
                      clearInterval(this.githubPollTimer);
                      this.githubPollTimer = null;
                    }
                    this.githubAuthStatus.set('error');
                    this.githubStatusMessage.set(
                      pollRes.message || 'GitHub authorization expired or was denied.'
                    );
                  }
                },
                error: () => {
                  // Ignore transient polling errors so RxJS never throws unhandled exception
                },
              });
          }, pollIntervalMs);
        },
        error: () => {
          this.githubAuthStatus.set('error');
          this.githubStatusMessage.set('Could not reach server to start GitHub authorization.');
        },
      });
  }

  public copyGitHubUserCode(): void {
    const code = this.githubUserCode();
    if (!code || !this.isBrowser || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(code).then(() => {
      this.showBanner('info', `Copied GitHub verification code ${code} to clipboard.`);
    });
  }

  public createGitHubRepoAndUpload(): void {
    const raw = this.githubForm.getRawValue();
    const token = (this.githubAccessToken() || raw.manualToken || '').trim();
    if (!token) {
      this.githubAuthStatus.set('error');
      this.githubStatusMessage.set(
        'Please authorize with GitHub (or paste a GitHub Personal Access Token) first.'
      );
      return;
    }

    if (raw.manualToken.trim() && this.isBrowser) {
      localStorage.setItem('gridario_gh_token', raw.manualToken.trim());
    }

    const repoName = raw.repoName.trim() || 'https://github.com/fushback/Grid.git';
    const commitMessage =
      raw.commitMessage.trim() || 'Commit Gridario full-stack application';
    this.githubAuthStatus.set('pushing');
    this.githubStatusMessage.set(
      `Committing and pushing project files to existing GitHub repository "${repoName}"...`
    );

    this.http
      .post<{
        ok?: boolean;
        owner?: string;
        repoName?: string;
        repoUrl?: string;
        commitSha?: string;
        commitUrl?: string;
        vercelCloneUrl?: string;
        filesUploaded?: number;
        error?: string;
      }>('/api/github/create-and-push', {
        accessToken: token,
        repoName,
        description: raw.description.trim(),
        commitMessage,
        isPrivate: raw.isPrivate,
      })
      .subscribe({
        next: (res) => {
          if (res.ok && res.repoUrl) {
            this.githubAuthStatus.set('pushed');
            this.githubPushedRepoUrl.set(res.repoUrl);
            if (res.owner) {
              this.githubAuthorizedUser.set(res.owner);
            }
            if (res.vercelCloneUrl) {
              this.vercelCloneUrl.set(res.vercelCloneUrl);
            }
            const shortSha = res.commitSha ? ` (${res.commitSha.slice(0, 7)})` : '';
            this.githubStatusMessage.set(
              `Committed ${res.filesUploaded || 0} files${shortSha} to ${res.repoUrl}!`
            );
            this.showBanner(
              'success',
              `Committed project to GitHub: ${res.repoUrl}`
            );
          } else {
            this.githubAuthStatus.set('error');
            this.githubStatusMessage.set(
              res.error || 'Failed to commit to GitHub.'
            );
          }
        },
        error: (err) => {
          this.githubAuthStatus.set('error');
          this.githubStatusMessage.set(
            err?.error?.error || 'Failed to commit project to GitHub. Check your token permissions.'
          );
        },
      });
  }

  public deployDirectlyToVercel(): void {
    const raw = this.githubForm.getRawValue();
    const projectName = raw.repoName.trim() || 'gridpulse-cloud-app';
    const vercelToken = raw.vercelToken.trim();

    this.vercelDeployStatus.set('deploying');
    this.githubStatusMessage.set(
      `Deploying "${projectName}" (Angular 21 UI + Serverless /api/* backend) directly to Vercel...`
    );

    this.http
      .post<{
        ok?: boolean;
        deploymentId?: string;
        deploymentUrl?: string;
        inspectorUrl?: string;
        filesDeployed?: number;
        error?: string;
      }>('/api/vercel/deploy', {
        vercelToken,
        projectName,
      })
      .subscribe({
        next: (res) => {
          if (res.ok && res.deploymentUrl) {
            this.vercelDeployStatus.set('deployed');
            this.vercelDeploymentUrl.set(res.deploymentUrl);
            this.githubStatusMessage.set(
              `Deployed ${res.filesDeployed || 0} files to Vercel! Your full-stack app + API is live at ${res.deploymentUrl}`
            );
            this.showBanner('success', `Live on Vercel: ${res.deploymentUrl}`);
          } else {
            this.vercelDeployStatus.set('error');
            this.githubStatusMessage.set(
              res.error || 'Could not deploy to Vercel. Check your Vercel token.'
            );
          }
        },
        error: (err) => {
          this.vercelDeployStatus.set('error');
          this.githubStatusMessage.set(
            err?.error?.error || 'Vercel deployment failed. Please enter a valid Vercel Access Token.'
          );
        },
      });
  }

  // =========================================================================
  // SPLIT SCREEN & EXPAND / CONTRACT CONTROLS (TABLE VIEW & OBJECT EXPLORER)
  // =========================================================================

  /**
   * Ensures that when the table view is expanded to show more rows, additional rows
   * are automatically loaded/visible to fill the expanded table height.
   */
  public ensureRowsLoadedForTableHeight(heightPx = this.tableViewHeightPx()): void {
    const neededRows = Math.max(this.lazyBatchSize, Math.ceil((heightPx - 56) / 38) + 4);
    if (this.visibleRowLimit() < neededRows) {
      this.visibleRowLimit.set(neededRows);
    }
    if (this.rows().length < neededRows && this.dbHasMoreRows() && !this.isLazyLoadingMore()) {
      const fetchMoreCount = Math.max(this.lazyBatchSize, neededRows - this.rows().length);
      this.queryDatabaseRows(false, fetchMoreCount);
    }
  }

  public adjustTableViewHeight(deltaPx: number, event?: Event): void {
    event?.stopPropagation();
    const nextHeight = Math.max(220, Math.min(960, this.tableViewHeightPx() + deltaPx));
    this.tableViewHeightPx.set(nextHeight);
    if (deltaPx > 0) {
      this.ensureRowsLoadedForTableHeight(nextHeight);
    }
  }

  public toggleTableViewExpanded(event?: Event): void {
    event?.stopPropagation();
    if (this.isTableViewExpanded()) {
      this.tableViewHeightPx.set(380);
    } else {
      const targetHeight = 720;
      this.tableViewHeightPx.set(targetHeight);
      this.ensureRowsLoadedForTableHeight(targetHeight);
    }
  }

  public setTableViewPreset(
    preset: 'compact' | 'medium' | 'expanded' | 'max',
    event?: Event
  ): void {
    event?.stopPropagation();
    const map: Record<'compact' | 'medium' | 'expanded' | 'max', number> = {
      compact: 300,
      medium: 460,
      expanded: 660,
      max: 860,
    };
    const nextHeight = map[preset] || 380;
    this.tableViewHeightPx.set(nextHeight);
    this.ensureRowsLoadedForTableHeight(nextHeight);
  }

  public startTableHeightResize(event: MouseEvent | TouchEvent): void {
    if (!this.isBrowser) return;
    event.preventDefault();
    event.stopPropagation();

    const startY =
      'touches' in event ? event.touches[0]?.clientY ?? 0 : event.clientY;
    const startHeight = this.tableViewHeightPx();
    this.isDraggingTableHeight.set(true);

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const currentY =
        'touches' in moveEv ? moveEv.touches[0]?.clientY ?? startY : moveEv.clientY;
      const deltaY = currentY - startY;
      const nextHeight = Math.max(220, Math.min(960, Math.round(startHeight + deltaY)));
      this.tableViewHeightPx.set(nextHeight);
    };

    const onUp = () => {
      this.isDraggingTableHeight.set(false);
      this.ensureRowsLoadedForTableHeight(this.tableViewHeightPx());
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
  }

  public adjustSidebarWidth(deltaPx: number, event?: Event): void {
    event?.stopPropagation();
    if (!this.isManageSidebarOpen()) {
      this.isManageSidebarOpen.set(true);
    }
    const nextWidth = Math.max(210, Math.min(680, this.sidebarWidthPx() + deltaPx));
    this.sidebarWidthPx.set(nextWidth);
  }

  public adjustSidebarTreeHeight(deltaPx: number, event?: Event): void {
    event?.stopPropagation();
    const nextHeight = Math.max(220, Math.min(960, this.sidebarTreeHeightPx() + deltaPx));
    this.sidebarTreeHeightPx.set(nextHeight);
  }

  public toggleSidebarExpandedView(event?: Event): void {
    event?.stopPropagation();
    if (!this.isManageSidebarOpen()) {
      this.isManageSidebarOpen.set(true);
      this.sidebarWidthPx.set(440);
      this.sidebarTreeHeightPx.set(720);
      return;
    }
    if (this.isSidebarExpanded()) {
      this.sidebarWidthPx.set(316);
      this.sidebarTreeHeightPx.set(520);
    } else {
      this.sidebarWidthPx.set(440);
      this.sidebarTreeHeightPx.set(740);
    }
  }

  public startSidebarWidthResize(event: MouseEvent | TouchEvent): void {
    if (!this.isBrowser) return;
    event.preventDefault();
    event.stopPropagation();

    const startX =
      'touches' in event ? event.touches[0]?.clientX ?? 0 : event.clientX;
    const startWidth = this.sidebarWidthPx();
    this.isDraggingSidebarWidth.set(true);

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const currentX =
        'touches' in moveEv ? moveEv.touches[0]?.clientX ?? startX : moveEv.clientX;
      const deltaX = currentX - startX;
      const rawTarget = Math.round(startWidth + deltaX);
      // Allow contracting sidebar all the way down to minimum possible width (128px),
      // or if dragged past 75px, collapse into the docked rail like in Excel
      if (rawTarget < 75) {
        this.isManageSidebarOpen.set(false);
        return;
      }
      if (!this.isManageSidebarOpen()) {
        this.isManageSidebarOpen.set(true);
      }
      const nextWidth = Math.max(128, Math.min(680, rawTarget));
      this.sidebarWidthPx.set(nextWidth);
    };

    const onUp = () => {
      this.isDraggingSidebarWidth.set(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
  }

  /**
   * Double-clicking the vertical sidebar splitter toggles between the minimum possible compact width (148px)
   * and the auto-fitted tree width (just like double-clicking a border in Excel).
   */
  public toggleSidebarMinimumOrAutoFit(event?: Event): void {
    event?.stopPropagation();
    if (!this.isManageSidebarOpen()) {
      this.isManageSidebarOpen.set(true);
      this.sidebarWidthPx.set(280);
      return;
    }
    if (this.sidebarWidthPx() > 170) {
      this.sidebarWidthPx.set(148);
    } else {
      this.sidebarWidthPx.set(316);
    }
  }

  public startSidebarHeightResize(event: MouseEvent | TouchEvent): void {
    if (!this.isBrowser) return;
    event.preventDefault();
    event.stopPropagation();

    const startY =
      'touches' in event ? event.touches[0]?.clientY ?? 0 : event.clientY;
    const startHeight = this.sidebarTreeHeightPx();
    this.isDraggingSidebarHeight.set(true);

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const currentY =
        'touches' in moveEv ? moveEv.touches[0]?.clientY ?? startY : moveEv.clientY;
      const deltaY = currentY - startY;
      const nextHeight = Math.max(160, Math.min(960, Math.round(startHeight + deltaY)));
      this.sidebarTreeHeightPx.set(nextHeight);
    };

    const onUp = () => {
      this.isDraggingSidebarHeight.set(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
  }

  // =========================================================================
  // EXCEL-STYLE COLUMN WIDTH EXPAND / CONTRACT (MINIMUM POSSIBLE) & AUTO-FIT
  // =========================================================================

  public startColumnWidthResize(col: GridColumn, event: MouseEvent | TouchEvent): void {
    if (!this.isBrowser) return;
    event.preventDefault();
    event.stopPropagation();

    const startX =
      'touches' in event ? event.touches[0]?.clientX ?? 0 : event.clientX;
    const startWidth = Number(col.width) || 140;
    this.resizingColId.set(col.id);

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const currentX =
        'touches' in moveEv ? moveEv.touches[0]?.clientX ?? startX : moveEv.clientX;
      const deltaX = currentX - startX;
      // Allow contracting column width down to minimum possible (48px) or expanding up to 800px like Excel
      const nextWidth = Math.max(48, Math.min(800, Math.round(startWidth + deltaX)));
      this.columns.update((cols) =>
        cols.map((c) => (c.id === col.id ? { ...c, width: nextWidth } : c))
      );
    };

    const onUp = () => {
      this.resizingColId.set(null);
      this.syncLocalActiveTableIntoDatabasesTree();
      const updatedCol = this.columns().find((c) => c.id === col.id);
      if (updatedCol && updatedCol.width !== startWidth) {
        this.persistToCloud(
          'Column Resized',
          `Resized column "${updatedCol.name}" to ${updatedCol.width}px`,
          undefined,
          updatedCol
        );
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
  }

  /**
   * Double-clicking a column's right border auto-fits the column width to the minimum possible width
   * required by its header and visible cell values (or contracts to compact width if already auto-fit),
   * matching Excel's column border double-click behavior.
   */
  public autoFitColumnWidth(col: GridColumn, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const headerLen = (col.name || '').length + (this.isColumnNotNull(col) ? 2 : 0);
    let maxCharLen = Math.max(4, headerLen);
    for (const r of this.visibleRows()) {
      const cellStr = String(this.formatCellForGrid(r, col) || '');
      if (cellStr.length > maxCharLen) {
        maxCharLen = cellStr.length;
      }
    }
    const idealWidth = Math.max(54, Math.min(480, Math.round(maxCharLen * 7.5 + 38)));
    const nextWidth = Math.abs((col.width || 140) - idealWidth) <= 6 ? 64 : idealWidth;
    let updatedCol: GridColumn | undefined;
    this.columns.update((cols) =>
      cols.map((c) => {
        if (c.id === col.id) {
          updatedCol = { ...c, width: nextWidth };
          return updatedCol;
        }
        return c;
      })
    );
    this.syncLocalActiveTableIntoDatabasesTree();
    if (updatedCol) {
      this.persistToCloud(
        'Column Auto-Fit',
        `Auto-fit column "${updatedCol.name}" width to ${nextWidth}px`,
        undefined,
        updatedCol
      );
    }
  }

  // =========================================================================
  // MANDATORY (NOT NULL) COLUMN CHECK & 4-THEME SWITCHER & OVERFLOW TOOLTIP
  // =========================================================================

  /**
   * Returns true if the column is set as NOT NULL / mandatory (shows red * in column header & sidebar).
   */
  public isColumnNotNull(col?: GridColumn | null): boolean {
    if (!col) return false;
    return Boolean(
      col.isPrimaryKey ||
        col.isIdentity ||
        col.isNullable === false ||
        col.required
    );
  }

  public setTheme(theme: GridarioTheme, event?: Event): void {
    event?.stopPropagation();
    this.applyTheme(theme);
  }

  public toggleLightDarkTheme(event?: Event): void {
    event?.stopPropagation();
    const next: GridarioTheme =
      this.activeTheme() === 'classic-dark' ? 'classic-light' : 'classic-dark';
    this.applyTheme(next);
  }

  private applyTheme(theme: GridarioTheme): void {
    const resolved: GridarioTheme = theme === 'classic-dark' ? 'classic-dark' : 'classic-light';
    this.activeTheme.set(resolved);
    if (this.isBrowser) {
      localStorage.setItem('gridario_ui_theme', resolved);
      document.documentElement.setAttribute('data-theme', resolved);
      document.body?.setAttribute('data-theme', resolved);
    }
  }

  /**
   * Generates a crisp circular SVG profile image data URI for the logged-in user.
   */
  public buildUserAvatarDataUri(displayName: string, accentColor: string): string {
    const cleanName = (displayName || 'User').trim();
    const parts = cleanName.split(/\s+/).filter(Boolean);
    const initials =
      parts.length >= 2
        ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
        : cleanName.slice(0, 2).toUpperCase();
    const bg = /^#[0-9a-fA-F]{3,8}$/.test(accentColor) ? accentColor : '#4285F4';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${bg}"/>
          <stop offset="100%" stop-color="#1e293b"/>
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill="url(#g)"/>
      <circle cx="32" cy="23" r="10.5" fill="rgba(255,255,255,0.22)"/>
      <path d="M14 55c3.5-10 11-15 18-15s14.5 5 18 15" fill="rgba(255,255,255,0.22)"/>
      <text x="32" y="37" text-anchor="middle" fill="#ffffff" font-family="Inter, system-ui, -apple-system, sans-serif" font-weight="700" font-size="22" letter-spacing="0.5">${initials}</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  /**
   * Immediately hides the 1-second hover explanation tooltip and cancels any pending hover timer.
   */
  public clearActionTooltip(): void {
    if (this.actionHoverTimerId) {
      clearTimeout(this.actionHoverTimerId);
      this.actionHoverTimerId = null;
    }
    this.hoveredInteractiveEl = null;
    if (this.actionTooltip().visible) {
      this.actionTooltip.update((t) => ({ ...t, visible: false }));
    }
  }

  /**
   * Inspects any hovered interactive control (button, hyperlink, textbox, dropdown, checkbox, tab,
   * sidebar node, splitter handle, or header action) and returns a short, professional explanation
   * in simple English of what that functionality or action does.
   */
  private resolveActionTooltipExplanation(el: HTMLElement): string {
    // Preserve native title attribute in data-gridario-tip and strip native title so browser tooltip doesn't conflict
    const rawTitle = el.getAttribute('title');
    if (rawTitle !== null) {
      if (rawTitle.trim()) {
        el.setAttribute('data-gridario-tip', rawTitle.trim());
      }
      el.removeAttribute('title');
    }
    // Also strip ancestor title attributes if present so native browser tooltip never overlaps
    let parentWithTitle = el.parentElement;
    while (parentWithTitle) {
      const pTitle = parentWithTitle.getAttribute('title');
      if (pTitle !== null) {
        if (pTitle.trim() && !parentWithTitle.getAttribute('data-gridario-tip')) {
          parentWithTitle.setAttribute('data-gridario-tip', pTitle.trim());
        }
        parentWithTitle.removeAttribute('title');
      }
      parentWithTitle = parentWithTitle.parentElement;
    }

    const explicitTip = (
      el.getAttribute('data-tooltip') ||
      el.getAttribute('data-gridario-tip') ||
      el.getAttribute('aria-label') ||
      ''
    ).trim();

    if (explicitTip) {
      return this.formatFriendlyActionTooltip(explicitTip, el);
    }

    const tag = el.tagName.toLowerCase();

    if (tag === 'input') {
      const inp = el as HTMLInputElement;
      const inputType = (inp.type || 'text').toLowerCase();
      if (inputType === 'checkbox') {
        return 'Click to check or uncheck this option.';
      }
      if (inputType === 'radio') {
        return 'Click to select this option.';
      }
      if (inputType === 'color') {
        return 'Click to choose a custom display color.';
      }
      if (inputType === 'number') {
        return 'Enter a numeric value in this field.';
      }
      if (inputType === 'date') {
        return 'Select or type a date in YYYY-MM-DD format.';
      }
      const placeholder = (inp.placeholder || '').trim();
      if (placeholder) {
        return this.formatFriendlyActionTooltip(placeholder, el);
      }
      return 'Type a value into this text box.';
    }

    if (tag === 'textarea') {
      const ta = el as HTMLTextAreaElement;
      const placeholder = (ta.placeholder || '').trim();
      if (placeholder) {
        return this.formatFriendlyActionTooltip(placeholder, el);
      }
      return 'Enter or paste text into this field.';
    }

    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const selectedOpt = sel.options?.[sel.selectedIndex]?.text?.trim() || '';
      if (selectedOpt) {
        return `Click to open the dropdown menu and change the selection (currently "${selectedOpt}").`;
      }
      return 'Click to open the dropdown menu and choose an option.';
    }

    if (tag === 'a') {
      const linkText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (linkText) {
        return `Click to open or download ${linkText}.`;
      }
      return 'Click to open this link.';
    }

    if (el.classList.contains('gridario-col-resizer')) {
      return 'Drag left or right to resize this column, or double-click to auto-fit its width.';
    }
    if (
      el.classList.contains('gridpulse-split-handle-horizontal') ||
      el.classList.contains('gridpulse-split-handle-vertical')
    ) {
      return 'Drag to resize this panel, or double-click to toggle expanded view.';
    }

    // Clone text without material icon ligature names
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('mat-icon, .material-icons').forEach((iconNode) => iconNode.remove());
    const cleanText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (cleanText) {
      return this.formatFriendlyActionTooltip(cleanText, el);
    }

    return 'Click to perform this action.';
  }

  /**
   * Formats raw titles, labels, or placeholders into a concise, professional sentence in simple English.
   */
  private formatFriendlyActionTooltip(raw: string, el: HTMLElement): string {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Click to use this feature.';

    const lower = cleaned.toLowerCase();
    const tag = el.tagName.toLowerCase();

    // Direct friendly mappings for common UI controls
    if (lower === 'close' || lower === 'cancel') {
      return 'Close this dialog without saving changes.';
    }
    if (lower === 'apply' || lower === 'apply filter') {
      return 'Apply the selected filter rules and update the table rows.';
    }
    if (lower === 'clear' || lower === 'clear filter') {
      return 'Remove this filter and restore all matching rows in the table.';
    }
    if (lower === 'clear sort/filter' || lower.includes('clear all sort rules')) {
      return 'Clear all active sort rules and filters to show all table rows.';
    }
    if (lower === 'select all') {
      return 'Select all values in the list.';
    }
    if (lower === 'login' || lower === 'user login' || lower === 'sign in to your account') {
      return 'Open the sign-in window to log in to your account.';
    }
    if (lower === 'log out' || lower.includes('log out of account')) {
      return 'Sign out of your current account session.';
    }
    if (lower === 'new tab' || lower === 'new database tab') {
      return 'Open a new database connection tab in the workspace.';
    }
    if (lower === 'new table' || lower.includes('create new table sheet tab')) {
      return 'Create a new database table as a sheet tab in the active database.';
    }
    if (lower.includes('search rows, columns')) {
      return 'Type keywords and press Enter to search across rows and columns in the active table.';
    }
    if (lower.includes('search scope column')) {
      return 'Choose whether to search across all columns or within a specific column.';
    }
    if (lower.includes('filter databases, tables, or columns')) {
      return 'Type to quickly filter databases, tables, and columns in the Object Explorer.';
    }
    if (lower.startsWith('filter ') && tag === 'input') {
      return `Type a value and press Enter to filter rows by ${cleaned.slice(7).replace(/\.\.\.$/, '')}.`;
    }
    if (lower.startsWith('enter ') && (tag === 'input' || tag === 'select')) {
      return `Enter the value for ${cleaned.slice(6).replace(/\.\.\.$/, '')} when adding a new row.`;
    }
    if (lower.includes('select all visible rows')) {
      return 'Check or uncheck this box to select or deselect all visible rows in the table.';
    }
    if (lower.startsWith('select row ')) {
      return `Check or uncheck this box to select ${cleaned.replace(/^select /i, '')} for bulk actions.`;
    }

    // If it already reads like a clear descriptive phrase, ensure it ends with a period
    if (cleaned.length >= 18) {
      const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
    }

    if (tag === 'input' || tag === 'textarea') {
      return `Enter or edit ${cleaned}.`;
    }
    if (tag === 'select') {
      return `Select an option for ${cleaned}.`;
    }
    if (tag === 'a') {
      return `Open ${cleaned}.`;
    }

    const capitalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    return /[.!?]$/.test(capitalized)
      ? capitalized
      : `Click to ${capitalized.charAt(0).toLowerCase() + capitalized.slice(1)}.`;
  }

  /**
   * Automatically inspects hovered cells (td/th) and sidebar nodes (.manage-tree-row / .truncate)
   * for text overflow tooltips, AND manages the 1-second hover explanation tooltip for all
   * interactive functionalities and actions (buttons, links, textboxes, dropdowns, tabs, etc.).
   */
  public onGlobalMouseOver(event: MouseEvent): void {
    if (!this.isBrowser) return;
    const rawTarget = event.target as HTMLElement | null;
    if (!rawTarget) return;

    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;

    // 1. Handle 1-second hover explanation tooltip for any interactive functionality or action
    const interactiveEl = rawTarget.closest(
      'button, a, input, select, textarea, [role="button"], [role="separator"], [data-tooltip], [data-gridario-tip], .excel-sheet-tab, .manage-tree-row, .gridario-col-resizer, .gridpulse-split-handle-horizontal, .gridpulse-split-handle-vertical'
    ) as HTMLElement | null;

    if (interactiveEl !== this.hoveredInteractiveEl) {
      if (this.actionHoverTimerId) {
        clearTimeout(this.actionHoverTimerId);
        this.actionHoverTimerId = null;
      }
      if (this.actionTooltip().visible) {
        this.actionTooltip.update((t) => ({ ...t, visible: false }));
      }
      this.hoveredInteractiveEl = interactiveEl;

      if (interactiveEl) {
        const explanation = this.resolveActionTooltipExplanation(interactiveEl);
        if (explanation) {
          this.actionHoverTimerId = setTimeout(() => {
            if (this.hoveredInteractiveEl !== interactiveEl) return;
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const x = Math.max(12, Math.min(this.lastMouseX + 14, vw - 340));
            const y = Math.max(12, Math.min(this.lastMouseY + 20, vh - 90));
            this.actionTooltip.set({
              visible: true,
              text: explanation,
              x,
              y,
            });
          }, 1000);
        }
      }
    }

    // 2. Handle smart overflow tooltip for truncated table cells & sidebar items
    const candidate = rawTarget.closest(
      'td, th, .manage-tree-row, .ssms-db-selector, .excel-sheet-tab, .truncate'
    ) as HTMLElement | null;
    if (!candidate) {
      if (this.overflowTooltip().visible) {
        this.overflowTooltip.update((t) => ({ ...t, visible: false }));
      }
      return;
    }

    let fullText = '';
    let isOverflowing = false;

    // Check if an <input> or <select> inside is overflowing
    if (rawTarget instanceof HTMLInputElement && rawTarget.type === 'text') {
      if (rawTarget.scrollWidth > rawTarget.clientWidth + 1 && rawTarget.value.trim()) {
        isOverflowing = true;
        fullText = rawTarget.value.trim();
      }
    }

    if (!isOverflowing) {
      // Check candidate and any .truncate child elements inside candidate
      const truncateNodes: HTMLElement[] = [];
      if (candidate.classList.contains('truncate')) {
        truncateNodes.push(candidate);
      }
      candidate.querySelectorAll('.truncate').forEach((node) => {
        if (node instanceof HTMLElement) {
          truncateNodes.push(node);
        }
      });

      for (const el of truncateNodes) {
        if (el.scrollWidth > el.clientWidth + 1) {
          isOverflowing = true;
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt) {
            fullText = txt;
            break;
          }
        }
      }

      if (!isOverflowing && candidate.scrollWidth > candidate.clientWidth + 2) {
        const txt = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt) {
          isOverflowing = true;
          fullText = txt;
        }
      }
    }

    if (isOverflowing && fullText) {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const x = Math.max(12, Math.min(event.clientX + 12, vw - 360));
      const y = Math.max(12, Math.min(event.clientY + 18, vh - 80));
      this.overflowTooltip.set({
        visible: true,
        text: fullText,
        x,
        y,
      });
    } else if (this.overflowTooltip().visible) {
      this.overflowTooltip.update((t) => ({ ...t, visible: false }));
    }
  }

  public onGlobalMouseMove(event: MouseEvent): void {
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
    const vw = this.isBrowser ? window.innerWidth : 1280;
    const vh = this.isBrowser ? window.innerHeight : 800;

    if (this.actionTooltip().visible) {
      const ax = Math.max(12, Math.min(event.clientX + 14, vw - 340));
      const ay = Math.max(12, Math.min(event.clientY + 20, vh - 90));
      this.actionTooltip.update((t) => ({ ...t, x: ax, y: ay }));
    }

    if (!this.overflowTooltip().visible) return;
    const x = Math.max(12, Math.min(event.clientX + 12, vw - 360));
    const y = Math.max(12, Math.min(event.clientY + 18, vh - 80));
    this.overflowTooltip.update((t) => ({ ...t, x, y }));
  }

  public onGlobalMouseOut(event: MouseEvent): void {
    const related = event.relatedTarget as HTMLElement | null;
    if (this.hoveredInteractiveEl) {
      if (!related || !this.hoveredInteractiveEl.contains(related)) {
        this.clearActionTooltip();
      }
    }
    if (!related && this.overflowTooltip().visible) {
      this.overflowTooltip.update((t) => ({ ...t, visible: false }));
    }
  }
}

