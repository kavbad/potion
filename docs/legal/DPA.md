> **DRAFT — requires counsel review before publication.**
> This document is a template prepared for the operator of the Potion platform.
> All `[●]` placeholders must be completed and the entire document must be
> reviewed and approved by qualified legal counsel in each relevant
> jurisdiction before it is published or incorporated into any customer
> agreement.

# Data Processing Addendum (DPA)

**Version:** [●] — **Effective Date:** [●]
**Processor:** [●] ("**Potion**"), [● entity type], [● address].
**Controller:** the customer entity identified in the applicable Order Form / account registration ("**Customer**").

This Data Processing Addendum ("**DPA**") supplements and forms part of the Terms of Service between Potion and Customer (the "**Agreement**", `docs/legal/TERMS_OF_SERVICE.md`, published at [● URL]) and applies where Potion processes **Customer Personal Data** (defined below) on Customer's behalf in providing the Service. In case of conflict concerning personal data processing, this DPA prevails over the Agreement (see Agreement §14.2).

Capitalized terms not defined here (including "**Service**", "**Customer Data**", "**Organization**" / "**Org**", "**Model Provider**", "**BYOK**") have the meanings given in the Agreement.

---

## 1. Definitions and Roles

1.1 "**Data Protection Law**" means applicable laws on personal data processing, including (where applicable) the EU GDPR (2016/679), the UK GDPR and Data Protection Act 2018, and the CCPA/CPRA.

1.2 "**Customer Personal Data**" means personal data contained within Customer Data that Potion processes on Customer's behalf in providing the Service — principally prompts, responses, and associated request-log content, plus Org membership data managed by Customer.

1.3 **Roles.** Customer is the **controller** (or, where Customer itself processes for a third party, a processor, in which case Potion is a subprocessor and Customer warrants it is authorized to appoint Potion). Potion is the **processor**. For account/billing data, Potion acts as an independent controller as described in the Privacy Policy (`docs/legal/PRIVACY_POLICY.md`); that processing is outside this DPA's scope.

1.4 "**Subprocessor**" means a third party engaged by Potion to process Customer Personal Data in connection with the Service.

1.5 "**Security Incident**" means a breach of Potion's security leading to accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to, Customer Personal Data processed by Potion.

1.6 "**SCCs**" means the EU Standard Contractual Clauses (Commission Implementing Decision (EU) 2021/914), and for UK transfers, the UK Addendum/IDTA, as applicable.

## 2. Processing Details (Art. 28(3))

| Item | Description |
|---|---|
| **Subject matter** | Provision of the Service: routing Customer's requests to Model Providers, storing request logs per Customer's retention settings, and related support. |
| **Duration** | The term of the Agreement, plus the deletion/return period in §10. |
| **Nature and purpose** | Receipt, transmission, storage, routing, and (per Customer configuration) deletion of prompts, responses, and related metadata, solely to provide, secure, and support the Service as instructed. |
| **Categories of data subjects** | Customer's end users and any individuals whose personal data Customer includes in prompts [● — adjust to actual use cases]. |
| **Categories of data** | Prompt/response content; request-log metadata (timestamps, usage, latency, model, status); Org membership data (names, emails, roles); API credentials (stored encrypted). Special categories: only if Customer includes them in prompts — see §3.3. |
| **Processing location** | [● hosting regions], plus Model Provider endpoints as selected by routing (see Annex II). |

## 3. Processor Obligations

3.1 **Documented instructions.** Potion will process Customer Personal Data only on Customer's documented instructions, including the Agreement, this DPA, and Customer's in-product configuration (routing policies, retention settings, deletion requests), unless required by law, in which case Potion will inform Customer unless legally prohibited.

3.2 **Confidentiality.** Potion ensures persons authorized to process Customer Personal Data are bound by confidentiality obligations.

3.3 **Customer's responsibilities.** Customer will not submit special categories of personal data, data of children, or regulated data (e.g., HIPAA, PCI) through the Service unless such use is lawful, and, where required, covered by a separate signed agreement [● — confirm whether any regulated-data addenda (BAA etc.) are offered]. Customer is responsible for the lawfulness of its instructions and for its own privacy notices to end users.

3.4 **No training use.** [● — POLICY DECISION REQUIRED, must match Agreement §6.4: Potion does not use Customer Personal Data (including prompt/response content) to train or fine-tune models.]

## 4. Security

Potion implements and maintains the technical and organizational measures described in **Annex I**, including encryption in transit and at rest, encrypted custody of API/Customer Provider Keys, access controls, and Org-level tenant isolation (all Customer assets scoped by `org_id`). Potion may update these measures provided it does not materially reduce the overall level of protection.

## 5. CCPA Service-Provider Terms

For CCPA/CPRA purposes, Potion acts as a "service provider"/"contractor": it will not sell or share Customer Personal Data, will not retain, use, or disclose it for any purpose other than providing the Service or as permitted by the CPRA, and will not combine it with personal data received from other sources except as permitted. [● — counsel to confirm wording against current CPRA regulations.]

## 6. Subprocessors

6.1 **General authorization.** Customer authorizes Potion's use of the Subprocessors listed in **Annex II** (current list also at [● URL]).

6.2 **Change notification.** Potion will give at least **thirty (30) days' [●]** notice of a new or replacement Subprocessor via [● email / in-product / mailing list]. Customer may object on reasonable data-protection grounds within that period; the parties will work in good faith toward a resolution (which may include Customer ceasing the affected routing path). If unresolved, Customer may terminate the affected Service without penalty.

6.3 **Flow-down.** Potion imposes data-protection obligations on each Subprocessor no less protective than this DPA and remains liable for its Subprocessors' performance to the extent required by Data Protection Law.

6.4 **Model Providers as Subprocessors.** Model Providers process prompts solely to execute inference requests. For **BYOK** routing, the relevant Model Provider processes under Customer's own agreement with that provider, and Potion is not responsible for that provider's terms or acts (see Agreement §§7–8).

## 7. Assistance with Data Subject Requests

Taking into account the nature of processing, Potion will provide reasonable assistance — including the Org-scoped export and deletion tooling described in the Privacy Policy §5 — to enable Customer to respond to data-subject requests (access, rectification, erasure, restriction, portability, objection) concerning Customer Personal Data. Requests from end users received directly by Potion will be redirected to Customer. Potion may charge reasonable costs for assistance beyond self-serve tooling [● — confirm].

## 8. Security Incidents

8.1 Potion will notify Customer without undue delay after becoming aware of a Security Incident affecting Customer Personal Data, and in any event within **seventy-two (72) hours [● — confirm; 72h is the GDPR regulator standard; many DPAs use "without undue delay" only]**.

8.2 The notice will describe, to the extent then known: the nature of the incident, categories and approximate number of data subjects/records affected, likely consequences, and mitigation measures. Potion will reasonably cooperate in Customer's breach-response obligations.

## 9. Audits

Potion will make available information reasonably necessary to demonstrate compliance with this DPA [● — e.g., security documentation, penetration-test summaries, or third-party certifications if/when obtained]. Customer may conduct an audit, at its expense, no more than once per 12 months (or following a Security Incident), on reasonable notice during business hours, subject to confidentiality and to Potion's reasonable security rules. Questionnaires and remote review will be used where they reasonably satisfy the audit purpose. [● — counsel to calibrate; add certification references (SOC 2 / ISO 27001) only once actually obtained.]

## 10. Deletion and Return at Termination

On termination or expiry of the Agreement, Potion will, at Customer's election (via Org-scoped export/delete tooling or written request within [● 30] days of termination), return or delete Customer Personal Data, and thereafter delete it within the retention timelines in Privacy Policy §4, except where retention is required by law. Residual copies in backups are deleted on the normal backup cycle [● e.g., 30 days] and remain protected until deletion. On request, Potion will confirm deletion in writing.

## 11. International Transfers and SCCs

Where Potion processes Customer Personal Data subject to the GDPR/UK GDPR in a country without an adequacy decision, the SCCs are incorporated by reference as set out in **Annex III**, with: Module 2 (controller-to-processor) [● or Module 3, processor-to-processor, where Customer is itself a processor]; Clause 7 docking clause [● in/out]; Clause 9 option [● (a) specific prior authorization / (b) general authorization per §6]; Clause 11 redress [● in/out]; Annexes I–III of the SCCs completed by reference to §2, Annex I, and Annex II of this DPA; governing law for the SCCs: [●]; competent supervisory authority: [●]. [● — counsel must complete Annex III before any EEA/UK customer signs.]

## 12. General

12.1 **Liability.** Each party's liability under this DPA is subject to the exclusions and caps in Agreement §12 [● — many DPAs carve out a separate, higher data-protection cap; counsel to decide].

12.2 **Term/termination.** This DPA remains in effect while Potion processes Customer Personal Data and terminates automatically with the Agreement; §§10–11 survive.

12.3 **Governing law.** Except as provided in the SCCs, this DPA is governed by the law of the Agreement (Agreement §14.1).

12.4 **Amendments.** Potion may update this DPA with at least [● 30] days' notice; updates apply prospectively and Customer may terminate if it reasonably objects on data-protection grounds.

---

## Annex I — Technical and Organizational Measures [● — verify each item against implementation before publication]

1. **Encryption.** TLS in transit for all external traffic; encryption at rest for the primary database and backups [● — specify mechanism, e.g., volume/KMS-level]; Customer API keys and BYOK Customer Provider Keys stored encrypted [● — specify: application-level / envelope encryption, key management].
2. **Access control.** Role-based access (Org roles: admin / member / viewer); least-privilege for staff; MFA for administrative access [● — confirm]; production access logged [● — confirm].
3. **Tenant isolation.** All Customer assets (users, memberships, keys, policies, request logs) scoped and authorized by `org_id`; cross-tenant access denied by the data-access layer [● — confirm test coverage].
4. **Availability.** Database backups with [● frequency/retention]; disaster-recovery restore procedure [● — confirm documented/tested].
5. **Development and operations.** Code review required for changes [● — confirm]; secrets managed via [● mechanism]; vulnerability/patch management [● — describe].
6. **Personnel.** Confidentiality obligations for staff and contractors; security awareness on onboarding [● — confirm].
7. **Incident response.** Documented incident-response procedure including detection, containment, customer notification (§8), and post-incident review [● — confirm exists].

## Annex II — Subprocessor List (mirrors Privacy Policy §3.1)

| Subprocessor | Processing purpose | Location | Transfer safeguard |
|---|---|---|---|
| [● cloud hosting provider] | Hosting, database, backups | [●] | [● SCCs / adequacy] |
| OpenAI [● include only if routed] | Inference execution (prompts) | [●] | [●] |
| Anthropic [● include only if routed] | Inference execution (prompts) | [●] | [●] |
| Google [● include only if routed] | Inference execution (prompts) | [●] | [●] |
| OpenRouter [● include only if routed] | Inference aggregation (prompts) | [●] | [●] |
| Stripe, Inc. | Payment processing | [●] | [●] |
| [● support / analytics tools] | [●] | [●] | [●] |

Change notification per §6.2; current list maintained at [● URL].

## Annex III — SCC Annex Placeholder

[● — Counsel to attach completed SCCs (Module 2 [●/3]), including: completed Annexes I.A–I.C (parties, description of transfer per DPA §2, competent supervisory authority), Annex II TOMs (cross-referencing Annex I above), and Annex III (Subprocessors, cross-referencing Annex II above). Include the UK Addendum if UK transfers are in scope.]

---

## Counsel Review Checklist — DPA

- [ ] Fill every `[●]`: parties, effective date, subprocessor list and locations, breach-notification window, audit mechanics, retention/deletion figures (must match Privacy Policy §4), SCC module and elections.
- [ ] Verify Annex I TOMs are all actually implemented — do not publish unimplemented controls.
- [ ] Decide breach-notification commitment (72h hard vs. "without undue delay") and the data-protection liability cap.
- [ ] Decide regulated-data posture (§3.3): is a BAA or PCI scope ever offered?
- [ ] Confirm Model Provider treatment in §6.4/Annex II matches actual routing (incl. OpenRouter) and each provider's DPA/zero-retention options.
- [ ] Confirm no-training clause (§3.4) matches Agreement §6.4 and the Privacy Policy.
- [ ] Complete Annex III SCCs before signing with any EEA/UK controller; add UK Addendum as needed.
- [ ] Confirm defined terms match `TERMS_OF_SERVICE.md` and `PRIVACY_POLICY.md`.
- [ ] If Customer may be a processor (§1.3), confirm the Module 3 chain and authorization warranty wording with counsel.
