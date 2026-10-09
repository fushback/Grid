export type ColumnType =
  | 'text'
  | 'varchar_max'
  | 'number'
  | 'date'
  | 'dropdown'
  | 'lookup'
  | 'checkbox'
  | 'formula';

export interface LookupItem {
  id: string | number;
  name: string;
  json: string;
  isActive?: boolean;
  attributes?: Record<string, string | number | boolean>;
}

export interface GridColumn {
  id: string;
  name: string;
  colType: ColumnType;
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

export interface DbTableSummary {
  tableName: string;
  rowCount: number;
  columnCount: number;
  columns?: GridColumn[];
  rows?: GridRow[];
  identitySeed: number;
  identityIncrement: number;
  nextIdentityValue: number;
  createdAt: string;
  updatedAt: string;
}

export interface DbDatabaseSummary {
  databaseName: string;
  activeTableName: string;
  tables: DbTableSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface NewTableColumnDraft {
  id: string;
  name: string;
  colType: ColumnType;
  isNullable: boolean;
  columnValue: string;
  formula: string;
  optionsCsv: string;
  lookupTableName?: string;
  isPrimaryKey: boolean;
  isIdentity: boolean;
}

export type CellPrimitive = string | number | boolean;

export interface GridRow {
  id: string;
  orderIndex: number;
  cells: Record<string, CellPrimitive>;
  updatedBy: string;
  updatedAt: string;
}

export interface SortRule {
  columnId: string;
  direction: 'asc' | 'desc';
}

export type FilterConditionType =
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

export interface ColumnFilterRule {
  columnId: string;
  condition: FilterConditionType;
  queryValue: string;
  queryValueEnd: string;
  excludedValues: string[];
}

export interface ClipboardBuffer {
  mode: 'copy' | 'cut';
  targetType: 'rows' | 'column';
  sourceIds: string[];
  rowsSnapshot: GridRow[];
  columnSnapshot: GridColumn | null;
  columnCellsSnapshot: Record<string, CellPrimitive>;
  createdAt: number;
}

export interface CollaboratorPresence {
  userId: string;
  displayName: string;
  color: string;
  isAnonymous: boolean;
  activeRowId: string;
  activeColId: string;
  updatedAt: string;
}

export interface ActivityLogItem {
  id: string;
  userName: string;
  userColor: string;
  action: string;
  detail: string;
  timestamp: string;
}

export interface ValidationResult {
  valid: boolean;
  normalizedValue: CellPrimitive;
  errorMessage: string;
}

export function getDropdownOptions(col: GridColumn): string[] {
  const raw = (col.optionsCsv || '').trim();
  const defVal = col.defaultValue !== undefined ? String(col.defaultValue).trim() : '';
  const seen = new Set<string>();
  const result: string[] = [];

  const addSplitOptions = (source: string) => {
    for (const part of source.split(/[,\n;|]+/)) {
      const clean = part.trim().replace(/^['"]|['"]$/g, '').trim();
      if (clean.length > 0 && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        result.push(clean);
      }
    }
  };

  // If optionsCsv is still the placeholder 'High, Medium, Low' while defaultValue has custom comma-separated options, prioritize defaultValue
  const isDefaultPlaceholder = raw.toLowerCase() === 'high, medium, low';
  const defHasCommas =
    defVal.includes(',') &&
    !defVal.startsWith('[') &&
    !defVal.startsWith('{') &&
    !defVal.startsWith('=');

  if (isDefaultPlaceholder && defHasCommas) {
    addSplitOptions(defVal);
  } else if (raw && !raw.startsWith('[') && !raw.startsWith('{')) {
    addSplitOptions(raw);
  }

  if (defVal && !defVal.startsWith('[') && !defVal.startsWith('{') && !defVal.startsWith('=')) {
    addSplitOptions(defVal);
  }

  return result;
}

export function parseLookupString(raw: string): LookupItem[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
      ? [parsed]
      : null;
    if (arr) {
      const items: LookupItem[] = [];
      for (let idx = 0; idx < arr.length; idx++) {
        const entry = arr[idx];
        if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          const attrs: Record<string, string | number | boolean> = {};
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              attrs[k] = v;
            } else if (v !== null && v !== undefined) {
              attrs[k] = String(v);
            }
          }
          const idEntry = Object.entries(obj).find(
            ([k]) => k.toLowerCase() === 'id' || k.toLowerCase() === 'key'
          );
          const rawId = obj['id'] ?? obj['ID'] ?? obj['key'] ?? idEntry?.[1] ?? idx + 1;
          const rawName =
            obj['name'] ??
            obj['Name'] ??
            obj['label'] ??
            obj['value'] ??
            obj['title'] ??
            Object.entries(attrs).find(([k]) => k.toLowerCase() !== 'id')?.[1] ??
            '';
          const strName = String(rawName).trim();
          const rawActive = obj['isactive'] ?? obj['isActive'] ?? obj['active'];
          const isActive =
            rawActive === undefined
              ? undefined
              : !(
                  rawActive === 0 ||
                  rawActive === '0' ||
                  rawActive === false ||
                  String(rawActive).toLowerCase() === 'false'
                );
          if (strName.length > 0 || Object.keys(attrs).length > 0) {
            const numId = Number(rawId);
            const resolvedId =
              Number.isFinite(numId) && String(rawId).trim() !== ''
                ? numId
                : String(rawId).trim();
            if (Object.keys(attrs).length === 0) {
              attrs['ID'] = resolvedId;
              if (strName) attrs['name'] = strName;
            }
            items.push({
              id: resolvedId,
              name: strName || String(resolvedId),
              json: JSON.stringify(attrs),
              isActive,
              attributes: attrs,
            });
          }
        } else if (entry !== null && entry !== undefined && String(entry).trim() !== '') {
          const s = String(entry).trim();
          const attrs = { id: idx + 1, name: s };
          items.push({
            id: idx + 1,
            name: s,
            json: JSON.stringify(attrs),
            attributes: attrs,
          });
        }
      }
      if (items.length > 0) return items;
    }
  } catch {
    // Fall through to relaxed JS object-array syntax parser:
    // e.g. [{id: 1, name: car}, {id: 2, name: bus}]
  }

  const objBlocks = Array.from(trimmed.matchAll(/\{([^{}]+)\}/g));
  if (objBlocks.length > 0) {
    const items: LookupItem[] = [];
    for (let idx = 0; idx < objBlocks.length; idx++) {
      const inner = objBlocks[idx][1];
      const parts = inner
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      let idVal: string | number = idx + 1;
      let nameVal = '';
      let isActive: boolean | undefined = undefined;
      const attrs: Record<string, string | number | boolean> = {};

      for (const part of parts) {
        let rawKey = '';
        let rawVal = '';
        const colonIdx = part.indexOf(':');
        if (colonIdx !== -1) {
          rawKey = part
            .slice(0, colonIdx)
            .trim()
            .replace(/^['"]|['"]$/g, '');
          rawVal = part
            .slice(colonIdx + 1)
            .trim()
            .replace(/^['"]|['"]$/g, '');
        } else {
          const spaceMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+(.+)$/.exec(part);
          if (spaceMatch) {
            rawKey = spaceMatch[1].trim();
            rawVal = spaceMatch[2].trim().replace(/^['"]|['"]$/g, '');
          } else {
            continue;
          }
        }

        const lowerKey = rawKey.toLowerCase();
        const numVal = Number(rawVal);
        const typedVal: string | number | boolean =
          rawVal.toLowerCase() === 'true'
            ? true
            : rawVal.toLowerCase() === 'false'
            ? false
            : Number.isFinite(numVal) && rawVal !== ''
            ? numVal
            : rawVal;
        attrs[rawKey] = typedVal;

        if (lowerKey === 'id' || lowerKey === 'key') {
          idVal = Number.isFinite(numVal) && rawVal !== '' ? numVal : rawVal;
        } else if (
          lowerKey === 'name' ||
          lowerKey === 'label' ||
          lowerKey === 'value' ||
          lowerKey === 'title'
        ) {
          nameVal = rawVal;
        } else if (lowerKey === 'isactive' || lowerKey === 'is_active' || lowerKey === 'active') {
          isActive = !(
            rawVal === '0' ||
            rawVal.toLowerCase() === 'false' ||
            rawVal.toLowerCase() === 'no'
          );
        } else if (parts.length === 1) {
          idVal = Number.isFinite(Number(rawKey)) && rawKey !== '' ? Number(rawKey) : rawKey;
          nameVal = rawVal;
        }
      }

      if (!nameVal && Object.keys(attrs).length > 0) {
        const fallbackEntry = Object.entries(attrs).find(([k]) => k.toLowerCase() !== 'id');
        if (fallbackEntry) {
          nameVal = String(fallbackEntry[1]);
        }
      }

      if (nameVal.length > 0 || Object.keys(attrs).length > 0) {
        if (Object.keys(attrs).length === 0) {
          attrs['id'] = idVal;
          attrs['name'] = nameVal || String(idVal);
        }
        items.push({
          id: idVal,
          name: nameVal || String(idVal),
          json: JSON.stringify(attrs),
          isActive,
          attributes: attrs,
        });
      }
    }
    if (items.length > 0) return items;
  }

  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0)
    .map((s, idx) => {
      const attrs = { id: idx + 1, name: s };
      return { id: idx + 1, name: s, json: JSON.stringify(attrs), attributes: attrs };
    });
}

export function extractLookupTemplateTokens(rawTemplate?: string): string[] {
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

export function formatLookupTemplateFromFieldNames(fieldNames: string[], pkName = 'ID'): string {
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

export function resolveLookupTemplateAndColumns<
  T extends {
    id?: string;
    name: string;
    colType?: string;
    isPrimaryKey?: boolean;
    isIdentity?: boolean;
  }
>(
  rawTemplate: string | undefined,
  sourceColumns: T[],
  mutations?: {
    renamedColumns?: { oldName: string; newName: string }[];
    addedColumnNames?: string[];
    deletedColumnNames?: string[];
  }
): { selectedColumns: T[]; normalizedTemplate: string } {
  const nonLookupCols = sourceColumns.filter((c) => c.colType !== 'lookup');
  const effectiveCols = nonLookupCols.length > 0 ? nonLookupCols : sourceColumns;
  const pkCol =
    effectiveCols.find(
      (c) =>
        c.isPrimaryKey ||
        c.isIdentity ||
        c.name.toLowerCase() === 'id' ||
        (c.id && c.id.toLowerCase() === 'id')
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

  const colByLower = new Map<string, T>();
  for (const col of effectiveCols) {
    colByLower.set(col.name.trim().toLowerCase(), col);
    if (col.id) {
      colByLower.set(col.id.trim().toLowerCase(), col);
    }
  }

  const selectedColumns: T[] = [];
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

  // If no non-PK columns were matched (e.g. initial default or all selected fields were deleted),
  // include all available non-lookup columns from the source table so the JSON has rich data
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

export function getLookupOptions(col: GridColumn): LookupItem[] {
  return parseLookupString(col.optionsCsv || '');
}

export function matchLookupItemFromRaw(items: LookupItem[], rawVal: string): LookupItem | undefined {
  if (!rawVal || items.length === 0) return undefined;
  const trimmed = rawVal.trim();
  const lower = trimmed.toLowerCase();

  // 1. Exact JSON match first
  const exactJson = items.find((item) => item.json.toLowerCase() === lower);
  if (exactJson) return exactJson;

  // 2. Check if rawVal is a JSON object or relaxed object with an id/key or attributes
  if (trimmed.includes('{')) {
    const parsedInput = parseLookupString(trimmed);
    if (parsedInput.length === 1) {
      const inputItem = parsedInput[0];
      const hasExplicitIdField = /['"]?(?:id|key)['"]?\s*:/i.test(trimmed);
      if (hasExplicitIdField) {
        const byId = items.find(
          (i) => String(i.id).toLowerCase() === String(inputItem.id).toLowerCase()
        );
        if (byId) return byId;
      }
      if (inputItem.name) {
        const byName = items.find(
          (i) => i.name.toLowerCase() === inputItem.name.toLowerCase()
        );
        if (byName) return byName;
      }
      if (inputItem.attributes) {
        for (const [attrKey, attrVal] of Object.entries(inputItem.attributes)) {
          if (attrKey.toLowerCase() === 'id') continue;
          const strAttr = String(attrVal).toLowerCase();
          const byAttr = items.find((item) =>
            item.attributes
              ? Object.values(item.attributes).some((v) => String(v).toLowerCase() === strAttr)
              : false
          );
          if (byAttr) return byAttr;
        }
      }
    }
  }

  // 3. Match by id, name, formatted label, or attribute values
  return items.find((item) => {
    if (item.json.toLowerCase() === lower) return true;
    if (String(item.id).toLowerCase() === lower) return true;
    if (item.name.toLowerCase() === lower) return true;
    if (`${item.id} - ${item.name}`.toLowerCase() === lower) return true;
    if (`${item.id}: ${item.name}`.toLowerCase() === lower) return true;
    if (`{id: ${item.id}, name: ${item.name}}`.toLowerCase() === lower) return true;
    if (item.attributes) {
      for (const val of Object.values(item.attributes)) {
        if (String(val).toLowerCase() === lower) return true;
      }
    }
    return false;
  });
}

/**
 * Enforces strict data integrity rules for a cell value according to its ColumnSchema.
 * When invalid, returns normalizedValue with the raw string so the invalid entry remains visible
 * inside the red-highlighted cell until the user corrects it.
 */
export function validateCellValue(col: GridColumn, rawInput: unknown): ValidationResult {
  const strVal = rawInput === null || rawInput === undefined ? '' : String(rawInput).trim();
  const isNotNull = col.isPrimaryKey || col.required || col.isNullable === false;

  if (col.isPrimaryKey || col.isIdentity) {
    const num = Number(strVal);
    if (strVal.length === 0 || Number.isNaN(num) || !Number.isInteger(num) || num < 1) {
      return {
        valid: false,
        normalizedValue: strVal,
        errorMessage: `"${col.name}" is a Primary Key IDENTITY(1,1) column (NOT NULL positive integer).`,
      };
    }
    return { valid: true, normalizedValue: num, errorMessage: '' };
  }

  if (col.colType === 'formula') {
    if (
      strVal.length === 0 ||
      typeof rawInput === 'boolean' ||
      typeof rawInput === 'number' ||
      strVal.toLowerCase() === 'false' ||
      strVal.toLowerCase() === 'true'
    ) {
      return { valid: true, normalizedValue: '', errorMessage: '' };
    }
    const cleaned = strVal.replace(/[$,%\s()]/g, '');
    const parsed = Number(cleaned);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      return {
        valid: false,
        normalizedValue: strVal,
        errorMessage: `"${col.name}" is a numeric formula column (${col.formula}) and cannot accept non-numeric value "${strVal}".`,
      };
    }
    return {
      valid: true,
      normalizedValue: '',
      errorMessage: '',
    };
  }

  if (col.colType === 'checkbox') {
    if (typeof rawInput === 'boolean') {
      return { valid: true, normalizedValue: rawInput, errorMessage: '' };
    }
    const lower = strVal.toLowerCase();
    const cleanedCurrency = lower.replace(/[$,\s]/g, '');
    if (
      lower === 'true' ||
      lower === 'yes' ||
      lower === '1' ||
      cleanedCurrency === '1' ||
      cleanedCurrency === '1.00' ||
      lower === 'y' ||
      lower === 'on' ||
      lower === 'checked' ||
      lower === 'approved' ||
      lower === '✓' ||
      lower === '☑'
    ) {
      return { valid: true, normalizedValue: true, errorMessage: '' };
    }
    if (
      lower === 'false' ||
      lower === 'no' ||
      lower === '0' ||
      cleanedCurrency === '0' ||
      cleanedCurrency === '0.00' ||
      lower === 'n' ||
      lower === 'off' ||
      lower === 'unchecked' ||
      (!isNotNull && lower === '')
    ) {
      return { valid: true, normalizedValue: false, errorMessage: '' };
    }
    return {
      valid: false,
      normalizedValue: strVal,
      errorMessage: `"${col.name}" requires a boolean value (true/false, yes/no, 1/0), received "${strVal}".`,
    };
  }

  if (isNotNull && strVal.length === 0) {
    return {
      valid: false,
      normalizedValue: '',
      errorMessage: `"${col.name}" is NOT NULL (required) and cannot be empty.`,
    };
  }

  if (strVal.length === 0) {
    return {
      valid: true,
      normalizedValue: col.colType === 'number' ? 0 : '',
      errorMessage: '',
    };
  }

  if (col.colType === 'number') {
    if (typeof rawInput === 'boolean') {
      return {
        valid: true,
        normalizedValue: rawInput ? 1 : 0,
        errorMessage: '',
      };
    }
    const lowerNumStr = strVal.toLowerCase();
    if (lowerNumStr === 'false' || lowerNumStr === 'true') {
      return {
        valid: true,
        normalizedValue: lowerNumStr === 'true' ? 1 : 0,
        errorMessage: '',
      };
    }
    const isNegativeParen = strVal.startsWith('(') && strVal.endsWith(')');
    const cleaned = strVal.replace(/[$,%\s()]/g, '');
    const parsed = Number(cleaned);
    if (cleaned.length === 0 || Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      return {
        valid: false,
        normalizedValue: strVal,
        errorMessage: `"${col.name}" requires a valid numeric value (received "${strVal}").`,
      };
    }
    return {
      valid: true,
      normalizedValue: isNegativeParen ? -Math.abs(parsed) : parsed,
      errorMessage: '',
    };
  }

  if (col.colType === 'date') {
    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
    const match = dateRegex.exec(strVal);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const d = new Date(Date.UTC(year, month - 1, day));
      if (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() === month - 1 &&
        d.getUTCDate() === day
      ) {
        return { valid: true, normalizedValue: strVal, errorMessage: '' };
      }
      return {
        valid: false,
        normalizedValue: strVal,
        errorMessage: `"${col.name}" has an invalid calendar date "${strVal}" (expected YYYY-MM-DD).`,
      };
    }

    const parsedDate = Date.parse(strVal);
    if (Number.isNaN(parsedDate)) {
      return {
        valid: false,
        normalizedValue: strVal,
        errorMessage: `"${col.name}" requires a valid date in YYYY-MM-DD format (received "${strVal}").`,
      };
    }
    const iso = new Date(parsedDate).toISOString().slice(0, 10);
    return { valid: true, normalizedValue: iso, errorMessage: '' };
  }

  if (col.colType === 'dropdown') {
    const options = getDropdownOptions(col);
    if (options.length > 0) {
      const matched = options.find((opt) => opt.toLowerCase() === strVal.toLowerCase());
      if (!matched) {
        return {
          valid: false,
          normalizedValue: strVal,
          errorMessage: `"${strVal}" is not an allowed option in "${col.name}". Allowed: ${options.join(', ')}`,
        };
      }
      return { valid: true, normalizedValue: matched, errorMessage: '' };
    }
    return { valid: true, normalizedValue: strVal.slice(0, 200), errorMessage: '' };
  }

  if (col.colType === 'lookup') {
    const items = getLookupOptions(col);
    if (items.length > 0) {
      const matched = matchLookupItemFromRaw(items, strVal);
      if (!matched) {
        const allowedSummary = items
          .slice(0, 8)
          .map((i) => i.json)
          .join(', ');
        return {
          valid: false,
          normalizedValue: strVal,
          errorMessage: `"${strVal}" is not in "${col.name}" linked lookup table${col.lookupTableName ? ` ("${col.lookupTableName}")` : ''}. Allowed: [${allowedSummary}]`,
        };
      }
      return { valid: true, normalizedValue: matched.json, errorMessage: '' };
    }

    if (strVal.startsWith('[') || strVal.startsWith('{')) {
      const parsedCellItems = parseLookupString(strVal);
      if (parsedCellItems.length === 0) {
        return {
          valid: false,
          normalizedValue: strVal,
          errorMessage: `"${col.name}" requires a valid lookup JSON record.`,
        };
      }
      return {
        valid: true,
        normalizedValue:
          parsedCellItems.length === 1 ? parsedCellItems[0].json : strVal,
        errorMessage: '',
      };
    }

    if (strVal.length > 2000) {
      return {
        valid: false,
        normalizedValue: strVal,
        errorMessage: `"${col.name}" exceeds maximum length of 2000 characters.`,
      };
    }
    return { valid: true, normalizedValue: strVal, errorMessage: '' };
  }

  // 'text' and 'varchar_max' — max 2000 characters
  if (strVal.length > 2000) {
    return {
      valid: false,
      normalizedValue: strVal,
      errorMessage: `"${col.name}" exceeds maximum text length of 2000 characters (current: ${strVal.length}).`,
    };
  }

  return { valid: true, normalizedValue: strVal, errorMessage: '' };
}

/**
 * Evaluates a formula column expression for a given row.
 * Supports:
 * - Column references by bracketed name/id: =[Units] * [Unit Cost]
 * - Column references by bare column name: =Price * Quantity
 * - Functions: =ROUND(expr, decimals), =SUM([ColA], [ColB]), =AVG([ColA], [ColB]),
 *   =MIN([ColA], [ColB]), =MAX([ColA], [ColB]), =IF([CheckboxCol], "YesVal", "NoVal"), =UPPER([TextCol])
 */
export function evaluateFormula(
  formula: string,
  row: GridRow,
  columns: GridColumn[],
  depth = 0
): CellPrimitive {
  if (!formula || depth > 4) return '';
  let expr = formula.trim();
  if (expr.startsWith('=')) {
    expr = expr.slice(1).trim();
  }
  if (!expr) return '';

  const resolveColRef = (refName: string): CellPrimitive => {
    const cleanRef = refName.trim().replace(/^\[|\]$/g, '').trim().toLowerCase();
    const targetCol = columns.find(
      (c) => c.id.toLowerCase() === cleanRef || c.name.toLowerCase() === cleanRef
    );
    if (!targetCol) return 0;
    if (targetCol.colType === 'formula' && targetCol.formula) {
      return evaluateFormula(targetCol.formula, row, columns, depth + 1);
    }
    const byName = row.cells[targetCol.name];
    const byId = row.cells[targetCol.id];
    const raw = byName !== undefined && byName !== null ? byName : byId;
    return raw !== undefined && raw !== null ? raw : 0;
  };

  // Handle UPPER([Col]) or UPPER(Col)
  const upperMatch = /^UPPER\(\s*(?:\[([^\]]+)\]|([^)]+))\s*\)$/i.exec(expr);
  if (upperMatch) {
    return String(resolveColRef(upperMatch[1] || upperMatch[2] || '')).toUpperCase();
  }

  // Handle IF([Col], "TrueText", "FalseText") or IF(Col, "TrueText", "FalseText")
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

  // Handle ROUND(innerExpr, decimals)
  let roundDecimals: number | null = null;
  const roundMatch = /^ROUND\(\s*(.+)\s*,\s*(\d+)\s*\)$/i.exec(expr);
  if (roundMatch) {
    expr = roundMatch[1].trim();
    roundDecimals = Number(roundMatch[2]);
  }

  // Handle SUM(...), AVG(...), MIN(...), MAX(...)
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

  // 1. Replace all [Column Name] references with numeric values for arithmetic evaluation
  let substituted = expr.replace(/\[([^\]]+)\]/g, (_, colRef: string) => {
    const val = Number(resolveColRef(colRef));
    return Number.isFinite(val) ? String(val) : '0';
  });

  // 2. Also replace bare column names (sorted longest first so multi-word names match first)
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

  // Safe arithmetic evaluation: allow only digits, decimal points, +, -, *, /, (, ), and spaces
  if (!/^[0-9+\-*/().\s]+$/.test(substituted)) {
    return '#EXPR!';
  }

  try {
    const tokens = tokenizeMath(substituted);
    const result = evaluateMathTokens(tokens);
    if (!Number.isFinite(result)) return 0;
    if (roundDecimals !== null) {
      const factor = Math.pow(10, roundDecimals);
      return Math.round(result * factor) / factor;
    }
    return Math.round(result * 100) / 100;
  } catch {
    return '#ERR!';
  }
}

function tokenizeMath(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (const ch of input) {
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
  return tokens;
}

function evaluateMathTokens(tokens: string[]): number {
  let pos = 0;

  function parseExpression(): number {
    let val = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseTerm();
      val = op === '+' ? val + right : val - right;
    }
    return val;
  }

  function parseTerm(): number {
    let val = parseFactor();
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parseFactor();
      val = op === '*' ? val * right : right === 0 ? 0 : val / right;
    }
    return val;
  }

  function parseFactor(): number {
    if (tokens[pos] === '+') {
      pos++;
      return parseFactor();
    }
    if (tokens[pos] === '-') {
      pos++;
      return -parseFactor();
    }
    if (tokens[pos] === '(') {
      pos++;
      const val = parseExpression();
      if (tokens[pos] === ')') pos++;
      return val;
    }
    const num = Number(tokens[pos++] ?? '0');
    return Number.isFinite(num) ? num : 0;
  }

  return parseExpression();
}

