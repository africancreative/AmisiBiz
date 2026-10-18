# AmisiBiz Product Requirements Document (PRD)

**Product:** AmisiBiz Social Commerce & Marketing Intelligence Platform  
**Owner:** Amisi Genuine Enterprises  
**Authority:** AGENT 00 — Chief Engineering Orchestrator  
**Status:** Approved Master Product Description  
**Sequencing:** This PRD defines the target, not the build order. Execution order follows `docs/ROADMAP.md` (Phase 1 production MVP hardening precedes advanced modules). Standing R1 regulatory guards apply throughout: no eTIMS transmission and no automated payment-gateway charge, suspension, or webhook flows may be introduced or claimed until the owner approves the live integrations.

---

## 1. Product Vision & Goals

AmisiBiz is a multi-tenant Social Commerce, Mini-CRM, and Marketing Intelligence Platform built for modern commercial businesses in Kenya and across East Africa.

The platform bridges social interactions (WhatsApp, Instagram, Facebook, SMS) with core ERP/CRM back-office capabilities (quotations, invoicing, payments, delivery notes, product catalogues, customer intelligence, marketing campaigns, and tax compliance).

---

## 2. Personas & Workspaces

1. **Amisi Genuine Internal Staff (Provider Workspace - `/admin/*`):**
   - Platform superadmins and support operators.
   - Responsible for business onboarding, workspace activation, plan administration, tenant status history, and cross-tenant security audits.
2. **Business Owners & Operators (Tenant Business Workspace - `/app/*` & `/dashboard`):**
   - Tenant owners, sales agents, finance officers, inventory managers.
   - Manages CRM contacts, catalogues, sales pipelines, quotations, invoices, payments, social inbox, marketing campaigns, and business branding.
3. **End Customers (Customer Portal - `/portal/*`):**
   - B2B and retail clients of each tenant.
   - Signs in to view, accept, and securely download PDF quotations, invoices, delivery notes, and payment receipts.

---

## 3. Detailed Functional Modules (17 Capabilities)

### 1. Authentication & Tenant Security

- Native credential authentication (bcrypt cost 12).
- Web Crypto HMAC-SHA256 signed sessions (`amisibiz_session`).
- Monotonic `sessionVersion` instant revocation.
- Subdomain isolation (`<slug>.amisibiz.com`).
- Rate limiting per IP and per credential on login, register, and password reset.
- Mailtrap transactional password reset flow with single-use tokens.

### 2. Provider-Controlled Onboarding & Owner Invitations

- Businesses are provisioned by Amisi Genuine in `PENDING` state.
- Business owners receive an invitation link with a cryptographic token.
- Multi-step invitation acceptance sets up the owner credentials and binds the workspace.
- Activation to `ACTIVE` status is an explicit, audited operator action.

### 3. Manual Subscription & Plan Administration

- Plans are informational and governed manually by Amisi Genuine.
- No automated payment gateway suspension; business suspension is an operator-controlled decision with mandatory audit reasoning.
- Feature flags gate access to advanced modules (Social Inbox, Marketing Studio, Amisi Intelligence AI) based on assigned plan.

### 4. CRM & Customer Intelligence

- Customer records with multi-address management (physical, billing, delivery).
- Customer-specific tiered pricing contracts (`ContactItem`).
- Real-time outstanding balance aggregation from issued documents.
- Customer intelligence: purchase frequency, total lifetime spend, preferred communication channels.

### 5. Lead Management & Sales Pipelines

- Visual drag-and-drop Kanban board for sales deals.
- Stages: New Lead → Contacted → Qualified → Proposal/Quotation Sent → Negotiation → Won / Lost.
- Seamless conversion of won deals directly into Quotations or Orders.

### 6. Product Catalogues & Shareable Product Pages

- Multi-category product inventory with SKUs, barcodes, unit descriptions, and configurable taxation (Kenya VAT 16%, Zero Rated, Exempt).
- Fixed-decimal currency math in Kenya Shillings (`KES`).
- Generator for shareable social product cards with deep links for WhatsApp/Instagram.

### 7. Quotations, Orders & Payment Tracking

- Full document lifecycle: Quotation → Invoice → Delivery Note.
- Immutable snapshotting upon document issuance (`Document.snapshot`).
- Atomic period numbering sequences (calendar year, financial year, custom prefix/padding).
- Partial payments, receipt generation, and overpayment prevention.

### 8. Unified Social Commerce Inbox

- Consolidated customer messaging stream (WhatsApp Business, Instagram DM, Facebook Messenger, SMS).
- Fast quotation creation directly inside the chat interface.
- Customer order and quote history displayed in the conversation side-panel.

### 9. Social Media Marketing Studio

- Social post creator with image uploads and brand watermarks.
- Scheduled publishing calendar for promotional campaigns.
- Reusable product showcase templates.

### 10. Campaign & Conversion Tracking

- Campaign creation with unique tracking links (UTM parameters).
- Conversion funnel tracking from social click to lead to paid invoice.
- Promo codes and campaign discount attribution.

### 11. Customer Segmentation & Loyalty

- RFM segmentation (Recency, Frequency, Monetary value).
- Dynamic tagging (e.g., "Wholesale VIP", "Slow Payer", "High Value").
- Customer loyalty points ledger and reward redemptions.

### 12. Marketing Automation

- Automated event triggers:
  - Welcome message upon lead creation.
  - Payment reminder 3 days before invoice due date.
  - Re-engagement message after 60 days of inactivity.

### 13. Revenue Attribution & Profitability Analytics

- Real-time revenue dashboards by product category, customer segment, and sales channel.
- Net profit calculation subtracting cost of goods sold (COGS).
- Exportable CSV/PDF financial summaries.

### 14. Amisi Intelligence AI Assistant

- Context-aware reply generator for social inquiries.
- AI drafting of quotation cover notes and payment reminders.
- Marketing copy generator tailored to East African commercial nuances.

### 15. Private Document Storage & PDF Delivery

- Secure PDF rendering engine (`@amisibiz/documents`).
- Authenticated, signed streaming endpoints for internal and portal users.
- Tenant-scoped private cloud storage for company logos, attachments, and receipts.

### 16. Integration Management

- Kenya Revenue Authority (KRA) eTIMS compliance connector.
- DPO Pay / M-Pesa payment integration contracts.
- Bulk SMS gateway connectors for East Africa (Africa's Talking / Twilio).

### 17. Monitoring, Security & Production Operations

- Tamper-evident, append-only `AuditLog` capturing all privileged actions and auth failures.
- Zero-downtime database migrations with automated drift detection.
- Centralized error tracking and automated health check endpoints (`/api/health/ready`).
