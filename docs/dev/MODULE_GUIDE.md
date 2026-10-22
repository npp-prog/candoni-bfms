# Building a BFMS module (Phases 3–12)

This guide describes how a phase plugs into the shared engine. **Phase 3 Budget is the reference
implementation** — read its files before writing a new module:

| Layer | Budget reference | What it holds |
|---|---|---|
| Shared module definition | `shared/src/modules/budget.ts` | `SourceModuleDef`s: collection, date field, workflow transitions, constants |
| Server module | `functions/src/modules/budget/index.ts` | zod schema, `prepare()`, action hooks, numbering, JEV template |
| Server callables | `functions/src/modules/budget/callables.ts` | anything that is not a source-document save/transition |
| Report builders | `shared/src/reports/builders/budget.ts` | pure `ReportBuilder`s (RAO, SAOB, REAI) |
| UI | `src/modules/budget/*` + `routes.tsx` | pages, registers, editors |
| E2E | `tests/e2e/10-budget.cjs` | drives the real callables as several users |

Architecture background: `docs/architecture/02-data-model.md`, `04-accounting-engine.md`,
`05-workflows.md`, `06-reporting.md`. Field-level types: `shared/src/types/*.ts`.

## Ground rules

- **Money is integer centavos** (`Centavos`). Dates are `YYYY-MM-DD` strings. Never floats.
- **All writes go through Cloud Functions.** The UI never writes Firestore directly. Use the generic
  engine (`saveSource` / `sourceAction`) for source documents; write a dedicated callable with
  `secureCallable` for anything else. Every callable checks a permission with `ctx.require(...)`
  at the record's barangay and writes an audit record with `AuditWriter` in the same transaction.
- **Firestore transactions read everything before writing anything.** Engine hooks are two-phase:
  the hook body reads/validates (throw `BfmsError` to reject); the function it returns writes.
- **Server recomputes every total.** Never trust totals from the browser; use the pure helpers in
  `shared/src/accounting/*` (they also power UI previews).
- **Barangay isolation.** Every document carries `barangayId` and `fiscalYear`; every client query
  filters on `barangayId` (Security Rules reject anything else). Cross-document references must be
  the same barangay — check it on the server.
- **Do not edit files owned by another phase.** Shared type files in `shared/src/types/` are
  frozen; if your module needs extra fields, declare an extended interface in your own
  `shared/src/modules/<module>.ts` (e.g. `interface DvRecord extends DisbursementVoucherDoc { … }`).
  Registries (`*/registry.ts`, `functions/src/index.ts`, `shared/src/index.ts`, `src/App.tsx`,
  `src/config/navigation.ts`) are already wired to your files — you only fill your own files.
- Follow the existing code style: dense, typed, small comments that explain *why*.

## Source documents (generic engine)

1. **Shared definition** (`shared/src/modules/<m>.ts`): export `SourceModuleDef`s and add them to
   the module's exported array (e.g. `COLLECTIONS_MODULES`). Use `standardTransitions({ approve,
   accept })` or list transitions explicitly. A transition names the permission
   (`shared/src/security/permissions.ts`), whether a reason is required, and whether the actor must
   differ from the preparer (`segregation`).
2. **Server module** (`functions/src/modules/<m>/index.ts`): a `ServerSourceModule` per definition:
   - `schema` — zod schema of what the encoder controls.
   - `prepare({ input, tx, barangayId, existing, id })` — READ phase of save: validate against
     related documents (same barangay!), compute derived fields and return the fields to store
     (must include the def's `dateField`; may include `fiscalYear`). The engine adds `barangayId`,
     `fiscalYear`, `accountingPeriod`, status, `createdBy/At`, `updatedBy/At`, `jevId: null`.
   - `onAction.<ACTION>` — side effects of a transition (e.g. Budget CERTIFY charges the
     appropriation and writes the RAO line).
   - `numbering` — server number allocated on an action (`NUMBER_FORMATS` in
     `shared/src/numbering/format.ts`; add a doc type there only if you own it — coordinate via
     the final report if you need a new one).
   - `jev(args)` — on ACCEPT, return the DRAFT journal entry to generate (`GeneratedJev`:
     journal JCT/GJ, date, particulars, references, balanced lines with subsidiary ids). The engine
     creates it, links `jevId`, and posting later stamps the source `POSTED`
     (`shared/src/modules/jevSources.ts` lists the source collections).
3. **UI**: `useCollection` for registers, `RegisterTable`, `ModuleTabs`, editors in a `Modal` with
   `Field`, `MoneyInput`, `AccountInput`, `SubsidiarySelect`, `BankAccountSelect`, `PartyInput`,
   `LinesEditor`; `ActionBar` renders exactly the transitions the user may run;
   `ReturnBanner`, `WorkflowTrail`, `PrintLink` / `reportHref` link to the forms and reports.

## Reports

Each report code in `shared/src/constants/reportDefinitions.ts` gets a pure `ReportBuilder`
(`shared/src/reports/builders/<m>.ts`):

- `params`: `MONTH | QUARTER | SEMESTER | YEAR | AS_OF | RANGE | DOCUMENT`. FORM-type reports
  (DV, LR, PCV, PAYROLL, ICS…) use `DOCUMENT` plus `document: { collection, numberField,
  dateField, labelField }`; the viewer shows a picker and module pages link with `PrintLink`.
- `extras`: optional pickers (`bankAccount`, `account`, `subsidiary`, `inventoryItem`, `ppe`,
  `select` with options).
- `build(ctx)` reads only through `ctx.ds` (the same code runs in the browser and in the server
  snapshot), uses `ctx.scope()` / `ctx.range` / `ctx.accounts()` / `ctx.subsidiaries()` /
  `ctx.sign(label, role)` and helpers in `shared/src/reports/helpers.ts`, and returns sections
  (`table`, `fields`, `text`, `certifications`), signatories, validations (the validator ids in
  the definition) and `isEmpty` (true when there are no source records — the monthly package then
  marks the report NOT APPLICABLE).
- Layouts follow the COA *Manual on the Financial Management of Barangays* forms and the legacy
  Agboy workbooks: same column order and headings, legacy references (OR no., DV no., check no.),
  totals rows, signature blocks for the responsible office (`06-reporting.md` §14).

## Testing

- Unit-test pure functions with vitest in `shared/test/`.
- `npx tsc -p tsconfig.app.json --noEmit`, `npm run typecheck`, `npm test` must pass.
- End-to-end: `tests/e2e/emulators.sh start <SLOT>` (each parallel worker uses its own slot),
  `E2E_SLOT=<SLOT> node tests/e2e/00-setup.cjs`, then your own `tests/e2e/<nn>-<module>.cjs`
  (drive the real callables as different users, assert both the happy path and the rejections),
  then `E2E_SLOT=<SLOT> tests/e2e/reports.sh <CODES>` to build your reports server-side.
  Stop with `tests/e2e/emulators.sh stop <SLOT>`.
