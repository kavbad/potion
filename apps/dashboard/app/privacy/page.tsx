import type { Metadata } from 'next';
import { LegalPage, LegalSection } from '@/components/legal';
import { SiteShell } from '@/components/site-header';

export const metadata: Metadata = { title: 'Privacy Policy — Potion' };

export default function PrivacyPage() {
  return (
    <SiteShell>
      <LegalPage title="Privacy Policy" updated="August 24, 2026">
        <LegalSection heading="The short version">
          <p>
            We keep the metadata needed to bill and route: token counts, costs, which model served a
            request, and what kind of work it was. We do not store the content of your prompts or answers,
            with two exceptions you control: traces you choose to send us, and workload samples kept only
            after you opt in — redacted and capped. We never train models on your content.
          </p>
        </LegalSection>

        <LegalSection heading="What we collect">
          <p>
            <span className="text-ink">Account data.</span> Your email address and name, your organization,
            team roles and invites, and an audit log of sign-ins and administrative actions.
          </p>
          <p>
            <span className="text-ink">Request metadata.</span> For every API request: timestamps, token
            counts, cost, the model and routing decision that served it, and the kind of work it was
            classified as. This is what your receipts, usage page, and savings figures are built from. It
            does not include the text of the request or the answer. It also includes content-free
            structural features — message and tool counts, size buckets, a hashed tool signature — and
            markers for what the serving path observed (a retry, a fallback), which never contain your
            text and exist so routing can improve on the shape of work rather than its content.
          </p>
          <p>
            <span className="text-ink">Content, only where you choose it.</span> Prompts pass through us to
            the model that generates your answer — that is the service working, not storage. Content is
            stored in exactly two cases: traces you explicitly export to us, and workload samples kept under
            the measurement opt-in described below. Both paths run through automatic redaction of common
            personal-data patterns before anything is written.
          </p>
        </LegalSection>

        <LegalSection heading="Measuring your workloads (the opt-in)">
          <p>
            If your organization opts in, we keep a small, capped sample of requests per kind of work —
            redacted prompt and answer — and use it for one purpose: measuring how well models perform on
            your actual work, so we can show you what your current model scores and propose routing settings
            with evidence. Proposals never apply themselves; you press the button. You can withdraw the
            opt-in at any time, and deleting your organization deletes the samples.
          </p>
        </LegalSection>

        <LegalSection heading="Where your data goes">
          <p>
            To answer a request, its content goes to the model that serves it. Today that means our upstream
            inference providers (such as OpenRouter and OpenAI) and the operators of the specific model your
            request is routed to, under their own terms. We also use Hetzner (Germany) for hosting, Render
            (EU, Frankfurt) for our database, and Resend for transactional email such as sign-in links and
            alerts. We do not sell your data, and we do not share it with anyone beyond these processors and
            what the law requires.
          </p>
        </LegalSection>

        <LegalSection heading="Security">
          <p>
            Traffic is encrypted in transit. API keys are stored only as hashes. Sign-in is by short-lived
            email link — we hold no passwords. Every API route is exercised by an automated tenant-isolation
            sweep before it ships, so one organization&rsquo;s data is not reachable from another&rsquo;s
            session or key.
          </p>
        </LegalSection>

        <LegalSection heading="Retention and deletion">
          <p>
            Request metadata is retained while your account is active, because it is your billing record.
            Deleting your organization deletes its data — keys, members, invites, traces, samples,
            measurements, and settings — in one cascade. To delete your organization or exercise access and
            correction rights over your data, email kavon@mutiny.ai and we will act on it.
          </p>
        </LegalSection>

        <LegalSection heading="Changes">
          <p>
            If this policy changes materially, we will tell you by email or in the dashboard before the
            change takes effect. This draft has not yet completed legal review.
          </p>
        </LegalSection>
      </LegalPage>
    </SiteShell>
  );
}
