/**
 * Phase 0 TDD Security Rules Test Suite for Gridiron Dynasty '92
 * Designed for @firebase/rules-unit-testing against firestore.rules.
 * Note: This file documents and verifies that all "Dirty Dozen" payloads
 * fail with PERMISSION_DENIED and legitimate owner device writes succeed.
 */
export interface DirtyDozenScenario {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'create' | 'update' | 'get' | 'list';
  actorUid: string | null;
  emailVerified: boolean;
  payload?: Record<string, unknown>;
  expectedOutcome: 'PERMISSION_DENIED';
}

export const validUserDoc = (uid: string) => ({
  uid,
  email: 'player@example.com',
  displayName: 'Coach 92',
  createdAt: 'REQUEST_TIME',
  updatedAt: 'REQUEST_TIME',
});

export const validCareerMap = () => ({
  teamId: 'BUF',
  season: 1,
  week: 1,
  phase: 'REGULAR',
  roster: [{ name: 'J. Kelly', pos: 'QB', ovr: 92 }],
  schedule: [{ week: 1, oppId: 'MIA', isHome: true, isBye: false, played: false }],
  standings: { BUF: { w: 0, l: 0, pf: 0, pa: 0 } },
});

export const validDeviceSaveDoc = (uid: string, deviceId = 'dev_abc123') => ({
  ownerUid: uid,
  deviceId,
  deviceLabel: 'Chrome Desktop',
  teamId: 'BUF',
  season: 1,
  week: 1,
  phase: 'REGULAR',
  rings: 0,
  careerData: validCareerMap(),
  createdAt: 'REQUEST_TIME',
  updatedAt: 'REQUEST_TIME',
});

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenScenario[] = [
  {
    id: 1,
    name: 'Identity Spoofing on User Create',
    collectionPath: '/users/victim_uid',
    operation: 'create',
    actorUid: 'attacker_uid',
    emailVerified: true,
    payload: validUserDoc('victim_uid'),
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Bypass',
    collectionPath: '/users/unverified_uid',
    operation: 'create',
    actorUid: 'unverified_uid',
    emailVerified: false,
    payload: validUserDoc('unverified_uid'),
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Orphaned Subcollection Write (Missing Parent User Doc)',
    collectionPath: '/users/orphan_uid/deviceSaves/dev_1234',
    operation: 'create',
    actorUid: 'orphan_uid',
    emailVerified: true,
    payload: validDeviceSaveDoc('orphan_uid', 'dev_1234'),
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cross-Owner Subcollection Hijack',
    collectionPath: '/users/victim_uid/deviceSaves/dev_1234',
    operation: 'create',
    actorUid: 'attacker_uid',
    emailVerified: true,
    payload: validDeviceSaveDoc('attacker_uid', 'dev_1234'),
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow / Ghost Field Injection on Create',
    collectionPath: '/users/owner_uid/deviceSaves/dev_1234',
    operation: 'create',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: {
      ...validDeviceSaveDoc('owner_uid', 'dev_1234'),
      isAdmin: true,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow / Ghost Field Injection on Update',
    collectionPath: '/users/owner_uid/deviceSaves/dev_1234',
    operation: 'update',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: {
      ...validDeviceSaveDoc('owner_uid', 'dev_1234'),
      ghostHack: 'injected',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Immutable Field Mutation (deviceId / createdAt)',
    collectionPath: '/users/owner_uid/deviceSaves/dev_1234',
    operation: 'update',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: {
      ...validDeviceSaveDoc('owner_uid', 'dev_other99'),
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Client Timestamp Forgery',
    collectionPath: '/users/owner_uid/deviceSaves/dev_1234',
    operation: 'create',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: {
      ...validDeviceSaveDoc('owner_uid', 'dev_1234'),
      updatedAt: 1700000000000,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'ID Poisoning / Oversized Device ID',
    collectionPath: `/users/owner_uid/deviceSaves/${'a'.repeat(200)}`,
    operation: 'create',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: validDeviceSaveDoc('owner_uid', 'a'.repeat(200)),
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Payload Type Poisoning (JSON String instead of Native Map)',
    collectionPath: '/users/owner_uid/deviceSaves/dev_1234',
    operation: 'create',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: {
      ...validDeviceSaveDoc('owner_uid', 'dev_1234'),
      careerData: '{"teamId":"BUF"}',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'PII Scraping via User List Query',
    collectionPath: '/users',
    operation: 'list',
    actorUid: 'attacker_uid',
    emailVerified: true,
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Metadata Desync / Invalid Phase State',
    collectionPath: '/users/owner_uid/deviceSaves/dev_1234',
    operation: 'create',
    actorUid: 'owner_uid',
    emailVerified: true,
    payload: {
      ...validDeviceSaveDoc('owner_uid', 'dev_1234'),
      phase: 'GODMODE',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
];
