import { WorkloadUpload } from '@/components/workload-upload';

export const dynamic = 'force-dynamic';

export default function WorkloadPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Your workload</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Paste a sample of the prompts you send today. Potion sorts them into workload clusters —
        each cluster gets its own cost-quality frontier.
      </p>
      <WorkloadUpload />
    </div>
  );
}
