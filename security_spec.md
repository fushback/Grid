# Security Specification — GridPulse Firestore Rules

## 1. Data Invariants

1. **Global Zero-Trust Catch-All**: Any path not explicitly matched under `/workspaces/{workspaceId}` and its subcollections (`columns`, `rows`, `presence`) is strictly denied (`allow read, write: if false`).
2. **Verified Authentication Invariant**: All Firestore reads and writes require an authenticated user with a verified email (`request.auth != null && request.auth.token.email_verified == true`).
3. **Path Variable & ID Hardening**: Every document ID (`workspaceId`, `columnId`, `rowId`, `presenceId`) must satisfy `isValidId(id)` (`id is string && id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\-]+$')`).
4. **Master Gate Relational Sync**: Every subcollection document (`columns`, `rows`, `presence`) must reference a `workspaceId` matching its parent path parameter `workspaceId`, and the parent `/workspaces/$(workspaceId)` document must exist and belong to `request.auth.uid`.
5. **Strict Blueprint Key & Size Validation**: Every `create` and `update` operation must pass `isValidWorkspace`, `isValidColumn`, `isValidRow`, or `isValidPresence`, enforcing exact required and allowed keys (`hasAll` and `hasOnly`), bounded string lengths, and valid enum values.
6. **Temporal & Ownership Immutability**: `ownerId` and `createdAt` are immutable across all updates, `createdAt` must equal `request.time` on `create`, and `updatedAt` must equal `request.time` on both `create` and `update`.
7. **Secure List Queries**: Every `allow list` rule enforces `resource.data.ownerId == request.auth.uid` without relying on client-side filtering or performing `get()` calls inside list blocks.

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 — Shadow Field Injection on Workspace Create**:
   ```json
   {
     "name": "Q4 Financial Grid",
     "ownerId": "user_123",
     "rowCount": 25,
     "isAdmin": true,
     "createdAt": "SERVER_TIMESTAMP",
     "updatedAt": "SERVER_TIMESTAMP"
   }
   ```
   *Expected Result*: `PERMISSION_DENIED` (blocked by `data.keys().hasOnly(...)`).

2. **Payload 2 — Identity Spoofing on Workspace Create**:
   ```json
   {
     "name": "Spoofed Workspace",
     "ownerId": "victim_uid_999",
     "rowCount": 10,
     "createdAt": "SERVER_TIMESTAMP",
     "updatedAt": "SERVER_TIMESTAMP"
   }
   ```
   *Expected Result*: `PERMISSION_DENIED` (`ownerId != request.auth.uid`).

3. **Payload 3 — Unverified Email Spoof Attack**:
   Auth token has `email: "ashismohta@gmail.com"`, `email_verified: false`.
   *Expected Result*: `PERMISSION_DENIED` (`isVerifiedUser()` requires `email_verified == true`).

4. **Payload 4 — Denial of Wallet Oversized Workspace Name (>120 chars)**:
   ```json
   {
     "name": "A_150_CHARACTER_STRING_EXCEEDING_THE_120_CHAR_BLUEPRINT_LIMIT...",
     "ownerId": "user_123",
     "rowCount": 10,
     "createdAt": "SERVER_TIMESTAMP",
     "updatedAt": "SERVER_TIMESTAMP"
   }
   ```
   *Expected Result*: `PERMISSION_DENIED` (`name.size() <= 120` fails).

5. **Payload 5 — ID Poisoning on Path Variable**:
   Path: `/workspaces/invalid$id!with@spaces/rows/row_1`
   *Expected Result*: `PERMISSION_DENIED` (`isValidId(workspaceId)` regex fails).

6. **Payload 6 — Orphaned Column Create (Non-Existent Parent Workspace)**:
   Creating `/workspaces/missing_ws/columns/col_1` where `/workspaces/missing_ws` does not exist.
   *Expected Result*: `PERMISSION_DENIED` (Master Gate `isWorkspaceOwner(workspaceId)` fails).

7. **Payload 7 — Invalid Column Type Enum Poisoning**:
   ```json
   {
     "workspaceId": "ws_1",
     "ownerId": "user_123",
     "name": "Malicious Script Column",
     "colType": "executable_script",
     "orderIndex": 1,
     "width": 160,
     "required": false,
     "formula": "",
     "optionsCsv": "",
     "createdAt": "SERVER_TIMESTAMP",
     "updatedAt": "SERVER_TIMESTAMP"
   }
   ```
   *Expected Result*: `PERMISSION_DENIED` (`colType` not in allowed enum list).

8. **Payload 8 — Immortal Field Mutation (`createdAt` or `ownerId` Tampering on Update)**:
   Updating `/workspaces/ws_1` with a modified `ownerId` or `createdAt`.
   *Expected Result*: `PERMISSION_DENIED` (`affectedKeys().hasOnly(...)` and immutability gates reject).

9. **Payload 9 — Forged Client Timestamp (Replay / Future Timestamp Attack)**:
   Creating a row where `createdAt` is `2099-01-01T00:00:00Z` instead of `request.time`.
   *Expected Result*: `PERMISSION_DENIED` (`data.createdAt == request.time` fails).

10. **Payload 10 — Cross-Tenant Row Injection (`workspaceId` Mismatch)**:
    Creating `/workspaces/ws_1/rows/row_1` with payload `"workspaceId": "ws_other"`.
    *Expected Result*: `PERMISSION_DENIED` (`incoming().workspaceId == workspaceId` fails).

11. **Payload 11 — Unauthorized Blanket List Query Scraping**:
    Listing `/workspaces/ws_1/rows` without filtering by `ownerId == request.auth.uid`.
    *Expected Result*: `PERMISSION_DENIED` (`allow list` checks `resource.data.ownerId == request.auth.uid`).

12. **Payload 12 — Value Poisoning on Row Update (`cells` Exceeding Key Count or Wrong Type)**:
    Updating `/workspaces/ws_1/rows/row_1` where `cells` is a string or has more than 60 keys.
    *Expected Result*: `PERMISSION_DENIED` (`data.cells is map && data.cells.keys().size() <= 60` fails).

---

## 3. Test Runner Reference

See `firestore.rules.test.ts` for the complete automated verification suite asserting `PERMISSION_DENIED` across all 12 adversarial payloads.
