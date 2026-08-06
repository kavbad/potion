> **DRAFT — requires counsel review before publication.**
> This document is a template prepared for the operator of the Potion platform.
> All `[●]` placeholders must be completed and the entire document must be
> reviewed and approved by qualified legal counsel in each relevant
> jurisdiction before it is published or incorporated into any customer
> agreement.

# Terms of Service

**Effective Date:** [●]
**Last Updated:** [●]
**Operator:** [●] ("**Potion**", "**we**", "**us**", "**our**"), [● entity type], organized under the laws of [●], with its principal place of business at [●].

These Terms of Service (these "**Terms**") form a binding agreement between Potion and the entity or person agreeing to them ("**Customer**", "**you**"). By creating an account, accessing, or using the Service, you agree to these Terms. If you accept on behalf of an organization, you represent that you have authority to bind that organization, and "Customer" refers to that organization.

Related documents, each incorporated by reference where applicable:

- **Privacy Policy:** `docs/legal/PRIVACY_POLICY.md` (published version at [● URL])
- **Data Processing Addendum ("DPA"):** `docs/legal/DPA.md` (published version at [● URL])
- **Acceptable Use Policy:** Section 5 of these Terms [● or separate AUP document]

---

## 1. Definitions

1.1 **"Service"** means Potion's hosted, self-serve platform that routes each of Customer's requests, according to Customer-configured policies and Potion's measured quality, cost, and latency data, to one or a combination of third-party large language models ("**Models**"), together with related APIs, dashboards, evaluation and frontier tooling, and documentation.

1.2 **"Customer Data"** means any data, content, or information submitted to the Service by or on behalf of Customer, including prompts, completions and other Model outputs returned to Customer, files, configuration, and API or provider keys. Customer Data excludes Aggregated Data and Potion's own routing evidence base (measured quality/cost/latency statistics that do not identify Customer or any individual).

1.3 **"Model Provider"** means a third-party provider of Models accessed through the Service, which may include OpenAI, Anthropic, Google, OpenRouter, and others listed at [● URL / in the dashboard].

1.4 **"BYOK"** means Customer's connection of its own Model Provider API keys to the Service ("**Customer Provider Keys**"), as opposed to use of Potion-managed platform keys ("**Platform Keys**").

1.5 **"Organization"** or "**Org**" means the multi-tenant workspace through which Customer's users, keys, policies, and logs are scoped within the Service.

1.6 **"Aggregated Data"** means de-identified or aggregated data derived from use of the Service that does not identify Customer or any individual, used by Potion to operate, evaluate, and improve the Service.

1.7 **"Subprocessor"** has the meaning given in the DPA.

## 2. The Service

2.1 **Service description.** The Service accepts Customer's inference requests and routes each request to one or more Models selected per task cluster according to Customer's policies and Potion's continuously measured quality, cost, and latency evidence. The Service includes request logging with Customer-configurable retention controls, evaluation/frontier tooling, and multi-tenant Org administration.

2.2 **No guaranteed Model availability.** Models are provided by third-party Model Providers. Potion does not control and does not guarantee the availability, performance, pricing, continued existence, or output of any Model or Model Provider. Routing to a particular Model is not guaranteed; Potion may add, remove, re-route, or substitute Models at any time, including to enforce Model Provider terms.

2.3 **Beta features.** Features identified as alpha, beta, or preview are provided "as is", may change or be discontinued, and are excluded from any service-level commitments.

2.4 **Changes.** Potion may update the Service provided it does not materially reduce the Service's overall functionality during a paid subscription term.

## 3. Accounts and Organizations

3.1 Customer must provide accurate registration information and keep credentials confidential. Customer is responsible for all activity under its Org and API keys.

3.2 Users with an Org administrator role manage membership, roles, keys, policies, and retention settings. Customer is responsible for its administrators' acts.

3.3 Customer must notify Potion promptly at [● security contact email] of any unauthorized access.

## 4. Fees and Payment [● — populate when billing launches]

4.1 Fees, if any, are stated at [● pricing page URL] or in an order form. Usage-based charges are computed from the Service's usage records.

4.2 Payments are processed by Stripe, Inc. ("**Stripe**"); Customer agrees to Stripe's terms for payment processing. Potion does not store full payment card numbers.

4.3 Fees are non-refundable except as required by law or expressly stated. Late or failed payment may result in suspension under Section 13.

4.4 Fees are exclusive of taxes; Customer is responsible for applicable taxes, excluding taxes on Potion's net income.

## 5. Acceptable Use

Customer will not, and will not permit anyone to:

(a) use the Service to violate any law, regulation, or third-party right, or to generate, store, or distribute illegal, harmful, deceptive, defamatory, or infringing content, including content that exploits minors, incites violence, or constitutes malware or fraud;
(b) use the Service to provide medical, legal, financial, or other professional advice without qualified human review, or in high-risk uses where failure could lead to death, injury, or severe harm;
(c) resell, sublicense, or provide the Service to third parties as a standalone inference service without Potion's prior written agreement [● — confirm whether a reseller/OEM path exists];
(d) reverse engineer the Service (except where permitted by law), probe or bypass security, rate limits, or routing logic, or scrape the Service;
(e) use Model outputs to develop models that compete with a Model Provider, where prohibited by that Model Provider's terms;
(f) misrepresent Model outputs as human-generated where disclosure is required by law, or violate any applicable AI-disclosure obligation.

**Enforcement.** Potion may rate-limit, throttle, suspend, or terminate access, and may remove or refuse to process content, where Potion reasonably believes this Section has been violated or to protect the Service, Model Providers, or third parties. Potion will provide notice where legally and operationally practicable.

## 6. Customer Data

6.1 **Ownership.** As between the parties, Customer retains all rights in Customer Data. Customer grants Potion a limited, non-exclusive license to host, process, transmit, and display Customer Data solely to provide, secure, and support the Service.

6.2 **Processing.** Customer Data (including prompts and responses) is processed to route and execute requests, maintain request logs per Customer's retention settings, enforce security and abuse controls, and provide support when Customer requests it.

6.3 **Retention controls.** Customer's Org administrators may configure retention for stored prompts/responses in request logs. Deletion follows the timelines in the Privacy Policy and DPA.

6.4 **No training on Customer Data.** [● — POLICY DECISION REQUIRED. Draft position: Potion does not use Customer Data to train or fine-tune Models and, where Potion controls the upstream relationship, instructs Model Providers not to do so. Counsel and product must confirm this is accurate for every provider path (BYOK traffic is governed by the Model Provider's own terms with Customer).]

6.5 **Aggregated Data.** Potion may create and use Aggregated Data (e.g., quality/cost/latency measurements) to operate and improve the Service, provided Aggregated Data does not identify Customer or any individual and does not reveal the content of prompts or responses.

6.6 **Privacy.** Processing of personal data is governed by the Privacy Policy and, where Potion processes personal data on Customer's behalf, the DPA.

## 7. Model Providers; Pass-Through Compliance

7.1 **Customer responsibility.** Use of each Model is subject to the applicable Model Provider's terms (e.g., OpenAI, Anthropic, Google, OpenRouter terms, each as updated by the provider). Customer must comply with those terms, including acceptable use and output restrictions, whether using BYOK or Platform Keys. Current links are maintained at [● URL].

7.2 **No liability for providers.** Potion is not responsible for Model outputs, Model Provider acts or omissions, outages, deprecations, pricing changes, or a provider's termination of Customer's BYOK access. Model outputs may be inaccurate, biased, or non-unique; Customer is responsible for evaluating outputs before use.

7.3 **Pass-through enforcement.** If a Model Provider requires it, Potion may suspend routing to that provider, remove content, or disclose Customer's identity and relevant data to the provider to the extent reasonably required to comply.

## 8. BYOK (Customer Provider Keys)

8.1 **Warranty.** Customer represents and warrants that it owns or is authorized to use each Customer Provider Key it connects, that its provider accounts are in good standing, and that use of the keys through the Service complies with the provider's terms.

8.2 **Custody.** Customer Provider Keys are stored by the Service in encrypted form and used solely to route Customer's requests. Key custody is a service feature, not an assumption of liability: Customer remains responsible for its provider accounts, charges incurred under its keys, and key rotation/revocation.

8.3 **Revocation.** Customer may delete a Customer Provider Key at any time; routing to that provider will cease. Provider-billed usage is settled between Customer and the provider.

## 9. Service Levels

9.1 The Service is provided on a **best-efforts** basis. No uptime, latency, or support commitment applies unless Customer has executed a separate Service Level Agreement with Potion. [● — SLA offering to be defined; update this Section when an SLA exists.]

9.2 Scheduled maintenance will, where practicable, be announced in advance at [● status page URL].

## 10. Intellectual Property

Potion retains all rights in the Service, including its routing, evaluation, and frontier tooling and the routing evidence base. Customer may provide feedback; Potion may use feedback without restriction or attribution. Model outputs are addressed by Section 7.2 and the applicable Model Provider terms; Potion claims no ownership of outputs returned to Customer. [● — confirm output-IP position against each provider's terms.]

## 11. Disclaimers

EXCEPT AS EXPRESSLY STATED, THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE". POTION DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ANY WARRANTY THAT THE SERVICE OR MODEL OUTPUTS WILL BE ACCURATE, UNINTERRUPTED, OR ERROR-FREE. CUSTOMER IS SOLELY RESPONSIBLE FOR ITS USE OF MODEL OUTPUTS.

## 12. Limitation of Liability; Indemnification

12.1 **Exclusions.** TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY IS LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR LOST PROFITS, REVENUE, DATA, OR GOODWILL.

12.2 **Cap.** POTION'S AGGREGATE LIABILITY ARISING OUT OF THESE TERMS IS LIMITED TO THE AMOUNTS PAID OR PAYABLE BY CUSTOMER TO POTION FOR THE SERVICE IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO LIABILITY, OR, IF GREATER, [● currency amount / floor for free tiers].

12.3 **Exceptions.** Sections 12.1–12.2 do not limit liability for [● — counsel to confirm, e.g.: a party's indemnification obligations; Customer's payment obligations; liability that cannot be limited by law].

12.4 **Customer indemnity.** Customer will defend and indemnify Potion against third-party claims arising from Customer Data, Customer's breach of Sections 5, 7, or 8, or Customer's unlawful use of the Service or outputs.

12.5 **Potion indemnity.** Potion will defend and indemnify Customer against third-party claims that the Service (excluding Model outputs, Customer Data, and Model Provider technology) infringes a third party's intellectual property rights, subject to prompt notice, sole control of the defense, and reasonable cooperation.

## 13. Term and Termination

13.1 These Terms apply from acceptance until terminated. Customer may terminate at any time by closing its Org; Potion may terminate for convenience on [● 30] days' notice [● — confirm free-tier convenience termination policy].

13.2 Either party may terminate for material breach uncured within 30 days of notice. Potion may suspend immediately for Acceptable Use violations, security risk, or non-payment.

13.3 **Effect.** On termination, access ceases and Customer Data is deleted or returned per the DPA and the retention timelines in the Privacy Policy. Sections intended to survive (including 6.1, 10–13) survive.

## 14. General

14.1 **Governing law and venue.** These Terms are governed by the laws of [●], without regard to conflict-of-laws rules. Disputes will be resolved in the courts of [●] [● — or: by binding arbitration under the rules of ●; counsel to decide].

14.2 **Entire agreement; order of precedence.** These Terms, the Privacy Policy, and any DPA or order form are the entire agreement. In case of conflict regarding personal data processing, the DPA prevails, then these Terms, then the Privacy Policy.

14.3 **Assignment.** Neither party may assign without the other's consent, except to an affiliate or in connection with a merger or sale of substantially all assets, with notice.

14.4 **Notices** to Potion: [● legal notices email/address]. Potion may notify Customer via the Org administrator's registered email or in-product notice.

14.5 **Miscellaneous.** Neither party is liable for force majeure delays. If a provision is unenforceable, the remainder stays in effect. No waiver is continuing. The parties are independent contractors. Export-control and sanctions compliance applies to both parties.

---

## Counsel Review Checklist — Terms of Service

- [ ] Fill every `[●]`: entity details, effective date, URLs, contacts, fees/billing section, SLA reference, liability floor, termination notice period, governing law/venue (or arbitration).
- [ ] Confirm the no-training policy in Section 6.4 is true for **every** provider path (platform keys and OpenRouter), and align marketing copy.
- [ ] Confirm BYOK custody description (Section 8) matches the implemented encryption/storage design.
- [ ] Decide reseller/OEM posture (Section 5(c)).
- [ ] Confirm pass-through compliance approach and the Model Provider terms list (Section 7) is current (OpenAI / Anthropic / Google / OpenRouter).
- [ ] Review liability cap and indemnities against target customer segment and insurance.
- [ ] Check consumer-protection / mandatory-arbitration rules if any non-business users are permitted.
- [ ] Verify cross-references to `PRIVACY_POLICY.md` and `DPA.md` use the same defined terms.
- [ ] Confirm AI-specific disclosure obligations (e.g., EU AI Act transparency) are allocated correctly for the deployment model.
