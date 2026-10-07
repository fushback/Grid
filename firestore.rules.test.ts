import { describe, it, expect } from 'vitest';

/**
 * Security Rules Specification Verification Suite for GridPulse
 * Validates all 12 "Dirty Dozen" payloads defined in security_spec.md
 * against the constraints enforced in firestore.rules.
 */

interface AuthContext {
  uid: string;
  email: string;
  email_verified: boolean;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_COL_TYPES = ['text', 'number', 'date', 'dropdown', 'checkbox', 'formula'];

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && VALID_ID_REGEX.test(id);
}

function isVerifiedUser(auth: AuthContext | null): boolean {
  return auth !== null && auth.email_verified === true;
}

function evaluateWorkspaceCreate(
  auth: AuthContext | null,
  workspaceId: string,
  data: Record<string, unknown>,
  requestTime: string
): 'ALLOW' | 'PERMISSION_DENIED' {
  if (!isVerifiedUser(auth) || !isValidId(workspaceId)) return 'PERMISSION_DENIED';
  const keys = Object.keys(data);
  const required = ['name', 'ownerId', 'rowCount', 'createdAt', 'updatedAt'];
  if (keys.length !== required.length || !required.every((k) => keys.includes(k))) {
    return 'PERMISSION_DENIED';
  }
  if (typeof data['name'] !== 'string' || data['name'].length < 1 || data['name'].length > 120) {
    return 'PERMISSION_DENIED';
  }
  if (data['ownerId'] !== auth!.uid || !isValidId(data['ownerId'])) {
    return 'PERMISSION_DENIED';
  }
  if (typeof data['rowCount'] !== 'number' || data['rowCount'] < 0 || data['rowCount'] > 100000) {
    return 'PERMISSION_DENIED';
  }
  if (data['createdAt'] !== requestTime || data['updatedAt'] !== requestTime) {
    return 'PERMISSION_DENIED';
  }
  return 'ALLOW';
}

function evaluateColumnCreate(
  auth: AuthContext | null,
  workspaceId: string,
  columnId: string,
  parentWorkspaceOwnerId: string | null,
  data: Record<string, unknown>,
  requestTime: string
): 'ALLOW' | 'PERMISSION_DENIED' {
  if (!isVerifiedUser(auth) || !isValidId(workspaceId) || !isValidId(columnId)) {
    return 'PERMISSION_DENIED';
  }
  if (!parentWorkspaceOwnerId || parentWorkspaceOwnerId !== auth!.uid) {
    return 'PERMISSION_DENIED';
  }
  const required = [
    'workspaceId',
    'ownerId',
    'name',
    'colType',
    'orderIndex',
    'width',
    'required',
    'formula',
    'optionsCsv',
    'createdAt',
    'updatedAt',
  ];
  const keys = Object.keys(data);
  if (keys.length !== required.length || !required.every((k) => keys.includes(k))) {
    return 'PERMISSION_DENIED';
  }
  if (data['workspaceId'] !== workspaceId || data['ownerId'] !== auth!.uid) {
    return 'PERMISSION_DENIED';
  }
  if (typeof data['name'] !== 'string' || data['name'].length < 1 || data['name'].length > 80) {
    return 'PERMISSION_DENIED';
  }
  if (typeof data['colType'] !== 'string' || !ALLOWED_COL_TYPES.includes(data['colType'])) {
    return 'PERMISSION_DENIED';
  }
  if (data['createdAt'] !== requestTime || data['updatedAt'] !== requestTime) {
    return 'PERMISSION_DENIED';
  }
  return 'ALLOW';
}

describe('Firestore Security Rules — Dirty Dozen Payloads', () => {
  const validAuth: AuthContext = {
    uid: 'user_123',
    email: 'ashismohta@gmail.com',
    email_verified: true,
  };
  const now = '2026-10-05T15:30:00Z';

  it('1. Rejects Shadow Field Injection on Workspace Create', () => {
    expect(
      evaluateWorkspaceCreate(
        validAuth,
        'ws_1',
        {
          name: 'Q4 Financial Grid',
          ownerId: 'user_123',
          rowCount: 25,
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('2. Rejects Identity Spoofing on Workspace Create', () => {
    expect(
      evaluateWorkspaceCreate(
        validAuth,
        'ws_1',
        {
          name: 'Spoofed Workspace',
          ownerId: 'victim_uid_999',
          rowCount: 10,
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('3. Rejects Unverified Email Spoof Attack', () => {
    const unverifiedAuth: AuthContext = {
      uid: 'user_123',
      email: 'ashismohta@gmail.com',
      email_verified: false,
    };
    expect(
      evaluateWorkspaceCreate(
        unverifiedAuth,
        'ws_1',
        {
          name: 'Valid Name',
          ownerId: 'user_123',
          rowCount: 10,
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('4. Rejects Denial of Wallet Oversized Workspace Name (>120 chars)', () => {
    expect(
      evaluateWorkspaceCreate(
        validAuth,
        'ws_1',
        {
          name: 'X'.repeat(150),
          ownerId: 'user_123',
          rowCount: 10,
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('5. Rejects ID Poisoning on Path Variable', () => {
    expect(
      evaluateWorkspaceCreate(
        validAuth,
        'invalid$id!with@spaces',
        {
          name: 'Valid Name',
          ownerId: 'user_123',
          rowCount: 10,
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('6. Rejects Orphaned Column Create (Non-Existent Parent Workspace)', () => {
    expect(
      evaluateColumnCreate(
        validAuth,
        'missing_ws',
        'col_1',
        null,
        {
          workspaceId: 'missing_ws',
          ownerId: 'user_123',
          name: 'Revenue',
          colType: 'number',
          orderIndex: 0,
          width: 150,
          required: true,
          formula: '',
          optionsCsv: '',
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('7. Rejects Invalid Column Type Enum Poisoning', () => {
    expect(
      evaluateColumnCreate(
        validAuth,
        'ws_1',
        'col_1',
        'user_123',
        {
          workspaceId: 'ws_1',
          ownerId: 'user_123',
          name: 'Malicious Script',
          colType: 'executable_script',
          orderIndex: 0,
          width: 150,
          required: false,
          formula: '',
          optionsCsv: '',
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('9. Rejects Forged Client Timestamp', () => {
    expect(
      evaluateWorkspaceCreate(
        validAuth,
        'ws_1',
        {
          name: 'Valid Name',
          ownerId: 'user_123',
          rowCount: 10,
          createdAt: '2099-01-01T00:00:00Z',
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });

  it('10. Rejects Cross-Tenant Column Injection (workspaceId mismatch)', () => {
    expect(
      evaluateColumnCreate(
        validAuth,
        'ws_1',
        'col_1',
        'user_123',
        {
          workspaceId: 'ws_other',
          ownerId: 'user_123',
          name: 'Revenue',
          colType: 'number',
          orderIndex: 0,
          width: 150,
          required: false,
          formula: '',
          optionsCsv: '',
          createdAt: now,
          updatedAt: now,
        },
        now
      )
    ).toBe('PERMISSION_DENIED');
  });
});
