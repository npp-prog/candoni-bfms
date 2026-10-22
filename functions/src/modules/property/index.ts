import {
  BIOLOGICAL_ASSET_MODULE,
  BfmsError,
  CAPITALIZATION_THRESHOLD,
  COL,
  DONATION_MODULE,
  ICS_MODULE,
  IIRUP_MODULE,
  INSPECTION_MODULE,
  PAR_MODULE,
  PPE_MODULE,
  PROPERTY_COL,
  PTR_MODULE,
  PURCHASE_ORDER_MODULE,
  PURCHASE_REQUEST_MODULE,
  REQUISITION_MODULE,
  RRPE_MODULE,
  defaultResidualValue,
  depreciationStartPeriod,
  extendedCost,
  formatPesos,
  periodOfDate,
  ppeAccountsFor,
  roundQty,
  type BarangayId,
  type BiologicalAssetDoc,
  type Centavos,
  type InspectionReportDoc,
  type InventoryItemRecord,
  type PoLine,
  type PpeMovement,
  type PpeRecord,
  type PropertyDocLine,
  type PropertyDocumentDoc,
  type PurchaseOrderDoc,
  type PurchaseRequestDoc,
  type ReceiptLine,
  type RequisitionDoc,
  type RisLine,
  type SourceModuleDef,
} from '@bfms/shared';
import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../lib/admin';
import type { CallerContext } from '../../lib/context';
import type { ServerSourceModule, SourceRecord } from '../../sources/engine';
import { InventoryPoster, PropertyNumbers, assertActivePpe, assertOpenPeriod, centavos, isoDate, movement, party, qty, readMany, readOwned, signer, text } from './support';

const id128 = z.string().min(1).max(128);
const ppeCode = z.string().regex(/^1-07-\d{2}-\d{3}$/, 'Use a PPE account (1-07-xx-xxx).');
const fund = z.string().min(1).max(60).default('GF');

async function assertAccounts(tx: Transaction, codes: readonly string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(codes.filter(Boolean))];
  const snaps = uniq.length ? await tx.getAll(...uniq.map((c) => db.collection(COL.chartOfAccounts).doc(c))) : [];
  const names = new Map<string, string>();
  for (const s of snaps) {
    if (!s.exists || !s.get('active')) throw new BfmsError('INVALID_ACCOUNT', `Account ${s.id} is not an active account.`);
    names.set(s.id, s.get('accountName') as string);
  }
  return names;
}

const keep = <T>(existing: SourceRecord | null, field: string, fallback: T): T => ((existing?.[field] as T | undefined) ?? fallback);

// ------------------------------------------------------------------ purchase request

const prSchema = z.object({
  prDate: isoDate,
  office: text(160),
  responsibilityCenterCode: text(40),
  fundId: fund,
  purpose: z.string().trim().min(3).max(1000),
  requestedBy: signer,
  lines: z
    .array(z.object({ itemId: z.string().max(128).nullable().default(null), stockNumber: text(40), unit: z.string().trim().min(1).max(30), description: z.string().trim().min(2).max(500), quantity: qty, estimatedUnitCost: centavos }))
    .min(1)
    .max(100),
});

const purchaseRequest: ServerSourceModule<typeof prSchema> = {
  def: PURCHASE_REQUEST_MODULE,
  schema: prSchema,
  async prepare({ input, tx, barangayId, existing }) {
    const items = await readMany(tx, COL.inventoryItems, input.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])), barangayId, 'Inventory item');
    const lines = input.lines.map((l) => ({ ...l, stockNumber: l.itemId ? (items.get(l.itemId)!.get('stockNumber') as string) : l.stockNumber, estimatedCost: extendedCost(l.quantity, l.estimatedUnitCost) }));
    return { ...input, lines, totalEstimatedCost: lines.reduce((t, l) => t + l.estimatedCost, 0), prNumber: keep(existing, 'prNumber', null) };
  },
  numbering: { action: 'SUBMIT', docType: 'PRQ', field: 'prNumber' },
};

// ------------------------------------------------------------------ purchase order

const poSchema = z.object({
  poDate: isoDate,
  purchaseRequestId: id128,
  supplier: party,
  modeOfProcurement: z.string().trim().max(120).default('Small Value Procurement'),
  placeOfDelivery: text(200),
  dateOfDelivery: isoDate.nullable().default(null),
  deliveryTerm: text(200),
  paymentTerm: text(200),
  lines: z
    .array(z.object({ prLineNo: z.number().int().min(1).nullable().default(null), itemId: z.string().max(128).nullable().default(null), stockNumber: text(40), unit: z.string().trim().min(1).max(30), description: z.string().trim().min(2).max(500), quantity: qty, unitCost: centavos }))
    .min(1)
    .max(100),
});

async function readApprovedPr(tx: Transaction, id: string, barangayId: string): Promise<PurchaseRequestDoc & { id: string }> {
  const snap = await readOwned(tx, PROPERTY_COL.purchaseRequests, id, barangayId, 'Purchase request');
  const pr = { ...(snap.data() as PurchaseRequestDoc), id: snap.id };
  if (pr.status !== 'APPROVED') throw new BfmsError('INVALID_STATUS', `Purchase request ${pr.prNumber ?? ''} is ${pr.status}; only an APPROVED PR can be ordered.`);
  return pr;
}

const purchaseOrder: ServerSourceModule<typeof poSchema> = {
  def: PURCHASE_ORDER_MODULE,
  schema: poSchema,
  async prepare({ input, tx, barangayId, existing }) {
    const pr = await readApprovedPr(tx, input.purchaseRequestId, barangayId);
    if (input.poDate < pr.prDate) throw new BfmsError('VALIDATION_FAILED', 'The PO date cannot be earlier than the PR date.');
    const ordered = new Map<number, number>();
    for (const l of input.lines) {
      if (l.prLineNo === null) continue;
      const prl = pr.lines[l.prLineNo - 1];
      if (!prl) throw new BfmsError('VALIDATION_FAILED', `PR line ${l.prLineNo} does not exist.`);
      const q = roundQty((ordered.get(l.prLineNo) ?? 0) + l.quantity);
      if (q > prl.quantity) throw new BfmsError('VALIDATION_FAILED', `PR line ${l.prLineNo} (${prl.description}) requests ${prl.quantity}; the PO orders ${q}.`);
      ordered.set(l.prLineNo, q);
    }
    const lines: PoLine[] = input.lines.map((l) => {
      const prl = l.prLineNo ? pr.lines[l.prLineNo - 1] : undefined;
      const itemId = l.itemId ?? prl?.itemId ?? null;
      return { ...l, itemId, stockNumber: l.stockNumber || prl?.stockNumber || '', unitCost: l.unitCost as Centavos, amount: extendedCost(l.quantity, l.unitCost), quantityReceived: 0 };
    });
    await readMany(tx, COL.inventoryItems, lines.flatMap((l) => (l.itemId ? [l.itemId] : [])), barangayId, 'Inventory item');
    return { ...input, lines, prNumber: pr.prNumber, fundId: pr.fundId, totalAmount: lines.reduce((t, l) => t + l.amount, 0), deliveryStatus: 'PENDING', poNumber: keep(existing, 'poNumber', null) };
  },
  numbering: { action: 'APPROVE', docType: 'PO', field: 'poNumber' },
  onAction: {
    async APPROVE({ tx, doc }) {
      await readApprovedPr(tx, String(doc.purchaseRequestId), doc.barangayId);
    },
  },
};

// ------------------------------------------------------------------ IAR / ARDSM (receipts)

const receiptSchema = z.object({
  iarDate: isoDate,
  purchaseOrderId: z.string().max(128).nullable().default(null),
  supplier: party.optional(),
  invoiceNumber: text(60),
  invoiceDate: isoDate.nullable().default(null),
  requisitioningOffice: text(160),
  inspectionDate: isoDate.nullable().default(null),
  inspectedBy: text(160),
  fundId: fund,
  remarks: text(1000),
  lines: z
    .array(
      z.object({
        poLineNo: z.number().int().min(1).nullable().default(null),
        kind: z.enum(['SUPPLY', 'PPE']),
        itemId: z.string().max(128).nullable().default(null),
        description: text(500),
        unit: text(30),
        quantity: qty,
        unitCost: centavos,
        ppe: z
          .object({ accountCode: ppeCode, usefulLifeYears: z.number().int().min(1).max(100), residualValue: centavos.nullable().default(null), location: text(200), accountablePerson: text(160) })
          .nullable()
          .default(null),
      }),
    )
    .min(1)
    .max(100),
});

function receiptModule(def: SourceModuleDef, receiptType: InspectionReportDoc['receiptType']): ServerSourceModule<typeof receiptSchema> {
  const donation = receiptType === 'DONATION';
  return {
    def,
    schema: receiptSchema,
    async prepare({ input, tx, barangayId, existing }) {
      let po: (PurchaseOrderDoc & { id: string }) | null = null;
      if (donation) {
        if (input.purchaseOrderId) throw new BfmsError('VALIDATION_FAILED', 'A donation is not received against a purchase order.');
        if (!input.supplier) throw new BfmsError('VALIDATION_FAILED', 'Enter the donor.');
      } else {
        if (!input.purchaseOrderId) throw new BfmsError('VALIDATION_FAILED', 'Select the purchase order being delivered.');
        const s = await readOwned(tx, PROPERTY_COL.purchaseOrders, input.purchaseOrderId, barangayId, 'Purchase order');
        po = { ...(s.data() as PurchaseOrderDoc), id: s.id };
        if (po.status !== 'APPROVED') throw new BfmsError('INVALID_STATUS', `Purchase order ${po.poNumber ?? ''} is ${po.status}; deliveries are received against an APPROVED PO.`);
        if (input.iarDate < po.poDate) throw new BfmsError('VALIDATION_FAILED', 'The IAR date cannot be earlier than the PO date.');
      }
      const items = await readMany(tx, COL.inventoryItems, input.lines.flatMap((l) => (l.kind === 'SUPPLY' && l.itemId ? [l.itemId] : [])), barangayId, 'Inventory item');
      const ppeCodes: string[] = [];
      const lines: ReceiptLine[] = input.lines.map((l, i) => {
        const n = i + 1;
        const pol = po && l.poLineNo ? po.lines[l.poLineNo - 1] : undefined;
        if (po && l.poLineNo && !pol) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: PO line ${l.poLineNo} does not exist.`);
        if (l.kind === 'SUPPLY') {
          const itemId = l.itemId ?? pol?.itemId ?? null;
          if (!itemId) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: select the stock item that receives the supplies.`);
          const it = (items.get(itemId) ?? null)?.data() as InventoryItemRecord | undefined;
          if (!it || !it.active) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: the stock item is not active.`);
          if (l.unitCost >= CAPITALIZATION_THRESHOLD)
            throw new BfmsError('VALIDATION_FAILED', `Line ${n}: unit cost ${formatPesos(l.unitCost as Centavos)} reaches the ₱50,000 capitalization threshold; receive it as PPE.`);
          return { poLineNo: l.poLineNo, kind: 'SUPPLY', itemId, stockNumber: it.stockNumber, description: l.description || it.description, unit: it.unit, quantity: l.quantity, unitCost: l.unitCost as Centavos, amount: extendedCost(l.quantity, l.unitCost), ppe: null };
        }
        if (!l.ppe) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: enter the PPE account, useful life and custody.`);
        if (l.unitCost < CAPITALIZATION_THRESHOLD)
          throw new BfmsError('VALIDATION_FAILED', `Line ${n}: unit cost ${formatPesos(l.unitCost as Centavos)} is below the ₱50,000 capitalization threshold; receive it as a semi-expendable stock item.`);
        if (!Number.isInteger(l.quantity) || l.quantity > 100) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: PPE quantity must be a whole number (one property number each, at most 100).`);
        const description = l.description || pol?.description || '';
        if (description.length < 2) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: describe the equipment (brand, model, serial no.).`);
        const accts = ppeAccountsFor(l.ppe.accountCode);
        if (l.ppe.residualValue !== null && l.ppe.residualValue > l.unitCost) throw new BfmsError('VALIDATION_FAILED', `Line ${n}: residual value exceeds cost.`);
        ppeCodes.push(l.ppe.accountCode, accts.accumulatedDepreciationAccountCode, accts.depreciationExpenseAccountCode);
        return { poLineNo: l.poLineNo, kind: 'PPE', itemId: null, stockNumber: '', description, unit: l.unit || pol?.unit || 'unit', quantity: l.quantity, unitCost: l.unitCost as Centavos, amount: extendedCost(l.quantity, l.unitCost), ppe: l.ppe as ReceiptLine['ppe'] };
      });
      await assertAccounts(tx, ppeCodes);
      return {
        ...input,
        receiptType,
        supplier: po ? po.supplier : input.supplier,
        poNumber: po?.poNumber ?? null,
        fundId: po?.fundId ?? input.fundId,
        lines,
        totalAmount: lines.reduce((t, l) => t + l.amount, 0),
        documentNumber: keep(existing, 'documentNumber', null),
      };
    },
    numbering: { action: 'SUBMIT', docType: donation ? 'ARDSM' : 'IAR', field: 'documentNumber' },
    onAction: {
      // Acceptance: stock-card receipts for supplies, one PPE record per unit of equipment.
      async APPROVE({ tx, ctx, doc }) {
        const r = doc as unknown as SourceRecord & InspectionReportDoc;
        let poSnap: DocumentSnapshot | null = null;
        let poLines: PoLine[] | null = null;
        if (!donation) {
          poSnap = await readOwned(tx, PROPERTY_COL.purchaseOrders, String(r.purchaseOrderId), r.barangayId, 'Purchase order');
          const po = poSnap.data() as PurchaseOrderDoc;
          if (po.status !== 'APPROVED') throw new BfmsError('INVALID_STATUS', `Purchase order ${po.poNumber ?? ''} is ${po.status}.`);
          poLines = po.lines.map((l) => ({ ...l }));
          for (const l of r.lines) {
            if (!l.poLineNo) continue;
            const pol = poLines[l.poLineNo - 1]!;
            pol.quantityReceived = roundQty((pol.quantityReceived ?? 0) + l.quantity);
            if (pol.quantityReceived > pol.quantity) throw new BfmsError('VALIDATION_FAILED', `PO line ${l.poLineNo} (${pol.description}): delivery exceeds the ${pol.quantity} ordered.`);
          }
        }
        const poster = await InventoryPoster.read(tx, r.barangayId, ctx.uid, r.lines.flatMap((l) => (l.kind === 'SUPPLY' && l.itemId ? [l.itemId] : [])));
        const year = periodOfDate(r.iarDate).fiscalYear;
        const numbers = await PropertyNumbers.read(tx, r.barangayId, year, r.lines.flatMap((l) => (l.kind === 'PPE' && l.ppe ? [l.ppe.accountCode] : [])));
        return ({ now }) => {
          const ref = r.documentNumber ?? '';
          const lines = r.lines.map((l) => {
            if (l.kind === 'SUPPLY') {
              poster.receive(l.itemId!, l.quantity, l.unitCost, { date: r.iarDate, kind: donation ? 'DONATION_RECEIVED' : 'RECEIPT', referenceType: donation ? 'ARDSM' : 'IAR', referenceNumber: ref, remarks: r.supplier?.name ?? '', sourceCollection: PROPERTY_COL.inspectionReports, sourceId: r.id });
              return l;
            }
            const ppeIds: string[] = [];
            const propertyNumbers: string[] = [];
            for (let k = 0; k < l.quantity; k++) {
              const pref = db.collection(COL.ppe).doc();
              const number = numbers.allocate(l.ppe!.accountCode, pref.id);
              tx.create(pref, newPpe(r, l, number, ctx, now));
              ppeIds.push(pref.id);
              propertyNumbers.push(number);
            }
            return { ...l, ppeIds, propertyNumbers };
          });
          poster.commit();
          numbers.commit();
          if (poSnap && poLines) {
            const complete = poLines.every((l) => l.quantityReceived >= l.quantity);
            tx.update(poSnap.ref, { lines: poLines, deliveryStatus: complete ? 'COMPLETE' : 'PARTIAL', updatedAt: now });
          }
          return { lines };
        };
      },
    },
  };
}

function newPpe(r: SourceRecord & InspectionReportDoc, l: ReceiptLine, propertyNumber: string, ctx: CallerContext, now: FirebaseFirestore.Timestamp): Omit<PpeRecord, 'submittedBy'> & Record<string, unknown> {
  const p = l.ppe!;
  const accts = ppeAccountsFor(p.accountCode);
  const residual = (p.residualValue ?? defaultResidualValue(l.unitCost)) as Centavos;
  const { fiscalYear, key } = periodOfDate(r.iarDate);
  return {
    barangayId: r.barangayId,
    fiscalYear,
    accountingPeriod: key,
    propertyNumber,
    description: l.description,
    unit: l.unit,
    accountCode: p.accountCode,
    accumulatedDepreciationAccountCode: accts.accumulatedDepreciationAccountCode,
    depreciationExpenseAccountCode: accts.depreciationExpenseAccountCode,
    acquisitionDate: r.iarDate,
    acquisitionCost: l.unitCost,
    residualValue: residual,
    usefulLifeYears: p.usefulLifeYears,
    depreciationStartPeriod: depreciationStartPeriod(r.iarDate),
    accumulatedDepreciation: 0 as Centavos,
    netBookValue: l.unitCost,
    openingAccumulatedDepreciation: 0 as Centavos,
    lastDepreciatedPeriod: null,
    location: p.location,
    accountablePerson: p.accountablePerson,
    parNumber: null,
    parId: null,
    icsNumber: null,
    sourceDvId: null,
    fundId: r.fundId,
    remarks: '',
    condition: 'SERVICEABLE',
    iarId: r.id,
    iarNumber: r.documentNumber,
    supplierName: r.supplier?.name ?? '',
    movements: [{ date: r.iarDate, type: 'ACQUIRED', reference: `${r.receiptType === 'DONATION' ? 'ARDSM' : 'IAR'} ${r.documentNumber ?? ''}`.trim(), person: p.accountablePerson, location: p.location, remarks: r.supplier?.name ?? '' }],
    disposalDate: null,
    lastCount: null,
    status: 'ACTIVE',
    revisionNumber: 0,
    jevId: null,
    createdAt: now,
    createdBy: ctx.uid,
    updatedAt: now,
    updatedBy: ctx.uid,
  };
}

// ------------------------------------------------------------------ RIS

const risSchema = z.object({
  risDate: isoDate,
  office: text(160),
  responsibilityCenterCode: text(40),
  purpose: z.string().trim().min(3).max(1000),
  requestedBy: signer,
  receivedBy: signer,
  lines: z.array(z.object({ itemId: id128, quantityRequested: qty, remarks: text(300) })).min(1).max(100),
});

const requisition: ServerSourceModule<typeof risSchema> = {
  def: REQUISITION_MODULE,
  schema: risSchema,
  async prepare({ input, tx, barangayId, existing }) {
    const items = await readMany(tx, COL.inventoryItems, input.lines.map((l) => l.itemId), barangayId, 'Inventory item');
    const lines: RisLine[] = input.lines.map((l) => {
      const it = items.get(l.itemId)!.data() as InventoryItemRecord;
      if (!it.active) throw new BfmsError('VALIDATION_FAILED', `${it.stockNumber} ${it.description} is inactive.`);
      return { itemId: l.itemId, stockNumber: it.stockNumber, description: it.description, unit: it.unit, quantityRequested: l.quantityRequested, stockAvailable: it.quantityOnHand >= l.quantityRequested, quantityIssued: 0, unitCost: 0 as Centavos, amount: 0 as Centavos, remarks: l.remarks };
    });
    return { ...input, lines, issueDate: null, totalIssuedCost: 0, risNumber: keep(existing, 'risNumber', null) };
  },
  numbering: { action: 'SUBMIT', docType: 'RIS', field: 'risNumber' },
  actionPayload: {
    ISSUE: z.object({
      issueDate: isoDate.optional(),
      issued: z.array(z.object({ line: z.number().int().min(0), quantityIssued: z.number().min(0).max(1_000_000) })).max(100).optional(),
      receivedBy: signer.optional(),
    }),
  },
  onAction: {
    async ISSUE({ tx, ctx, doc, payload }) {
      const r = doc as unknown as SourceRecord & RequisitionDoc;
      const p = payload as { issueDate?: string; issued?: Array<{ line: number; quantityIssued: number }>; receivedBy?: RequisitionDoc['receivedBy'] };
      const issueDate = p.issueDate ?? r.risDate;
      if (issueDate < r.risDate || periodOfDate(issueDate).fiscalYear !== r.fiscalYear) throw new BfmsError('VALIDATION_FAILED', 'The issue date must be on or after the RIS date, in the same fiscal year.');
      await assertOpenPeriod(tx, r.barangayId, issueDate);
      const poster = await InventoryPoster.read(tx, r.barangayId, ctx.uid, r.lines.map((l) => l.itemId));
      const qtys = r.lines.map((l, i) => p.issued?.find((x) => x.line === i)?.quantityIssued ?? l.quantityRequested);
      r.lines.forEach((l, i) => {
        if (qtys[i]! > l.quantityRequested) throw new BfmsError('VALIDATION_FAILED', `Line ${i + 1}: cannot issue more than the ${l.quantityRequested} requested.`);
      });
      if (!qtys.some((q) => q > 0)) throw new BfmsError('VALIDATION_FAILED', 'Nothing to issue.');
      // Validate against stock now (READ phase) so an over-issue is refused before any write.
      const lines = r.lines.map((l, i) => {
        if (!qtys[i]) return { ...l, quantityIssued: 0, unitCost: 0 as Centavos, amount: 0 as Centavos };
        const c = poster.issue(l.itemId, qtys[i]!, { date: issueDate, kind: 'ISSUE', referenceType: 'RIS', referenceNumber: r.risNumber ?? '', office: r.office, remarks: r.purpose.slice(0, 200), sourceCollection: PROPERTY_COL.requisitions, sourceId: r.id });
        return { ...l, quantityIssued: qtys[i]!, unitCost: c.unitCost, amount: c.amount };
      });
      return () => {
        poster.commit();
        return { lines, issueDate, totalIssuedCost: lines.reduce((t, l) => t + l.amount, 0), ...(p.receivedBy?.name ? { receivedBy: p.receivedBy } : {}) };
      };
    },
  },
};

// ------------------------------------------------------------------ ICS (semi-expendable)

const icsSchema = z.object({
  date: isoDate,
  receivedBy: signer,
  remarks: text(1000),
  lines: z.array(z.object({ itemId: id128, quantity: qty, estimatedUsefulLife: z.number().int().min(1).max(20).nullable().default(null), inventoryItemNo: text(60), remarks: text(300) })).min(1).max(100),
});

function docDefaults(type: PropertyDocumentDoc['documentType'], existing: SourceRecord | null) {
  return { documentType: type, documentNumber: keep(existing, 'documentNumber', null), fromAccountable: '', toLocation: '', transferType: '', reason: '', remarks: '' };
}

function requireReceiver(name: string | undefined, what: string) {
  if (!name || name.trim().length < 2) throw new BfmsError('VALIDATION_FAILED', `Enter the ${what}.`);
}

const ics: ServerSourceModule<typeof icsSchema> = {
  def: ICS_MODULE,
  schema: icsSchema,
  async prepare({ input, tx, barangayId, existing }) {
    requireReceiver(input.receivedBy.name, 'end user who receives the items');
    const items = await readMany(tx, COL.inventoryItems, input.lines.map((l) => l.itemId), barangayId, 'Inventory item');
    const lines: PropertyDocLine[] = input.lines.map((l) => {
      const it = items.get(l.itemId)!.data() as InventoryItemRecord;
      if (it.itemClass !== 'SEMI_EXPENDABLE') throw new BfmsError('VALIDATION_FAILED', `${it.stockNumber} is a consumable; issue it on a RIS.`);
      return { ppeId: null, itemId: l.itemId, propertyNumber: l.inventoryItemNo || it.stockNumber, description: it.description, unit: it.unit, quantity: l.quantity, unitCost: it.unitCost, amount: extendedCost(l.quantity, it.unitCost), acquisitionDate: null, estimatedUsefulLife: l.estimatedUsefulLife, remarks: l.remarks };
    });
    return { ...docDefaults('ICS', existing), ...input, lines, totalAmount: lines.reduce((t, l) => t + l.amount, 0) };
  },
  numbering: { action: 'APPROVE', docType: 'ICS', field: 'documentNumber' },
  onAction: {
    async APPROVE({ tx, ctx, doc }) {
      const d = doc as unknown as SourceRecord & PropertyDocumentDoc;
      const poster = await InventoryPoster.read(tx, d.barangayId, ctx.uid, d.lines.map((l) => l.itemId!));
      // Issue in the READ phase so an over-issue is refused before any write; the number is stamped at commit.
      const lines = d.lines.map((l) => {
        const c = poster.issue(l.itemId!, l.quantity, { date: d.date, kind: 'ISSUE', referenceType: 'ICS', referenceNumber: '', office: d.receivedBy.office ?? '', remarks: d.receivedBy.name, sourceCollection: COL.propertyDocuments, sourceId: d.id });
        return { ...l, unitCost: c.unitCost, amount: c.amount };
      });
      return ({ number }) => {
        poster.commit(number ?? '');
        return { lines, totalAmount: lines.reduce((t, l) => t + l.amount, 0) };
      };
    },
  },
};

// ------------------------------------------------------------------ PAR / PTR / RRPE / IIRUP (PPE custody)

function ppeLine(id: string, p: PpeRecord, extra: Partial<PropertyDocLine> = {}): PropertyDocLine {
  return { ppeId: id, itemId: null, propertyNumber: p.propertyNumber, description: p.description, unit: p.unit ?? 'unit', quantity: 1, unitCost: p.acquisitionCost, amount: p.acquisitionCost, acquisitionDate: p.acquisitionDate, estimatedUsefulLife: p.usefulLifeYears, remarks: '', ...extra };
}

async function readActivePpe(tx: Transaction, ids: readonly string[], barangayId: string): Promise<Map<string, DocumentSnapshot>> {
  if (new Set(ids).size !== ids.length) throw new BfmsError('VALIDATION_FAILED', 'The same property is listed twice.');
  const snaps = await readMany(tx, COL.ppe, ids, barangayId, 'PPE');
  for (const s of snaps.values()) assertActivePpe(s);
  return snaps;
}

const ppeIds = z.array(id128).min(1).max(50);

const parSchema = z.object({ date: isoDate, receivedBy: signer, remarks: text(1000), ppeIds });

const par: ServerSourceModule<typeof parSchema> = {
  def: PAR_MODULE,
  schema: parSchema,
  async prepare({ input, tx, barangayId, existing, id }) {
    requireReceiver(input.receivedBy.name, 'accountable officer who receives the property');
    const snaps = await readActivePpe(tx, input.ppeIds, barangayId);
    const lines = input.ppeIds.map((pid) => {
      const p = snaps.get(pid)!.data() as PpeRecord;
      if (p.parId && p.parId !== id) throw new BfmsError('VALIDATION_FAILED', `${p.propertyNumber} is already covered by ${p.parNumber}; use a Property Transfer Report.`);
      return ppeLine(pid, p);
    });
    return { ...docDefaults('PAR', existing), date: input.date, receivedBy: input.receivedBy, remarks: input.remarks, ppeIds: input.ppeIds, lines, totalAmount: lines.reduce((t, l) => t + l.amount, 0) };
  },
  numbering: { action: 'APPROVE', docType: 'PAR', field: 'documentNumber' },
  onAction: {
    async APPROVE({ tx, doc }) {
      const d = doc as unknown as SourceRecord & PropertyDocumentDoc;
      const snaps = await readActivePpe(tx, d.lines.map((l) => l.ppeId!), d.barangayId);
      for (const s of snaps.values()) if (s.get('parId') && s.get('parId') !== d.id) throw new BfmsError('VALIDATION_FAILED', `${s.get('propertyNumber')} is already covered by ${s.get('parNumber')}.`);
      return ({ now, number }) => {
        for (const s of snaps.values())
          tx.update(s.ref, { accountablePerson: d.receivedBy.name, parNumber: number, parId: d.id, updatedAt: now, movements: movement(mv(d, 'ISSUED', `PAR ${number}`, d.receivedBy.name, s.get('location') as string)) });
      };
    },
  },
};

function mv(d: PropertyDocumentDoc, type: PpeMovement['type'], reference: string, person: string, location: string, remarks = ''): PpeMovement {
  return { date: d.date, type, reference, person, location, remarks };
}

const ptrSchema = z.object({ date: isoDate, transferType: z.string().trim().min(2).max(60), receivedBy: signer, toLocation: text(200), reason: z.string().trim().min(3).max(1000), remarks: text(1000), ppeIds });

const ptr: ServerSourceModule<typeof ptrSchema> = {
  def: PTR_MODULE,
  schema: ptrSchema,
  async prepare({ input, tx, barangayId, existing }) {
    requireReceiver(input.receivedBy.name, 'new accountable officer');
    const snaps = await readActivePpe(tx, input.ppeIds, barangayId);
    const lines = input.ppeIds.map((pid) => ppeLine(pid, snaps.get(pid)!.data() as PpeRecord, { remarks: (snaps.get(pid)!.get('accountablePerson') as string) || '' }));
    const from = [...new Set([...snaps.values()].map((s) => (s.get('accountablePerson') as string) || 'Property office'))].join('; ');
    return { ...docDefaults('PTR', existing), ...input, fromAccountable: from, lines, totalAmount: lines.reduce((t, l) => t + l.amount, 0) };
  },
  numbering: { action: 'APPROVE', docType: 'PTR', field: 'documentNumber' },
  onAction: {
    async APPROVE({ tx, doc }) {
      const d = doc as unknown as SourceRecord & PropertyDocumentDoc;
      const snaps = await readActivePpe(tx, d.lines.map((l) => l.ppeId!), d.barangayId);
      return ({ now, number }) => {
        for (const s of snaps.values()) {
          const location = d.toLocation || (s.get('location') as string);
          tx.update(s.ref, { accountablePerson: d.receivedBy.name, location, updatedAt: now, movements: movement(mv(d, 'TRANSFERRED', `PTR ${number}`, d.receivedBy.name, location, d.transferType)) });
        }
      };
    },
  },
};

const rrpeSchema = z.object({
  date: isoDate,
  receivedBy: signer,
  toLocation: z.string().trim().max(200).default('Property / Supply Office'),
  reason: z.string().trim().min(3).max(1000),
  remarks: text(1000),
  lines: z.array(z.object({ ppeId: id128, condition: z.enum(['SERVICEABLE', 'UNSERVICEABLE']), remarks: text(300) })).min(1).max(50),
});

const rrpe: ServerSourceModule<typeof rrpeSchema> = {
  def: RRPE_MODULE,
  schema: rrpeSchema,
  async prepare({ input, tx, barangayId, existing }) {
    requireReceiver(input.receivedBy.name, 'officer returning the property');
    const snaps = await readActivePpe(tx, input.lines.map((l) => l.ppeId), barangayId);
    const lines = input.lines.map((l) => ppeLine(l.ppeId, snaps.get(l.ppeId)!.data() as PpeRecord, { condition: l.condition, remarks: l.remarks }));
    const from = [...new Set([...snaps.values()].map((s) => (s.get('accountablePerson') as string) || ''))].filter(Boolean).join('; ');
    return { ...docDefaults('RRPE', existing), date: input.date, receivedBy: input.receivedBy, toLocation: input.toLocation, reason: input.reason, remarks: input.remarks, fromAccountable: from, ppeIds: input.lines.map((l) => l.ppeId), lines, totalAmount: lines.reduce((t, l) => t + l.amount, 0) };
  },
  numbering: { action: 'APPROVE', docType: 'RRPE', field: 'documentNumber' },
  onAction: {
    async APPROVE({ tx, doc }) {
      const d = doc as unknown as SourceRecord & PropertyDocumentDoc;
      const snaps = await readActivePpe(tx, d.lines.map((l) => l.ppeId!), d.barangayId);
      return ({ now, number }) => {
        for (const l of d.lines)
          tx.update(snaps.get(l.ppeId!)!.ref, { accountablePerson: '', parNumber: null, parId: null, location: d.toLocation, condition: l.condition ?? 'SERVICEABLE', updatedAt: now, movements: movement(mv(d, 'RETURNED', `RRPE ${number}`, d.receivedBy.name, d.toLocation, l.condition ?? '')) });
      };
    },
  },
};

const iirupSchema = z.object({
  date: isoDate,
  remarks: text(1000),
  lines: z.array(z.object({ ppeId: id128, disposalMode: z.enum(['SALE', 'TRANSFER', 'DESTRUCTION', 'OTHERS']), appraisedValue: centavos.default(0), remarks: text(300) })).min(1).max(50),
});

const iirup: ServerSourceModule<typeof iirupSchema> = {
  def: IIRUP_MODULE,
  schema: iirupSchema,
  async prepare({ input, tx, barangayId, existing }) {
    const snaps = await readActivePpe(tx, input.lines.map((l) => l.ppeId), barangayId);
    const lines = input.lines.map((l) => {
      const p = snaps.get(l.ppeId)!.data() as PpeRecord;
      return ppeLine(l.ppeId, p, { disposalMode: l.disposalMode, appraisedValue: l.appraisedValue as Centavos, accumulatedDepreciation: p.accumulatedDepreciation, carryingAmount: p.netBookValue, remarks: l.remarks });
    });
    const from = [...new Set([...snaps.values()].map((s) => (s.get('accountablePerson') as string) || ''))].filter(Boolean).join('; ');
    return { ...docDefaults('IIRUP', existing), date: input.date, remarks: input.remarks, receivedBy: { name: '', position: '', office: '' }, fromAccountable: from, ppeIds: input.lines.map((l) => l.ppeId), lines, totalAmount: lines.reduce((t, l) => t + l.amount, 0), disposalDate: null, disposalReference: '', disposalAmount: 0 };
  },
  numbering: { action: 'APPROVE', docType: 'IIRUP', field: 'documentNumber' },
  actionPayload: { DISPOSE: z.object({ disposalDate: isoDate, disposalReference: text(120), disposalAmount: centavos.default(0) }) },
  onAction: {
    async APPROVE({ tx, doc }) {
      const d = doc as unknown as SourceRecord & PropertyDocumentDoc;
      const snaps = await readActivePpe(tx, d.lines.map((l) => l.ppeId!), d.barangayId);
      // Refresh the appraisal snapshot: depreciation may have run since the draft.
      const lines = d.lines.map((l) => {
        const p = snaps.get(l.ppeId!)!.data() as PpeRecord;
        return { ...l, accumulatedDepreciation: p.accumulatedDepreciation, carryingAmount: p.netBookValue };
      });
      return ({ now, number }) => {
        for (const s of snaps.values()) tx.update(s.ref, { status: 'UNSERVICEABLE', condition: 'UNSERVICEABLE', iirupId: d.id, updatedAt: now, movements: movement(mv(d, 'UNSERVICEABLE', `IIRUP ${number}`, (s.get('accountablePerson') as string) ?? '', s.get('location') as string)) });
        return { lines };
      };
    },
    async DISPOSE({ tx, doc, payload }) {
      const d = doc as unknown as SourceRecord & PropertyDocumentDoc;
      const p = payload as { disposalDate: string; disposalReference: string; disposalAmount: number };
      if (p.disposalDate < d.date) throw new BfmsError('VALIDATION_FAILED', 'The disposal date cannot be earlier than the IIRUP date.');
      const snaps = await readMany(tx, COL.ppe, d.lines.map((l) => l.ppeId!), d.barangayId, 'PPE');
      for (const s of snaps.values()) if (s.get('status') !== 'UNSERVICEABLE') throw new BfmsError('INVALID_STATUS', `${s.get('propertyNumber')} is ${s.get('status')}, not UNSERVICEABLE.`);
      return ({ now }) => {
        for (const [i, s] of [...snaps.values()].entries())
          tx.update(s.ref, { status: 'DISPOSED', disposalDate: p.disposalDate, updatedAt: now, movements: movement({ date: p.disposalDate, type: 'DISPOSED', reference: `IIRUP ${d.documentNumber ?? ''}${p.disposalReference ? ` / ${p.disposalReference}` : ''}`, person: '', location: '', remarks: d.lines[i]?.disposalMode ?? '' }) });
        return { disposalDate: p.disposalDate, disposalReference: p.disposalReference, disposalAmount: p.disposalAmount };
      };
    },
  },
};

// ------------------------------------------------------------------ PPE register (existing / directly encoded PPE)

const ppeSchema = z.object({
  description: z.string().trim().min(2).max(500),
  unit: z.string().trim().min(1).max(30).default('unit'),
  accountCode: ppeCode,
  accumulatedDepreciationAccountCode: z.string().max(20).optional(),
  depreciationExpenseAccountCode: z.string().max(20).optional(),
  acquisitionDate: isoDate,
  acquisitionCost: centavos.refine((v) => v > 0, 'Cost must be greater than zero.'),
  residualValue: centavos.nullable().default(null),
  usefulLifeYears: z.number().int().min(1).max(100),
  location: text(200),
  accountablePerson: text(160),
  fundId: fund,
  sourceDvId: z.string().max(128).nullable().default(null),
  supplierName: text(160),
  openingAccumulatedDepreciation: centavos.default(0),
  openingAsOfPeriod: z.string().regex(/^\d{4}-\d{2}$/).nullable().default(null),
  remarks: text(1000),
});

const ppe: ServerSourceModule<typeof ppeSchema> = {
  def: PPE_MODULE,
  schema: ppeSchema,
  skipPeriodCheck: true, // existing PPE is encoded with historical acquisition dates
  async prepare({ input, tx, existing }) {
    const d = ppeAccountsFor(input.accountCode);
    const accumulated = input.accumulatedDepreciationAccountCode || d.accumulatedDepreciationAccountCode;
    const expense = input.depreciationExpenseAccountCode || d.depreciationExpenseAccountCode;
    if (d.depreciable && (!/^1-07-\d{2}-\d{3}$/.test(accumulated) || !/^5-04-01-\d{3}$/.test(expense))) throw new BfmsError('INVALID_ACCOUNT', 'Use a 1-07 accumulated depreciation and a 5-04-01 depreciation expense account.');
    await assertAccounts(tx, [input.accountCode, accumulated, expense]);
    const residual = (input.residualValue ?? defaultResidualValue(input.acquisitionCost)) as Centavos;
    if (residual > input.acquisitionCost) throw new BfmsError('VALIDATION_FAILED', 'Residual value exceeds cost.');
    if (input.openingAccumulatedDepreciation > input.acquisitionCost - residual) throw new BfmsError('VALIDATION_FAILED', 'Opening accumulated depreciation exceeds the depreciable amount.');
    const start = depreciationStartPeriod(input.acquisitionDate);
    if (input.openingAccumulatedDepreciation > 0 && !input.openingAsOfPeriod) throw new BfmsError('VALIDATION_FAILED', 'State the month the opening accumulated depreciation is as of.');
    return {
      ...input,
      accumulatedDepreciationAccountCode: accumulated,
      depreciationExpenseAccountCode: expense,
      residualValue: residual,
      depreciationStartPeriod: start,
      accumulatedDepreciation: input.openingAccumulatedDepreciation,
      netBookValue: input.acquisitionCost - input.openingAccumulatedDepreciation,
      lastDepreciatedPeriod: input.openingAccumulatedDepreciation > 0 ? input.openingAsOfPeriod : null,
      propertyNumber: keep(existing, 'propertyNumber', null),
      parNumber: keep(existing, 'parNumber', null),
      parId: keep(existing, 'parId', null),
      icsNumber: null,
      condition: 'SERVICEABLE',
      iarId: null,
      iarNumber: null,
      movements: [],
      disposalDate: null,
      lastCount: null,
    };
  },
  onAction: {
    async APPROVE({ tx, doc }) {
      const p = doc as unknown as SourceRecord & PpeRecord;
      const year = periodOfDate(p.acquisitionDate).fiscalYear;
      const numbers = await PropertyNumbers.read(tx, p.barangayId as BarangayId, year, [p.accountCode]);
      return () => {
        const propertyNumber = p.propertyNumber || numbers.allocate(p.accountCode, p.id);
        numbers.commit();
        return { propertyNumber, movements: [{ date: p.acquisitionDate, type: 'ACQUIRED', reference: p.sourceDvId ? `DV ${p.sourceDvId}` : 'Register', person: p.accountablePerson, location: p.location, remarks: p.supplierName ?? '' }] };
      };
    },
  },
};

// ------------------------------------------------------------------ biological assets

const bioSchema = z.object({
  kind: z.string().trim().min(2).max(80),
  description: text(500),
  unit: z.string().trim().min(1).max(30).default('head'),
  accountCode: z.string().regex(/^1-08-\d{2}-\d{3}$/, 'Use a biological asset account (1-08-xx-xxx).').default('1-08-01-010'),
  acquisitionDate: isoDate,
  quantity: z.number().int().positive().max(100_000),
  unitCost: centavos,
  fairValue: centavos.nullable().default(null),
  location: text(200),
  custodian: text(160),
  remarks: text(1000),
});

const biologicalAsset: ServerSourceModule<typeof bioSchema> = {
  def: BIOLOGICAL_ASSET_MODULE,
  schema: bioSchema,
  skipPeriodCheck: true,
  async prepare({ input, tx, existing }) {
    await assertAccounts(tx, [input.accountCode]);
    return { ...input, quantityOnHand: 0, carryingAmount: 0, movements: [], assetNumber: keep(existing, 'assetNumber', null) };
  },
  numbering: { action: 'APPROVE', docType: 'BAPC', field: 'assetNumber' },
  onAction: {
    async APPROVE({ doc }) {
      const b = doc as unknown as SourceRecord & BiologicalAssetDoc;
      return ({ number }) => {
        const amount = extendedCost(b.quantity, b.fairValue ?? b.unitCost);
        return { quantityOnHand: b.quantity, carryingAmount: amount, movementCount: 1, movements: [{ seq: 1, date: b.acquisitionDate, kind: 'ACQUISITION', quantity: b.quantity, amount, reference: number ?? '', remarks: 'Initial recognition', balanceQuantity: b.quantity, balanceAmount: amount }] };
      };
    },
  },
};

export const PROPERTY_SERVER_MODULES: ServerSourceModule[] = [
  purchaseRequest,
  purchaseOrder,
  receiptModule(INSPECTION_MODULE, 'PURCHASE'),
  receiptModule(DONATION_MODULE, 'DONATION'),
  requisition,
  ics,
  par,
  ptr,
  rrpe,
  iirup,
  ppe,
  biologicalAsset,
] as ServerSourceModule[];

