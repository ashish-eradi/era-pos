# Indian retail delivery sequence

### Configure cashier discounts

Open **Discounts** in the owner workspace. Set a whole percentage of the bill subtotal or a flat limit in minor currency units (5000 paise is ₹50). The initial limit is zero. Add coupon codes for fixed amounts or whole percentages, optionally scoped to a SKU and an expiry date. An expiry date includes that entire UTC day. Save and download the catalog on each register.

At checkout, select **Request discount** and enter either a manual amount or one coupon code. The counter applies item offers to the matching line before it calculates GST. Cash, UPI and split payments support coupons and manual amounts within the cap. Above-cap manual discounts follow the existing owner-approved cash workflow. Synced receipts retain the applied coupon and its line allocation for refunds.

For WhatsApp Business receipts, configure the Twilio account and token used for SMS and set `ERA_WHATSAPP_FROM` to the approved WhatsApp sender in international number format. Free-form provider messages require an active customer service window. The counter also offers a WhatsApp draft that opens a prefilled bill for the operator to review and send. [Twilio messaging guidance](https://www.twilio.com/docs/whatsapp/message-features)

| Increment | Implementation | Acceptance |
|---|---|---|
| Counter and merchant polish | Share dialog, status and theme styles. Connect checkout search, payment selection, customer editing and inventory line selection to existing workflows. | Scan and park a cart, cancel clearing it, resume and take split payment. Find a customer by phone, edit the record, then scan a barcode into a stock count. |
| WhatsApp receipts | Extend the saved-receipt delivery service, deduplication key and counter action. Offer a customer-directed WhatsApp draft. | Repeat a provider-backed request, inspect the sender and recipient, and open a draft without marking it delivered. |
| MRP and weighed goods | Version the catalog CSV and snapshots with optional MRP, base unit and precision. Store billed quantities as fixed-point values across local drafts, stock movements, sales, returns and exports. Snapshot the original MRP for reprints. | Reopen an old counter cache, sell 0.125 kg at a per-kg price, partially return it and reconcile remaining stock, GST and savings to the paise. Verify a pilot scale separately. |
| Discounts and offers | Store merchant caps and promotion rules. Share deterministic line allocations between the counter and API. Snapshot each adjustment and validate approval on sync. | Exercise cap boundaries, expired coupons, offline replay, split tender and partial returns. |
| GST reporting | Extend the sale and credit snapshots with cess and original-invoice references. Generate period reports by GST registration with B2B, B2C, notes and HSN totals. | Reconcile each sheet with the sales and returns ledgers and review a sample period with the accountant. |
| E-invoice and transport documents | Add provider requests, persisted status, signed QR and IRN rendering, cancellation and e-way bill references. | Confirm registration and retries with the chosen GSP sandbox before enabling live issuance. |
| Khata and card | Build a per-customer credit ledger and enforce limits under concurrent checkout. Capture card terminal references and reconcile refunds before integrating the selected terminal. | Race two charges against one limit, replay settlements, reconcile a return and test a terminal timeout. |
| Batch stock and languages | Track received lots and expiry through PO receipts, transfers, FEFO selection and returns. Externalize counter and receipt labels and verify Hindi and the selected regional language. | Trace a returned lot to its delivery and print representative scripts on the pilot printer. |
