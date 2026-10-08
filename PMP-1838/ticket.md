# PMP-1838 — Add a Preferences screen with a local "Do not claim or lock encounters" option

Local copy of https://9amhealth.atlassian.net/browse/PMP-1838
Captured 2026-10-08 with `tik export PMP-1838`.

## Fields

| Field | Value |
|---|---|
| Key | PMP-1838 (issue id `59292`) |
| Summary | Add a Preferences screen with a local "Do not claim or lock encounters" option |
| Type | Task |
| Status | Explorative & Review (category: In Progress) |
| Priority | Medium |
| Assignee | Brendan Mullins |
| Reporter | Brendan Mullins |
| Creator | Brendan Mullins |
| Story points | — |
| Labels | — |
| Team | Mission - Zendesk migration |
| Epic / Parent | — |
| Sprint | — |
| Created | 2026-10-08T10:02:57.851+0200 |
| Updated | 2026-10-08T15:31:13.193+0200 |
| Due | — |
| Resolution | — |
| Resolved | — |

### Links

| Relation | Key | Summary | Status |
|---|---|---|---|
| relates to | PMP-1732 | Assigning Encounters -> Lock Encounters | Released |
| relates to | PMP-1781 | Two CCS working in the same encounter when first CCS leaves encounters and goes to full profile of the member | Released |

### Available transitions

Won't Fix, Backlog, Ready for refinement, Refined, Explorative & Review, Ready for Merge, Verification, Ready for Release, In Progress, Pick me, Duplicate, Verified, Reopen, Ready for QA, Done & no release needed

## Description

### Summary

Add a very simple **Preferences** screen to the PMP, opened from the account popover (profile popup card) in the main navigation (`MainNavigation.tsx`, `AccountPopover`).

The screen has two parts:

1. **Me** — the basic, read-only info about the logged-in staff user and their profile (name, avatar, email, current role, other info already available in `UserCubit`).
2. **Preferences** — per-browser settings, persisted only in `localStorage` for now. Treat them as **local feature flags**: a small typed set of known keys with defaults, readable from anywhere in the app.

### First (and only) preference: "Do not claim or lock encounters"

- Default: **off**.
- Shows a clear warning: turning it on breaks functionality required for working in encounters (no working claim → colleagues are not kept out, and actions that rely on holding the claim will not work).
- When **on**, the PMP must **never** automatically claim, lock or renew a lock on an encounter.

### Centralized check

The check must live in one place that every claim path goes through, so no current or future path can bypass it. Today the claim is acquired via `CaseLockAdminControllerService.adminAcquireCaseLock` in three places:

- `EncounterDetailCubit.claimLockIfUnheld` (claim on open)
- `EncounterDetailCubit` renewal of our own claim
- `encounterLockKeeper.renew` (`src/lib/encounterLockKeeper.ts`, keeps the claim after the workspace closes — PMP-1781)

Route all of these through a single helper that consults the preference and no-ops when it is enabled, rather than adding the check at each call site.

### Notes

- `FeatureFlagsCubit` already has an unused `localFlags` field — reuse/extend it for the local flags if it fits, instead of building a parallel mechanism.

### Out of scope

- Persisting preferences on the backend.
- Any further preferences beyond the one above.

## Acceptance Criteria

- [ ] The account popover in the main navigation has an entry that opens a Preferences screen.
- [ ] The Preferences screen shows the logged-in user's basic profile info.
- [ ] The Preferences screen has a "Do not claim or lock encounters" toggle, off by default, with a visible warning that enabling it breaks working in encounters.
- [ ] The toggle value persists in `localStorage` across reloads and is per browser.
- [ ] With the toggle on, opening, working in, or leaving an encounter never sends an acquire/renew case-lock request.
- [ ] With the toggle off, encounter claiming and renewal behave exactly as before.
- [ ] The preference is checked in one centralized place that all claim/renew paths go through.

## Testing Instructions

1. **Open Preferences** — In the PMP, click the account avatar in the main navigation and choose Preferences. Expected: the Preferences screen opens and shows your name and profile info.
2. **Default state** — Look at the "Do not claim or lock encounters" toggle. Expected: it is off and a warning explains that turning it on breaks working in encounters.
3. **Lock off (default)** — Open an unclaimed encounter. Expected: it is claimed by you (lock holder shown; network shows the acquire case-lock request).
4. **Lock on** — Enable the toggle, reload the page. Expected: the toggle is still on.
5. **No claim** — Open an unclaimed encounter, stay longer than the lock renewal period, then navigate to the member's full profile. Expected: no acquire case-lock request is sent at any point and the encounter shows as unclaimed for a colleague.
6. **Turn it back off** — Disable the toggle and open an unclaimed encounter. Expected: it is claimed by you again.

## Comments (0)

_No comments._

## History

| When | Who | Field | From | To |
|---|---|---|---|---|
| 2026-10-08T08:02:57.851Z | Brendan Mullins | Created | — | — |
| 2026-10-08T08:03:05.269Z | Brendan Mullins | Assignee | — | Brendan Mullins |
| 2026-10-08T08:03:07.190Z | Brendan Mullins | Link | — | This work item relates to PMP-1732 |
| 2026-10-08T08:03:08.671Z | Brendan Mullins | Link | — | This work item relates to PMP-1781 |
| 2026-10-08T08:21:11.780Z | Brendan Mullins | Status | Backlog | In Progress |
| 2026-10-08T09:51:32.988Z | Brendan Mullins | Status | In Progress | Explorative & Review |
| 2026-10-08T13:07:44.287Z | Brendan Mullins | Team | — | Mission - Zendesk migration |
