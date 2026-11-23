# `src/App.jsx` Audit

Scope: `src/App.jsx` only. Firestore comparisons below use the checked-in
`firestore.rules`; live Firebase Console rules were not inspected. Findings are
ordered by severity. No source code was changed.

## Critical

None confirmed.

## High

| Severity | File:line | Problem | Fix |
|---|---|---|---|
| High | `src/App.jsx:3347-3433`; `firestore.rules:74-88,425-432` | Customer order item prices and `finalTotal` are assembled on the client and sent to Firestore. `validCustomerOrder()` checks that the total is numeric and within a ceiling, but does not calculate it from trusted menu prices. A modified client can therefore submit inconsistent prices/totals. | Move authoritative price lookup and total calculation to a trusted server/Cloud Function; keep rules as validation, not as the pricing authority. |

## Medium

| Severity | File:line | Problem | Fix |
|---|---|---|---|
| Medium | `src/App.jsx:3503`; `firestore.rules:484-490` | The table-booking availability check queries `bookings` by `date`, `time`, and `table`. The rules allow booking reads only for staff (`isStaff()`), so a signed-in customer query is denied; the catch then stops the booking with “Booking availability check nahi hui.” | Check availability through a trusted callable/transaction, or add an owner-scoped availability design. Do not grant customers unrestricted booking reads. |
| Medium | `src/App.jsx:7921-7928,8005,8071-8073`; `firestore.rules:463-472` | `fetchAllData()` queries all `loyaltyUsers` and `coinHistory` after `authReady`, without checking `staffRole`. Rules require staff for list queries and coin-history reads; customer sessions therefore generate permission-denied warnings. Admins then issue duplicate reads in the later staff-only effect. | Run these list queries only for authorized staff/admin roles; use the permitted per-customer `loyaltyUsers` document read for customer loyalty data. |
| Medium | `src/App.jsx:7635-7648`; `firestore.rules:4-15` | The auth listener sets `staffRole` from the staff document's role without checking `active`. Rules consider `active: false` non-staff, while the UI still enables staff-mode listeners/actions, which are then denied. | Check the staff document's active flag before setting the staff role or exposing staff UI. |
| Medium | `src/App.jsx:1597-1620,3003-3017,8108-8112` | Waiter submission disables the button while `isSubmitting`, but each submission attempt creates a fresh order ID. `placeOrder()` races the Firestore write against a 15-second timeout; the timeout does not cancel the write. If the write commits late and the waiter retries after the error, a second ID can create a duplicate order. | Use a stable idempotency key for the attempt and a create-only/transactional write; do not generate a new ID when retrying an outcome-unknown write. |
| Medium | `src/App.jsx:3018-3031` | `handleWaiterOrder` reads customer-cart `appliedDiscount`, `couponCode`, and `custPhone`, but its dependency list is only `[placeOrder]`. This can use stale customer state and record coupon usage against a waiter order even though the waiter form does not provide that coupon. | Remove this customer-cart side effect from waiter orders, or pass explicit waiter-order coupon data and include all reactive dependencies. |
| Medium | `src/App.jsx:865,2804,8010,8014,8042` | These Firestore listeners have success callbacks but no listener error callback. Permission/network failures do not produce an app-level error state; cleanup/unsubscribe is present. | Add the standard error callback and surface the failure to the relevant UI/logging path. |
| Medium | `src/App.jsx:7590-7593` | `setOrderOnce()` suppresses every `getDoc()` error and then performs a non-merge `setDoc()`. A transient read failure is treated as “document absent”; on a retry this could overwrite an existing order rather than preserve it. | Do not treat read failure as absence. Use a transaction/create-only write and propagate read/write errors. |

## Low

| Severity | File:line | Problem | Fix |
|---|---|---|---|
| Low | `src/App.jsx:7931-7932,7970,7975`; `src/App.jsx:4216,6713,6813` | Category and gallery data are assigned from Firestore without confirming they are arrays, then rendered with `.map()`. Malformed documents can cause a runtime crash. Menu and offers have stronger shape checks. | Validate `Array.isArray(data.categories)` and `Array.isArray(data.images)` before storing; retain defaults or show a data error otherwise. |
| Low | `src/App.jsx:7931-7933` | Per-document settings reads convert every error to `null`, making permission/network failures indistinguishable from missing documents. A missing menu/categories document can then trigger a default write (lines 7954-7970), whose failure is only logged. | Log/report read errors separately from `!snapshot.exists()` and only run migrations/default writes for authorized admins. |
| Low | `src/App.jsx:3020-3025` | Coupon-usage write failure is swallowed with `.catch(() => {})`; the order can succeed while usage/accounting data is absent with no diagnostic. | Log the failure and expose a non-blocking warning or retry mechanism. |
| Low | `src/App.jsx:2704-2720,2737-2744` | Customer loyalty and past-order reads swallow errors. A permission/network failure silently looks like no loyalty profile or no order history. | Log/report the failure separately from an empty result; preserve the existing state and show a small retry/error state. |
| Low | `src/App.jsx:7650-7654` | The staff-document error handler compares `fsErr.code` to the human-readable string `"Please contact to billing counter."`; Firebase permission errors use codes such as `permission-denied`, so the intended rules-specific message is unreachable. | Compare against the actual Firebase error code and keep the user-facing message separate. |
| Low | `src/App.jsx:32` | File-wide disables for `react-hooks/exhaustive-deps` and `no-unused-vars` weaken checks across this 8,000+ line component. The missing dependencies and dead declarations below are examples the lint setup cannot reliably flag. | Remove global suppressions; fix or narrowly suppress individual lines after the file is split or checked. |

## Dead code / unused declarations

These declarations have no other references in `src/App.jsx` (line numbers are
the declaration locations). Remove them after confirming no external tooling
depends on source names:

- `getSmartSuggestionPoolOld` (402), `useLocalStorageOld` (714).
- `processRazorpayPaymentLegacy` (931), `loadRazorpayScriptOld` (960),
  `processRazorpayPaymentOld` (968).
- `handlePrintKOTOld` (1640), `toggleFavoriteOld` (2883),
  `reorderOrderOld` (2925), `addRunningItemsPrev` (2965),
  `addRunningItemsOld` (2985), `handleWaiterOrderOld` (3033),
  `handleWaiterPinSubmitOld` (3085), `handleSendOtpOld` (3157),
  `handleVerifyOtpOld` (3219), `addComboToCartPrev` (3574),
  `addComboToCartOld` (3589), `addFlashSaleToCartOld` (3621).
- `handlePrintReceiptOld` (5088), `handleBillActionOld` (5187),
  `_revenueOld` (6340), `_avgOld` (6342), `_oldFlash` state (7708),
  `_oldCombos` state (7723), `advanceStatusOld` (8151).
- Disabled legacy blocks: `{false && ...}` at 5414 and 5561; legacy
  promotions block at 7081; disabled notification code at 7913; disabled
  default-menu write at 7990.
- `addRunningItemsOld` also contains unreachable statements after
  `return order` at 2998-2999.

No unused import was confirmed in this pass. The configured `no-unused-vars`
suppression means that conclusion is based on manual symbol searches rather
than a complete lint guarantee.

## Listener cleanup and hook/runtime checks

- No confirmed conditional-hook violation was found.
- No confirmed listener leak was found: the inspected `onSnapshot` effects
  return unsubscribe functions, including the listeners called out above.
- No confirmed `.toFixed()` crash was found; the only use is on geolocation
  coordinate values.
- The main customer checkout handler has a synchronous `submitLockRef` guard
  and reuses `pendingOrderIdRef`; the waiter flow has only the state-based
  button guard and the timeout/retry risk described above.

## Firestore query comparison summary

- Customer booking availability: **mismatch** — filtered `bookings` query at
  line 3503, but `bookings` reads are staff-only in the checked-in rules.
- Loyalty list and coin history: **role-gating mismatch** — unfiltered staff
  list queries are run for customer sessions; rules require staff.
- Customer order history: queries by `createdBy == auth.uid` and is consistent
  with the order read rule.
- Staff calls/bookings/orders listeners: their read rules require staff and
  the listeners are started only when `staffRole` is truthy; the inactive
  staff role-state mismatch is noted above.
- `settings/presets`: the hook is used by POS/bill screens, not by the public
  customer screen in this file; no customer-facing presets query mismatch was
  confirmed.

## Safe cleanup order

1. Move order price/total authority to a trusted backend and add idempotent
   order creation.
2. Fix booking availability without broadening customer booking reads.
3. Gate staff-only reads and verify staff `active` state before enabling staff
   mode.
4. Add listener error handling and stop suppressing Firestore read/write errors.
5. Add Firestore shape validation for arrays used by render paths.
6. Remove verified legacy declarations/disabled blocks; then narrow lint
   suppressions and split the component in separate, behavior-preserving work.
