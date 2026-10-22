import { lastDayOfMonth } from '../../accounting/periods';
import { roundQty, stockCardBalances } from '../../accounting/property';
import { monthlyDepreciation } from '../../accounting/statements';
import {
  DISPOSAL_MODES,
  ITEM_CLASSES,
  PROPERTY_COL,
  type BiologicalAssetDoc,
  type DepreciationRunDoc,
  type InspectionReportDoc,
  type InventoryItemRecord,
  type InventoryTxRecord,
  type PpeDepreciationDoc,
  type PpeRecord,
  type PropertyDocumentDoc,
  type PropertyDocumentType,
  type PurchaseOrderDoc,
  type PurchaseRequestDoc,
  type RequisitionDoc,
} from '../../modules/property';
import type { ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { inRange, peso, postedLines } from '../helpers';
import { col, longDate, row, table, validation, type CertificationsSection, type FieldsSection, type ReportRow, type ReportSection, type ReportSignatory, type TableSection } from '../model';

/**
 * Phase 10 — supplies and property forms and reports, laid out after the MFMB annexes
 * (PR, PO, IAR, RIS, ICS, PAR, stock and property cards, RSMI, RPCI, RPCPPE, IIRUP …).
 * The Property / Inventory Officer prepares and the Punong Barangay approves (06-reporting §14);
 * PELC and the depreciation schedule belong to Municipal Accounting.
 */

const fundName = (f: string | undefined) => (!f || f === 'GF' ? 'General Fund' : f);
const nz = (v: number) => (v ? v : null);

async function loadDoc<T>(ctx: ReportContext, collection: string, label: string): Promise<WithId<T & { barangayId: string; status: string }>> {
  const id = ctx.params.documentId;
  if (!id) throw new Error(`Select the ${label}.`);
  const d = await ctx.ds.get<T & { barangayId: string; status: string }>(collection, id);
  if (!d || d.barangayId !== ctx.params.barangayId) throw new Error(`${label} not found for this barangay.`);
  return d;
}

async function loadPropertyDoc(ctx: ReportContext, type: PropertyDocumentType): Promise<WithId<PropertyDocumentDoc>> {
  const d = await loadDoc<PropertyDocumentDoc>(ctx, 'propertyDocuments', 'document');
  if (d.documentType !== type) throw new Error(`The selected document ${d.documentNumber ?? ""} is a ${d.documentType} form, not ${type}. Pick a ${type} document.`);
  return d;
}

function fields(list: FieldsSection['fields'], columns: FieldsSection['columns'] = 2, title?: string): FieldsSection {
  return { kind: 'fields', fields: list, columns, ...(title ? { title } : {}) };
}

function boxes(list: CertificationsSection['boxes']): CertificationsSection {
  return { kind: 'certifications', boxes: list };
}

const person = (s: { name?: string; position?: string } | undefined, fallback: ReportSignatory): ReportSignatory => (s?.name ? { label: fallback.label, name: s.name, position: s.position || fallback.position } : fallback);

/** Status note under a form that is not yet final (drafts must not pass as issued forms). */
function draftNote(status: string, finalStatuses: readonly string[]): string[] {
  return finalStatuses.includes(status) ? [] : [`Status: ${status} — not yet ${finalStatuses[0]!.toLowerCase()}; for review only.`];
}

// ------------------------------------------------------------------ amount in words (PO)

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function words999(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const t = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', t].filter(Boolean).join(' ');
}
/** 1234567 centavos → "Twelve Thousand Three Hundred Forty-Five Pesos and 67/100". */
export function pesosInWords(centavos: number): string {
  const pesos = Math.floor(Math.abs(centavos) / 100);
  const cents = Math.abs(centavos) % 100;
  const parts: string[] = [];
  const scales = ['', 'Thousand', 'Million', 'Billion'];
  let n = pesos;
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(`${words999(chunk)}${scales[i] ? ` ${scales[i]}` : ''}`);
  }
  return `${parts.join(' ') || 'Zero'} Peso${pesos === 1 ? '' : 's'}${cents ? ` and ${String(cents).padStart(2, '0')}/100` : ' Only'}`;
}

// ------------------------------------------------------------------ PR

const PR: ReportBuilder = {
  code: 'PR',
  params: 'DOCUMENT',
  document: { collection: PROPERTY_COL.purchaseRequests, numberField: 'prNumber', dateField: 'prDate', labelField: 'purpose' },
  async build(ctx) {
    const d = await loadDoc<PurchaseRequestDoc>(ctx, PROPERTY_COL.purchaseRequests, 'purchase request');
    const rows = d.lines.map((l) => row({ stock: l.stockNumber, unit: l.unit, description: l.description, quantity: l.quantity, unitCost: l.estimatedUnitCost, total: l.estimatedCost }));
    rows.push(row({ description: 'TOTAL', total: d.totalEstimatedCost }, 'grandtotal'));
    return {
      subtitle: [],
      meta: [{ label: 'Fund Cluster', value: fundName(d.fundId) }],
      sections: [
        fields([
          { label: 'Office/Section', value: d.office },
          { label: 'PR No.', value: d.prNumber ?? '(not yet numbered)' },
          { label: 'Responsibility Center Code', value: d.responsibilityCenterCode },
          { label: 'Date', value: longDate(d.prDate) },
        ]),
        table([col('stock', 'Stock/Property No.', 'code'), col('unit', 'Unit'), col('description', 'Item Description', 'text', { width: 3 }), col('quantity', 'Quantity', 'number'), col('unitCost', 'Unit Cost', 'money'), col('total', 'Total Cost', 'money')], rows),
        { kind: 'text', paragraphs: [`Purpose: ${d.purpose}`] },
      ],
      signatories: [person(d.requestedBy, { label: 'Requested by', name: '', position: 'Requesting Official' }), ctx.sign('Approved by', 'PUNONG_BARANGAY', d.prDate)],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['APPROVED']),
    };
  },
};

// ------------------------------------------------------------------ PO

const PO: ReportBuilder = {
  code: 'PO',
  params: 'DOCUMENT',
  document: { collection: PROPERTY_COL.purchaseOrders, numberField: 'poNumber', dateField: 'poDate', labelField: 'supplier' },
  async build(ctx) {
    const d = await loadDoc<PurchaseOrderDoc>(ctx, PROPERTY_COL.purchaseOrders, 'purchase order');
    const rows = d.lines.map((l) => row({ stock: l.stockNumber, unit: l.unit, description: l.description, quantity: l.quantity, unitCost: l.unitCost, amount: l.amount }));
    rows.push(row({ description: `(Total Amount in Words) ${pesosInWords(d.totalAmount)}`, amount: d.totalAmount }, 'grandtotal'));
    return {
      subtitle: [],
      meta: [{ label: 'Fund Cluster', value: fundName(d.fundId) }],
      sections: [
        fields(
          [
            { label: 'Supplier', value: d.supplier.name },
            { label: 'P.O. No.', value: d.poNumber ?? '(not yet numbered)' },
            { label: 'Address', value: d.supplier.address ?? '' },
            { label: 'Date', value: longDate(d.poDate) },
            { label: 'TIN', value: d.supplier.tin ?? '' },
            { label: 'Mode of Procurement', value: d.modeOfProcurement },
            { label: 'Place of Delivery', value: d.placeOfDelivery },
            { label: 'Delivery Term', value: d.deliveryTerm },
            { label: 'Date of Delivery', value: longDate(d.dateOfDelivery) },
            { label: 'Payment Term', value: d.paymentTerm },
            { label: 'Purchase Request', value: d.prNumber ?? '' },
          ],
          2,
        ),
        { kind: 'text', paragraphs: ['Gentlemen: Please furnish this Office the following articles subject to the terms and conditions contained herein:'] },
        table([col('stock', 'Stock/Property No.', 'code'), col('unit', 'Unit'), col('description', 'Description', 'text', { width: 3 }), col('quantity', 'Quantity', 'number'), col('unitCost', 'Unit Cost', 'money'), col('amount', 'Amount', 'money')], rows),
        { kind: 'text', paragraphs: ['In case of failure to make the full delivery within the time specified above, a penalty of one-tenth (1/10) of one percent for every day of delay shall be imposed on the undelivered item/s.'] },
        boxes([
          { label: 'Conforme', name: d.supplier.name, position: 'Signature over printed name of supplier', date: null },
          { ...ctx.sign('Very truly yours', 'PUNONG_BARANGAY', d.poDate), date: null },
        ]),
      ],
      signatories: [ctx.sign('Certified as to availability of appropriation', 'APPROPRIATIONS_CHAIR', d.poDate), ctx.sign('Funds available', 'BARANGAY_TREASURER', d.poDate)],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['APPROVED']),
    };
  },
};

// ------------------------------------------------------------------ AIR / ARDSM

async function receiptModel(ctx: ReportContext, donation: boolean) {
  const d = await loadDoc<InspectionReportDoc>(ctx, PROPERTY_COL.inspectionReports, donation ? 'donation receipt' : 'inspection and acceptance report');
  if ((d.receiptType === 'DONATION') !== donation) throw new Error(donation ? 'The selected receipt is a purchase; print it as an AIR.' : 'The selected receipt is a donation; print it as an ARDSM.');
  const rows = d.lines.map((l) =>
    row({ stock: l.kind === 'PPE' ? (l.propertyNumbers ?? []).join(', ') || 'PPE (no. on acceptance)' : l.stockNumber, description: l.description, unit: l.unit, quantity: l.quantity, unitCost: l.unitCost, amount: l.amount }),
  );
  rows.push(row({ description: 'TOTAL', amount: d.totalAmount }, 'grandtotal'));
  const columns = [col('stock', donation ? 'Stock/Property No.' : 'Stock/ Property No.', 'code'), col('description', 'Description', 'text', { width: 3 }), col('unit', 'Unit'), col('quantity', 'Quantity', 'number'), col('unitCost', donation ? 'Unit Value' : 'Unit Cost', 'money'), col('amount', donation ? 'Total Value' : 'Amount', 'money')];
  return { d, rows, columns };
}

const AIR: ReportBuilder = {
  code: 'AIR',
  params: 'DOCUMENT',
  document: { collection: PROPERTY_COL.inspectionReports, numberField: 'documentNumber', dateField: 'iarDate', labelField: 'supplier' },
  async build(ctx) {
    const { d, rows, columns } = await receiptModel(ctx, false);
    const accepted = d.status === 'ACCEPTED';
    const complete = d.lines.every((l) => l.poLineNo !== null);
    return {
      subtitle: [],
      meta: [{ label: 'Fund Cluster', value: fundName(d.fundId) }],
      sections: [
        fields([
          { label: 'Supplier', value: d.supplier?.name ?? '' },
          { label: 'IAR No.', value: d.documentNumber ?? '(not yet numbered)' },
          { label: 'PO No./Date', value: `${d.poNumber ?? ''}` },
          { label: 'Date', value: longDate(d.iarDate) },
          { label: 'Requisitioning Office/Dept.', value: d.requisitioningOffice },
          { label: 'Invoice No.', value: d.invoiceNumber },
          { label: 'Responsibility Center Code', value: '' },
          { label: 'Invoice Date', value: longDate(d.invoiceDate) },
        ]),
        table(columns, rows),
        boxes([
          { label: 'INSPECTION', text: `Date inspected: ${longDate(d.inspectionDate ?? d.iarDate)}. ☑ Inspected, verified and found in order as to quantity and specifications.`, name: d.inspectedBy, position: 'Inspection Officer / Inspection Committee', date: d.inspectionDate },
          { ...ctx.sign('ACCEPTANCE', 'PROPERTY_OFFICER', d.iarDate), text: `Date received: ${longDate(d.iarDate)}. ${accepted ? '☑' : '☐'} ${complete ? 'Complete' : 'Partial (pls. specify quantity)'}`, date: null },
        ]),
      ],
      signatories: [ctx.sign('Approved by', 'PUNONG_BARANGAY', d.iarDate)],
      validations: [validation('PPE_CAPITALIZED', d.lines.every((l) => (l.kind === 'PPE') === l.unitCost >= 5_000_000), 'Items of ₱50,000 or more per unit are capitalized as PPE; lower-cost items go to stock.')],
      isEmpty: false,
      notes: draftNote(d.status, ['ACCEPTED']),
    };
  },
};

const ARDSM: ReportBuilder = {
  code: 'ARDSM',
  params: 'DOCUMENT',
  document: { collection: PROPERTY_COL.inspectionReports, numberField: 'documentNumber', dateField: 'iarDate', labelField: 'supplier' },
  async build(ctx) {
    const { d, rows, columns } = await receiptModel(ctx, true);
    return {
      subtitle: [],
      meta: [{ label: 'ARDSM No.', value: d.documentNumber ?? '(not yet numbered)' }, { label: 'Date', value: longDate(d.iarDate) }],
      sections: [
        fields([
          { label: 'Donor', value: d.supplier?.name ?? '' },
          { label: 'Address', value: d.supplier?.address ?? '' },
          { label: 'Purpose / remarks', value: d.remarks, span: 2 },
        ]),
        { kind: 'text', paragraphs: [`This is to acknowledge receipt of the following supplies and materials donated by ${d.supplier?.name ?? 'the donor'} to Barangay ${ctx.barangayName}:`] },
        table(columns, rows),
      ],
      signatories: [ctx.sign('Received by', 'PROPERTY_OFFICER', d.iarDate), ctx.sign('Noted by', 'PUNONG_BARANGAY', d.iarDate)],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['ACCEPTED']),
    };
  },
};

// ------------------------------------------------------------------ RIS

const RIS: ReportBuilder = {
  code: 'RIS',
  params: 'DOCUMENT',
  document: { collection: PROPERTY_COL.requisitions, numberField: 'risNumber', dateField: 'risDate', labelField: 'purpose' },
  async build(ctx) {
    const d = await loadDoc<RequisitionDoc>(ctx, PROPERTY_COL.requisitions, 'requisition and issue slip');
    const issued = d.status === 'ISSUED';
    const rows = d.lines.map((l) =>
      row({ stock: l.stockNumber, unit: l.unit, description: l.description, qtyReq: l.quantityRequested, yes: l.stockAvailable ? '✓' : null, no: l.stockAvailable ? null : '✓', qtyIss: issued ? l.quantityIssued : null, remarks: l.remarks }),
    );
    const at = d.issueDate ?? d.risDate;
    return {
      subtitle: [],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }],
      sections: [
        fields([
          { label: 'Division/Office', value: d.office },
          { label: 'Responsibility Center Code', value: d.responsibilityCenterCode },
          { label: 'RIS No.', value: d.risNumber ?? '(not yet numbered)' },
          { label: 'Date', value: longDate(d.risDate) },
        ]),
        table(
          [
            col('stock', 'Stock No.', 'code', { group: 'Requisition' }),
            col('unit', 'Unit', 'text', { group: 'Requisition' }),
            col('description', 'Description', 'text', { group: 'Requisition', width: 3 }),
            col('qtyReq', 'Quantity', 'number', { group: 'Requisition' }),
            col('yes', 'Yes', 'text', { group: 'Stock Available?' }),
            col('no', 'No', 'text', { group: 'Stock Available?' }),
            col('qtyIss', 'Quantity', 'number', { group: 'Issue' }),
            col('remarks', 'Remarks', 'text', { group: 'Issue' }),
          ],
          rows,
        ),
        { kind: 'text', paragraphs: [`Purpose: ${d.purpose}`] },
        boxes([
          { label: 'Requested by', name: d.requestedBy?.name ?? '', position: d.requestedBy?.position ?? '', date: d.risDate },
          { ...ctx.sign('Approved by', 'PUNONG_BARANGAY', d.risDate), date: null },
          { ...ctx.sign('Issued by', 'PROPERTY_OFFICER', at), date: issued ? d.issueDate : null },
          { label: 'Received by', name: d.receivedBy?.name ?? '', position: d.receivedBy?.position ?? '', date: issued ? d.issueDate : null },
        ]),
      ],
      signatories: [],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['ISSUED']),
    };
  },
};

// ------------------------------------------------------------------ ICS / PAR / RRPE

const ICS: ReportBuilder = {
  code: 'ICS',
  params: 'DOCUMENT',
  document: { collection: 'propertyDocuments', numberField: 'documentNumber', dateField: 'date', labelField: 'documentType' },
  async build(ctx) {
    const d = await loadPropertyDoc(ctx, 'ICS');
    const rows = d.lines.map((l) => row({ quantity: l.quantity, unit: l.unit, unitCost: l.unitCost, total: l.amount, description: l.description, itemNo: l.propertyNumber, life: l.estimatedUsefulLife ? `${l.estimatedUsefulLife} yr${l.estimatedUsefulLife > 1 ? 's' : ''}` : '' }));
    rows.push(row({ description: 'TOTAL', total: d.totalAmount }, 'grandtotal'));
    return {
      subtitle: [],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }, { label: 'ICS No.', value: d.documentNumber ?? '(on issue)' }],
      sections: [
        table(
          [
            col('quantity', 'Quantity', 'number'),
            col('unit', 'Unit'),
            col('unitCost', 'Unit Cost', 'money', { group: 'Amount' }),
            col('total', 'Total Cost', 'money', { group: 'Amount' }),
            col('description', 'Description', 'text', { width: 3 }),
            col('itemNo', 'Inventory Item No.', 'code'),
            col('life', 'Estimated Useful Life'),
          ],
          rows,
        ),
        boxes([
          { ...ctx.sign('Received from', 'PROPERTY_OFFICER', d.date), date: d.date },
          { label: 'Received by', name: d.receivedBy.name, position: [d.receivedBy.position, d.receivedBy.office].filter(Boolean).join(', '), date: d.date },
        ]),
      ],
      signatories: [ctx.sign('Approved by', 'PUNONG_BARANGAY', d.date)],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['ISSUED']),
    };
  },
};

const PAR: ReportBuilder = {
  code: 'PAR',
  params: 'DOCUMENT',
  document: { collection: 'propertyDocuments', numberField: 'documentNumber', dateField: 'date', labelField: 'documentType' },
  async build(ctx) {
    const d = await loadPropertyDoc(ctx, 'PAR');
    const rows = d.lines.map((l) => row({ quantity: l.quantity, unit: l.unit, description: l.description, propertyNumber: l.propertyNumber, acquired: l.acquisitionDate, amount: l.amount }));
    rows.push(row({ description: 'TOTAL', amount: d.totalAmount }, 'grandtotal'));
    return {
      subtitle: [],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }, { label: 'PAR No.', value: d.documentNumber ?? '(on issue)' }],
      sections: [
        table([col('quantity', 'Quantity', 'number'), col('unit', 'Unit'), col('description', 'Description', 'text', { width: 3 }), col('propertyNumber', 'Property Number', 'code'), col('acquired', 'Date Acquired', 'date'), col('amount', 'Amount', 'money')], rows),
        boxes([
          { label: 'Received by', name: d.receivedBy.name, position: [d.receivedBy.position, d.receivedBy.office].filter(Boolean).join(', '), date: d.date },
          { ...ctx.sign('Issued by', 'PROPERTY_OFFICER', d.date), date: d.date },
        ]),
      ],
      signatories: [ctx.sign('Approved by', 'PUNONG_BARANGAY', d.date)],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['ISSUED']),
    };
  },
};

const RRPE: ReportBuilder = {
  code: 'RRPE',
  params: 'DOCUMENT',
  document: { collection: 'propertyDocuments', numberField: 'documentNumber', dateField: 'date', labelField: 'documentType' },
  async build(ctx) {
    const d = await loadPropertyDoc(ctx, 'RRPE');
    const rows = d.lines.map((l) => row({ description: l.description, quantity: l.quantity, propertyNumber: l.propertyNumber, acquired: l.acquisitionDate, amount: l.amount, condition: [l.condition, l.remarks].filter(Boolean).join(' — ') }));
    rows.push(row({ description: 'TOTAL', amount: d.totalAmount }, 'grandtotal'));
    return {
      subtitle: [],
      meta: [{ label: 'RRPE No.', value: d.documentNumber ?? '(on approval)' }, { label: 'Date', value: longDate(d.date) }],
      sections: [
        { kind: 'text', paragraphs: [`This is to acknowledge receipt of the returned property/equipment (${d.reason}):`] },
        table([col('description', 'Item Description', 'text', { width: 3 }), col('quantity', 'Quantity', 'number'), col('propertyNumber', 'Property No.', 'code'), col('acquired', 'Date Acquired', 'date'), col('amount', 'Amount', 'money'), col('condition', 'Condition / Remarks', 'text', { width: 2 })], rows),
        boxes([
          { label: 'Returned by', name: d.receivedBy.name, position: d.receivedBy.position ?? '', date: d.date },
          { ...ctx.sign('Received by', 'PROPERTY_OFFICER', d.date), date: d.date },
        ]),
      ],
      signatories: [ctx.sign('Noted by', 'PUNONG_BARANGAY', d.date)],
      validations: [],
      isEmpty: false,
      notes: draftNote(d.status, ['ISSUED']),
    };
  },
};

// ------------------------------------------------------------------ stock card

async function itemAndLines(ctx: ReportContext) {
  const id = ctx.params.itemId;
  if (!id) throw new Error('Select a stock item.');
  const item = await ctx.ds.get<InventoryItemRecord>('inventoryItems', id);
  if (!item || item.barangayId !== ctx.params.barangayId) throw new Error('Stock item not found for this barangay.');
  const txs = await ctx.ds.list<InventoryTxRecord>('inventoryTransactions', [['barangayId', '==', ctx.params.barangayId], ['itemId', '==', id]]);
  return { item, lines: stockCardBalances(txs) };
}

const STOCK_CARD: ReportBuilder = {
  code: 'STOCK_CARD',
  params: 'YEAR',
  extras: [{ key: 'itemId', label: 'Stock item', kind: 'inventoryItem', required: true }],
  async build(ctx) {
    const { item, lines } = await itemAndLines(ctx);
    const before = lines.filter((l) => l.date < ctx.range.from);
    const during = lines.filter((l) => inRange(l.date, ctx.range));
    const opening = before.length ? before[before.length - 1]!.balance : 0;
    const rows: ReportRow[] = [row({ date: ctx.range.from, reference: 'Balance forwarded', balance: opening }, 'subheading')];
    for (const l of during)
      rows.push(row({ date: l.date, reference: `${l.referenceType} ${l.referenceNumber}`.trim(), receipt: l.quantity > 0 ? l.quantity : null, issue: l.quantity < 0 ? -l.quantity : null, office: l.quantity < 0 ? l.office : null, balance: l.balance, days: null }));
    const rec = during.filter((l) => l.quantity > 0).reduce((t, l) => t + l.quantity, 0);
    const iss = during.filter((l) => l.quantity < 0).reduce((t, l) => t - l.quantity, 0);
    const closing = roundQty(opening + rec - iss);
    rows.push(row({ reference: 'Totals / balance', receipt: roundQty(rec), issue: roundQty(iss), balance: closing }, 'total'));
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }],
      sections: [
        fields(
          [
            { label: 'Item', value: item.description },
            { label: 'Stock No.', value: item.stockNumber },
            { label: 'Description', value: `${ITEM_CLASSES.find((c) => c.value === item.itemClass)?.label ?? item.itemClass} · ${item.accountCode}` },
            { label: 'Re-order Point', value: item.reorderPoint },
            { label: 'Unit of Measurement', value: item.unit },
            { label: 'Moving-average unit cost', value: item.unitCost, type: 'money' },
          ],
          2,
        ),
        table(
          [
            col('date', 'Date', 'date'),
            col('reference', 'Reference', 'text', { width: 2 }),
            col('receipt', 'Qty.', 'number', { group: 'Receipt' }),
            col('issue', 'Qty.', 'number', { group: 'Issue' }),
            col('office', 'Office', 'text', { group: 'Issue' }),
            col('balance', 'Qty.', 'number', { group: 'Balance' }),
            col('days', 'No. of Days to Consume', 'number'),
          ],
          rows,
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'PROPERTY_OFFICER')],
      validations: lines.every((l) => l.date <= ctx.range.to) ? [validation('STOCK_CARD_EQUALS_ON_HAND', Math.abs(closing - item.quantityOnHand) < 1e-6, `Card balance ${closing} ${Math.abs(closing - item.quantityOnHand) < 1e-6 ? 'agrees with' : 'differs from'} the quantity on hand (${item.quantityOnHand}).`)] : [],
      isEmpty: during.length === 0 && opening === 0,
    };
  },
};

// ------------------------------------------------------------------ PEC / PELC (one PPE)

async function loadPpe(ctx: ReportContext): Promise<WithId<PpeRecord>> {
  const id = ctx.params.itemId;
  if (!id) throw new Error('Select a property (PPE).');
  const p = await ctx.ds.get<PpeRecord>('ppe', id);
  if (!p || p.barangayId !== ctx.params.barangayId) throw new Error('PPE not found for this barangay.');
  return p;
}

const PEC: ReportBuilder = {
  code: 'PEC',
  params: 'AS_OF',
  extras: [{ key: 'itemId', label: 'Property', kind: 'ppe', required: true }],
  async build(ctx) {
    const p = await loadPpe(ctx);
    const acc = (await ctx.accounts()).get(p.accountCode);
    const moves = [...(p.movements ?? [])].filter((m) => m.date <= ctx.range.to).sort((a, b) => a.date.localeCompare(b.date));
    let bal = 0;
    const rows: ReportRow[] = moves.map((m) => {
      const receipt = m.type === 'ACQUIRED' ? 1 : null;
      const out = m.type === 'DISPOSED' ? 1 : null;
      bal += (receipt ?? 0) - (out ?? 0);
      const issueQty = m.type === 'ISSUED' || m.type === 'TRANSFERRED' ? 1 : out;
      return row({ date: m.date, reference: m.reference, receipt, issueQty, officer: [m.person, m.location].filter(Boolean).join(' / ') || null, balance: bal, amount: bal ? p.acquisitionCost : 0, remarks: [m.type, m.remarks].filter(Boolean).join(' — ') });
    });
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund Cluster', value: fundName(p.fundId) }],
      sections: [
        fields([
          { label: 'Property, Plant and Equipment', value: `${p.accountCode} ${acc?.accountName ?? ''}` },
          { label: 'Property Number', value: p.propertyNumber },
          { label: 'Description', value: p.description, span: 2 },
        ]),
        table(
          [
            col('date', 'Date', 'date'),
            col('reference', 'Reference/ PAR No.', 'text', { width: 2 }),
            col('receipt', 'Qty.', 'number', { group: 'Receipt' }),
            col('issueQty', 'Qty.', 'number', { group: 'Issue/Transfer/ Disposal' }),
            col('officer', 'Office/Officer', 'text', { group: 'Issue/Transfer/ Disposal', width: 2 }),
            col('balance', 'Balance Qty.', 'number'),
            col('amount', 'Amount', 'money'),
            col('remarks', 'Remarks', 'text', { width: 2 }),
          ],
          rows,
          { emptyText: 'No movements recorded on or before this date.' },
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'PROPERTY_OFFICER')],
      validations: [],
      isEmpty: moves.length === 0,
    };
  },
};

/** Accumulated depreciation of one asset around a fiscal year (opening balance counts in its as-of year). */
function ppeYear(p: PpeRecord, deps: readonly PpeDepreciationDoc[], fy: number) {
  const opening = p.openingAccumulatedDepreciation ?? 0;
  const asOfYear = Number((p.openingAsOfPeriod ?? '0').slice(0, 4));
  const before = deps.filter((d) => d.fiscalYear < fy).reduce((t, d) => t + d.amount, 0) + (opening && asOfYear < fy ? opening : 0);
  const during = deps.filter((d) => d.fiscalYear === fy).reduce((t, d) => t + d.amount, 0) + (opening && asOfYear === fy ? opening : 0);
  return { beginning: before, thisYear: during, end: before + during };
}

const PELC: ReportBuilder = {
  code: 'PELC',
  params: 'YEAR',
  extras: [{ key: 'itemId', label: 'Property', kind: 'ppe', required: true }],
  async build(ctx) {
    const p = await loadPpe(ctx);
    const acc = (await ctx.accounts()).get(p.accountCode);
    const deps = (await ctx.ds.list<PpeDepreciationDoc>('ppeDepreciation', [['barangayId', '==', ctx.params.barangayId], ['ppeId', '==', p.id]]))
      .filter((d) => d.fiscalYear <= ctx.params.fiscalYear)
      .sort((a, b) => a.period.localeCompare(b.period));
    const rows: ReportRow[] = [];
    if (p.acquisitionDate <= ctx.range.to) rows.push(row({ date: p.acquisitionDate, reference: p.iarNumber ? `IAR ${p.iarNumber}` : p.sourceDvId ? `DV ${p.sourceDvId}` : 'Acquisition', qty: 1, unitCost: p.acquisitionCost, totalCost: p.acquisitionCost, accum: 0, impairment: null, issues: null, adjusted: p.acquisitionCost, repair: null, repairAmt: null }));
    let accum = p.openingAccumulatedDepreciation ?? 0;
    if (accum) rows.push(row({ date: null, reference: `Accumulated depreciation as of ${p.openingAsOfPeriod ?? ''} (balance forwarded)`, accum, adjusted: p.acquisitionCost - accum }));
    for (const d of deps) {
      accum += d.amount;
      rows.push(row({ date: lastDayOfMonth(d.fiscalYear, d.month), reference: `Depreciation ${d.period}`, accum, adjusted: p.acquisitionCost - accum }));
    }
    if (p.disposalDate && p.disposalDate <= ctx.range.to) rows.push(row({ date: p.disposalDate, reference: 'Disposed (IIRUP)', issues: p.acquisitionCost, adjusted: 0 }));
    const monthly = monthlyDepreciation(p.acquisitionCost, p.residualValue, p.usefulLifeYears);
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund Cluster', value: fundName(p.fundId) }],
      sections: [
        fields(
          [
            { label: 'Property, Plant and Equipment', value: `${p.accountCode} ${acc?.accountName ?? ''}` },
            { label: 'Object Account Code', value: p.accountCode },
            { label: 'Description', value: p.description },
            { label: 'Property Number', value: p.propertyNumber },
            { label: 'Estimated Useful Life', value: `${p.usefulLifeYears} years` },
            { label: 'Rate of Depreciation', value: `${(100 / p.usefulLifeYears).toFixed(2)}% per year · ${peso(monthly)} per month` },
            { label: 'Residual value', value: p.residualValue, type: 'money' },
            { label: 'Accumulated depreciation account', value: p.accumulatedDepreciationAccountCode },
          ],
          2,
        ),
        table(
          [
            col('date', 'Date', 'date'),
            col('reference', 'Reference', 'text', { width: 2 }),
            col('qty', 'Qty.', 'number', { group: 'Receipt' }),
            col('unitCost', 'Unit Cost', 'money', { group: 'Receipt' }),
            col('totalCost', 'Total Cost', 'money', { group: 'Receipt' }),
            col('accum', 'Accumulated Depreciation', 'money'),
            col('impairment', 'Accumulated Impairment Losses', 'money'),
            col('issues', 'Issues/ Transfers/ Adjustment/s', 'money'),
            col('adjusted', 'Adjusted Cost', 'money'),
            col('repair', 'Nature of Repair', 'text', { group: 'Repair History' }),
            col('repairAmt', 'Amount', 'money', { group: 'Repair History' }),
          ],
          rows,
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [validation('PELC_ACCUMULATED_MATCHES', ctx.params.fiscalYear < Number((p.lastDepreciatedPeriod ?? '0').slice(0, 4)) || accum === p.accumulatedDepreciation, `Ledger accumulated depreciation ${peso(accum)} agrees with the PPE record (${peso(p.accumulatedDepreciation)}).`)],
      isEmpty: rows.length === 0,
    };
  },
};

// ------------------------------------------------------------------ BAPC / QRBA

function bioLabel(b: BiologicalAssetDoc) {
  return `${b.kind}${b.description ? ` — ${b.description}` : ''}`;
}

async function bioAssets(ctx: ReportContext): Promise<Array<WithId<BiologicalAssetDoc>>> {
  return (await ctx.ds.list<BiologicalAssetDoc>('biologicalAssets', [['barangayId', '==', ctx.params.barangayId]]))
    .filter((b) => ['ACTIVE', 'DISPOSED', 'CLOSED'].includes(b.status) && (!ctx.params.documentId || b.id === ctx.params.documentId))
    .sort((a, b) => (a.assetNumber ?? '').localeCompare(b.assetNumber ?? ''));
}

const BAPC: ReportBuilder = {
  code: 'BAPC',
  params: 'YEAR',
  async build(ctx) {
    const assets = await bioAssets(ctx);
    const sections: ReportSection[] = [];
    for (const b of assets) {
      const moves = (b.movements ?? []).filter((m) => m.date <= ctx.range.to);
      const before = moves.filter((m) => m.date < ctx.range.from).at(-1);
      const rows: ReportRow[] = [row({ date: ctx.range.from, reference: 'Balance forwarded', balance: before?.balanceQuantity ?? 0, amount: before?.balanceAmount ?? 0 }, 'subheading')];
      for (const m of moves.filter((x) => x.date >= ctx.range.from)) {
        const inc = m.kind === 'ACQUISITION' || m.kind === 'BIRTH';
        rows.push(row({ date: m.date, reference: m.reference, receipt: inc ? m.quantity : null, issue: inc ? null : m.quantity, balance: m.balanceQuantity, amount: m.balanceAmount, remarks: [m.kind, m.remarks].filter(Boolean).join(' — ') }));
      }
      sections.push(fields([{ label: 'Biological asset', value: bioLabel(b) }, { label: 'Property / card no.', value: b.assetNumber ?? '' }, { label: 'Unit', value: b.unit }, { label: 'Location / custodian', value: [b.location, b.custodian].filter(Boolean).join(' / ') }], 4));
      sections.push(table([col('date', 'Date', 'date'), col('reference', 'Reference', 'text', { width: 2 }), col('receipt', 'Qty.', 'number', { group: 'Receipt / Increase' }), col('issue', 'Qty.', 'number', { group: 'Issue / Decrease' }), col('balance', 'Qty.', 'number', { group: 'Balance' }), col('amount', 'Amount', 'money', { group: 'Balance' }), col('remarks', 'Remarks', 'text', { width: 2 })], rows));
    }
    return {
      subtitle: [ctx.range.label],
      meta: [],
      sections: sections.length ? sections : [table([col('x', 'Biological assets')], [], { emptyText: 'No biological assets recorded.' })],
      signatories: [ctx.sign('Prepared by', 'PROPERTY_OFFICER')],
      validations: [],
      isEmpty: assets.length === 0,
    };
  },
};

const QRBA: ReportBuilder = {
  code: 'QRBA',
  params: 'QUARTER',
  async build(ctx) {
    const assets = await bioAssets(ctx);
    const rows: ReportRow[] = [];
    const t = { beg: 0, acq: 0, birth: 0, death: 0, disp: 0, end: 0, amount: 0 };
    for (const b of assets) {
      const moves = (b.movements ?? []).filter((m) => m.date <= ctx.range.to);
      const before = moves.filter((m) => m.date < ctx.range.from).at(-1);
      const q = moves.filter((m) => m.date >= ctx.range.from);
      const s = (k: string) => q.filter((m) => m.kind === k).reduce((x, m) => x + m.quantity, 0);
      const r = { beg: before?.balanceQuantity ?? 0, acq: s('ACQUISITION'), birth: s('BIRTH'), death: s('DEATH'), disp: s('DISPOSITION'), end: moves.at(-1)?.balanceQuantity ?? 0, amount: moves.at(-1)?.balanceAmount ?? 0 };
      if (!moves.length) continue;
      rows.push(row({ asset: bioLabel(b), number: b.assetNumber, unit: b.unit, beg: r.beg, acq: nz(r.acq), birth: nz(r.birth), death: nz(r.death), disp: nz(r.disp), end: r.end, amount: r.amount }));
      for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += r[k];
    }
    rows.push(row({ asset: 'TOTAL', ...t }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label],
      meta: [],
      sections: [
        table(
          [
            col('asset', 'Kind / Description', 'text', { width: 3 }),
            col('number', 'Card No.', 'code'),
            col('unit', 'Unit'),
            col('beg', 'Beginning', 'number'),
            col('acq', 'Purchased/ Acquired', 'number', { group: 'Additions' }),
            col('birth', 'Births/ Offspring', 'number', { group: 'Additions' }),
            col('death', 'Deaths', 'number', { group: 'Deductions' }),
            col('disp', 'Sold/ Disposed', 'number', { group: 'Deductions' }),
            col('end', 'Ending', 'number'),
            col('amount', 'Carrying Amount', 'money'),
          ],
          rows,
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'PROPERTY_OFFICER'), ctx.sign('Approved by', 'PUNONG_BARANGAY')],
      validations: [validation('BIO_ROLLFORWARD', rows.slice(0, -1).every((r) => (r.cells.beg as number) + ((r.cells.acq as number) ?? 0) + ((r.cells.birth as number) ?? 0) - ((r.cells.death as number) ?? 0) - ((r.cells.disp as number) ?? 0) === r.cells.end), 'Beginning + additions − deductions = ending for every asset.')],
      isEmpty: rows.length <= 1,
    };
  },
};

// ------------------------------------------------------------------ RSMI (monthly)

const RSMI: ReportBuilder = {
  code: 'RSMI',
  params: 'MONTH',
  async build(ctx) {
    const issues = (await ctx.ds.list<InventoryTxRecord>('inventoryTransactions', ctx.scope()))
      .filter((t) => t.kind === 'ISSUE' && (t.referenceType === 'RIS' || t.referenceType === 'ICS') && inRange(t.date, ctx.range))
      .sort((a, b) => a.date.localeCompare(b.date) || a.referenceNumber.localeCompare(b.referenceNumber) || a.stockNumber.localeCompare(b.stockNumber));
    const rows = issues.map((t) => row({ ref: t.referenceNumber, rcc: t.office, stock: t.stockNumber, item: t.description, unit: t.unit, qty: -t.quantity, unitCost: t.unitCost, amount: -t.totalCost }));
    const total = issues.reduce((s, t) => s - t.totalCost, 0);
    rows.push(row({ item: 'TOTAL', amount: total }, 'grandtotal'));
    const byStock = new Map<string, { stock: string; item: string; qty: number; amount: number; account: string }>();
    for (const t of issues) {
      const c = byStock.get(t.stockNumber) ?? { stock: t.stockNumber, item: t.description, qty: 0, amount: 0, account: t.accountCode };
      c.qty = roundQty(c.qty - t.quantity);
      c.amount -= t.totalCost;
      byStock.set(t.stockNumber, c);
    }
    const accounts = await ctx.accounts();
    const byAccount = new Map<string, number>();
    for (const c of byStock.values()) byAccount.set(c.account, (byAccount.get(c.account) ?? 0) + c.amount);
    const recap: TableSection = table(
      [col('stock', 'Stock No.', 'code'), col('item', 'Item', 'text', { width: 2 }), col('qty', 'Quantity', 'number'), col('unitCost', 'Unit Cost', 'money'), col('amount', 'Total Cost', 'money'), col('account', 'UACS Object Code', 'code')],
      [...byStock.values()].sort((a, b) => a.stock.localeCompare(b.stock)).map((c) => row({ stock: c.stock, item: c.item, qty: c.qty, unitCost: c.qty ? Math.round(c.amount / c.qty) : null, amount: c.amount, account: c.account })),
      { title: 'Recapitulation' },
    );
    const byAcct = table(
      [col('account', 'Account Code', 'code'), col('name', 'Account Title', 'text', { width: 3 }), col('amount', 'Amount', 'money')],
      [...[...byAccount.entries()].sort().map(([a, v]) => row({ account: a, name: accounts.get(a)?.accountName ?? a, amount: v })), row({ name: 'TOTAL', amount: total }, 'grandtotal')],
      { title: 'Recapitulation by account (for the JEV: Dr expense / Cr inventory)' },
    );
    const ris = (await ctx.ds.list<RequisitionDoc>(PROPERTY_COL.requisitions, ctx.scope())).filter((r) => r.status === 'ISSUED' && inRange(r.issueDate ?? r.risDate, ctx.range));
    const icsDocs = (await ctx.ds.list<PropertyDocumentDoc>('propertyDocuments', ctx.scope())).filter((d) => d.documentType === 'ICS' && d.status === 'ISSUED' && inRange(d.date, ctx.range));
    const docTotal = ris.reduce((t, r) => t + r.totalIssuedCost, 0) + icsDocs.reduce((t, d) => t + d.totalAmount, 0);
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }, { label: 'Serial No.', value: `${ctx.params.fiscalYear}-${String(ctx.params.month ?? 1).padStart(2, '0')}` }],
      sections: [
        { kind: 'text', title: 'To be filled up by the Supply and/or Property Division/Unit', paragraphs: [] },
        table(
          [
            col('ref', 'RIS No.', 'code'),
            col('rcc', 'Responsibility Center Code', 'text'),
            col('stock', 'Stock No.', 'code'),
            col('item', 'Item', 'text', { width: 3 }),
            col('unit', 'Unit', 'text'),
            col('qty', 'Quantity Issued', 'number'),
            col('unitCost', 'Unit Cost', 'money'),
            col('amount', 'Amount', 'money'),
          ],
          rows,
        ),
        recap,
        byAcct,
      ],
      signatories: [ctx.sign('I hereby certify to the correctness of the above information.', 'PROPERTY_OFFICER'), ctx.sign('Posted by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [validation('RSMI_TIES_TO_RIS', total === docTotal, total === docTotal ? `Issues ${peso(total)} agree with the issued RIS/ICS documents.` : `Stock-card issues ${peso(total)} differ from issued RIS/ICS totals ${peso(docTotal)}.`)],
      isEmpty: issues.length === 0,
    };
  },
};

// ------------------------------------------------------------------ RPCI (semestral count of supplies)

const RPCI: ReportBuilder = {
  code: 'RPCI',
  params: 'SEMESTER',
  async build(ctx) {
    const bid = ctx.params.barangayId;
    const items = (await ctx.ds.list<InventoryItemRecord>('inventoryItems', [['barangayId', '==', bid]])).sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.stockNumber.localeCompare(b.stockNumber));
    const txs = await ctx.ds.list<InventoryTxRecord>('inventoryTransactions', [['barangayId', '==', bid]]);
    const accounts = await ctx.accounts();
    const rows: ReportRow[] = [];
    let uncounted = 0;
    let grand = 0;
    let shortValue = 0;
    for (const code of [...new Set(items.map((i) => i.accountCode))]) {
      rows.push(row({ article: `${code} ${accounts.get(code)?.accountName ?? ''}` }, 'heading'));
      let sub = 0;
      for (const i of items.filter((x) => x.accountCode === code)) {
        const lines = stockCardBalances(txs.filter((t) => t.itemId === i.id && t.date <= ctx.range.to));
        const last = lines.at(-1);
        const balance = last?.balance ?? 0;
        const unitValue = last?.balanceUnitCost ?? i.unitCost;
        if (!balance && !i.active) continue;
        const count = i.lastCount && inRange(i.lastCount.date, ctx.range) ? i.lastCount.quantity : null;
        if (count === null) uncounted++;
        const diff = count === null ? null : roundQty(count - balance);
        const value = Math.round(balance * unitValue);
        sub += value;
        if (diff) shortValue += Math.round(diff * unitValue);
        rows.push(
          row({
            article: ITEM_CLASSES.find((c) => c.value === i.itemClass)?.label ?? i.itemClass,
            description: i.description,
            stock: i.stockNumber,
            unit: i.unit,
            unitValue,
            card: balance,
            count,
            diffQty: diff ? diff : null,
            diffValue: diff ? Math.round(diff * unitValue) : null,
            totalValue: value,
            remarks: i.lastCount?.remarks ?? (count === null ? 'Not yet counted' : ''),
          }),
        );
      }
      rows.push(row({ article: `Total ${code}`, totalValue: sub }, 'subtotal'));
      grand += sub;
    }
    rows.push(row({ article: 'GRAND TOTAL', totalValue: grand, diffValue: shortValue || null }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label, 'Type of Inventory Item: Supplies and Materials / Semi-expendable Property'],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }, { label: 'As at', value: longDate(ctx.range.to) }],
      sections: [
        table(
          [
            col('article', 'Article', 'text', { width: 2 }),
            col('description', 'Description', 'text', { width: 3 }),
            col('stock', 'Stock Number', 'code'),
            col('unit', 'Unit of Measure', 'text'),
            col('unitValue', 'Unit Value', 'money'),
            col('card', 'Balance Per Card (Quantity)', 'number'),
            col('count', 'On Hand Per Count (Quantity)', 'number'),
            col('diffQty', 'Quantity', 'number', { group: 'Shortage/Overage' }),
            col('diffValue', 'Value', 'money', { group: 'Shortage/Overage' }),
            col('totalValue', 'Total Value per Card', 'money'),
            col('remarks', 'Remarks', 'text', { width: 2 }),
          ],
          rows,
        ),
      ],
      signatories: [ctx.sign('Certified correct by', 'PROPERTY_OFFICER'), ctx.sign('Approved by', 'PUNONG_BARANGAY'), ctx.sign('Verified by', 'COA_AUDITOR')],
      validations: [validation('PHYSICAL_COUNT_RECORDED', uncounted === 0 ? true : 'WARNING', uncounted === 0 ? 'Every stock item has a physical count this semester.' : `${uncounted} stock item(s) have no physical count this semester.`)],
      isEmpty: items.length === 0,
    };
  },
};

// ------------------------------------------------------------------ RPCPPE / IIRUP / depreciation schedule

/** PPE on the books at a date: acquired by then and not yet disposed. */
function onBooks(p: PpeRecord, date: string): boolean {
  return ['ACTIVE', 'UNSERVICEABLE', 'DISPOSED', 'TRANSFERRED'].includes(p.status) && p.acquisitionDate <= date && !(p.disposalDate && p.disposalDate <= date);
}

const RPCPPE: ReportBuilder = {
  code: 'RPCPPE',
  params: 'AS_OF',
  async build(ctx) {
    const all = await ctx.ds.list<PpeRecord>('ppe', [['barangayId', '==', ctx.params.barangayId]]);
    const list = all.filter((p) => onBooks(p, ctx.range.to)).sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.propertyNumber.localeCompare(b.propertyNumber));
    const accounts = await ctx.accounts();
    const rows: ReportRow[] = [];
    let uncounted = 0;
    let grand = 0;
    for (const code of [...new Set(list.map((p) => p.accountCode))]) {
      const name = accounts.get(code)?.accountName ?? code;
      rows.push(row({ article: `${code} ${name}` }, 'heading'));
      let sub = 0;
      for (const p of list.filter((x) => x.accountCode === code)) {
        const c = p.lastCount && p.lastCount.date.slice(0, 4) === ctx.range.to.slice(0, 4) && p.lastCount.date <= ctx.range.to ? p.lastCount : null;
        if (!c) uncounted++;
        const count = c ? (c.found ? 1 : 0) : null;
        const short = count === null ? null : count - 1;
        sub += p.acquisitionCost;
        rows.push(
          row({
            article: name,
            description: p.description,
            propertyNumber: p.propertyNumber,
            unit: p.unit ?? 'unit',
            unitValue: p.acquisitionCost,
            card: 1,
            count,
            shortQty: short ? short : null,
            shortValue: short ? short * p.acquisitionCost : null,
            remarks: [p.location, p.accountablePerson, c?.condition ?? (p.status === 'UNSERVICEABLE' ? 'Unserviceable' : p.condition === 'UNSERVICEABLE' ? 'Unserviceable' : 'Serviceable'), count === null ? 'not yet counted' : ''].filter(Boolean).join(' · '),
          }),
        );
      }
      rows.push(row({ article: `Total ${name}`, unitValue: sub }, 'subtotal'));
      grand += sub;
    }
    rows.push(row({ article: 'GRAND TOTAL', unitValue: grand }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label, 'Type of Property, Plant and Equipment: All classes'],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }],
      sections: [
        table(
          [
            col('article', 'Article', 'text', { width: 2 }),
            col('description', 'Description', 'text', { width: 3 }),
            col('propertyNumber', 'Property Number', 'code'),
            col('unit', 'Unit of Measure', 'text'),
            col('unitValue', 'Unit Value', 'money'),
            col('card', 'Quantity per Property Card', 'number'),
            col('count', 'Quantity per Physical Count', 'number'),
            col('shortQty', 'Quantity', 'number', { group: 'Shortage/Overage' }),
            col('shortValue', 'Value', 'money', { group: 'Shortage/Overage' }),
            col('remarks', 'Remarks (location, accountable officer, condition)', 'text', { width: 3 }),
          ],
          rows,
        ),
      ],
      signatories: [ctx.sign('Certified correct by', 'PROPERTY_OFFICER'), ctx.sign('Approved by', 'PUNONG_BARANGAY'), ctx.sign('Verified by', 'COA_AUDITOR')],
      validations: [validation('PHYSICAL_COUNT_RECORDED', uncounted === 0 ? true : 'WARNING', uncounted === 0 ? 'Every PPE item has a physical count this year.' : `${uncounted} PPE item(s) have no physical count this year.`)],
      isEmpty: list.length === 0,
    };
  },
};

const IIRUP: ReportBuilder = {
  code: 'IIRUP',
  params: 'AS_OF',
  async build(ctx) {
    const docs = (await ctx.ds.list<PropertyDocumentDoc>('propertyDocuments', ctx.scope()))
      .filter((d) => d.documentType === 'IIRUP' && ['APPROVED', 'DISPOSED'].includes(d.status) && inRange(d.date, ctx.range))
      .sort((a, b) => a.date.localeCompare(b.date));
    const rows: ReportRow[] = [];
    const t = { total: 0, accum: 0, carrying: 0, appraised: 0 };
    for (const d of docs) {
      rows.push(row({ acquired: null, particulars: `IIRUP ${d.documentNumber ?? ''} — ${longDate(d.date)}${d.status === 'DISPOSED' ? ` · disposed ${longDate(d.disposalDate)}` : ''}` }, 'subheading'));
      for (const l of d.lines) {
        const mode = (m: string) => (l.disposalMode === m ? (l.carryingAmount ?? 0) : null);
        rows.push(
          row({
            acquired: l.acquisitionDate,
            particulars: l.description,
            propertyNumber: l.propertyNumber,
            qty: l.quantity,
            unitCost: l.unitCost,
            total: l.amount,
            accum: l.accumulatedDepreciation ?? 0,
            impairment: null,
            carrying: l.carryingAmount ?? 0,
            remarks: l.remarks,
            sale: mode('SALE'),
            transfer: mode('TRANSFER'),
            destruction: mode('DESTRUCTION'),
            others: l.disposalMode === 'OTHERS' ? (l.carryingAmount ?? 0) : null,
            appraised: l.appraisedValue ?? 0,
            orNo: l.disposalMode === 'SALE' && d.status === 'DISPOSED' ? d.disposalReference ?? '' : null,
          }),
        );
        t.total += l.amount;
        t.accum += l.accumulatedDepreciation ?? 0;
        t.carrying += l.carryingAmount ?? 0;
        t.appraised += l.appraisedValue ?? 0;
      }
    }
    rows.push(row({ particulars: 'TOTAL', total: t.total, accum: t.accum, carrying: t.carrying, appraised: t.appraised }, 'grandtotal'));
    const disposalLabel = (v: string) => DISPOSAL_MODES.find((m) => m.value === v)?.label ?? v;
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund Cluster', value: 'General Fund' }],
      sections: [
        table(
          [
            col('acquired', 'Date Acquired', 'date', { group: 'INVENTORY' }),
            col('particulars', 'Particulars/ Articles', 'text', { group: 'INVENTORY', width: 3 }),
            col('propertyNumber', 'Property No.', 'code', { group: 'INVENTORY' }),
            col('qty', 'Qty', 'number', { group: 'INVENTORY' }),
            col('unitCost', 'Unit Cost', 'money', { group: 'INVENTORY' }),
            col('total', 'Total Cost', 'money', { group: 'INVENTORY' }),
            col('accum', 'Accumulated Depreciation', 'money', { group: 'INVENTORY' }),
            col('impairment', 'Accumulated Impairment Losses', 'money', { group: 'INVENTORY' }),
            col('carrying', 'Carrying Amount', 'money', { group: 'INVENTORY' }),
            col('remarks', 'Remarks', 'text', { group: 'INVENTORY' }),
            col('sale', disposalLabel('SALE'), 'money', { group: 'INSPECTION and DISPOSAL' }),
            col('transfer', disposalLabel('TRANSFER'), 'money', { group: 'INSPECTION and DISPOSAL' }),
            col('destruction', disposalLabel('DESTRUCTION'), 'money', { group: 'INSPECTION and DISPOSAL' }),
            col('others', 'Others (Specify)', 'money', { group: 'INSPECTION and DISPOSAL' }),
            col('appraised', 'Appraised Value', 'money', { group: 'INSPECTION and DISPOSAL' }),
            col('orNo', 'OR No.', 'code', { group: 'RECORD OF SALES' }),
          ],
          rows,
        ),
        boxes([
          { ...ctx.sign('Requested by', 'PROPERTY_OFFICER'), text: 'I HEREBY request inspection and disposition, pursuant to Section 79 of PD 1445, of the property enumerated above.', date: null },
          { ...ctx.sign('Approved by', 'PUNONG_BARANGAY'), date: null },
          { label: 'Inspection officer', text: 'I CERTIFY that I have inspected each and every article enumerated in this report, and that the disposition made thereof was, in my judgment, the best for the public interest.', name: '', position: 'Inspection Officer', date: null },
          { label: 'Witness', text: 'I CERTIFY that I have witnessed the disposition of the articles enumerated on this report.', name: '', position: 'Witness', date: null },
        ]),
      ],
      signatories: [],
      validations: [],
      isEmpty: docs.length === 0,
    };
  },
};

const PPE_DEPRECIATION: ReportBuilder = {
  code: 'PPE_DEPRECIATION',
  params: 'YEAR',
  async build(ctx) {
    const fy = ctx.params.fiscalYear;
    const bid = ctx.params.barangayId;
    const all = await ctx.ds.list<PpeRecord>('ppe', [['barangayId', '==', bid]]);
    const list = all
      .filter((p) => ['ACTIVE', 'UNSERVICEABLE', 'DISPOSED', 'TRANSFERRED'].includes(p.status) && p.acquisitionDate <= ctx.range.to && !(p.disposalDate && p.disposalDate < ctx.range.from) && p.accumulatedDepreciationAccountCode)
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.propertyNumber.localeCompare(b.propertyNumber));
    const deps = (await ctx.ds.list<PpeDepreciationDoc>('ppeDepreciation', [['barangayId', '==', bid]])).filter((d) => d.fiscalYear <= fy);
    const byPpe = new Map<string, PpeDepreciationDoc[]>();
    for (const d of deps) byPpe.set(d.ppeId, [...(byPpe.get(d.ppeId) ?? []), d]);
    const accounts = await ctx.accounts();
    const rows: ReportRow[] = [];
    const grand = { cost: 0, residual: 0, monthly: 0, beginning: 0, thisYear: 0, end: 0, nbv: 0 };
    const perContra = new Map<string, number>();
    for (const code of [...new Set(list.map((p) => p.accountCode))]) {
      rows.push(row({ propertyNumber: code, description: accounts.get(code)?.accountName ?? code }, 'heading'));
      const sub = { cost: 0, residual: 0, monthly: 0, beginning: 0, thisYear: 0, end: 0, nbv: 0 };
      for (const p of list.filter((x) => x.accountCode === code)) {
        const y = ppeYear(p, byPpe.get(p.id) ?? [], fy);
        const monthly = monthlyDepreciation(p.acquisitionCost, p.residualValue, p.usefulLifeYears);
        const r = { cost: p.acquisitionCost, residual: p.residualValue, monthly, beginning: y.beginning, thisYear: y.thisYear, end: y.end, nbv: p.acquisitionCost - y.end };
        rows.push(row({ propertyNumber: p.propertyNumber, description: p.description, acquired: p.acquisitionDate, life: p.usefulLifeYears, ...r }, 'normal', 1));
        for (const k of Object.keys(sub) as Array<keyof typeof sub>) sub[k] += r[k];
        perContra.set(p.accumulatedDepreciationAccountCode, (perContra.get(p.accumulatedDepreciationAccountCode) ?? 0) + y.end);
      }
      rows.push(row({ description: `Total ${accounts.get(code)?.accountName ?? code}`, ...sub }, 'subtotal'));
      for (const k of Object.keys(grand) as Array<keyof typeof grand>) grand[k] += sub[k];
    }
    rows.push(row({ description: 'GRAND TOTAL', ...grand }, 'grandtotal'));

    // Tie-out: schedule accumulated depreciation per contra account vs posted GL balances (1-07-xx-xx1).
    const lines = await postedLines(ctx);
    const gl = new Map<string, number>();
    for (const l of lines) if (perContra.has(l.accountCode)) gl.set(l.accountCode, (gl.get(l.accountCode) ?? 0) + l.credit - l.debit);
    const tie = table(
      [col('account', 'Accumulated depreciation account', 'code'), col('name', 'Account title', 'text', { width: 3 }), col('schedule', 'Per schedule', 'money'), col('gl', 'Per General Ledger (posted)', 'money'), col('diff', 'Difference', 'money')],
      [...perContra.entries()].sort().map(([a, v]) => row({ account: a, name: accounts.get(a)?.accountName ?? a, schedule: v, gl: gl.get(a) ?? 0, diff: v - (gl.get(a) ?? 0) })),
      { title: 'Reconciliation with the General Ledger' },
    );
    const mismatches = [...perContra.entries()].filter(([a, v]) => v !== (gl.get(a) ?? 0)).length;
    const runs = await ctx.ds.list<DepreciationRunDoc>(PROPERTY_COL.depreciationRuns, ctx.scope());
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }, { label: 'Depreciation runs', value: runs.map((r) => r.period.slice(5)).sort().join(', ') || 'none' }],
      sections: [
        table(
          [
            col('propertyNumber', 'Property No.', 'code'),
            col('description', 'Description', 'text', { width: 3 }),
            col('acquired', 'Date Acquired', 'date'),
            col('cost', 'Acquisition Cost', 'money'),
            col('residual', 'Residual Value', 'money'),
            col('life', 'Useful Life (yrs)', 'number'),
            col('monthly', 'Monthly Depreciation', 'money'),
            col('beginning', 'Beginning', 'money', { group: 'Accumulated Depreciation' }),
            col('thisYear', 'This Year', 'money', { group: 'Accumulated Depreciation' }),
            col('end', 'End of Year', 'money', { group: 'Accumulated Depreciation' }),
            col('nbv', 'Net Book Value', 'money'),
          ],
          rows,
        ),
        tie,
      ],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [
        validation(
          'PPE_TIES_TO_GL',
          mismatches === 0 ? true : 'WARNING',
          mismatches === 0 ? 'Accumulated depreciation per schedule agrees with the posted General Ledger.' : `${mismatches} accumulated depreciation account(s) differ from the posted GL (unposted depreciation JEVs or opening balances not yet entered).`,
        ),
      ],
      notes: ['Straight-line method: (acquisition cost − residual value) ÷ useful life in months; residual value 5% of cost unless stated. Depreciation starts the month of acquisition when acquired on or before the 15th, otherwise the following month.'],
      isEmpty: list.length === 0,
    };
  },
};

export const PROPERTY_REPORTS: ReportBuilder[] = [PR, PO, AIR, ARDSM, RIS, ICS, PAR, RRPE, STOCK_CARD, PEC, PELC, BAPC, QRBA, RSMI, RPCI, RPCPPE, IIRUP, PPE_DEPRECIATION];
