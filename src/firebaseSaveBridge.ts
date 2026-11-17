import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();

const CLOUD_SAVE_ID = 'activeCareer';
const LEGACY_DEVICE_ID_KEY = 'gd92_device_id';
const LOCAL_SAVE_KEY = 'gd92_local_career_save';

const ALLOWED_CAREER_KEYS = new Set<string>([
  'activeFacilityKeys',
  'byeWeeks',
  'capLimit',
  'cc',
  'draftClass',
  'draftState',
  'facilities',
  'freeAgents',
  'leagueRosters',
  'phase',
  'playoffs',
  'retiredLegends',
  'rings',
  'roster',
  'schedule',
  'season',
  'seasonDrillsUsed',
  'seasonHistory',
  'standings',
  'teamId',
  'week',
  'weekGames',
]);

type ValidPhase = 'REGULAR' | 'PLAYOFFS' | 'OFFSEASON';

interface CareerLike {
  teamId?: unknown;
  season?: unknown;
  week?: unknown;
  phase?: unknown;
  rings?: unknown;
  roster?: unknown;
  schedule?: unknown;
  standings?: unknown;
  [key: string]: unknown;
}

interface CloudSaveBridge {
  ready: boolean;
  authReady: boolean;
  userId: string | null;
  deviceId: string;
  userEmail: string | null;
  displayName: string | null;
  cachedSave: CareerLike | null;
  signInWithGoogle: () => Promise<boolean>;
  signOutCloud: () => Promise<void>;
  saveCareerCloud: (careerObj: CareerLike) => Promise<boolean>;
  loadCareerCloud: () => Promise<CareerLike | null>;
}

declare global {
  interface Window {
    __cloudSaveBridge?: CloudSaveBridge;
  }
}

function getLegacyDeviceId(): string | null {
  try {
    const existing = window.localStorage.getItem(LEGACY_DEVICE_ID_KEY);
    if (existing && /^[a-zA-Z0-9_\-]{4,128}$/.test(existing)) {
      return existing;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function getDeviceLabel(): string {
  try {
    const ua = navigator.userAgent || '';
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
    const platform = (navigator.platform || '').trim();
    const label = `${isMobile ? 'Mobile' : 'Desktop'}${platform ? ` (${platform})` : ''}`;
    return label.slice(0, 80) || 'Web Device';
  } catch {
    return 'Web Device';
  }
}

function readLocalSave(): CareerLike | null {
  try {
    const direct = window.localStorage.getItem(LOCAL_SAVE_KEY);
    if (direct) {
      const parsed = JSON.parse(direct) as CareerLike;
      if (parsed && typeof parsed === 'object' && typeof parsed.teamId === 'string') {
        return parsed;
      }
    }
    const legacyId = getLegacyDeviceId();
    if (legacyId) {
      const legacyRaw = window.localStorage.getItem(`gd92_device_save_${legacyId}`);
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw) as CareerLike;
        if (parsed && typeof parsed === 'object' && typeof parsed.teamId === 'string') {
          return parsed;
        }
      }
    }
  } catch {
    // Ignore storage/parse errors
  }
  return null;
}

function writeLocalSave(careerObj: CareerLike): boolean {
  try {
    window.localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify(careerObj));
    return true;
  } catch {
    return false;
  }
}

function stripUndefinedDeep(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out;
  }
  return null;
}

function normalizeCareerPayload(rawCareer: CareerLike): {
  teamId: string;
  season: number;
  week: number;
  phase: ValidPhase;
  rings: number;
  careerData: Record<string, unknown>;
} {
  const rawTeam = String(rawCareer.teamId || 'BUF')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5);
  const teamId = rawTeam.length >= 2 ? rawTeam : 'BUF';

  const season = Math.max(1, Math.min(999, Math.trunc(Number(rawCareer.season) || 1)));
  const week = Math.max(1, Math.min(30, Math.trunc(Number(rawCareer.week) || 1)));

  const rawPhase = String(rawCareer.phase || 'REGULAR');
  const phase: ValidPhase =
    rawPhase === 'PLAYOFFS' || rawPhase === 'OFFSEASON' ? rawPhase : 'REGULAR';

  const rings = Math.max(0, Math.min(999, Math.trunc(Number(rawCareer.rings) || 0)));

  const careerData: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rawCareer)) {
    if (ALLOWED_CAREER_KEYS.has(key) && val !== undefined) {
      careerData[key] = stripUndefinedDeep(val);
    }
  }

  careerData.teamId = teamId;
  careerData.season = season;
  careerData.week = week;
  careerData.phase = phase;
  careerData.rings = rings;

  const roster = Array.isArray(careerData.roster)
    ? careerData.roster.slice(0, 80)
    : [];
  if (roster.length === 0) {
    roster.push({ name: 'QB #12', pos: 'QB', ovr: 75 });
  }
  careerData.roster = roster;

  const schedule = Array.isArray(careerData.schedule)
    ? careerData.schedule.slice(0, 30)
    : [];
  if (schedule.length === 0) {
    schedule.push({ week: 1, oppId: null, isHome: true, isBye: true, played: false });
  }
  careerData.schedule = schedule;

  if (!careerData.standings || typeof careerData.standings !== 'object' || Array.isArray(careerData.standings)) {
    careerData.standings = {};
  }

  return {
    teamId,
    season,
    week,
    phase,
    rings,
    careerData,
  };
}

function getSafeUserFields(user: User): {
  uid: string;
  email: string;
  displayName: string;
} {
  const emailRaw = (user.email || `${user.uid}@users.local`).trim();
  const email = (emailRaw.length >= 3 ? emailRaw : `${user.uid}@users.local`).slice(0, 254);
  const nameRaw = (user.displayName || email.split('@')[0] || 'Coach 92').trim();
  const displayName = (nameRaw.length >= 1 ? nameRaw : 'Coach 92').slice(0, 100);
  return { uid: user.uid, email, displayName };
}

async function ensureUserProfile(user: User): Promise<void> {
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  const { uid, email, displayName } = getSafeUserFields(user);

  let existingSnap;
  try {
    existingSnap = await getDoc(userRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userPath);
  }

  if (!existingSnap.exists()) {
    try {
      await setDoc(userRef, {
        uid,
        email,
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, userPath);
    }
  } else {
    try {
      await updateDoc(userRef, {
        email,
        displayName,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, userPath);
    }
  }
}

const deviceLabel = getDeviceLabel();
let activeSnapshotUnsub: Unsubscribe | null = null;
let cloudSyncStatusText = '';

function renderCloudBarUI(): void {
  const bridge = window.__cloudSaveBridge;
  const statusEl = document.getElementById('cloud-save-status-text');
  const signInBtn = document.getElementById('btn-cloud-google-signin');
  const signOutBtn = document.getElementById('btn-cloud-google-signout');

  if (!bridge) return;

  if (statusEl) {
    if (bridge.userId) {
      const who = bridge.displayName || bridge.userEmail || bridge.userId.slice(0, 8);
      statusEl.textContent = `CROSS-DEVICE CLOUD SAVE ACTIVE • COACH: ${who}${cloudSyncStatusText ? ` (${cloudSyncStatusText})` : ''}`;
      statusEl.className = 'text-[10px] sm:text-xs text-emerald-300';
    } else if (!bridge.authReady) {
      statusEl.textContent = 'CHECKING CLOUD SESSION...';
      statusEl.className = 'text-[10px] sm:text-xs text-slate-300';
    } else {
      const hasLocal = Boolean(bridge.cachedSave && bridge.cachedSave.teamId);
      statusEl.textContent = hasLocal
        ? 'SAVED LOCALLY ON THIS BROWSER • SIGN IN WITH GOOGLE FOR CROSS-DEVICE CLOUD SAVE'
        : 'SIGN IN WITH GOOGLE TO SAVE & PLAY ACROSS ANY DEVICE';
      statusEl.className = 'text-[10px] sm:text-xs text-amber-300';
    }
  }

  if (signInBtn) {
    signInBtn.classList.toggle('hidden', Boolean(bridge.userId));
  }
  if (signOutBtn) {
    signOutBtn.classList.toggle('hidden', !bridge.userId);
  }
}

async function saveCareerCloudImpl(careerObj: CareerLike): Promise<boolean> {
  if (!careerObj || typeof careerObj !== 'object') return false;

  const cleanLocal = stripUndefinedDeep(careerObj) as CareerLike;
  window.__cloudSaveBridge!.cachedSave = cleanLocal;
  writeLocalSave(cleanLocal);

  const user = auth.currentUser;
  if (!user || !user.emailVerified) {
    renderCloudBarUI();
    return false;
  }

  await ensureUserProfile(user);

  const normalized = normalizeCareerPayload(cleanLocal);
  const savePath = `users/${user.uid}/deviceSaves/${CLOUD_SAVE_ID}`;
  const saveRef = doc(db, 'users', user.uid, 'deviceSaves', CLOUD_SAVE_ID);

  let existingSave;
  try {
    existingSave = await getDoc(saveRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, savePath);
  }

  if (!existingSave.exists()) {
    try {
      await setDoc(saveRef, {
        ownerUid: user.uid,
        deviceId: CLOUD_SAVE_ID,
        deviceLabel,
        teamId: normalized.teamId,
        season: normalized.season,
        week: normalized.week,
        phase: normalized.phase,
        rings: normalized.rings,
        careerData: normalized.careerData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, savePath);
    }
  } else {
    try {
      await updateDoc(saveRef, {
        deviceLabel,
        teamId: normalized.teamId,
        season: normalized.season,
        week: normalized.week,
        phase: normalized.phase,
        rings: normalized.rings,
        careerData: normalized.careerData,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, savePath);
    }
  }

  cloudSyncStatusText = 'SYNCED';
  renderCloudBarUI();
  return true;
}

async function loadCareerCloudImpl(): Promise<CareerLike | null> {
  const user = auth.currentUser;
  if (user && user.emailVerified) {
    const savePath = `users/${user.uid}/deviceSaves/${CLOUD_SAVE_ID}`;
    const saveRef = doc(db, 'users', user.uid, 'deviceSaves', CLOUD_SAVE_ID);
    try {
      const snap = await getDoc(saveRef);
      if (snap.exists()) {
        const data = snap.data();
        if (data && data.ownerUid === user.uid && data.careerData && typeof data.careerData === 'object') {
          const careerCopy = JSON.parse(JSON.stringify(data.careerData)) as CareerLike;
          window.__cloudSaveBridge!.cachedSave = careerCopy;
          writeLocalSave(careerCopy);
          cloudSyncStatusText = 'SYNCED';
          renderCloudBarUI();
          return careerCopy;
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, savePath);
    }

    // Fallback: migrate from an earlier per-device cloud slot on first cross-device login if activeCareer is empty
    const legacyId = getLegacyDeviceId();
    if (legacyId) {
      const legacyPath = `users/${user.uid}/deviceSaves/${legacyId}`;
      try {
        const legacySnap = await getDoc(doc(db, 'users', user.uid, 'deviceSaves', legacyId));
        if (legacySnap.exists()) {
          const legacyData = legacySnap.data();
          if (legacyData && legacyData.careerData && typeof legacyData.careerData === 'object') {
            const careerCopy = JSON.parse(JSON.stringify(legacyData.careerData)) as CareerLike;
            await saveCareerCloudImpl(careerCopy);
            return careerCopy;
          }
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, legacyPath);
      }
    }
  }

  const localSave = readLocalSave();
  if (localSave) {
    window.__cloudSaveBridge!.cachedSave = localSave;
    return JSON.parse(JSON.stringify(localSave)) as CareerLike;
  }
  return null;
}

const initialLocalSave = readLocalSave();

window.__cloudSaveBridge = {
  ready: true,
  authReady: false,
  userId: null,
  deviceId: CLOUD_SAVE_ID,
  userEmail: null,
  displayName: null,
  cachedSave: initialLocalSave,
  signInWithGoogle: async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
      return true;
    } catch (err: unknown) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        console.error('Google Sign-In failed:', err);
      }
      return false;
    }
  },
  signOutCloud: async () => {
    if (activeSnapshotUnsub) {
      activeSnapshotUnsub();
      activeSnapshotUnsub = null;
    }
    await signOut(auth);
  },
  saveCareerCloud: saveCareerCloudImpl,
  loadCareerCloud: loadCareerCloudImpl,
};

onAuthStateChanged(auth, async (user) => {
  if (activeSnapshotUnsub) {
    activeSnapshotUnsub();
    activeSnapshotUnsub = null;
  }

  const bridge = window.__cloudSaveBridge!;
  bridge.authReady = true;

  if (user && user.emailVerified) {
    bridge.userId = user.uid;
    bridge.userEmail = user.email;
    bridge.displayName = user.displayName || user.email;
    cloudSyncStatusText = 'CONNECTING...';
    renderCloudBarUI();

    try {
      await ensureUserProfile(user);
      const savePath = `users/${user.uid}/deviceSaves/${CLOUD_SAVE_ID}`;
      const saveRef = doc(db, 'users', user.uid, 'deviceSaves', CLOUD_SAVE_ID);

      // Cloud-first rule: if activeCareer already exists in Firestore, NEVER overwrite it with a local save.
      // Only migrate a legacy per-device save or local pre-login save when activeCareer is empty.
      const existingCloudSnap = await getDoc(saveRef);
      if (existingCloudSnap.exists()) {
        const existingData = existingCloudSnap.data();
        if (existingData && existingData.careerData && typeof existingData.careerData === 'object') {
          const careerCopy = JSON.parse(JSON.stringify(existingData.careerData)) as CareerLike;
          bridge.cachedSave = careerCopy;
          writeLocalSave(careerCopy);
        }
      } else {
        let seedCareer: CareerLike | null = null;
        const legacyId = getLegacyDeviceId();
        if (legacyId) {
          const legacySnap = await getDoc(doc(db, 'users', user.uid, 'deviceSaves', legacyId));
          if (legacySnap.exists()) {
            const legacyData = legacySnap.data();
            if (legacyData && legacyData.careerData && typeof legacyData.careerData === 'object') {
              seedCareer = JSON.parse(JSON.stringify(legacyData.careerData)) as CareerLike;
            }
          }
        }
        if (!seedCareer) {
          seedCareer = readLocalSave();
        }
        if (seedCareer && seedCareer.teamId) {
          await saveCareerCloudImpl(seedCareer);
        }
      }

      activeSnapshotUnsub = onSnapshot(
        saveRef,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            if (data && data.careerData && typeof data.careerData === 'object') {
              const careerCopy = JSON.parse(JSON.stringify(data.careerData)) as CareerLike;
              bridge.cachedSave = careerCopy;
              writeLocalSave(careerCopy);
              cloudSyncStatusText = 'SYNCED';
              renderCloudBarUI();
            }
          } else {
            cloudSyncStatusText = 'READY';
            renderCloudBarUI();
          }
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, savePath);
        }
      );
    } catch (err) {
      console.error('Cloud profile/save sync error:', err);
      cloudSyncStatusText = 'SYNC ERROR';
      renderCloudBarUI();
    }
  } else {
    bridge.userId = null;
    bridge.userEmail = null;
    bridge.displayName = null;
    bridge.cachedSave = readLocalSave();
    cloudSyncStatusText = '';
    renderCloudBarUI();
  }
});

function wireCloudButtons(): void {
  const signInBtn = document.getElementById('btn-cloud-google-signin') as HTMLButtonElement | null;
  const signOutBtn = document.getElementById('btn-cloud-google-signout') as HTMLButtonElement | null;

  if (signInBtn) {
    signInBtn.addEventListener('click', async () => {
      signInBtn.disabled = true;
      const orig = signInBtn.textContent;
      signInBtn.textContent = 'SIGNING IN...';
      try {
        await window.__cloudSaveBridge?.signInWithGoogle();
      } finally {
        signInBtn.disabled = false;
        signInBtn.textContent = orig || 'SIGN IN WITH GOOGLE (CLOUD SAVE)';
      }
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      await window.__cloudSaveBridge?.signOutCloud();
    });
  }

  renderCloudBarUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCloudButtons);
} else {
  wireCloudButtons();
}
