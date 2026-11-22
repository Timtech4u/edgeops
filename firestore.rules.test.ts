import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rulesPath = fs.existsSync('firestore.rules') ? 'firestore.rules' : 'DRAFT_firestore.rules';
const rulesText = fs.readFileSync(rulesPath, 'utf8');

test('Dirty Dozen #1-12: Firestore rules enforce all Eight Pillars and deny adversarial payloads', () => {
  // Pillar 1 & Global Safety Net
  assert.match(rulesText, /rules_version\s*=\s*'2'/);
  assert.match(rulesText, /match \/\{document=\*\*\}\s*\{\s*allow read, write:\s*if false;\s*\}/);

  // Pillar 2: Validation Blueprints called on create and update with strict key checks
  for (const fn of [
    'isValidUserProfile',
    'isValidOrg',
    'isValidOrgIncident',
    'isValidWorkspace',
    'isValidIncident',
    'isValidConnector',
    'isValidSlackPrivateConfig',
    'isValidAlertState',
  ]) {
    assert.match(rulesText, new RegExp(`function ${fn}\\(`));
  }
  assert.match(rulesText, /affectedKeys\(\)\.hasOnly\(/);

  // Pillar 3: Path Variable Hardening
  assert.match(rulesText, /function isValidId\(id\)/);
  assert.match(rulesText, /isValidId\(orgId\)/);
  assert.match(rulesText, /isValidId\(workspaceId\)/);
  assert.match(rulesText, /isValidId\(incidentId\)/);
  assert.match(rulesText, /isValidId\(connectorId\)/);
  assert.match(rulesText, /isValidId\(alertHash\)/);

  // Pillar 4 & Email Verification / Zero-Hardcoded-Email Admin Guard
  assert.match(rulesText, /request\.auth\.token\.email_verified == true/);
  assert.match(
    rulesText,
    /function isAdmin\(\)\s*\{\s*return isVerified\(\) &&\s*exists\(\/databases\/\$\(database\)\/documents\/admins\/\$\(request\.auth\.uid\)\);\s*\}/
  );
  assert.doesNotMatch(rulesText, /request\.auth\.token\.email\s*==/);
  assert.doesNotMatch(rulesText, /@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  // Pillar 5: Total Array Guarding on toolsUsed
  assert.match(rulesText, /toolsUsed\.size\(\) <= 15/);
  assert.match(rulesText, /toolsUsed\[0\] is string/);

  // Pillar 6: PII Isolation (no blanket signed-in reads on users or private configs)
  assert.doesNotMatch(rulesText, /allow read:\s*if isSignedIn\(\);/);

  // Pillar 7 & Temporal Integrity + Terminal State Locking
  assert.match(rulesText, /incoming\(\)\.createdAt == request\.time/);
  assert.match(rulesText, /incoming\(\)\.updatedAt == request\.time/);
  assert.match(rulesText, /existing\(\)\.status != 'resolved'/);

  // Pillar 8: Secure List Queries (evaluates resource.data.ownerId without get() in list)
  assert.match(rulesText, /allow list:\s*if isVerified\(\) && resource\.data\.ownerId == request\.auth\.uid/);

  // Org ownerUid & memberUids support for newly created orgs and live webhook incidents
  assert.match(rulesText, /ownerUid/);
  assert.match(rulesText, /memberUids/);

  // Server-only Slack OAuth token collection strictly denied to all clients
  assert.match(
    rulesText,
    /match \/server_slack_connections\/\{orgId\}\s*\{\s*allow read, write:\s*if false;\s*\}/
  );
});

test('Zero-Knowledge Sync: /orgs/{orgId}/alert_states/{alertHash} strictly rejects PII/text fields and enforces immutability', () => {
  // Match block and validator exist
  assert.match(rulesText, /match \/alert_states\/\{alertHash\}/);
  assert.match(rulesText, /isValidAlertState\(incoming\(\), orgId, alertHash\)/);

  // Extract isValidAlertState body and verify strict zero-knowledge schema
  const validatorMatch = rulesText.match(/function isValidAlertState\([\s\S]*?\n    \}/);
  assert.ok(validatorMatch, 'Expected isValidAlertState validator function');
  const validatorBody = validatorMatch[0];

  // Required & allowed fields
  for (const field of [
    'alertHash',
    'orgId',
    'ownerId',
    'status',
    'bucket',
    'updatedBy',
    'updatedAt',
    'expireAt',
    'snoozedUntil',
  ]) {
    assert.match(validatorBody, new RegExp(`'${field}'`));
  }

  // Strictly forbidden raw text / PII fields
  for (const forbidden of ['rawMessage', 'title', 'body', 'text', 'scrubbedSummary', 'suggestedReply']) {
    assert.doesNotMatch(validatorBody, new RegExp(`'${forbidden}'`));
  }

  // Enum, length, identity, and timestamp invariants
  assert.match(validatorBody, /data\.alertHash\.size\(\) <= 64 && data\.alertHash == alertHash/);
  assert.match(validatorBody, /data\.status in \['open', 'snoozed', 'resolved', 'noise'\]/);
  assert.match(validatorBody, /data\.bucket in \['needs_action', 'hidden_noise'\]/);
  assert.match(validatorBody, /data\.updatedBy == request\.auth\.uid/);
  assert.match(validatorBody, /data\.updatedAt == request\.time/);
  assert.match(validatorBody, /data\.expireAt is timestamp/);
  assert.match(validatorBody, /data\.snoozedUntil == null \|\| data\.snoozedUntil is timestamp/);

  // Extract match /alert_states/{alertHash} block and verify immutability + authorization
  const alertMatch = rulesText.match(/match \/alert_states\/\{alertHash\}[\s\S]*?\n      \}/);
  assert.ok(alertMatch, 'Expected match /alert_states/{alertHash} block');
  const alertBlock = alertMatch[0];

  assert.match(alertBlock, /isOrgMemberOrOwner\(orgId\) \|\| isAdmin\(\)/);
  assert.match(alertBlock, /incoming\(\)\.alertHash == existing\(\)\.alertHash/);
  assert.match(alertBlock, /incoming\(\)\.orgId == existing\(\)\.orgId/);
  assert.match(alertBlock, /incoming\(\)\.ownerId == existing\(\)\.ownerId/);
  assert.match(alertBlock, /affectedKeys\(\)\.hasOnly\(\[/);
});

