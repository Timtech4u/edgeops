# EdgeOps Firestore Security Specification

## 1. Data Invariants
1. **Identity Ownership & Admin Registry**: Every `UserProfile` (`/users/{userId}`) can only be read or written by `request.auth.uid == userId` with a verified email (`request.auth.token.email_verified == true`). Admin privileges are derived exclusively from `isVerified() && exists(/databases/$(database)/documents/admins/$(request.auth.uid))` — zero hardcoded personal emails exist in `firestore.rules`.
2. **Server-Only Slack Secrets**: `/server_slack_connections/{orgId}` stores KMS-wrapped Slack OAuth credentials and is strictly denied (`allow read, write: if false`) to all browser/mobile client SDKs.
3. **Org & Workspace Master Gate**: Every `Incident`, `Connector`, `SlackPrivateConfig`, and `AlertState` under `/orgs/{orgId}/...` or `/workspaces/{workspaceId}/...` requires the parent document to exist and validates membership/ownership against the parent document.
4. **Zero-Knowledge Alert State Sync (`/orgs/{orgId}/alert_states/{alertHash}`)**: Blind HMAC-SHA256 alert hashes (`<= 64` chars) sync strictly bounded state metadata (`alertHash`, `orgId`, `ownerId`, `status` in `['open', 'snoozed', 'resolved', 'noise']`, `bucket` in `['needs_action', 'hidden_noise']`, `updatedBy == request.auth.uid`, `updatedAt == request.time`, optional `expireAt` timestamp, optional `snoozedUntil` timestamp or null). Raw PII, `text`, `title`, `body`, and `rawMessage` fields are strictly forbidden.
5. **Immutable Ownership & Creation Time**: `ownerId`, `orgId`, `alertHash`, `workspaceId`, `incidentId`, `connectorId`, and `createdAt` can never be mutated after creation.
6. **Strict Temporal Integrity**: `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
7. **Terminal State Locking**: Once an `Incident` reaches `status == 'resolved'`, non-admin clients cannot mutate its fields.
8. **PII Isolation & Zero Shadow Fields**: Every write validates exact required and allowed keys (`hasAll` + `hasOnly` in domain validators called on both create and update; `affectedKeys().hasOnly(...)` on update) and enforces explicit `.size()` caps on every string and array (`toolsUsed.size() <= 15`).
9. **Secure List Queries**: Organization/workspace `allow list` rules check `resource.data.ownerId == request.auth.uid`, and `/orgs/{orgId}/alert_states` restricts `list` to verified org members/owners or registered admins scoped to the explicit parent `{orgId}`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Shadow Field / PII Injection on Alert State or Incident Write**: Adding `rawMessage`, `text`, `title`, `body`, `isVerified: true`, or `isAdmin: true` to `/orgs/{orgId}/alert_states/{alertHash}` or incident writes.
2. **Owner Spoofing on Create**: Creating `/workspaces/ws_evil` or `/orgs/org_a/alert_states/{hash}` with `ownerId: "victim_uid"` or `updatedBy: "victim_uid"` while authenticated as `attacker_uid`.
3. **ID Poisoning**: Creating a document with a 200-character ID, an `alertHash` exceeding 64 characters, or a slash/symbol-polluted ID (`../admin`).
4. **Unverified Email Write**: Attempting any create/update when `request.auth.token.email_verified == false`.
5. **Admin Privilege Escalation**: Attempting to self-register in `/admins/{uid}`, claim admin privileges via an unverified email, or rely on any hardcoded email bypass.
6. **Cross-Tenant Read/Write**: Authenticated user B calling `get`, `list`, or `update` on user A's `/orgs/org_a/alert_states/{hash}` or `/workspaces/ws_a/incidents/inc_1`.
7. **Server-Only Slack Secret Read/Write**: Any authenticated client attempting to read or write `/server_slack_connections/{orgId}`.
8. **Orphaned Subcollection Create**: Creating `/orgs/nonexistent_org/alert_states/{hash}` or `/workspaces/nonexistent_ws/incidents/inc_1` where the parent document does not exist.
9. **Terminal State Re-Open Bypass**: Non-admin attempting to update an incident whose existing `status` is `'resolved'`.
10. **Value Poisoning & Immutability Bypass on Update**: Updating `status`/`bucket` to an invalid value or mutating immutable `alertHash`, `orgId`, or `ownerId`.
11. **Array Exhaustion Attack**: Writing `toolsUsed` with 50 items (> 15 cap) or non-string first element `[123]`.
12. **Client Timestamp Forgery**: Creating or updating a document with a forged past/future `createdAt` or `updatedAt` instead of `request.time`.
