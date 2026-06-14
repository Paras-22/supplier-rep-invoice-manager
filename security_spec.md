# Chapel Downs Supermarket - Security Specification & Access Control

This specification governs the database security policies for the Supplier Rep & Invoice Manager Firestore.

## 1. Safety & Data Invariants
All operations inside our Firestore must comply with the following invariants:
- **No Orphaned Records**: A price logging entry (`Price`) must reference an existing `productId` and `repId`.
- **Date Verification**: Invoice scanning records, price logs, and visit notes must enforce that `createdAt` matches the authoritative server timestamp `request.time`.
- **ID Safety**: Custom document identifiers (e.g., barcodes or custom rep keys) must be sanitized and tested against standard length and character filters.
- **Verification Integrity**: Only verified email accounts (if Google Auth flags are enabled) of the authenticated staff domain are allowed write privileges.

---

## 2. Access Tiers
Since this is an internally accessed supermarket staff tool, we enforce a unified **Staff Role** base:
- **Authenticated Staff**: Any user signed in via verified Google/Workspace authentication possesses read and write access.
- **Identity Verification**: Writing requires a verified email session.

---

## 3. The "Dirty Dozen" Security Violations (TDD Payloads)
The security rules are strictly compiled and hardened to block the following 12 common visual or data injection exploits:

1. **Spoofed Ownership**: Attempt to create a Price history block setting `createdBy` to a different user's UID.
2. **Backdated Timestamps**: Write high-impact pricing logs using a client-side timestamp in `createdAt` to falsify effective dates.
3. **Privilege Escalation**: Attempt to create or modify a document inside `/products/` with unauthorized administrative properties (e.g., setting custom auth flags).
4. **ID Poisoning / Denial-of-Wallet**: Write an item using a 2MB garbage-character string as the Document ID to cause storage size inflation.
5. **Orphaned Price Logs**: Write a Price document with non-existent or blank referenced product and rep IDs.
6. **State Shortcutting on Invoices**: Skip the `"pending_review"` state on a docket upload by directly saving it as `"confirmed"` before review has been recorded.
7. **Phantom Fields Injection**: Insert extraneous metadata keys (e.g., `{ isHack: true }`) into a Product schema to trigger downstream crash states.
8. **Negative Price Values**: Attempting to set pre-tax wholesale product price to a zero or negative decimal number.
9. **Null/Missing Barcode IDs**: Forcing products to save with critical identifier fields missing.
10. **Unauthenticated Read Scraping**: Attempting to fetch the rep directory list without sending authorization tokens.
11. **Stale Visit Notes Modification**: Modifying historic visit logs created by other staff members beyond permitted timelines.
12. **Double-Order Spawning**: Submitting multiple conflicting order records utilizing duplicate draft keys.

---

## 4. Security Rules Implementation Design
A central `firestore.rules` file enforces strict validation functions (`isValidProduct`, `isValidRep`, `isValidPrice`, etc.) to intercept any malformed payload matching these 12 cases. Users must pass authentication criteria, type-safety, boundaries (such as name length, non-negative numbers), and temporal integrity.
