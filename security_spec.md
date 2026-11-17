# Security Specification: Gridiron Dynasty '92 Cloud Save

## Phase 0: Data Invariants & Threat Model

### 1. Core Data Invariants
1. **Master Gate & Ownership**: A `DeviceDynastySave` document at `/users/{userId}/deviceSaves/{deviceId}` CANNOT exist without a verified parent `UserProfile` document at `/users/{userId}` whose `uid` equals `request.auth.uid`.
2. **Verified Identity & Anti-Spoofing**: All reads and writes require `request.auth != null`, `request.auth.uid == userId`, and `request.auth.token.email_verified == true`.
3. **Device Isolation**: Every `DeviceDynastySave` must bind `ownerUid == request.auth.uid` and `deviceId == deviceId` (matching `^[a-zA-Z0-9_\-]+$`, length 4–128). Neither `ownerUid`, `deviceId`, nor `createdAt` may ever change after creation.
4. **PII Isolation**: User `email` and `displayName` live strictly inside `/users/{userId}` and are readable only by `isOwner(userId)` (`get` only—no `list` allowed on `/users`).
5. **No JSON Strings / Native Schema Integrity**: `careerData` MUST be a native Firestore `map` containing valid core franchise keys (`teamId`, `season`, `week`, `phase`, `roster`, `schedule`, `standings`) matching top-level metadata (`teamId`, `season`, `week`, `phase`).
6. **Temporal Integrity**: `createdAt == request.time` on `create`; `updatedAt == request.time` on both `create` and `update`; `createdAt` is immutable on `update`.
7. **No Unprotected Collections & No Arbitrary List Queries**: Default-deny catch-all at top; `/users` explicitly blocks `list`; `/users/{userId}/deviceSaves` enforces `resource.data.ownerUid == request.auth.uid` on `list`.

---

### 2. The "Dirty Dozen" Adversarial Payloads

1. **Identity Spoofing on User Create**: Unverified user or attacker tries creating `/users/victim_uid` with `uid: "victim_uid"`.
2. **Unverified Email Bypass**: Authenticated user with `email_verified: false` tries creating `/users/{uid}` or saving a dynasty.
3. **Orphaned Subcollection Write (Master Gate Bypass)**: User writes `/users/{uid}/deviceSaves/dev_123` before `/users/{uid}` exists.
4. **Cross-Owner Subcollection Hijack**: Attacker (`attacker_uid`) writes `/users/victim_uid/deviceSaves/dev_123` with `ownerUid: "attacker_uid"`.
5. **Shadow / Ghost Field Injection (Create)**: Owner includes undeclared field `isAdmin: true` or `freeCoins: 99999` inside `DeviceDynastySave`.
6. **Shadow / Ghost Field Injection (Update)**: Owner updates `DeviceDynastySave` adding undeclared `extraPrivilege: true`.
7. **Immutable Field Mutation (`ownerUid` / `deviceId` / `createdAt`)**: Owner tries changing `deviceId` or backdating `createdAt` during an update.
8. **Client Timestamp Forgery**: Owner sends a hardcoded numeric/past `updatedAt` instead of `request.time`.
9. **ID Poisoning / Path Exhaustion**: Attacker passes a 300-character or invalid-character `deviceId` (e.g., `dev/../admin` or `'a'.repeat(300)`).
10. **Payload Type / Size Poisoning (`careerData` as string or oversized array)**: Client tries passing `careerData` as a stringified JSON blob (`"{...}"`) instead of a native Firestore `map`, or injects `> 80` roster entries.
11. **PII Scraping via User List Query**: Signed-in non-owner queries `list` on `/users` to harvest player emails.
12. **Metadata Desync / Invalid Phase State**: Client sends `phase: "GODMODE"` or `careerData.teamId != teamId` to corrupt franchise integrity.
