> **DRAFT — requires counsel review before publication.**
> This document is a template prepared for the operator of the Potion platform.
> All `[●]` placeholders must be completed and the entire document must be
> reviewed and approved by qualified legal counsel in each relevant
> jurisdiction before it is published or incorporated into any customer
> agreement.

# Privacy Policy

**Effective Date:** [●]
**Last Updated:** [●]
**Controller / Operator:** [●] ("**Potion**", "**we**", "**us**", "**our**"), [● entity type], [● address]. Privacy contact: [● email]. Data Protection Officer (if appointed): [● name/email / "not appointed"].

This Privacy Policy explains how Potion collects, uses, discloses, and retains personal data in connection with the Potion Service. Capitalized terms not defined here (including "**Service**", "**Customer Data**", "**Customer**", "**Model Provider**", "**Organization**" / "**Org**", "**BYOK**", and "**Subprocessor**") have the meanings given in the Terms of Service (`docs/legal/TERMS_OF_SERVICE.md`, published at [● URL]).

**Controller / processor roles.** When Customer's end users' personal data appears inside prompts and responses routed through the Service, Customer is the **controller** and Potion acts as a **processor** under the Data Processing Addendum (`docs/legal/DPA.md`, published at [● URL]). Potion is the **controller** of account, billing, and Service-operations data described in Sections 1.1–1.2 and 2.1–2.2 below.

---

## 1. What We Collect

### 1.1 Account and Organization data (Potion as controller)
- Registration data: name, email address, password hash, Org name, role (admin / member / viewer).
- Billing data (when billing launches): billing contact, invoicing details, and payment transaction identifiers. Full payment card numbers are collected and stored by Stripe, not by Potion.
- Communications: support requests and correspondence.

### 1.2 Service-operations data (Potion as controller)
- Usage metadata: timestamps, request counts, token usage, latency, model selected, routing strategy/cluster identifiers, status codes, and similar technical telemetry stored in request logs.
- Security and abuse-prevention logs: IP addresses, authentication events, rate-limit events.
- Cookies and similar technologies: [● — list: e.g., session/authentication cookies (strictly necessary); analytics cookies (consent-based) ●]. See Section 9.

### 1.3 Customer Data processed on Customer's behalf (Potion as processor)
- **Prompts and responses** submitted to or returned by the Service, stored in request logs according to the Customer's Org-level retention settings.
- **API keys**: Customer's Potion API keys and BYOK Customer Provider Keys, stored in encrypted form.
- Org configuration and policies set by Customer's administrators.

Potion does not determine the purposes or means of processing the data in this Section 1.3; that processing is governed by the DPA.

### 1.4 Data we do not intend to collect
Please do not submit special categories of personal data (e.g., health, biometric, or precise geolocation data) or data of children under 16 through the Service unless your use case is lawful and, where required, covered by a signed DPA and appropriate safeguards. [● — counsel to confirm the age threshold and any sector exclusions.]

## 2. Purposes and Legal Bases (GDPR/UK GDPR)

Where the GDPR or UK GDPR applies, we rely on the following legal bases:

| Purpose | Data | Legal basis |
|---|---|---|
| Provide, route, and operate the Service | Account data, Customer Data, usage metadata | Performance of a contract (Art. 6(1)(b)) |
| Secure the Service; prevent abuse and fraud | Security logs, IP addresses, usage metadata | Legitimate interest (Art. 6(1)(f)) in operating a secure service |
| Improve routing quality/cost/latency measurement | Aggregated, de-identified measurements (not prompt/response content) [● — confirm] | Legitimate interest (Art. 6(1)(f)); data is aggregated so it no longer identifies any individual |
| Billing and accounting | Billing data, transaction records | Contract (Art. 6(1)(b)); legal obligation (Art. 6(1)(c)) |
| Product analytics and non-essential cookies | Analytics identifiers | Consent (Art. 6(1)(a)), where required |
| Legal compliance and defense of claims | Any of the above, as needed | Legal obligation (Art. 6(1)(c)); legitimate interest (Art. 6(1)(f)) |

[● — POLICY DECISION REQUIRED, mirroring ToS §6.4: Potion does not use prompt/response content to train or fine-tune models. If any quality-improvement processing uses Customer Data in non-aggregated form, that basis must be described here and in the DPA.]

## 3. How We Share Personal Data

We do not sell personal data [● — confirm "sale"/"share" posture under CCPA/CPRA after the analytics/cookie setup is finalized]. We disclose personal data only to:

### 3.1 Subprocessors (template list)

| Subprocessor | Purpose | Location | Safeguards / notes |
|---|---|---|---|
| [● cloud hosting provider, e.g., AWS / GCP / Hetzner] | Infrastructure hosting, database, backups | [● region(s)] | [● DPA/SCCs reference] |
| Model Providers (e.g., OpenAI, Anthropic, Google, OpenRouter, each only when routing uses that provider) | Execute inference requests; prompts and necessary context are transmitted to the provider selected per request | [● per provider] | Governed by the provider's terms/DPA; BYOK requests are governed by Customer's own agreement with that provider |
| Stripe, Inc. | Payment processing (when billing launches) | United States [●] | Stripe processes card data directly; Potion receives only tokens/identifiers |
| [● support/ticketing tool] | Customer support | [●] | [●] |
| [● analytics/error-monitoring tool] | Service reliability | [●] | [● — confirm no prompt/response content flows here] |

The current Subprocessor list for DPA purposes is maintained at [● URL]; see DPA Annex II and the change-notification mechanism in DPA §6.

### 3.2 Other disclosures
- **Legal requirements:** where required by law, regulation, or valid legal process, or to protect rights, safety, and the security of the Service.
- **Business transfers:** in connection with a merger, acquisition, or sale of assets, subject to this Policy.
- **With Customer's direction:** e.g., when Customer configures integrations.

## 4. Retention

| Data category | Default retention | Notes |
|---|---|---|
| Prompts/responses in request logs | **30 days [●]** | Configurable per Org within [● range, e.g., 0–365 days]; Org admins can set shorter windows or disable content logging [● — confirm feature scope] |
| Usage metadata (non-content request telemetry) | [● e.g., 13 months] | May be retained longer only in aggregated, de-identified form |
| Account and Org data | Life of the account + [● e.g., 90 days] | Deleted or anonymized after Org closure, subject to backup cycle |
| Security/abuse logs | [● e.g., 12 months] | Longer where needed to investigate an active incident |
| Billing/tax records | [● e.g., 7 years] | As required by applicable accounting law |
| Backups | [● e.g., 30 days] rolling | Deleted data is purged from backups on the next cycle; it is not restored except for disaster recovery |

Org-scoped deletion: because every Customer asset (users, memberships, keys, policies, request logs) is scoped by `org_id`, closing an Org triggers deletion of that Org's Customer Data according to the table above and the DPA's deletion/return clause.

## 5. Your Rights and Choices (EEA/UK and similar laws)

Subject to law, you may have the right to access, rectify, erase, restrict, or object to processing of your personal data, to data portability, and to withdraw consent (without affecting prior lawful processing). You may lodge a complaint with your supervisory authority.

**How to exercise rights:**
- **Org administrators** can export/delete Org-scoped data and manage retention directly in the dashboard at [● URL / feature].
- **All users:** email [● privacy email] with your request. We respond within [● 30] days (extendable as permitted by law) and verify identity before acting.
- **End users whose data is inside Customer prompts/responses:** Potion processes that data as processor; please contact the relevant Customer (the controller). Potion will assist Customers in honoring such requests per DPA §7.

## 6. International Transfers

Potion is based in [●] and processes data in [● regions]. Where personal data is transferred outside the EEA/UK to a country without an adequacy decision, we rely on the European Commission's Standard Contractual Clauses (EU) and/or the UK IDTA/Addendum, as incorporated through the DPA (Annex III) [● — confirm which transfer mechanisms apply and whether a US entity self-certifies to the EU-US Data Privacy Framework; do not claim DPF participation unless certified]. Copies of transfer safeguards are available on request at [● email].

## 7. Security

We maintain technical and organizational measures appropriate to the risk, summarized in DPA Annex I, including: encryption of Customer Data and credentials in transit (TLS) and at rest; encrypted storage of API and Customer Provider Keys; access controls with least-privilege and Org-level tenant isolation; authentication controls and audit logging [● — confirm implemented]; vulnerability management and incident-response procedures [● — confirm]. No method of transmission or storage is fully secure; report suspected vulnerabilities to [● security email].

## 8. CCPA / California Privacy Rights

If you are a California resident, the CCPA/CPRA gives you the right to know, access, correct, delete, and port personal information; to opt out of the "sale" or "sharing" of personal information; and to not be discriminated against for exercising these rights.

- **Sale/sharing:** Potion does not sell personal information [● — and does not "share" it for cross-context behavioral advertising; confirm once analytics are finalized].
- **Notice at collection:** the categories collected, purposes, and retention are described in Sections 1–4.
- **Service provider / contractor role:** for personal information contained in Customer prompts/responses, Potion acts as a "service provider"/"contractor" to the Customer (the business); direct requests to the Customer, or to [● privacy email] and we will route them.
- **Requests:** email [● privacy email] or [● toll-free number / webform]. We will verify your request as required. Authorized agents may submit requests with proof of authorization.
- **Metrics/disclosures:** [● — add annual metrics if required by volume thresholds.]

## 9. Cookies

We use strictly necessary cookies for authentication and security. [● — Describe any analytics/marketing cookies, the consent mechanism (banner), and how to withdraw consent.] You can also control cookies via your browser settings; disabling strictly necessary cookies may break the Service.

## 10. Changes to This Policy

We will post updates at [● URL] and update the "Last Updated" date. Material changes will be notified via the Org administrator's registered email or in-product notice at least [● 14/30] days before taking effect, where required by law.

## 11. Contact

- Privacy requests: [● privacy email]
- Security reports: [● security email]
- Postal: [● address]
- EU representative (GDPR Art. 27, if required): [● or "not required — explain why"]
- UK representative (if required): [●]

---

## Counsel Review Checklist — Privacy Policy

- [ ] Fill every `[●]`: entity/contact details, DPO and Art. 27 representative status, URLs, all retention values, subprocessor rows, cookie inventory.
- [ ] Verify the retention table matches the implemented `request_logs` retention controls and backup cycle before publication.
- [ ] Decide and state the no-training policy consistently with ToS §6.4 and DPA.
- [ ] Confirm the subprocessor list matches reality: cloud host, which Model Providers are actually routed to (incl. OpenRouter as an aggregator), Stripe, support/analytics tooling — and that no prompt content reaches analytics tools.
- [ ] Confirm CCPA "sale/share" posture against actual analytics/adtech usage.
- [ ] Confirm transfer mechanism(s): SCCs, UK Addendum, and whether DPF certification will be obtained (do not claim it otherwise).
- [ ] Validate legal-basis table (Section 2) with counsel; confirm legitimate-interest balancing notes exist internally.
- [ ] Confirm age threshold and special-category stance (Section 1.4).
- [ ] Check defined terms match `TERMS_OF_SERVICE.md` and `DPA.md` (Customer Data, Service, Subprocessor, Model Provider).
