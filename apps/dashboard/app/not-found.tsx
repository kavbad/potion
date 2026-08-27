// P1-6: the default Next 404 was the only unstyled page in the product —
// exactly the page a mistyped or expired link lands on.
import Link from 'next/link';
import { Mark } from '@/components/mark';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f4f2ec] px-6">
      <Mark className="h-8 w-8 text-accent" />
      <div className="mt-6 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">404</div>
      <h1 className="mt-2 text-center text-[1.6rem] font-medium tracking-[-0.02em] text-ink">This page doesn&rsquo;t exist</h1>
      <p className="mt-3 max-w-sm text-center text-[13.5px] leading-relaxed text-soft">
        The link may be old, or the address mistyped. Nothing was lost.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/" className="bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-85">
          Go to your dashboard
        </Link>
        <Link href="/docs" className="border border-[#d9d5cb] px-4 py-2 text-[12px] font-medium text-soft hover:border-ink hover:text-ink">
          Docs
        </Link>
      </div>
    </div>
  );
}
