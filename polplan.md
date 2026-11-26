# ERA POS — UI Polish & Indian Retail Feature Plan

## Goal
Transform ERA POS from a functionally rich developer prototype into a commercial-grade Indian retail POS by:
1. Fixing visible UI/UX rough edges so the Counter and Merchant Web apps feel cohesive, fast, and touch/operator-friendly.
2. Closing the remaining feature gaps expected by Indian retail stores (kirana, apparel, FMCG, electronics).

---

## Phase 1 — UI/UX Polish & Rough-Edge Fixes (Immediate, Low Risk)
*Target: Make the existing features look and feel like a finished product without changing core backend contracts.*

1. **Fix encoding artifacts & visual bugs**
   - Replace `Â·` mojibake with `·` in [SaleReceipt.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/SaleReceipt.tsx) and [Checkout.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/Checkout.tsx).
2. **Upgrade the shared design system ([theme.css](file:///c:/Users/ashish/Desktop/era-pos/packages/ui/theme.css))**
   - Add elevation/shadow tokens, status pill/badge styles (`synced`, `pending`, `rejected`, `low-stock`), native `<dialog>` modal styling, and consistent empty-state & loading-skeleton styles.
   - Add optional dark-mode tokens for evening counter shifts.
3. **Add iconography across Web & Counter**
   - Install/use `lucide-react` in `apps/web` (already used in `apps/counter`) for sidebar navigation, section headers, table actions, and empty states.
4. **Replace raw `<details>` & `window.confirm()` with proper UI patterns**
   - **Counter Checkout ([Checkout.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/Checkout.tsx))**:
     - Replace the flat `<select>` customer dropdown with a searchable customer picker (search by phone, name, or code).
     - Replace `window.confirm('Clear the current cart?')` with an in-app confirmation modal.
     - Group Cash / UPI / Split tender into a cleaner payment panel/modal instead of a stacked `<fieldset>`.
     - Surface [SendReceipt.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/SendReceipt.tsx) as an inline action bar instead of a collapsed `<details>` toggle.
   - **Merchant Inventory ([Inventory.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/web/src/merchant/Inventory.tsx))**:
     - Replace the "all SKUs in one giant table" delivery/count form with a searchable/barcode SKU picker that adds only selected rows.
   - **Merchant Customers ([Customers.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/web/src/merchant/Customers.tsx))**:
     - Move Add/Edit customer forms into a clean modal/drawer instead of `<details>`.

---

## Phase 2 — Core Indian Retail Checkout & Receipt Features
*Target: Cover daily counter workflows that Indian stores expect out of the box.*

1. **WhatsApp Receipt Sharing**
   - Extend `apps/api/src/modules/cash/digital-receipts.ts` and [SendReceipt.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/SendReceipt.tsx) to support a `whatsapp` channel (API-backed WhatsApp Business/provider integration, plus a fallback `wa.me` formatted bill link).
2. **MRP & Savings Display**
   - Add optional `mrpMinor` to catalog items (`apps/api` migration + CSV import + `CatalogSnapshotV1` in `packages/contracts`).
   - Show MRP, selling price, and total "You saved" on [Checkout.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/Checkout.tsx) and [SaleReceipt.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/SaleReceipt.tsx).
3. **Fractional / Weighted Quantities & Units**
   - Add `unit` (`pcs`, `kg`, `g`, `L`, `ml`) and `allowDecimal` to catalog items.
   - Update quantity validation and `saleTotals` in [gst.ts](file:///c:/Users/ashish/Desktop/era-pos/packages/contracts/src/gst.ts) and [Checkout.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/Checkout.tsx) (currently `min="1" step="1"`), plus optional serial/USB weighing-scale input.
4. **Flexible Discounts & Basic Offers**
   - Allow merchants to configure a cashier self-discount cap (e.g., up to 5% or ₹50 without needing an owner approval code) while keeping owner approval for larger overrides.
   - Add basic bill/item-level promo rules (% off, flat off, coupon code).

---

## Phase 3 — Indian GST & Accounting Compliance
*Target: Make tax filing and B2B billing seamless for Indian merchants and CAs.*

1. **GSTR-1 & HSN Summary Exports**
   - Add a `GSTR-1` report generator alongside [tally.ts](file:///c:/Users/ashish/Desktop/era-pos/apps/web/src/merchant/tally.ts) exporting B2B, B2C Large, B2C Small, HSN-wise summary, and Credit/Debit Note sheets (CSV/JSON).
2. **GST Cess Support**
   - Extend `GstLine` in [gst.ts](file:///c:/Users/ashish/Desktop/era-pos/packages/contracts/src/gst.ts) and receipt/report totals to support Cess where applicable.
3. **E-Invoicing (IRN + QR) & E-Way Bill Hook**
   - Add optional GSP/NIC E-Invoice integration for B2B invoices (`buyer.gstin` present) to stamp IRN and signed QR onto [SaleReceipt.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/SaleReceipt.tsx).

---

## Phase 4 — Credit (Udhaar/Khata), Card/EDC & Inventory Depth
*Target: Support higher-volume retail and multi-tender/credit stores.*

1. **Customer Credit / Udhaar (Khata)**
   - Add customer credit balance, credit limit, "Pay on Credit" tender in [Checkout.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/counter/src/renderer/Checkout.tsx), and payment/settlement ledger in [Customers.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/web/src/merchant/Customers.tsx).
2. **Card / EDC Terminal Tender**
   - Add `card` tender (manual card-slip reference/RRN first, followed by Pine Labs / Paytm / Razorpay POS terminal integration).
3. **Batch & Expiry Tracking**
   - Optional batch number and expiry date on supplier deliveries/purchase orders with FEFO suggestions and expiry alerts in [Inventory.tsx](file:///c:/Users/ashish/Desktop/era-pos/apps/web/src/merchant/Inventory.tsx).
4. **Multi-Language UI & Receipts (i18n)**
   - Externalize Counter and receipt labels to support Hindi and regional Indian languages.
