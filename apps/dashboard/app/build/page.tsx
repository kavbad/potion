// /build — "what are you building?" (SERVING-ROADMAP S2).
//
// The from-scratch front door. Every other surface in the product assumes a
// workload to look at; this one assumes only a sentence, which is all someone
// starting a new thing actually has. The sentence goes through the same
// cluster assigner every request goes through and reads the same platform
// frontier the serving path would read, so what this page shows is the
// routing decision they are going to get — offered before they commit rather
// than discovered afterwards.
//
// Server component is deliberately thin: the whole flow is one client island
// because it is a conversation (describe → classify → choose → apply), not a
// render of stored state.
import { BuildPlanner } from '@/components/build-planner';

export const dynamic = 'force-dynamic';

export default function BuildPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">What are you building?</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        You don&apos;t need existing traffic, and you don&apos;t need to know which model is good.
        Describe what you&apos;re making and Potion will tell you which workload type it is, which
        strategy it has measured as best for that work, and what that costs — then set it up.
      </p>
      <BuildPlanner />
    </div>
  );
}
